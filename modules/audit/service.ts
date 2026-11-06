/**
 * Audit Log Service
 * Tracks all user and system actions for compliance (SOC2, GDPR, etc.)
 */

import type { AuditAction, AuditSeverity, AuditStatus } from '@prisma/client';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateAuditLogParams {
  organizationId: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  action: AuditAction;
  resource: string;
  resourceId?: string;
  description: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  severity?: AuditSeverity;
  status?: AuditStatus;
  errorMessage?: string;
  retentionDays?: number; // null = retain indefinitely
}

export interface AuditLogFilters {
  organizationId: string;
  userId?: string;
  action?: AuditAction;
  resource?: string;
  severity?: AuditSeverity;
  status?: AuditStatus;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditLogStats {
  totalLogs: number;
  bySeverity: Record<string, number>;
  byAction: Record<string, number>;
  byStatus: Record<string, number>;
  recentCritical: number; // Last 24 hours
  failureRate: number;
}

// ============================================================================
// AUDIT LOG CREATION
// ============================================================================

/**
 * Create audit log entry
 * Records user/system actions for compliance and security
 */
export async function createAuditLog(params: CreateAuditLogParams): Promise<void> {
  const log = logger.child({
    operation: 'createAuditLog',
    action: params.action,
    userId: params.userId,
  });

  try {
    // Calculate retention date if specified
    const retainUntil = params.retentionDays
      ? new Date(Date.now() + params.retentionDays * 24 * 60 * 60 * 1000)
      : null;

    await prisma.auditLog.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId || null,
        userName: params.userName || null,
        userEmail: params.userEmail || null,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId || null,
        description: params.description,
        metadata: params.metadata as any || null,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
        severity: params.severity || 'INFO',
        status: params.status || 'SUCCESS',
        errorMessage: params.errorMessage || null,
        retainUntil,
      },
    });

    // Log critical/high severity events
    if (params.severity === 'CRITICAL' || params.severity === 'HIGH') {
      log.warn(
        {
          action: params.action,
          severity: params.severity,
          resource: params.resource,
        },
        'High-severity audit event recorded'
      );
    }
  } catch (error) {
    log.error({ error, params }, 'Failed to create audit log');
    // Don't throw - audit logging failures shouldn't break main flow
  }
}

// ============================================================================
// HELPER FUNCTIONS FOR COMMON ACTIONS
// ============================================================================

/**
 * Log authentication event
 */
export async function logAuthEvent(params: {
  organizationId: string;
  userId?: string;
  userEmail?: string;
  action: 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED' | 'PASSWORD_RESET' | 'PASSWORD_CHANGED' | 'EMAIL_VERIFIED';
  ipAddress?: string;
  userAgent?: string;
  errorMessage?: string;
}): Promise<void> {
  await createAuditLog({
    organizationId: params.organizationId,
    userId: params.userId,
    userEmail: params.userEmail,
    action: params.action,
    resource: 'auth',
    description: getAuthDescription(params.action, params.userEmail),
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    severity: params.action === 'LOGIN_FAILED' ? 'MEDIUM' : 'INFO',
    status: params.errorMessage ? 'FAILURE' : 'SUCCESS',
    errorMessage: params.errorMessage,
    retentionDays: 90, // Auth logs retained for 90 days
  });
}

/**
 * Log resource creation
 */
export async function logResourceCreated(params: {
  organizationId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  resource: string;
  resourceId: string;
  description: string;
  metadata?: Record<string, any>;
  severity?: AuditSeverity;
}): Promise<void> {
  await createAuditLog({
    ...params,
    action: getCreateAction(params.resource),
    severity: params.severity || 'LOW',
    retentionDays: 365, // Resource creation logs retained for 1 year
  });
}

/**
 * Log resource update
 */
export async function logResourceUpdated(params: {
  organizationId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  resource: string;
  resourceId: string;
  description: string;
  metadata?: Record<string, any>;
  severity?: AuditSeverity;
}): Promise<void> {
  await createAuditLog({
    ...params,
    action: getUpdateAction(params.resource),
    severity: params.severity || 'LOW',
    retentionDays: 180, // Update logs retained for 6 months
  });
}

/**
 * Log resource deletion
 */
