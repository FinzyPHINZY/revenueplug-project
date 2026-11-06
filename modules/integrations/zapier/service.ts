/**
 * Zapier Integration Service
 * Handles outgoing webhooks and API endpoints for Zapier integration
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ZapierWebhookConfig {
  id: string;
  organizationId: string;
  eventType: ZapierEventType;
  targetUrl: string;
  enabled: boolean;
  secret?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ZapierEventType =
  | 'campaign.triggered'
  | 'campaign.converted'
  | 'customer.at_risk'
  | 'payment.failed'
  | 'payment.recovered'
  | 'trial.ending'
  | 'trial.converted'
  | 'subscription.cancelled';

export interface ZapierTriggerPayload {
  id: string;
  event: ZapierEventType;
  timestamp: string;
  organizationId: string;
  data: Record<string, any>;
}

// ============================================================================
// WEBHOOK CONFIGURATION
// ============================================================================

/**
 * Create Zapier webhook configuration
 * Allows organizations to send events to Zapier when specific events occur
 */
export async function createZapierWebhook(params: {
  organizationId: string;
  eventType: ZapierEventType;
  targetUrl: string;
  secret?: string;
}): Promise<ZapierWebhookConfig> {
  const log = logger.child({
    operation: 'createZapierWebhook',
    organizationId: params.organizationId,
    eventType: params.eventType,
  });

  try {
    // Validate URL
    new URL(params.targetUrl); // Throws if invalid

    const webhook = await prisma.zapierWebhook.create({
      data: {
        id: randomUUID(),
        organizationId: params.organizationId,
        eventType: params.eventType,
        targetUrl: params.targetUrl,
        enabled: true,
        secret: params.secret || null,
      },
    });

    log.info({ webhookId: webhook.id }, 'Created Zapier webhook');

    return webhook as ZapierWebhookConfig;
  } catch (error) {
    log.error({ error }, 'Failed to create Zapier webhook');
    throw error;
  }
}

/**
 * List Zapier webhooks for organization
 */
export async function listZapierWebhooks(
  organizationId: string
): Promise<ZapierWebhookConfig[]> {
  const webhooks = await prisma.zapierWebhook.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });

  return webhooks as ZapierWebhookConfig[];
}

/**
 * Update Zapier webhook
 */
export async function updateZapierWebhook(
  webhookId: string,
  updates: {
    targetUrl?: string;
    enabled?: boolean;
    secret?: string;
  }
): Promise<ZapierWebhookConfig> {
  const webhook = await prisma.zapierWebhook.update({
    where: { id: webhookId },
    data: {
      ...updates,
      updatedAt: new Date(),
    },
  });

  return webhook as ZapierWebhookConfig;
}

/**
 * Delete Zapier webhook
 */
export async function deleteZapierWebhook(webhookId: string): Promise<void> {
  await prisma.zapierWebhook.delete({
    where: { id: webhookId },
  });

  logger.info({ webhookId }, 'Deleted Zapier webhook');
}

// ============================================================================
// TRIGGER EVENTS
// ============================================================================

/**
 * Send event to Zapier webhooks
 * Finds all enabled webhooks for the event type and POSTs the payload
 */
export async function sendZapierTrigger(
  organizationId: string,
  eventType: ZapierEventType,
  data: Record<string, any>
): Promise<void> {
  const log = logger.child({
    operation: 'sendZapierTrigger',
    organizationId,
    eventType,
  });

  try {
    // Find all enabled webhooks for this event type
    const webhooks = await prisma.zapierWebhook.findMany({
      where: {
        organizationId,
        eventType,
        enabled: true,
      },
    });

    if (webhooks.length === 0) {
      log.debug('No enabled Zapier webhooks found for event type');
      return;
    }

    // Build payload
    const payload: ZapierTriggerPayload = {
      id: randomUUID(),
      event: eventType,
      timestamp: new Date().toISOString(),
      organizationId,
      data,
    };

    // Send to all webhooks in parallel
    const promises = webhooks.map((webhook) =>
      sendWebhookRequest(webhook.targetUrl, payload, webhook.secret || undefined)
    );

    await Promise.allSettled(promises);

    log.info({ webhookCount: webhooks.length }, 'Sent Zapier trigger to webhooks');
  } catch (error) {
    log.error({ error }, 'Failed to send Zapier trigger');
    // Don't throw - webhook failures shouldn't break main flow
  }
}

