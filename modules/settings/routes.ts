/**
 * Settings API Routes
 * Endpoints for organization settings, user preferences, webhooks, and feature flags
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger/index.js';
import { requireAuth } from '../auth/middleware.js';
import { requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import {
  getOrganizationSettings,
  updateOrganizationSettings,
  getUserNotificationPreference,
  updateUserNotificationPreference,
  createOutgoingWebhook,
  listOutgoingWebhooks,
  getOutgoingWebhook,
  updateOutgoingWebhook,
  deleteOutgoingWebhook,
  createFeatureFlag,
  listFeatureFlags,
  getFeatureFlag,
  updateFeatureFlag,
  deleteFeatureFlag,
  isFeatureEnabled,
  getEnabledFeatures,
} from './service.js';

// ============================================================================
// REQUEST SCHEMAS
// ============================================================================

const UpdateOrganizationSettingsSchema = z.object({
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(), // ISO 4217
  dateFormat: z.string().optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  fromName: z.string().optional(),
  fromEmail: z.string().email().optional(),
  replyTo: z.string().email().optional(),
  emailFooter: z.string().optional(),
  defaultCampaignCooldown: z.number().min(1).optional(),
  maxEmailsPerDay: z.number().min(1).optional(),
  minDaysBetweenEmails: z.number().min(0).optional(),
  notifyHighRiskChurn: z.boolean().optional(),
  notifyPaymentFailures: z.boolean().optional(),
  notifyCampaignConversions: z.boolean().optional(),
  notifyLowHealthScore: z.boolean().optional(),
  enableABTesting: z.boolean().optional(),
  enablePredictiveAnalytics: z.boolean().optional(),
  enableBehavioralTracking: z.boolean().optional(),
  gdprMode: z.boolean().optional(),
  dataRetentionDays: z.number().min(30).optional(),
});

const UpdateNotificationPreferenceSchema = z.object({
  emailDigest: z.enum(['REALTIME', 'HOURLY', 'DAILY', 'WEEKLY', 'NEVER']).optional(),
  emailOnHighRisk: z.boolean().optional(),
  emailOnPaymentFailed: z.boolean().optional(),
  emailOnCampaignConverted: z.boolean().optional(),
  emailOnTrialEnding: z.boolean().optional(),
  emailOnMilestones: z.boolean().optional(),
  inAppOnHighRisk: z.boolean().optional(),
  inAppOnPaymentFailed: z.boolean().optional(),
  inAppOnCampaignConverted: z.boolean().optional(),
  slackWebhookUrl: z.string().url().nullable().optional(),
  slackOnHighRisk: z.boolean().optional(),
  slackOnCampaignConverted: z.boolean().optional(),
});

const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.string()).min(1),
  headers: z.record(z.string()).optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  retryDelay: z.number().min(1).max(3600).optional(),
});

const UpdateWebhookSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  secret: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  events: z.array(z.string()).min(1).optional(),
  headers: z.record(z.string()).nullable().optional(),
  maxRetries: z.number().min(0).max(10).optional(),
  retryDelay: z.number().min(1).max(3600).optional(),
});

const WebhookParamsSchema = z.object({
  webhook_id: z.string(),
});

const CreateFeatureFlagSchema = z.object({
  key: z.string().regex(/^[a-z_]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  rolloutPercentage: z.number().min(0).max(100).optional(),
  rolloutStrategy: z
    .enum(['DISABLED', 'ENABLED', 'PERCENTAGE_ROLLOUT', 'WHITELIST', 'BLACKLIST'])
    .optional(),
});

const UpdateFeatureFlagSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  rolloutPercentage: z.number().min(0).max(100).optional(),
  rolloutStrategy: z
    .enum(['DISABLED', 'ENABLED', 'PERCENTAGE_ROLLOUT', 'WHITELIST', 'BLACKLIST'])
    .optional(),
  enabledOrganizations: z.array(z.string()).optional(),
  disabledOrganizations: z.array(z.string()).optional(),
});

const FeatureFlagParamsSchema = z.object({
  key: z.string(),
});

// ============================================================================
// ORGANIZATION SETTINGS
// ============================================================================

/**
 * GET /api/settings
 * Get organization settings
 */
