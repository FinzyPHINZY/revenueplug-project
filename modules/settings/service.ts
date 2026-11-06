/**
 * Settings Service
 * Manages organization settings, user notification preferences, outgoing webhooks, and feature flags
 */

import type {
  EmailDigestFrequency,
  FeatureFlagStrategy,
  OutgoingWebhookStatus,
} from '@prisma/client';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { randomUUID } from 'node:crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface OrganizationSettingsUpdate {
  // Regional settings
  timezone?: string;
  currency?: string;
  dateFormat?: string;
  timeFormat?: string;

  // Email settings
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  emailFooter?: string;

  // Retention campaign defaults
  defaultCampaignCooldown?: number;
  maxEmailsPerDay?: number;
  minDaysBetweenEmails?: number;

  // Notification settings
  notifyHighRiskChurn?: boolean;
  notifyPaymentFailures?: boolean;
  notifyCampaignConversions?: boolean;
  notifyLowHealthScore?: boolean;

  // Feature preferences
  enableABTesting?: boolean;
  enablePredictiveAnalytics?: boolean;
  enableBehavioralTracking?: boolean;

  // Privacy & compliance
  gdprMode?: boolean;
  dataRetentionDays?: number;
}

export interface UserNotificationPreferenceUpdate {
  // Email notifications
  emailDigest?: EmailDigestFrequency;
  emailOnHighRisk?: boolean;
  emailOnPaymentFailed?: boolean;
  emailOnCampaignConverted?: boolean;
  emailOnTrialEnding?: boolean;
  emailOnMilestones?: boolean;

  // In-app notifications
  inAppOnHighRisk?: boolean;
  inAppOnPaymentFailed?: boolean;
  inAppOnCampaignConverted?: boolean;

  // Slack notifications
  slackWebhookUrl?: string | null;
  slackOnHighRisk?: boolean;
  slackOnCampaignConverted?: boolean;
}

export interface OutgoingWebhookCreate {
  organizationId: string;
  name: string;
  url: string;
  secret?: string;
  events: string[]; // Array of event types
  headers?: Record<string, string>;
  maxRetries?: number;
  retryDelay?: number;
}

export interface OutgoingWebhookUpdate {
  name?: string;
  url?: string;
  secret?: string | null;
  enabled?: boolean;
  events?: string[];
  headers?: Record<string, string> | null;
  maxRetries?: number;
  retryDelay?: number;
}

export interface FeatureFlagCreate {
  key: string;
  name: string;
  description?: string;
  enabled?: boolean;
  rolloutPercentage?: number;
  rolloutStrategy?: FeatureFlagStrategy;
}

export interface FeatureFlagUpdate {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  rolloutPercentage?: number;
  rolloutStrategy?: FeatureFlagStrategy;
  enabledOrganizations?: string[];
  disabledOrganizations?: string[];
}

// ============================================================================
// ORGANIZATION SETTINGS
// ============================================================================

/**
 * Get organization settings (creates default if doesn't exist)
 */
export async function getOrganizationSettings(organizationId: string) {
  const log = logger.child({
    operation: 'getOrganizationSettings',
    organizationId,
  });

  try {
    let settings = await prisma.organizationSettings.findUnique({
      where: { organizationId },
    });

    // Create default settings if doesn't exist
    if (!settings) {
      settings = await prisma.organizationSettings.create({
        data: {
          organizationId,
        },
      });
      log.info('Created default organization settings');
    }

    return settings;
  } catch (error) {
    log.error({ error }, 'Failed to get organization settings');
    throw error;
  }
}

/**
 * Update organization settings
 */
export async function updateOrganizationSettings(
  organizationId: string,
  updates: OrganizationSettingsUpdate
) {
  const log = logger.child({
    operation: 'updateOrganizationSettings',
    organizationId,
  });

  try {
    // Ensure settings exist
    await getOrganizationSettings(organizationId);

    const settings = await prisma.organizationSettings.update({
      where: { organizationId },
      data: updates,
    });

    log.info({ updates }, 'Updated organization settings');

    return settings;
  } catch (error) {
    log.error({ error }, 'Failed to update organization settings');
    throw error;
  }
}

// ============================================================================
// USER NOTIFICATION PREFERENCES
// ============================================================================

/**
 * Get user notification preferences (creates default if doesn't exist)
 */