/**
 * Send HTTP POST request to webhook URL
 */
async function sendWebhookRequest(
  url: string,
  payload: ZapierTriggerPayload,
  secret?: string
): Promise<void> {
  const log = logger.child({
    operation: 'sendWebhookRequest',
    url,
    event: payload.event,
  });

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'RevenuePlug-Zapier/1.0',
    };

    // Add secret header if provided
    if (secret) {
      headers['X-Zapier-Secret'] = secret;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`Webhook request failed: ${response.status} ${response.statusText}`);
    }

    log.info({ status: response.status }, 'Webhook request succeeded');
  } catch (error) {
    log.error({ error }, 'Webhook request failed');
    // Log but don't throw - individual webhook failures shouldn't break the flow
  }
}

// ============================================================================
// TRIGGER HELPERS
// ============================================================================

/**
 * Trigger: Campaign Triggered
 */
export async function triggerCampaignTriggered(params: {
  organizationId: string;
  campaignId: string;
  customerId: string;
  customerEmail: string;
  triggerType: string;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'campaign.triggered', {
    campaign_id: params.campaignId,
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    trigger_type: params.triggerType,
  });
}

/**
 * Trigger: Campaign Converted
 */
export async function triggerCampaignConverted(params: {
  organizationId: string;
  campaignId: string;
  customerId: string;
  customerEmail: string;
  recoveredRevenue: number;
  currency: string;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'campaign.converted', {
    campaign_id: params.campaignId,
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    recovered_revenue: params.recoveredRevenue,
    currency: params.currency,
  });
}

/**
 * Trigger: Customer At Risk
 */
export async function triggerCustomerAtRisk(params: {
  organizationId: string;
  customerId: string;
  customerEmail: string;
  riskLevel: string;
  churnProbability: number;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'customer.at_risk', {
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    risk_level: params.riskLevel,
    churn_probability: params.churnProbability,
  });
}

/**
 * Trigger: Payment Failed
 */
export async function triggerPaymentFailed(params: {
  organizationId: string;
  customerId: string;
  customerEmail: string;
  invoiceId: string;
  amount: number;
  currency: string;
  attemptCount: number;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'payment.failed', {
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    invoice_id: params.invoiceId,
    amount: params.amount,
    currency: params.currency,
    attempt_count: params.attemptCount,
  });
}

/**
 * Trigger: Payment Recovered
 */
export async function triggerPaymentRecovered(params: {
  organizationId: string;
  customerId: string;
  customerEmail: string;
  invoiceId: string;
  amount: number;
  currency: string;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'payment.recovered', {
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    invoice_id: params.invoiceId,
    amount: params.amount,
    currency: params.currency,
  });
}

/**
 * Trigger: Trial Ending
 */
export async function triggerTrialEnding(params: {
  organizationId: string;
  customerId: string;
  customerEmail: string;
  subscriptionId: string;
  trialEndDate: Date;
  daysRemaining: number;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'trial.ending', {
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    subscription_id: params.subscriptionId,
    trial_end_date: params.trialEndDate.toISOString(),
    days_remaining: params.daysRemaining,
  });
}

/**
 * Trigger: Trial Converted
 */
export async function triggerTrialConverted(params: {
  organizationId: string;
  customerId: string;
  customerEmail: string;
  subscriptionId: string;
  amount: number;
  currency: string;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'trial.converted', {
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    subscription_id: params.subscriptionId,
    amount: params.amount,
    currency: params.currency,
  });
}

/**
 * Trigger: Subscription Cancelled
 */
export async function triggerSubscriptionCancelled(params: {
  organizationId: string;
  customerId: string;
  customerEmail: string;
  subscriptionId: string;
  cancelledAt: Date;
  amount: number;
}): Promise<void> {
  await sendZapierTrigger(params.organizationId, 'subscription.cancelled', {
    customer_id: params.customerId,
    customer_email: params.customerEmail,
    subscription_id: params.subscriptionId,
    cancelled_at: params.cancelledAt.toISOString(),
    monthly_value: params.amount,
  });
}