export async function logResourceDeleted(params: {
  organizationId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  resource: string;
  resourceId: string;
  description: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  await createAuditLog({
    ...params,
    action: getDeleteAction(params.resource),
    severity: 'HIGH', // Deletions are always high severity
    retentionDays: null, // Deletion logs retained indefinitely
  });
}

/**
 * Log data export (for compliance)
 */
export async function logDataExport(params: {
  organizationId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  exportType: string;
  recordCount?: number;
  ipAddress?: string;
}): Promise<void> {
  await createAuditLog({
    organizationId: params.organizationId,
    userId: params.userId,
    userName: params.userName,
    userEmail: params.userEmail,
    action: 'DATA_EXPORTED',
    resource: 'data',
    description: `Exported ${params.exportType} data${params.recordCount ? ` (${params.recordCount} records)` : ''}`,
    metadata: {
      exportType: params.exportType,
      recordCount: params.recordCount,
    },
    ipAddress: params.ipAddress,
    severity: 'MEDIUM', // Data exports are medium severity
    retentionDays: null, // Export logs retained indefinitely
  });
}

/**
 * Log security event
 */
export async function logSecurityEvent(params: {
  organizationId: string;
  userId?: string;
  action: 'UNAUTHORIZED_ACCESS_ATTEMPT' | 'PERMISSION_DENIED' | 'SUSPICIOUS_ACTIVITY_DETECTED';
  resource: string;
  resourceId?: string;
  description: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  await createAuditLog({
    ...params,
    severity: 'CRITICAL', // Security events are always critical
    status: 'FAILURE',
    retentionDays: null, // Security logs retained indefinitely
  });
}

// ============================================================================
// AUDIT LOG QUERYING
// ============================================================================

/**
 * Query audit logs with filters
 */
export async function queryAuditLogs(filters: AuditLogFilters) {
  const log = logger.child({ operation: 'queryAuditLogs' });

  try {
    const where: any = {
      organizationId: filters.organizationId,
    };

    if (filters.userId) where.userId = filters.userId;
    if (filters.action) where.action = filters.action;
    if (filters.resource) where.resource = filters.resource;
    if (filters.severity) where.severity = filters.severity;
    if (filters.status) where.status = filters.status;

    if (filters.startDate || filters.endDate) {
      where.occurredAt = {};
      if (filters.startDate) where.occurredAt.gte = filters.startDate;
      if (filters.endDate) where.occurredAt.lte = filters.endDate;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: filters.limit || 100,
        skip: filters.offset || 0,
      }),
      prisma.auditLog.count({ where }),
    ]);

    log.info({ count: logs.length, total }, 'Queried audit logs');

    return {
      logs,
      total,
      limit: filters.limit || 100,
      offset: filters.offset || 0,
      hasMore: (filters.offset || 0) + logs.length < total,
    };
  } catch (error) {
    log.error({ error }, 'Failed to query audit logs');
    throw error;
  }
}

/**
 * Get audit log statistics
 */
