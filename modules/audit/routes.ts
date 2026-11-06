/**
 * Audit Log API Routes
 * Endpoints for querying and exporting audit logs
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger/index.js';
import { requireAuth } from '../auth/middleware.js';
import { requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import {
  queryAuditLogs,
  getAuditLogStats,
  createAuditLog,
  archiveExpiredLogs,
} from './service.js';
import type { AuditAction, AuditSeverity, AuditStatus } from '@prisma/client';

// ============================================================================
// REQUEST SCHEMAS
// ============================================================================

const QueryAuditLogsSchema = z.object({
  user_id: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
  status: z.enum(['SUCCESS', 'FAILURE', 'PENDING']).optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
});

const ExportAuditLogsSchema = z.object({
  format: z.enum(['csv', 'json']),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  action: z.string().optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']).optional(),
});

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/audit-logs
 * Query audit logs with filters
 */
async function handleQueryAuditLogs(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleQueryAuditLogs' });

  try {
    const query = QueryAuditLogsSchema.parse(request.query);
    const organizationId = (request as any).organizationId;

    if (!organizationId) {
      return reply.code(400).send({
        error: 'Organization context required',
      });
    }

    const result = await queryAuditLogs({
      organizationId,
      userId: query.user_id,
      action: query.action as AuditAction | undefined,
      resource: query.resource,
      severity: query.severity as AuditSeverity | undefined,
      status: query.status as AuditStatus | undefined,
      startDate: query.start_date ? new Date(query.start_date) : undefined,
      endDate: query.end_date ? new Date(query.end_date) : undefined,
      limit: query.limit,
      offset: query.offset,
    });

    log.info(
      {
        organizationId,
        count: result.logs.length,
        total: result.total,
      },
      'Queried audit logs'
    );

    return reply.code(200).send({
      logs: result.logs.map((log) => ({
        id: log.id,
        user_id: log.userId,
        user_name: log.userName,
        user_email: log.userEmail,
        action: log.action,
        resource: log.resource,
        resource_id: log.resourceId,
        description: log.description,
        metadata: log.metadata,
        ip_address: log.ipAddress,
        user_agent: log.userAgent,
        severity: log.severity,
        status: log.status,
        error_message: log.errorMessage,
        occurred_at: log.occurredAt.toISOString(),
        archived: log.archived,
      })),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      has_more: result.hasMore,
    });
  } catch (error) {
    log.error({ error }, 'Failed to query audit logs');
    return reply.code(500).send({
      error: 'Failed to query audit logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/audit-logs/stats
 * Get audit log statistics
 */
async function handleGetAuditLogStats(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetAuditLogStats' });

  try {
    const organizationId = (request as any).organizationId;

    if (!organizationId) {
      return reply.code(400).send({
        error: 'Organization context required',
      });
    }

    const stats = await getAuditLogStats(organizationId);

    log.info({ organizationId, stats }, 'Retrieved audit log stats');

    return reply.code(200).send({
      total_logs: stats.totalLogs,
      by_severity: stats.bySeverity,
      by_action: stats.byAction,
      by_status: stats.byStatus,
      recent_critical: stats.recentCritical,
      failure_rate: stats.failureRate,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get audit log stats');
    return reply.code(500).send({
      error: 'Failed to get audit log stats',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/audit-logs/export
 * Export audit logs for compliance
 */
async function handleExportAuditLogs(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleExportAuditLogs' });

  try {
    const body = ExportAuditLogsSchema.parse(request.body);
    const organizationId = (request as any).organizationId;
    const user = (request as any).user;

    if (!organizationId || !user) {
      return reply.code(400).send({
        error: 'Organization context and user required',
      });
    }

    // Query audit logs with filters
    const result = await queryAuditLogs({
      organizationId,
      action: body.action as AuditAction | undefined,
      severity: body.severity as AuditSeverity | undefined,
      startDate: body.start_date ? new Date(body.start_date) : undefined,
      endDate: body.end_date ? new Date(body.end_date) : undefined,
      limit: 10000, // Max export limit
    });

    // Log the export action
    await createAuditLog({
      organizationId,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      action: 'AUDIT_LOG_EXPORTED',
      resource: 'audit_logs',
      description: `Exported ${result.logs.length} audit logs as ${body.format.toUpperCase()}`,
      metadata: {
        format: body.format,
        count: result.logs.length,
        filters: {
          action: body.action,
          severity: body.severity,
          start_date: body.start_date,
          end_date: body.end_date,
        },
      },
      severity: 'MEDIUM',
      ipAddress:
        (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        request.ip,
      userAgent: request.headers['user-agent'],
    });

    // Generate export based on format
    if (body.format === 'csv') {
      const csv = generateCsvExport(result.logs);

      return reply
        .code(200)
        .header('Content-Type', 'text/csv')
        .header(
          'Content-Disposition',
          `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.csv"`
        )
        .send(csv);
    } else {
      // JSON export
      return reply
        .code(200)
        .header('Content-Type', 'application/json')
        .header(
          'Content-Disposition',
          `attachment; filename="audit-logs-${new Date().toISOString().split('T')[0]}.json"`
        )
        .send({
          exported_at: new Date().toISOString(),
          organization_id: organizationId,
          total_logs: result.logs.length,
          filters: {
            action: body.action,
            severity: body.severity,
            start_date: body.start_date,
            end_date: body.end_date,
          },
          logs: result.logs.map((log) => ({
            id: log.id,
            user_id: log.userId,
            user_name: log.userName,
            user_email: log.userEmail,
            action: log.action,
            resource: log.resource,
            resource_id: log.resourceId,
            description: log.description,
            metadata: log.metadata,
            ip_address: log.ipAddress,
            user_agent: log.userAgent,
            severity: log.severity,
            status: log.status,
            error_message: log.errorMessage,
            occurred_at: log.occurredAt.toISOString(),
          })),
        });
    }
  } catch (error) {
    log.error({ error }, 'Failed to export audit logs');
    return reply.code(500).send({
      error: 'Failed to export audit logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/audit-logs/archive
 * Manually trigger archival of expired logs
 */
async function handleArchiveExpiredLogs(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleArchiveExpiredLogs' });

  try {
    const user = (request as any).user;
    const organizationId = (request as any).organizationId;

    // Only admins can trigger archival
    if (!user || user.role !== 'ADMIN') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Only admins can trigger log archival',
      });
    }

    const count = await archiveExpiredLogs();

    log.info({ count }, 'Archived expired audit logs');

    return reply.code(200).send({
      message: 'Archived expired audit logs',
      count,
    });
  } catch (error) {
    log.error({ error }, 'Failed to archive logs');
    return reply.code(500).send({
      error: 'Failed to archive logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate CSV export from audit logs
 */
function generateCsvExport(logs: any[]): string {
  // CSV header
  const headers = [
    'ID',
    'Occurred At',
    'User Email',
    'User Name',
    'Action',
    'Resource',
    'Resource ID',
    'Description',
    'Severity',
    'Status',
    'IP Address',
    'Error Message',
  ];

  const rows = logs.map((log) => [
    log.id,
    log.occurredAt.toISOString(),
    log.userEmail || '',
    log.userName || '',
    log.action,
    log.resource,
    log.resourceId || '',
    escapeCsvField(log.description),
    log.severity,
    log.status,
    log.ipAddress || '',
    escapeCsvField(log.errorMessage || ''),
  ]);

  // Build CSV
  const csv = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

  return csv;
}

/**
 * Escape CSV field (handle quotes and commas)
 */
function escapeCsvField(field: string): string {
  if (!field) return '';

  // If field contains comma, quote, or newline, wrap in quotes and escape quotes
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }

  return field;
}

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  // All audit routes require authentication and organization context
  const preHandler = [requireAuth, requireOrganizationContext];

  app.get('/api/audit-logs', { preHandler }, handleQueryAuditLogs);

  app.get('/api/audit-logs/stats', { preHandler }, handleGetAuditLogStats);

  app.post('/api/audit-logs/export', { preHandler }, handleExportAuditLogs);

  app.post('/api/audit-logs/archive', { preHandler }, handleArchiveExpiredLogs);

  logger.info('Registered audit log routes');
}
