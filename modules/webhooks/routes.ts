import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import * as webhookService from './service.js';

/**
 * Webhook routes for receiving events from Stripe
 */

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * POST /api/webhooks/mixpanel
 * Receive and process Mixpanel behavioral events
 */
async function handleMixpanelWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleMixpanelWebhook' });

  try {
    const payload = request.body as string;
    const signature = request.headers['x-mixpanel-signature'] as string;

    if (!signature) {
      log.warn('Missing Mixpanel signature header');
      return reply.code(400).send({
        error: 'Missing signature',
        message: 'X-Mixpanel-Signature header is required',
      });
    }

    // Get webhook secret from env
    const webhookSecret = process.env['MIXPANEL_WEBHOOK_SECRET'];
    if (!webhookSecret) {
      log.error('MIXPANEL_WEBHOOK_SECRET not configured');
      return reply.code(500).send({
        error: 'Configuration error',
        message: 'Webhook secret not configured',
      });
    }

    // Verify signature
    const isValid = webhookService.verifyMixpanelSignature(
      payload,
      signature,
      webhookSecret
    );

    if (!isValid) {
      log.warn('Invalid Mixpanel signature');
      return reply.code(400).send({
        error: 'Invalid signature',
        message: 'Webhook signature verification failed',
      });
    }

    log.info('Mixpanel webhook signature verified');

    // Parse payload
    const event = JSON.parse(payload);

    // Process webhook event (async, but we respond immediately)
    setImmediate(async () => {
      try {
        await webhookService.processMixpanelWebhook(event);
      } catch (error) {
        log.error({ error, event: event.event }, 'Failed to process Mixpanel webhook in background');
      }
    });

    // Respond immediately
    return reply.code(200).send({
      received: true,
      event: event.event,
    });
  } catch (error) {
    log.error({ error }, 'Mixpanel webhook processing failed');
    return reply.code(500).send({
      error: 'Webhook processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/webhooks/hubspot
 * Receive and process HubSpot CRM events
 */
async function handleHubSpotWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleHubSpotWebhook' });

  try {
    const payload = request.body as string;
    const signature = request.headers['x-hubspot-signature'] as string;

    if (!signature) {
      log.warn('Missing HubSpot signature header');
      return reply.code(400).send({
        error: 'Missing signature',
        message: 'X-HubSpot-Signature header is required',
      });
    }

    // Get webhook secret from env
    const webhookSecret = process.env['HUBSPOT_WEBHOOK_SECRET'];
    if (!webhookSecret) {
      log.error('HUBSPOT_WEBHOOK_SECRET not configured');
      return reply.code(500).send({
        error: 'Configuration error',
        message: 'Webhook secret not configured',
      });
    }

    // HubSpot signature verification needs method and URL
    const requestUrl = `https://${request.headers.host}${request.url}`;
    const method = request.method;

    // Verify signature
    const isValid = webhookService.verifyHubSpotSignature(
      payload,
      signature,
      webhookSecret,
      requestUrl,
      method
    );

    if (!isValid) {
      log.warn('Invalid HubSpot signature');
      return reply.code(400).send({
        error: 'Invalid signature',
        message: 'Webhook signature verification failed',
      });
    }

    log.info('HubSpot webhook signature verified');

    // Parse payload
    const event = JSON.parse(payload);

    // Process webhook event (async, but we respond immediately)
    setImmediate(async () => {
      try {
        await webhookService.processHubSpotWebhook(event);
      } catch (error) {
        log.error(
          { error, subscriptionType: event.subscriptionType },
          'Failed to process HubSpot webhook in background'
        );
      }
    });

    // Respond immediately
    return reply.code(200).send({
      received: true,
      subscriptionType: event.subscriptionType,
    });
  } catch (error) {
    log.error({ error }, 'HubSpot webhook processing failed');
    return reply.code(500).send({
      error: 'Webhook processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/webhooks/stripe
 * Receive and process Stripe webhook events
 */
async function handleStripeWebhook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleStripeWebhook' });

  try {
    // Get raw body (Fastify doesn't parse it for webhooks)
    const payload = request.body as string;
    const signature = request.headers['stripe-signature'] as string;

    if (!signature) {
      log.warn('Missing Stripe signature header');
      return reply.code(400).send({
        error: 'Missing signature',
        message: 'Stripe-Signature header is required',
      });
    }

    // Get webhook secret from env
    const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];
    if (!webhookSecret) {
      log.error('STRIPE_WEBHOOK_SECRET not configured');
      return reply.code(500).send({
        error: 'Configuration error',
        message: 'Webhook secret not configured',
      });
    }

    // Verify signature and construct event
    const event = webhookService.verifyStripeSignature(
      payload,
      signature,
      webhookSecret
    );

    log.info(
      {
        eventId: event.id,
        eventType: event.type,
      },
      'Webhook signature verified'
    );

    // Process webhook event (async, but we respond immediately)
    // We use setImmediate to process after responding
    setImmediate(async () => {
      try {
        await webhookService.processStripeWebhook(event);
      } catch (error) {
        log.error(
          {
            error,
            eventId: event.id,
            eventType: event.type,
          },
          'Failed to process webhook in background'
        );
      }
    });

    // Respond immediately (Stripe requires response within 5 seconds)
    return reply.code(200).send({
      received: true,
      eventId: event.id,
    });
  } catch (error) {
    log.error({ error }, 'Webhook processing failed');

    // Return specific error for signature verification
    if (error instanceof Error && error.message === 'Invalid signature') {
      return reply.code(400).send({
        error: 'Invalid signature',
        message: 'Webhook signature verification failed',
      });
    }

    return reply.code(500).send({
      error: 'Webhook processing failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Configure Fastify to handle raw body for webhooks
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string, done) => {
      // For webhook routes, preserve raw body
      if (req.url.startsWith('/api/webhooks/')) {
        done(null, body);
      } else {
        // For other routes, parse JSON normally
        try {
          const json = JSON.parse(body);
          done(null, json);
        } catch (error) {
          done(error as Error, undefined);
        }
      }
    }
  );

  // Register webhook endpoints
  app.post('/api/webhooks/stripe', handleStripeWebhook);
  app.post('/api/webhooks/mixpanel', handleMixpanelWebhook);
  app.post('/api/webhooks/hubspot', handleHubSpotWebhook);

  logger.info('Registered webhook routes');
}