async function handleGetOrganizationSettings(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetOrganizationSettings' });

  try {
    const organizationId = (request as any).organizationId;

    const settings = await getOrganizationSettings(organizationId);

    log.info({ organizationId }, 'Retrieved organization settings');

    return reply.code(200).send(settings);
  } catch (error) {
    log.error({ error }, 'Failed to get organization settings');
    return reply.code(500).send({
      error: 'Failed to get settings',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PATCH /api/settings
 * Update organization settings
 */
async function handleUpdateOrganizationSettings(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateOrganizationSettings' });

  try {
    const organizationId = (request as any).organizationId;
    const updates = UpdateOrganizationSettingsSchema.parse(request.body);

    const settings = await updateOrganizationSettings(organizationId, updates);

    log.info({ organizationId, updates }, 'Updated organization settings');

    return reply.code(200).send(settings);
  } catch (error) {
    log.error({ error }, 'Failed to update organization settings');
    return reply.code(500).send({
      error: 'Failed to update settings',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// USER NOTIFICATION PREFERENCES
// ============================================================================

/**
 * GET /api/settings/notifications
 * Get user notification preferences
 */
async function handleGetNotificationPreference(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetNotificationPreference' });

  try {
    const userId = (request as any).user.id;

    const preference = await getUserNotificationPreference(userId);

    log.info({ userId }, 'Retrieved user notification preferences');

    return reply.code(200).send(preference);
  } catch (error) {
    log.error({ error }, 'Failed to get notification preferences');
    return reply.code(500).send({
      error: 'Failed to get preferences',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PATCH /api/settings/notifications
 * Update user notification preferences
 */
async function handleUpdateNotificationPreference(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateNotificationPreference' });

  try {
    const userId = (request as any).user.id;
    const updates = UpdateNotificationPreferenceSchema.parse(request.body);

    const preference = await updateUserNotificationPreference(userId, updates);

    log.info({ userId, updates }, 'Updated user notification preferences');

    return reply.code(200).send(preference);
  } catch (error) {
    log.error({ error }, 'Failed to update notification preferences');
    return reply.code(500).send({
      error: 'Failed to update preferences',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// OUTGOING WEBHOOKS
// ============================================================================

/**
 * POST /api/settings/webhooks
 * Create outgoing webhook
 */
async function handleCreateWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreateWebhook' });

  try {
    const organizationId = (request as any).organizationId;
    const body = CreateWebhookSchema.parse(request.body);

    const webhook = await createOutgoingWebhook({
      organizationId,
      ...body,
    });

    log.info({ webhookId: webhook.id, name: webhook.name }, 'Created outgoing webhook');

    return reply.code(201).send(webhook);
  } catch (error) {
    log.error({ error }, 'Failed to create webhook');
    return reply.code(500).send({
      error: 'Failed to create webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/webhooks
 * List outgoing webhooks
 */
async function handleListWebhooks(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleListWebhooks' });

  try {
    const organizationId = (request as any).organizationId;

    const webhooks = await listOutgoingWebhooks(organizationId);

    log.info({ organizationId, count: webhooks.length }, 'Listed outgoing webhooks');

    return reply.code(200).send({ webhooks });
  } catch (error) {
    log.error({ error }, 'Failed to list webhooks');
    return reply.code(500).send({
      error: 'Failed to list webhooks',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/webhooks/:webhook_id
 * Get single outgoing webhook
 */
async function handleGetWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetWebhook' });

  try {
    const organizationId = (request as any).organizationId;
    const { webhook_id } = WebhookParamsSchema.parse(request.params);

    const webhook = await getOutgoingWebhook(webhook_id, organizationId);

    if (!webhook) {
      return reply.code(404).send({
        error: 'Webhook not found',
      });
    }

    log.info({ webhookId: webhook_id }, 'Retrieved outgoing webhook');

    return reply.code(200).send(webhook);
  } catch (error) {
    log.error({ error }, 'Failed to get webhook');
    return reply.code(500).send({
      error: 'Failed to get webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PATCH /api/settings/webhooks/:webhook_id
 * Update outgoing webhook
 */
async function handleUpdateWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateWebhook' });

  try {
    const organizationId = (request as any).organizationId;
    const { webhook_id } = WebhookParamsSchema.parse(request.params);
    const updates = UpdateWebhookSchema.parse(request.body);

    await updateOutgoingWebhook(webhook_id, organizationId, updates);

    log.info({ webhookId: webhook_id, updates }, 'Updated outgoing webhook');

    return reply.code(200).send({
      message: 'Webhook updated successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to update webhook');
    return reply.code(500).send({
      error: 'Failed to update webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * DELETE /api/settings/webhooks/:webhook_id
 * Delete outgoing webhook
 */
async function handleDeleteWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDeleteWebhook' });

  try {
    const organizationId = (request as any).organizationId;
    const { webhook_id } = WebhookParamsSchema.parse(request.params);

    await deleteOutgoingWebhook(webhook_id, organizationId);

    log.info({ webhookId: webhook_id }, 'Deleted outgoing webhook');

    return reply.code(200).send({
      message: 'Webhook deleted successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to delete webhook');
    return reply.code(500).send({
      error: 'Failed to delete webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/webhooks/events
 * List available webhook event types
 */
async function handleListWebhookEvents(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const events = [
    {
      type: 'churn.risk_high',
      description: 'Customer churn risk is HIGH',
      payload_example: {
        customer_id: 'cus_123',
        email: 'user@example.com',
        risk_level: 'HIGH',
        probability: 0.75,
      },
    },
    {
      type: 'churn.risk_critical',
      description: 'Customer churn risk is CRITICAL',
      payload_example: {
        customer_id: 'cus_123',
        email: 'user@example.com',
        risk_level: 'CRITICAL',
        probability: 0.92,
      },
    },
    {
      type: 'payment.failed',
      description: 'Payment attempt failed',
      payload_example: {
        customer_id: 'cus_123',
        invoice_id: 'inv_123',
        amount: 4900,
        currency: 'usd',
        attempt_count: 2,
      },
    },
    {
      type: 'payment.recovered',
      description: 'Failed payment recovered',
      payload_example: {
        customer_id: 'cus_123',
        invoice_id: 'inv_123',
        amount: 4900,
        currency: 'usd',
      },
    },
    {
      type: 'campaign.triggered',
      description: 'Retention campaign triggered',
      payload_example: {
        campaign_id: 'camp_123',
        customer_id: 'cus_123',
        trigger_type: 'CHURN_RISK_HIGH',
      },
    },
    {
      type: 'campaign.converted',
      description: 'Campaign resulted in conversion',
      payload_example: {
        campaign_id: 'camp_123',
        customer_id: 'cus_123',
        recovered_revenue: 4900,
      },
    },
    {
      type: 'trial.ending',
      description: 'Customer trial ending soon',
      payload_example: {
        customer_id: 'cus_123',
        subscription_id: 'sub_123',
        trial_end_date: '2024-12-31T23:59:59Z',
        days_remaining: 3,
      },
    },
    {
      type: 'trial.converted',
      description: 'Trial converted to paid',
      payload_example: {
        customer_id: 'cus_123',
        subscription_id: 'sub_123',
        amount: 4900,
        currency: 'usd',
      },
    },
  ];

  return reply.code(200).send({ events });
}

// ============================================================================
// FEATURE FLAGS (Admin Only)
// ============================================================================

/**
 * POST /api/settings/feature-flags
 * Create feature flag
 */
async function handleCreateFeatureFlag(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreateFeatureFlag' });

  try {
    const user = (request as any).user;

    // Only admins can create feature flags
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Only admins can create feature flags',
      });
    }

    const body = CreateFeatureFlagSchema.parse(request.body);

    const flag = await createFeatureFlag(body);

    log.info({ flagKey: flag.key }, 'Created feature flag');

    return reply.code(201).send(flag);
  } catch (error) {
    log.error({ error }, 'Failed to create feature flag');
    return reply.code(500).send({
      error: 'Failed to create feature flag',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/feature-flags
 * List feature flags
 */
async function handleListFeatureFlags(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleListFeatureFlags' });

  try {
    const flags = await listFeatureFlags();

    log.info({ count: flags.length }, 'Listed feature flags');

    return reply.code(200).send({ flags });
  } catch (error) {
    log.error({ error }, 'Failed to list feature flags');
    return reply.code(500).send({
      error: 'Failed to list feature flags',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/feature-flags/:key
 * Get single feature flag
 */
async function handleGetFeatureFlag(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetFeatureFlag' });

  try {
    const { key } = FeatureFlagParamsSchema.parse(request.params);

    const flag = await getFeatureFlag(key);

    if (!flag) {
      return reply.code(404).send({
        error: 'Feature flag not found',
      });
    }

    log.info({ flagKey: key }, 'Retrieved feature flag');

    return reply.code(200).send(flag);
  } catch (error) {
    log.error({ error }, 'Failed to get feature flag');
    return reply.code(500).send({
      error: 'Failed to get feature flag',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PATCH /api/settings/feature-flags/:key
 * Update feature flag
 */
async function handleUpdateFeatureFlag(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateFeatureFlag' });

  try {
    const user = (request as any).user;

    // Only admins can update feature flags
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Only admins can update feature flags',
      });
    }

    const { key } = FeatureFlagParamsSchema.parse(request.params);
    const updates = UpdateFeatureFlagSchema.parse(request.body);

    const flag = await updateFeatureFlag(key, updates);

    log.info({ flagKey: key, updates }, 'Updated feature flag');

    return reply.code(200).send(flag);
  } catch (error) {
    log.error({ error }, 'Failed to update feature flag');
    return reply.code(500).send({
      error: 'Failed to update feature flag',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * DELETE /api/settings/feature-flags/:key
 * Delete feature flag
 */
async function handleDeleteFeatureFlag(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDeleteFeatureFlag' });

  try {
    const user = (request as any).user;

    // Only admins can delete feature flags
    if (user.role !== 'ADMIN') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Only admins can delete feature flags',
      });
    }

    const { key } = FeatureFlagParamsSchema.parse(request.params);

    await deleteFeatureFlag(key);

    log.info({ flagKey: key }, 'Deleted feature flag');

    return reply.code(200).send({
      message: 'Feature flag deleted successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to delete feature flag');
    return reply.code(500).send({
      error: 'Failed to delete feature flag',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/features
 * Get enabled features for current organization
 */
async function handleGetEnabledFeatures(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetEnabledFeatures' });

  try {
    const organizationId = (request as any).organizationId;

    const features = await getEnabledFeatures(organizationId);

    log.info({ organizationId, features }, 'Retrieved enabled features');

    return reply.code(200).send({ features });
  } catch (error) {
    log.error({ error }, 'Failed to get enabled features');
    return reply.code(500).send({
      error: 'Failed to get features',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/settings/features/:key
 * Check if specific feature is enabled
 */
async function handleCheckFeature(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCheckFeature' });

  try {
    const organizationId = (request as any).organizationId;
    const { key } = FeatureFlagParamsSchema.parse(request.params);

    const enabled = await isFeatureEnabled(key, organizationId);

    log.info({ organizationId, flagKey: key, enabled }, 'Checked feature flag');

    return reply.code(200).send({ enabled });
  } catch (error) {
    log.error({ error }, 'Failed to check feature');
    return reply.code(500).send({
      error: 'Failed to check feature',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = [requireAuth, requireOrganizationContext];

  // Organization settings
  app.get('/api/settings', { preHandler }, handleGetOrganizationSettings);
  app.patch('/api/settings', { preHandler }, handleUpdateOrganizationSettings);

  // User notification preferences
  app.get('/api/settings/notifications', { preHandler: [requireAuth] }, handleGetNotificationPreference);
  app.patch('/api/settings/notifications', { preHandler: [requireAuth] }, handleUpdateNotificationPreference);

  // Outgoing webhooks
  app.post('/api/settings/webhooks', { preHandler }, handleCreateWebhook);
  app.get('/api/settings/webhooks', { preHandler }, handleListWebhooks);
  app.get('/api/settings/webhooks/events', { preHandler: [requireAuth] }, handleListWebhookEvents);
  app.get('/api/settings/webhooks/:webhook_id', { preHandler }, handleGetWebhook);
  app.patch('/api/settings/webhooks/:webhook_id', { preHandler }, handleUpdateWebhook);
  app.delete('/api/settings/webhooks/:webhook_id', { preHandler }, handleDeleteWebhook);

  // Feature flags
  app.post('/api/settings/feature-flags', { preHandler: [requireAuth] }, handleCreateFeatureFlag);
  app.get('/api/settings/feature-flags', { preHandler: [requireAuth] }, handleListFeatureFlags);
  app.get('/api/settings/feature-flags/:key', { preHandler: [requireAuth] }, handleGetFeatureFlag);
  app.patch('/api/settings/feature-flags/:key', { preHandler: [requireAuth] }, handleUpdateFeatureFlag);
  app.delete('/api/settings/feature-flags/:key', { preHandler: [requireAuth] }, handleDeleteFeatureFlag);

  // Enabled features (for current organization)
  app.get('/api/settings/features', { preHandler }, handleGetEnabledFeatures);
  app.get('/api/settings/features/:key', { preHandler }, handleCheckFeature);

  logger.info('Registered settings routes');
}