export async function getUserNotificationPreference(userId: string) {
  const log = logger.child({
    operation: 'getUserNotificationPreference',
    userId,
  });

  try {
    let preference = await prisma.userNotificationPreference.findUnique({
      where: { userId },
    });

    // Create default preferences if doesn't exist
    if (!preference) {
      preference = await prisma.userNotificationPreference.create({
        data: {
          userId,
        },
      });
      log.info('Created default user notification preferences');
    }

    return preference;
  } catch (error) {
    log.error({ error }, 'Failed to get user notification preferences');
    throw error;
  }
}

/**
 * Update user notification preferences
 */
export async function updateUserNotificationPreference(
  userId: string,
  updates: UserNotificationPreferenceUpdate
) {
  const log = logger.child({
    operation: 'updateUserNotificationPreference',
    userId,
  });

  try {
    // Ensure preferences exist
    await getUserNotificationPreference(userId);

    const preference = await prisma.userNotificationPreference.update({
      where: { userId },
      data: updates,
    });

    log.info({ updates }, 'Updated user notification preferences');

    return preference;
  } catch (error) {
    log.error({ error }, 'Failed to update user notification preferences');
    throw error;
  }
}

// ============================================================================
// OUTGOING WEBHOOKS
// ============================================================================

/**
 * Create outgoing webhook
 */
export async function createOutgoingWebhook(params: OutgoingWebhookCreate) {
  const log = logger.child({
    operation: 'createOutgoingWebhook',
    organizationId: params.organizationId,
  });

  try {
    // Validate URL
    new URL(params.url); // Throws if invalid

    const webhook = await prisma.outgoingWebhook.create({
      data: {
        id: randomUUID(),
        organizationId: params.organizationId,
        name: params.name,
        url: params.url,
        secret: params.secret || null,
        events: params.events as any,
        headers: params.headers as any || null,
        maxRetries: params.maxRetries || 3,
        retryDelay: params.retryDelay || 60,
        enabled: true,
      },
    });

    log.info({ webhookId: webhook.id, name: webhook.name }, 'Created outgoing webhook');

    return webhook;
  } catch (error) {
    log.error({ error }, 'Failed to create outgoing webhook');
    throw error;
  }
}

/**
 * List outgoing webhooks for organization
 */
export async function listOutgoingWebhooks(organizationId: string) {
  const webhooks = await prisma.outgoingWebhook.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });

  return webhooks;
}

/**
 * Get single outgoing webhook
 */
export async function getOutgoingWebhook(webhookId: string, organizationId: string) {
  const webhook = await prisma.outgoingWebhook.findFirst({
    where: {
      id: webhookId,
      organizationId,
    },
    include: {
      deliveries: {
        orderBy: { createdAt: 'desc' },
        take: 20, // Last 20 deliveries
      },
    },
  });

  return webhook;
}

/**
 * Update outgoing webhook
 */
export async function updateOutgoingWebhook(
  webhookId: string,
  organizationId: string,
  updates: OutgoingWebhookUpdate
) {
  const log = logger.child({
    operation: 'updateOutgoingWebhook',
    webhookId,
  });

  try {
    // Validate URL if provided
    if (updates.url) {
      new URL(updates.url);
    }

    const webhook = await prisma.outgoingWebhook.updateMany({
      where: {
        id: webhookId,
        organizationId,
      },
      data: {
        name: updates.name,
        url: updates.url,
        secret: updates.secret !== undefined ? updates.secret : undefined,
        enabled: updates.enabled,
        events: updates.events as any,
        headers: updates.headers !== undefined ? (updates.headers as any) : undefined,
        maxRetries: updates.maxRetries,
        retryDelay: updates.retryDelay,
      },
    });

    if (webhook.count === 0) {
      throw new Error('Webhook not found or unauthorized');
    }

    log.info({ updates }, 'Updated outgoing webhook');

    return webhook;
  } catch (error) {
    log.error({ error }, 'Failed to update outgoing webhook');
    throw error;
  }
}

/**
 * Delete outgoing webhook
 */
export async function deleteOutgoingWebhook(webhookId: string, organizationId: string) {
  const log = logger.child({
    operation: 'deleteOutgoingWebhook',
    webhookId,
  });

  try {
    await prisma.outgoingWebhook.deleteMany({
      where: {
        id: webhookId,
        organizationId,
      },
    });

    log.info('Deleted outgoing webhook');
  } catch (error) {
    log.error({ error }, 'Failed to delete outgoing webhook');
    throw error;
  }
}

/**
 * Record webhook delivery attempt
 */
