import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../../shared/logger/index.js';
import { getOrganizationContext, requireOrganizationContext } from '../../../shared/middleware/organization-context.js';
import { enforceApiUsageLimit } from '../../../shared/middleware/usage-limits.js';
import { requireAuth } from '../../auth/middleware.js';
import * as zapierService from './service.js';

/**
 * Zapier Integration Routes
 * Allows organizations to connect RevenuePlug with Zapier for custom workflows
 */

// ==========================================================================
// REQUEST SCHEMAS
// ==========================================================================

const CreateWebhookSchema = z.object({
  event_type: z.enum([
    'campaign.triggered',
    'campaign.converted',
    'customer.at_risk',
    'payment.failed',
    'payment.recovered',
    'trial.ending',
    'trial.converted',
    'subscription.cancelled',
  ]),
  target_url: z.string().url(),
  secret: z.string().optional(),
});

const UpdateWebhookSchema = z.object({
  target_url: z.string().url().optional(),
  enabled: z.boolean().optional(),
  secret: z.string().optional(),
});

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * POST /api/integrations/zapier/webhooks
 * Create Zapier webhook configuration
 */
async function handleCreateWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreateWebhook' });

  try {
    const body = CreateWebhookSchema.parse(request.body);
    const { id: organizationId } = getOrganizationContext(request);

    const webhook = await zapierService.createZapierWebhook({
      organizationId,
      eventType: body.event_type as any,
      targetUrl: body.target_url,
      secret: body.secret,
    });

    log.info(
      {
        organizationId,
        webhookId: webhook.id,
        eventType: body.event_type,
      },
      'Created Zapier webhook'
    );

    return reply.code(201).send({
      id: webhook.id,
      event_type: webhook.eventType,
      target_url: webhook.targetUrl,
      enabled: webhook.enabled,
      created_at: webhook.createdAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to create Zapier webhook');
    return reply.code(500).send({
      error: 'Failed to create webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/integrations/zapier/webhooks
 * List Zapier webhooks for organization
 */
async function handleListWebhooks(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleListWebhooks' });

  try {
    const { id: organizationId } = getOrganizationContext(request);

    const webhooks = await zapierService.listZapierWebhooks(organizationId);

    log.info({ organizationId, count: webhooks.length }, 'Listed Zapier webhooks');

    return reply.code(200).send({
      webhooks: webhooks.map((w) => ({
        id: w.id,
        event_type: w.eventType,
        target_url: w.targetUrl,
        enabled: w.enabled,
        created_at: w.createdAt,
        updated_at: w.updatedAt,
      })),
    });
  } catch (error) {
    log.error({ error }, 'Failed to list Zapier webhooks');
    return reply.code(500).send({
      error: 'Failed to list webhooks',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PATCH /api/integrations/zapier/webhooks/:webhookId
 * Update Zapier webhook configuration
 */
async function handleUpdateWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateWebhook' });

  try {
    const { webhookId } = request.params as { webhookId: string };
    const body = UpdateWebhookSchema.parse(request.body);

    const webhook = await zapierService.updateZapierWebhook(webhookId, {
      targetUrl: body.target_url,
      enabled: body.enabled,
      secret: body.secret,
    });

    log.info({ webhookId }, 'Updated Zapier webhook');

    return reply.code(200).send({
      id: webhook.id,
      event_type: webhook.eventType,
      target_url: webhook.targetUrl,
      enabled: webhook.enabled,
      updated_at: webhook.updatedAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to update Zapier webhook');
    return reply.code(500).send({
      error: 'Failed to update webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * DELETE /api/integrations/zapier/webhooks/:webhookId
 * Delete Zapier webhook
 */
async function handleDeleteWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDeleteWebhook' });

  try {
    const { webhookId } = request.params as { webhookId: string };

    await zapierService.deleteZapierWebhook(webhookId);

    log.info({ webhookId }, 'Deleted Zapier webhook');

    return reply.code(204).send();
  } catch (error) {
    log.error({ error }, 'Failed to delete Zapier webhook');
    return reply.code(500).send({
      error: 'Failed to delete webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/integrations/zapier/events
 * List available Zapier event types
 */
async function handleListEventTypes(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  return reply.code(200).send({
    events: [
      {
        type: 'campaign.triggered',
        description: 'Triggered when a retention campaign is started for a customer',
        sample_data: {
          campaign_id: 'camp_123',
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          trigger_type: 'PAYMENT_FAILURE',
        },
      },
      {
        type: 'campaign.converted',
        description: 'Triggered when a retention campaign successfully converts a customer',
        sample_data: {
          campaign_id: 'camp_123',
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          recovered_revenue: 49.99,
          currency: 'usd',
        },
      },
      {
        type: 'customer.at_risk',
        description: 'Triggered when a customer is identified as at-risk of churning',
        sample_data: {
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          risk_level: 'HIGH',
          churn_probability: 0.75,
        },
      },
      {
        type: 'payment.failed',
        description: 'Triggered when a payment fails',
        sample_data: {
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          invoice_id: 'inv_789',
          amount: 49.99,
          currency: 'usd',
          attempt_count: 2,
        },
      },
      {
        type: 'payment.recovered',
        description: 'Triggered when a previously failed payment is recovered',
        sample_data: {
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          invoice_id: 'inv_789',
          amount: 49.99,
          currency: 'usd',
        },
      },
      {
        type: 'trial.ending',
        description: 'Triggered when a trial is about to end (3 days before)',
        sample_data: {
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          subscription_id: 'sub_789',
          trial_end_date: '2025-01-15T00:00:00Z',
          days_remaining: 3,
        },
      },
      {
        type: 'trial.converted',
        description: 'Triggered when a trial converts to a paid subscription',
        sample_data: {
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          subscription_id: 'sub_789',
          amount: 49.99,
          currency: 'usd',
        },
      },
      {
        type: 'subscription.cancelled',
        description: 'Triggered when a subscription is cancelled',
        sample_data: {
          customer_id: 'cust_456',
          customer_email: 'user@example.com',
          subscription_id: 'sub_789',
          cancelled_at: '2025-01-01T00:00:00Z',
          monthly_value: 49.99,
        },
      },
    ],
  });
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

export async function registerZapierRoutes(app: FastifyInstance): Promise<void> {
  // All routes require auth, organization context, and API usage limits
  const preHandler = [requireAuth, requireOrganizationContext, enforceApiUsageLimit];

  app.post('/api/integrations/zapier/webhooks', { preHandler }, handleCreateWebhook);
  app.get('/api/integrations/zapier/webhooks', { preHandler }, handleListWebhooks);
  app.patch('/api/integrations/zapier/webhooks/:webhookId', { preHandler }, handleUpdateWebhook);
  app.delete('/api/integrations/zapier/webhooks/:webhookId', { preHandler }, handleDeleteWebhook);
  app.get('/api/integrations/zapier/events', { preHandler }, handleListEventTypes);

  logger.info('Registered Zapier integration routes');
}