export async function getAuditLogStats(organizationId: string): Promise<AuditLogStats> {
  const log = logger.child({ operation: 'getAuditLogStats', organizationId });

  try {
    const [
      totalLogs,
      severityGroups,
      actionGroups,
      statusGroups,
      recentCritical,
      failures,
    ] = await Promise.all([
      // Total logs
      prisma.auditLog.count({ where: { organizationId } }),

      // Group by severity
      prisma.auditLog.groupBy({
        by: ['severity'],
        where: { organizationId },
        _count: true,
      }),

      // Group by action
      prisma.auditLog.groupBy({
        by: ['action'],
        where: { organizationId },
        _count: true,
      }),

      // Group by status
      prisma.auditLog.groupBy({
        by: ['status'],
        where: { organizationId },
        _count: true,
      }),

      // Recent critical events (last 24 hours)
      prisma.auditLog.count({
        where: {
          organizationId,
          severity: 'CRITICAL',
          occurredAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),

      // Total failures
      prisma.auditLog.count({
        where: { organizationId, status: 'FAILURE' },
      }),
    ]);

    const bySeverity: Record<string, number> = {};
    severityGroups.forEach((group) => {
      bySeverity[group.severity] = group._count;
    });

    const byAction: Record<string, number> = {};
    actionGroups.forEach((group) => {
      byAction[group.action] = group._count;
    });

    const byStatus: Record<string, number> = {};
    statusGroups.forEach((group) => {
      byStatus[group.status] = group._count;
    });

    const failureRate = totalLogs > 0 ? failures / totalLogs : 0;

    log.info({ totalLogs, recentCritical, failureRate }, 'Generated audit log stats');

    return {
      totalLogs,
      bySeverity,
      byAction,
      byStatus,
      recentCritical,
      failureRate,
    };
  } catch (error) {
    log.error({ error }, 'Failed to get audit log stats');
    throw error;
  }
}

// ============================================================================
// RETENTION & CLEANUP
// ============================================================================

/**
 * Archive old audit logs
 * Marks logs past retention date as archived
 */
export async function archiveExpiredLogs(): Promise<number> {
  const log = logger.child({ operation: 'archiveExpiredLogs' });

  try {
    const result = await prisma.auditLog.updateMany({
      where: {
        retainUntil: {
          lte: new Date(),
        },
        archived: false,
      },
      data: {
        archived: true,
      },
    });

    log.info({ count: result.count }, 'Archived expired audit logs');

    // Also log this action
    if (result.count > 0) {
      // Get first organization ID for logging (ideally run per org)
      const firstLog = await prisma.auditLog.findFirst({
        where: { archived: true },
        select: { organizationId: true },
      });

      if (firstLog) {
        await createAuditLog({
          organizationId: firstLog.organizationId,
          action: 'AUDIT_LOG_ARCHIVED',
          resource: 'audit_log',
          description: `Archived ${result.count} expired audit logs`,
          metadata: { count: result.count },
          severity: 'LOW',
        });
      }
    }

    return result.count;
  } catch (error) {
    log.error({ error }, 'Failed to archive expired logs');
    throw error;
  }
}

/**
 * Delete archived logs (hard delete for compliance)
 * Only deletes logs marked as archived
 */
export async function deleteArchivedLogs(olderThanDays: number = 730): Promise<number> {
  const log = logger.child({ operation: 'deleteArchivedLogs' });

  try {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const result = await prisma.auditLog.deleteMany({
      where: {
        archived: true,
        occurredAt: {
          lte: cutoffDate,
        },
      },
    });

    log.info({ count: result.count, olderThanDays }, 'Deleted archived audit logs');

    return result.count;
  } catch (error) {
    log.error({ error }, 'Failed to delete archived logs');
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getAuthDescription(action: string, email?: string): string {
  const user = email ? `User ${email}` : 'User';

  switch (action) {
    case 'LOGIN':
      return `${user} logged in`;
    case 'LOGOUT':
      return `${user} logged out`;
    case 'LOGIN_FAILED':
      return `${user} failed to log in`;
    case 'PASSWORD_RESET':
      return `${user} reset password`;
    case 'PASSWORD_CHANGED':
      return `${user} changed password`;
    case 'EMAIL_VERIFIED':
      return `${user} verified email`;
    default:
      return `Auth action: ${action}`;
  }
}

function getCreateAction(resource: string): AuditAction {
  switch (resource.toLowerCase()) {
    case 'user':
      return 'USER_CREATED';
    case 'organization':
      return 'ORGANIZATION_CREATED';
    case 'connection':
      return 'CONNECTION_CREATED';
    case 'campaign':
      return 'CAMPAIGN_CREATED';
    case 'subscription':
      return 'SUBSCRIPTION_CREATED';
    case 'webhook':
      return 'WEBHOOK_CREATED';
    case 'api_key':
      return 'API_KEY_CREATED';
    default:
      return 'USER_CREATED'; // Fallback
  }
}

function getUpdateAction(resource: string): AuditAction {
  switch (resource.toLowerCase()) {
    case 'user':
      return 'USER_UPDATED';
    case 'organization':
      return 'ORGANIZATION_UPDATED';
    case 'connection':
      return 'CONNECTION_UPDATED';
    case 'campaign':
      return 'CAMPAIGN_UPDATED';
    case 'subscription':
      return 'SUBSCRIPTION_UPDATED';
    case 'settings':
      return 'SETTINGS_UPDATED';
    default:
      return 'USER_UPDATED'; // Fallback
  }
}

function getDeleteAction(resource: string): AuditAction {
  switch (resource.toLowerCase()) {
    case 'user':
      return 'USER_DELETED';
    case 'organization':
      return 'ORGANIZATION_DELETED';
    case 'connection':
      return 'CONNECTION_DELETED';
    case 'campaign':
      return 'CAMPAIGN_DELETED';
    case 'webhook':
      return 'WEBHOOK_DELETED';
    case 'api_key':
      return 'API_KEY_DELETED';
    case 'data':
      return 'DATA_DELETED';
    default:
      return 'DATA_DELETED'; // Fallback
  }
}