export async function recordWebhookDelivery(params: {
  webhookId: string;
  eventType: string;
  payload: Record<string, any>;
  status: OutgoingWebhookStatus;
  statusCode?: number;
  responseBody?: string;
  errorMessage?: string;
  attemptNumber?: number;
}) {
  const log = logger.child({
    operation: 'recordWebhookDelivery',
    webhookId: params.webhookId,
  });

  try {
    const delivery = await prisma.outgoingWebhookDelivery.create({
      data: {
        id: randomUUID(),
        webhookId: params.webhookId,
        eventType: params.eventType,
        payload: params.payload as any,
        status: params.status,
        statusCode: params.statusCode || null,
        responseBody: params.responseBody || null,
        errorMessage: params.errorMessage || null,
        attemptNumber: params.attemptNumber || 1,
        deliveredAt: params.status === 'DELIVERED' ? new Date() : null,
      },
    });

    // Update webhook delivery tracking
    if (params.status === 'DELIVERED') {
      await prisma.outgoingWebhook.update({
        where: { id: params.webhookId },
        data: {
          lastDeliveryAt: new Date(),
          failureCount: 0, // Reset failure count on success
        },
      });
    } else if (params.status === 'FAILED') {
      await prisma.outgoingWebhook.update({
        where: { id: params.webhookId },
        data: {
          lastFailureAt: new Date(),
          failureCount: { increment: 1 },
        },
      });

      // Auto-disable after 10 consecutive failures
      const webhook = await prisma.outgoingWebhook.findUnique({
        where: { id: params.webhookId },
      });

      if (webhook && webhook.failureCount >= 10) {
        await prisma.outgoingWebhook.update({
          where: { id: params.webhookId },
          data: {
            enabled: false,
            disabledAt: new Date(),
          },
        });

        log.warn(
          { failureCount: webhook.failureCount },
          'Auto-disabled webhook due to consecutive failures'
        );
      }
    }

    return delivery;
  } catch (error) {
    log.error({ error }, 'Failed to record webhook delivery');
    throw error;
  }
}

/**
 * Send webhook to external URL
 */
export async function sendOutgoingWebhook(
  webhookId: string,
  eventType: string,
  payload: Record<string, any>
): Promise<void> {
  const log = logger.child({
    operation: 'sendOutgoingWebhook',
    webhookId,
    eventType,
  });

  try {
    const webhook = await prisma.outgoingWebhook.findUnique({
      where: { id: webhookId },
    });

    if (!webhook || !webhook.enabled) {
      log.debug('Webhook not found or disabled, skipping');
      return;
    }

    // Check if event type is in webhook's event filter
    const events = webhook.events as string[];
    if (!events.includes(eventType)) {
      log.debug({ eventType, webhookEvents: events }, 'Event type not subscribed, skipping');
      return;
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'RevenuePlug-Webhook/1.0',
      'X-Event-Type': eventType,
      ...(webhook.headers as Record<string, string> || {}),
    };

    // Add HMAC signature if secret is set
    if (webhook.secret) {
      const crypto = await import('node:crypto');
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-Webhook-Signature'] = signature;
    }

    // Send request
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    const responseBody = await response.text();

    if (response.ok) {
      await recordWebhookDelivery({
        webhookId,
        eventType,
        payload,
        status: 'DELIVERED',
        statusCode: response.status,
        responseBody: responseBody.slice(0, 1000), // Limit response body size
      });

      log.info({ status: response.status }, 'Webhook delivered successfully');
    } else {
      await recordWebhookDelivery({
        webhookId,
        eventType,
        payload,
        status: 'FAILED',
        statusCode: response.status,
        responseBody: responseBody.slice(0, 1000),
        errorMessage: `HTTP ${response.status}: ${response.statusText}`,
      });

      log.warn({ status: response.status }, 'Webhook delivery failed');
    }
  } catch (error) {
    await recordWebhookDelivery({
      webhookId,
      eventType,
      payload,
      status: 'FAILED',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });

    log.error({ error }, 'Failed to send webhook');
  }
}

/**
 * Broadcast event to all subscribed webhooks
 */
export async function broadcastWebhookEvent(
  organizationId: string,
  eventType: string,
  payload: Record<string, any>
): Promise<void> {
  const log = logger.child({
    operation: 'broadcastWebhookEvent',
    organizationId,
    eventType,
  });

  try {
    const webhooks = await prisma.outgoingWebhook.findMany({
      where: {
        organizationId,
        enabled: true,
      },
    });

    if (webhooks.length === 0) {
      log.debug('No enabled webhooks found');
      return;
    }

    // Send to all webhooks in parallel (non-blocking)
    const promises = webhooks.map((webhook) =>
      sendOutgoingWebhook(webhook.id, eventType, payload)
    );

    await Promise.allSettled(promises);

    log.info({ webhookCount: webhooks.length }, 'Broadcast webhook event to all subscribers');
  } catch (error) {
    log.error({ error }, 'Failed to broadcast webhook event');
    // Don't throw - webhook failures shouldn't break main flow
  }
}

