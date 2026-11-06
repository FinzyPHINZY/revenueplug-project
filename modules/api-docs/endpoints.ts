
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';


const API_ENDPOINTS = {
  authentication: [
    {
      method: 'POST',
      path: '/api/auth/register',
      description: 'Register new user account with email verification',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/auth/login',
      description: 'Login with email and password, returns access + refresh tokens',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/auth/refresh',
      description: 'Refresh access token using refresh token',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/auth/logout',
      description: 'Invalidate refresh token and logout',
      auth: true,
    },
    {
      method: 'POST',
      path: '/api/auth/forgot-password',
      description: 'Send password reset email',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/auth/reset-password',
      description: 'Reset password with token from email',
      auth: false,
    },
    {
      method: 'GET',
      path: '/api/auth/verify-email/:token',
      description: 'Verify email address with token',
      auth: false,
    },
  ],

  users: [
    {
      method: 'GET',
      path: '/api/users/me',
      description: 'Get current authenticated user profile',
      auth: true,
    },
    {
      method: 'PATCH',
      path: '/api/users/me',
      description: 'Update user profile (name, email, preferences)',
      auth: true,
    },
    {
      method: 'DELETE',
      path: '/api/users/me',
      description: 'Delete user account',
      auth: true,
    },
  ],

  organizations: [
    {
      method: 'POST',
      path: '/api/organizations',
      description: 'Create new organization',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/organizations/:id',
      description: 'Get organization details',
      auth: true,
    },
    {
      method: 'PATCH',
      path: '/api/organizations/:id',
      description: 'Update organization settings',
      auth: true,
    },
    {
      method: 'DELETE',
      path: '/api/organizations/:id',
      description: 'Delete organization',
      auth: true,
    },
    {
      method: 'POST',
      path: '/api/organizations/:id/members',
      description: 'Invite team member',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/organizations/:id/members',
      description: 'List organization members',
      auth: true,
    },
  ],

  api_keys: [
    {
      method: 'POST',
      path: '/api/api-keys',
      description: 'Create new API key for programmatic access',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/api-keys',
      description: 'List all API keys for organization',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/api-keys/scopes',
      description: 'List available API scopes',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/api-keys/:key_id',
      description: 'Get single API key details',
      auth: true,
    },
    {
      method: 'DELETE',
      path: '/api/api-keys/:key_id',
      description: 'Revoke API key',
      auth: true,
    },
  ],

  connections: [
    {
      method: 'POST',
      path: '/api/connections/stripe/oauth',
      description: 'Initiate Stripe OAuth flow',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/connections/stripe/callback',
      description: 'Handle OAuth callback and exchange code for tokens',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/connections',
      description: 'List all connected platforms for organization',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/connections/:id',
      description: 'Get connection details and status',
      auth: true,
    },
    {
      method: 'DELETE',
      path: '/api/connections/:id',
      description: 'Disconnect platform and delete connection',
      auth: true,
    },
  ],

  sync: [
    {
      method: 'POST',
      path: '/api/sync/trigger',
      description: 'Trigger background data sync for a connection',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/sync/jobs/:job_id',
      description: 'Get sync job progress and status',
      auth: true,
    },
    {
      method: 'DELETE',
      path: '/api/sync/jobs/:job_id',
      description: 'Cancel running sync job',
      auth: true,
    },
  ],

  analytics: [
    {
      method: 'GET',
      path: '/api/dashboard/failed-payments',
      description: 'Get failed payments with filters',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/dashboard/summary',
      description: 'Get dashboard summary metrics',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/dashboard/forecast',
      description: 'Get revenue forecast (30/90/365-day horizons)',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/dashboard/forecast/recovery-impact',
      description: 'Get recovery campaign impact projections',
      auth: true,
    },
  ],

  retention: [
    {
      method: 'POST',
      path: '/api/retention/campaigns',
      description: 'Create new retention campaign',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/retention/campaigns',
      description: 'List all campaigns',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/retention/campaigns/:id',
      description: 'Get campaign details',
      auth: true,
    },
    {
      method: 'PATCH',
      path: '/api/retention/campaigns/:id',
      description: 'Update campaign',
      auth: true,
    },
    {
      method: 'DELETE',
      path: '/api/retention/campaigns/:id',
      description: 'Delete campaign',
      auth: true,
    },
  ],

  settings: [
    {
      method: 'GET',
      path: '/api/settings',
      description: 'Get organization settings',
      auth: true,
    },
    {
      method: 'PATCH',
      path: '/api/settings',
      description: 'Update organization settings',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/settings/notifications',
      description: 'Get user notification preferences',
      auth: true,
    },
    {
      method: 'PATCH',
      path: '/api/settings/notifications',
      description: 'Update user notification preferences',
      auth: true,
    },
    {
      method: 'POST',
      path: '/api/settings/webhooks',
      description: 'Create outgoing webhook',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/settings/webhooks',
      description: 'List outgoing webhooks',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/settings/webhooks/events',
      description: 'List available webhook event types',
      auth: true,
    },
  ],

  audit_logs: [
    {
      method: 'GET',
      path: '/api/audit-logs',
      description: 'Query audit logs with filters',
      auth: true,
    },
    {
      method: 'GET',
      path: '/api/audit-logs/stats',
      description: 'Get aggregate audit statistics',
      auth: true,
    },
    {
      method: 'POST',
      path: '/api/audit-logs/export',
      description: 'Export audit logs to CSV or JSON',
      auth: true,
    },
    {
      method: 'POST',
      path: '/api/audit-logs/archive',
      description: 'Manually trigger archival of expired logs (admin only)',
      auth: true,
    },
  ],

  webhooks: [
    {
      method: 'POST',
      path: '/api/webhooks/stripe',
      description: 'Receive Stripe webhook events (customer platforms)',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/webhooks/revenueplug-billing',
      description: 'Receive Stripe webhook events (our billing)',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/webhooks/mixpanel',
      description: 'Receive Mixpanel behavioral events',
      auth: false,
    },
    {
      method: 'POST',
      path: '/api/webhooks/hubspot',
      description: 'Receive HubSpot CRM updates',
      auth: false,
    },
  ],

  system: [
    {
      method: 'GET',
      path: '/api/endpoints',
      description: 'List all available API endpoints (this endpoint)',
      auth: false,
    },
    {
      method: 'GET',
      path: '/api/docs',
      description: 'Interactive Swagger/OpenAPI documentation',
      auth: false,
    },
    {
      method: 'GET',
      path: '/health',
      description: 'Overall health check with infrastructure status',
      auth: false,
    },
    {
      method: 'GET',
      path: '/health/liveness',
      description: 'Kubernetes liveness probe',
      auth: false,
    },
    {
      method: 'GET',
      path: '/health/readiness',
      description: 'Kubernetes readiness probe with dependency checks',
      auth: false,
    },
  ],
};

/**
 * GET /api/endpoints
 * Returns JSON with all available endpoints
 */
async function handleGetEndpoints(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const totalEndpoints = Object.values(API_ENDPOINTS).reduce(
    (sum, category) => sum + category.length,
    0
  );

  return reply.code(200).send({
    version: '1.0.0',
    total_endpoints: totalEndpoints,
    categories: Object.keys(API_ENDPOINTS),
    endpoints: API_ENDPOINTS,
    documentation: {
      swagger: '/api/docs',
      openapi_spec: '/api/docs/json',
    },
  });
}


export async function registerEndpointsSummary(app: FastifyInstance): Promise<void> {
  app.get('/api/endpoints', handleGetEndpoints);

  logger.info('Registered endpoints summary route');
}
