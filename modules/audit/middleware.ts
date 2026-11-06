/**
 * Audit Middleware
 * Automatically logs all requests for compliance tracking
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import { createAuditLog } from './service.js';
import type { AuditAction } from '@prisma/client';

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * Audit logging middleware
 * Automatically logs all authenticated requests
 */
export async function auditMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'auditMiddleware' });

  try {
    // Skip audit logging for health checks and webhooks
    if (shouldSkipAuditLog(request.url)) {
      return;
    }

    // Get user and organization from request
    const user = (request as any).user;
    const organizationId = (request as any).organizationId;

    // Only log authenticated requests with organization context
    if (!user || !organizationId) {
      return;
    }

    // Determine action type from request
    const action = getActionFromRequest(request);
    if (!action) {
      return; // Skip if we can't determine action
    }

    // Get resource info from URL
    const { resource, resourceId } = getResourceFromUrl(request.url, request.method);

    // Get IP address (handle proxy headers)
    const ipAddress =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (request.headers['x-real-ip'] as string) ||
      request.ip;

    // Get user agent
    const userAgent = request.headers['user-agent'] || undefined;

    // Log the action (async, non-blocking)
    setImmediate(async () => {
      try {
        await createAuditLog({
          organizationId,
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
          action,
          resource,
          resourceId,
          description: generateDescription(action, resource, resourceId, user.email),
          metadata: {
            method: request.method,
            url: request.url,
            query: request.query,
            // Don't log request body - may contain sensitive data
          },
          ipAddress,
          userAgent,
          severity: getSeverityForAction(action),
          status: 'SUCCESS', // Will be updated if request fails
        });
      } catch (error) {
        log.error({ error }, 'Failed to create audit log');
        // Don't throw - audit failures shouldn't break request
      }
    });

    // Hook into response to log failures
    reply.addHook('onSend', async (_request, _reply, payload) => {
      // If response has error status, log failure
      if (reply.statusCode >= 400) {
        setImmediate(async () => {
          try {
            await createAuditLog({
              organizationId,
              userId: user.id,
              userName: user.name,
              userEmail: user.email,
              action,
              resource,
              resourceId,
              description: `${generateDescription(action, resource, resourceId, user.email)} (failed)`,
              metadata: {
                method: request.method,
                url: request.url,
                statusCode: reply.statusCode,
              },
              ipAddress,
              userAgent,
              severity: 'MEDIUM',
              status: 'FAILURE',
              errorMessage: reply.statusCode >= 500 ? 'Internal server error' : 'Request failed',
            });
          } catch (error) {
            log.error({ error }, 'Failed to create failure audit log');
          }
        });
      }

      return payload;
    });
  } catch (error) {
    log.error({ error }, 'Error in audit middleware');
    // Don't throw - middleware errors shouldn't break request
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Determine if URL should skip audit logging
 */
function shouldSkipAuditLog(url: string): boolean {
  const skipPaths = [
    '/health',
    '/metrics',
    '/api/webhooks/', // Webhooks are logged separately
    '/api/sync/jobs/', // Job status checks are too noisy
  ];

  return skipPaths.some((path) => url.startsWith(path));
}

/**
 * Map HTTP request to audit action
 */
function getActionFromRequest(request: FastifyRequest): AuditAction | null {
  const method = request.method;
  const url = request.url;

  // Authentication actions
  if (url.includes('/auth/login')) return 'LOGIN';
  if (url.includes('/auth/logout')) return 'LOGOUT';
  if (url.includes('/auth/password/reset')) return 'PASSWORD_RESET';
  if (url.includes('/auth/password/change')) return 'PASSWORD_CHANGED';
  if (url.includes('/auth/email/verify')) return 'EMAIL_VERIFIED';

  // User actions
  if (url.includes('/users')) {
    if (method === 'POST') return 'USER_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'USER_UPDATED';
    if (method === 'DELETE') return 'USER_DELETED';
  }

  // Organization actions
  if (url.includes('/organizations')) {
    if (method === 'POST') return 'ORGANIZATION_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'ORGANIZATION_UPDATED';
    if (method === 'DELETE') return 'ORGANIZATION_DELETED';
  }

  // Connection actions
  if (url.includes('/connections')) {
    if (method === 'POST') return 'CONNECTION_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'CONNECTION_UPDATED';
    if (method === 'DELETE') return 'CONNECTION_DELETED';
  }

  // Campaign actions
  if (url.includes('/campaigns')) {
    if (method === 'POST') return 'CAMPAIGN_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'CAMPAIGN_UPDATED';
    if (method === 'DELETE') return 'CAMPAIGN_DELETED';
    if (url.includes('/activate')) return 'CAMPAIGN_ACTIVATED';
    if (url.includes('/pause')) return 'CAMPAIGN_PAUSED';
  }

  // Subscription actions
  if (url.includes('/subscriptions')) {
    if (method === 'POST') return 'SUBSCRIPTION_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'SUBSCRIPTION_UPDATED';
    if (url.includes('/cancel')) return 'SUBSCRIPTION_CANCELLED';
  }

  // Data actions
  if (url.includes('/export')) return 'DATA_EXPORTED';
  if (url.includes('/import')) return 'DATA_IMPORTED';
  if (url.includes('/bulk-delete')) return 'BULK_DELETE';

  // Settings actions
  if (url.includes('/settings')) {
    if (method === 'PATCH' || method === 'PUT') return 'SETTINGS_UPDATED';
  }

  // API key actions
  if (url.includes('/api-keys')) {
    if (method === 'POST') return 'API_KEY_CREATED';
    if (method === 'DELETE') return 'API_KEY_DELETED';
  }

  // Webhook actions
  if (url.includes('/webhooks') && !url.includes('/api/webhooks/')) {
    if (method === 'POST') return 'WEBHOOK_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'WEBHOOK_UPDATED';
    if (method === 'DELETE') return 'WEBHOOK_DELETED';
  }

  // Audit log actions
  if (url.includes('/audit-logs/export')) return 'AUDIT_LOG_EXPORTED';

  // Retention actions
  if (url.includes('/retention/campaigns')) {
    if (method === 'POST') return 'CAMPAIGN_CREATED';
    if (method === 'PATCH' || method === 'PUT') return 'CAMPAIGN_UPDATED';
  }

  // Default for unmatched actions (we log them for visibility)
  return null;
}

/**
 * Extract resource and resource ID from URL
 */
function getResourceFromUrl(
  url: string,
  method: string
): { resource: string; resourceId?: string } {
  // Remove query params
  const path = url.split('?')[0];

  // Extract resource from URL path
  const pathParts = path.split('/').filter(Boolean);

  // Usually format is: /api/{resource}/{id}
  if (pathParts.length >= 2 && pathParts[0] === 'api') {
    const resource = pathParts[1];

    // Check if there's an ID (numeric or CUID)
    let resourceId: string | undefined;
    if (pathParts.length >= 3) {
      const potentialId = pathParts[2];
      // Check if it looks like an ID (not a sub-resource)
      if (
        potentialId.match(/^[0-9a-z_-]+$/i) &&
        !['export', 'import', 'activate', 'pause', 'cancel'].includes(potentialId)
      ) {
        resourceId = potentialId;
      }
    }

    return { resource, resourceId };
  }

  // Fallback
  return { resource: 'unknown' };
}

/**
 * Generate human-readable description
 */
function generateDescription(
  action: AuditAction,
  resource: string,
  resourceId?: string,
  userEmail?: string
): string {
  const user = userEmail ? `User ${userEmail}` : 'User';
  const resourceStr = resourceId ? `${resource} ${resourceId}` : resource;

  // Map actions to descriptions
  const actionMap: Record<string, string> = {
    LOGIN: `${user} logged in`,
    LOGOUT: `${user} logged out`,
    LOGIN_FAILED: `${user} failed to log in`,
    PASSWORD_RESET: `${user} reset password`,
    PASSWORD_CHANGED: `${user} changed password`,
    EMAIL_VERIFIED: `${user} verified email`,

    USER_CREATED: `${user} created ${resourceStr}`,
    USER_UPDATED: `${user} updated ${resourceStr}`,
    USER_DELETED: `${user} deleted ${resourceStr}`,

    ORGANIZATION_CREATED: `${user} created ${resourceStr}`,
    ORGANIZATION_UPDATED: `${user} updated ${resourceStr}`,
    ORGANIZATION_DELETED: `${user} deleted ${resourceStr}`,

    CONNECTION_CREATED: `${user} created ${resourceStr}`,
    CONNECTION_UPDATED: `${user} updated ${resourceStr}`,
    CONNECTION_DELETED: `${user} deleted ${resourceStr}`,

    CAMPAIGN_CREATED: `${user} created ${resourceStr}`,
    CAMPAIGN_UPDATED: `${user} updated ${resourceStr}`,
    CAMPAIGN_DELETED: `${user} deleted ${resourceStr}`,
    CAMPAIGN_ACTIVATED: `${user} activated ${resourceStr}`,
    CAMPAIGN_PAUSED: `${user} paused ${resourceStr}`,

    SUBSCRIPTION_CREATED: `${user} created ${resourceStr}`,
    SUBSCRIPTION_UPDATED: `${user} updated ${resourceStr}`,
    SUBSCRIPTION_CANCELLED: `${user} cancelled ${resourceStr}`,

    DATA_EXPORTED: `${user} exported ${resourceStr} data`,
    DATA_IMPORTED: `${user} imported ${resourceStr} data`,
    BULK_DELETE: `${user} performed bulk delete on ${resourceStr}`,

    SETTINGS_UPDATED: `${user} updated ${resourceStr}`,

    API_KEY_CREATED: `${user} created API key`,
    API_KEY_DELETED: `${user} deleted API key`,

    WEBHOOK_CREATED: `${user} created webhook`,
    WEBHOOK_UPDATED: `${user} updated webhook`,
    WEBHOOK_DELETED: `${user} deleted webhook`,

    AUDIT_LOG_EXPORTED: `${user} exported audit logs`,
  };

  return actionMap[action] || `${user} performed ${action} on ${resourceStr}`;
}

/**
 * Get severity level for action
 */
function getSeverityForAction(action: AuditAction): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' {
  // Critical actions
  if (
    [
      'ORGANIZATION_DELETED',
      'BULK_DELETE',
      'API_KEY_DELETED',
      'UNAUTHORIZED_ACCESS_ATTEMPT',
      'SUSPICIOUS_ACTIVITY_DETECTED',
    ].includes(action)
  ) {
    return 'CRITICAL';
  }

  // High severity actions
  if (
    [
      'USER_DELETED',
      'CONNECTION_DELETED',
      'CAMPAIGN_DELETED',
      'SUBSCRIPTION_CANCELLED',
      'DATA_DELETED',
      'PERMISSION_DENIED',
    ].includes(action)
  ) {
    return 'HIGH';
  }

  // Medium severity actions
  if (
    [
      'LOGIN_FAILED',
      'PASSWORD_RESET',
      'USER_ROLE_CHANGED',
      'DATA_EXPORTED',
      'SETTINGS_UPDATED',
      'API_KEY_CREATED',
    ].includes(action)
  ) {
    return 'MEDIUM';
  }

  // Low severity actions
  if (
    [
      'USER_CREATED',
      'USER_UPDATED',
      'ORGANIZATION_CREATED',
      'ORGANIZATION_UPDATED',
      'CONNECTION_CREATED',
      'CONNECTION_UPDATED',
      'CAMPAIGN_CREATED',
      'CAMPAIGN_UPDATED',
    ].includes(action)
  ) {
    return 'LOW';
  }

  // Everything else is INFO
  return 'INFO';
}