// ============================================================================
// FEATURE FLAGS
// ============================================================================

/**
 * Create feature flag
 */
export async function createFeatureFlag(params: FeatureFlagCreate) {
  const log = logger.child({
    operation: 'createFeatureFlag',
    key: params.key,
  });

  try {
    const flag = await prisma.featureFlag.create({
      data: {
        id: randomUUID(),
        key: params.key,
        name: params.name,
        description: params.description || null,
        enabled: params.enabled || false,
        rolloutPercentage: params.rolloutPercentage || 0,
        rolloutStrategy: params.rolloutStrategy || 'DISABLED',
      },
    });

    log.info({ flagId: flag.id }, 'Created feature flag');

    return flag;
  } catch (error) {
    log.error({ error }, 'Failed to create feature flag');
    throw error;
  }
}

/**
 * List all feature flags
 */
export async function listFeatureFlags() {
  const flags = await prisma.featureFlag.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return flags;
}

/**
 * Get single feature flag
 */
export async function getFeatureFlag(key: string) {
  const flag = await prisma.featureFlag.findUnique({
    where: { key },
  });

  return flag;
}

/**
 * Update feature flag
 */
export async function updateFeatureFlag(key: string, updates: FeatureFlagUpdate) {
  const log = logger.child({
    operation: 'updateFeatureFlag',
    key,
  });

  try {
    const flag = await prisma.featureFlag.update({
      where: { key },
      data: {
        name: updates.name,
        description: updates.description !== undefined ? updates.description : undefined,
        enabled: updates.enabled,
        rolloutPercentage: updates.rolloutPercentage,
        rolloutStrategy: updates.rolloutStrategy,
        enabledOrganizations: updates.enabledOrganizations,
        disabledOrganizations: updates.disabledOrganizations,
      },
    });

    log.info({ updates }, 'Updated feature flag');

    return flag;
  } catch (error) {
    log.error({ error }, 'Failed to update feature flag');
    throw error;
  }
}

/**
 * Delete feature flag
 */
export async function deleteFeatureFlag(key: string) {
  const log = logger.child({
    operation: 'deleteFeatureFlag',
    key,
  });

  try {
    await prisma.featureFlag.delete({
      where: { key },
    });

    log.info('Deleted feature flag');
  } catch (error) {
    log.error({ error }, 'Failed to delete feature flag');
    throw error;
  }
}

/**
 * Check if feature is enabled for organization
 */
export async function isFeatureEnabled(key: string, organizationId: string): Promise<boolean> {
  const flag = await getFeatureFlag(key);

  if (!flag) {
    return false; // Feature doesn't exist
  }

  // Check whitelist/blacklist first
  if (flag.disabledOrganizations.includes(organizationId)) {
    return false;
  }

  if (flag.enabledOrganizations.includes(organizationId)) {
    return true;
  }

  // Apply rollout strategy
  switch (flag.rolloutStrategy) {
    case 'DISABLED':
      return false;

    case 'ENABLED':
      return true;

    case 'WHITELIST':
      return flag.enabledOrganizations.includes(organizationId);

    case 'BLACKLIST':
      return !flag.disabledOrganizations.includes(organizationId);

    case 'PERCENTAGE_ROLLOUT':
      // Deterministic percentage rollout based on org ID hash
      const crypto = await import('node:crypto');
      const hash = crypto.createHash('md5').update(organizationId + flag.key).digest('hex');
      const hashValue = parseInt(hash.slice(0, 8), 16);
      const percentage = (hashValue % 100) + 1; // 1-100
      return percentage <= flag.rolloutPercentage;

    default:
      return false;
  }
}

/**
 * Get all enabled features for organization
 */
export async function getEnabledFeatures(organizationId: string): Promise<string[]> {
  const flags = await listFeatureFlags();

  const enabledFlags = await Promise.all(
    flags.map(async (flag) => {
      const enabled = await isFeatureEnabled(flag.key, organizationId);
      return enabled ? flag.key : null;
    })
  );

  return enabledFlags.filter((key): key is string => key !== null);
}
