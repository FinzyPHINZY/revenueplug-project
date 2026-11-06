import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { z } from 'zod';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import {
  getOrganizationContext,
  requireOrganizationContext,
} from '../../shared/middleware/organization-context.js';
import { requireAuth } from '../auth/middleware.js';
import { BILLING_PLANS, getOrganizationPlan, getPlanIdByPriceId } from './plans.js';
import * as billingService from './service.js';
import { processBillingWebhook } from './webhooks.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-12-15.clover',
});

// ==========================================================================
// REQUEST SCHEMAS
// ==========================================================================

const CheckoutBodySchema = z.object({
  price_id: z.string().min(1),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

const PortalBodySchema = z.object({
  return_url: z.string().url(),
});

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * GET /api/billing/plans
 * List available billing plans
 */
async function handleGetPlans(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const plans = Object.values(BILLING_PLANS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    price: plan.price,
    limits: plan.limits,
    features: plan.features,
  }));

  return reply.code(200).send({ plans });
}

/**
 * GET /api/billing/subscription
 * Get organization's subscription status
 */
async function handleGetSubscription(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetSubscription' });

  try {
    const { id: organizationId } = getOrganizationContext(request);

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      return reply.code(404).send({ error: 'Organization not found' });
    }

    const plan = getOrganizationPlan(org);
    const usage = await billingService.getUsageForPeriod(
      organizationId,
      org.currentPeriodStart || new Date()
    );

    return reply.code(200).send({
      plan: {
        id: plan.id,
        name: plan.name,
        description: plan.description,
        limits: plan.limits,
        features: plan.features,
      },
      status: org.billingStatus,
      currentPeriodStart: org.currentPeriodStart,
      currentPeriodEnd: org.currentPeriodEnd,
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      usage,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get subscription');
    return reply.code(500).send({
      error: 'Failed to retrieve subscription',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/billing/checkout
 * Create Stripe checkout session
 */
async function handleCreateCheckout(
  request: FastifyRequest<{
    Body: z.infer<typeof CheckoutBodySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreateCheckout' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const body = CheckoutBodySchema.parse(request.body);

    // Determine which plan they're trying to purchase
    const requestedPlanId = getPlanIdByPriceId(body.price_id);

    if (!requestedPlanId) {
      log.warn({ priceId: body.price_id }, 'Invalid price ID');
      return reply.code(400).send({
        error: 'Invalid Price ID',
        message: 'The specified price ID does not match any available plans',
      });
    }

    // Validate plan eligibility
    const eligibility = await billingService.validatePlanEligibility(
      organizationId,
      requestedPlanId
    );

    if (!eligibility.eligible) {
      log.warn({ organizationId, requestedPlanId, eligibility }, 'Plan eligibility check failed');

      return reply.code(400).send({
        error: 'Plan Not Eligible',
        message: eligibility.reason,
        your_stats: eligibility.stats,
        suggested_action:
          eligibility.suggestedPlan === 'enterprise' ? 'contact_sales' : 'upgrade_to_pro',
        suggested_plan: eligibility.suggestedPlan,
        contact_sales_url: '/contact-sales',
      });
    }

    // Create checkout session if eligible
    const session = await billingService.createCheckoutSession({
      organizationId,
      priceId: body.price_id,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
    });

    log.info(
      { organizationId, sessionId: session.sessionId, plan: requestedPlanId },
      'Checkout session created'
    );

    return reply.code(200).send(session);
  } catch (error) {
    log.error({ error }, 'Failed to create checkout session');
    return reply.code(500).send({
      error: 'Failed to create checkout',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/billing/portal
 * Create Stripe customer portal session
 */
async function handleCreatePortal(
  request: FastifyRequest<{
    Body: z.infer<typeof PortalBodySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreatePortal' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const body = PortalBodySchema.parse(request.body);

    const session = await billingService.createPortalSession({
      organizationId,
      returnUrl: body.return_url,
    });

    log.info({ organizationId }, 'Portal session created');

    return reply.code(200).send(session);
  } catch (error) {
    log.error({ error }, 'Failed to create portal session');

    if (error instanceof Error && error.message.includes('No Stripe customer')) {
      return reply.code(400).send({
        error: 'No subscription found',
        message: 'You need an active subscription to access the customer portal',
      });
    }

    return reply.code(500).send({
      error: 'Failed to create portal',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/billing/webhook
 * Stripe webhook endpoint (no auth required)
 */
async function handleWebhook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleBillingWebhook' });

  const signature = request.headers['stripe-signature'] as string;

  if (!signature) {
    log.warn('Webhook request missing signature');
    return reply.code(400).send({ error: 'No signature' });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      request.body as string | Buffer,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET_BILLING!
    );
  } catch (error) {
    log.error({ error }, 'Webhook signature verification failed');
    return reply.code(400).send({ error: 'Invalid signature' });
  }

  try {
    await processBillingWebhook(event);
    return reply.code(200).send({ received: true });
  } catch (error) {
    log.error({ error, eventId: event.id }, 'Webhook processing failed');
    // Return 200 to prevent Stripe retries for this error
    return reply.code(200).send({ received: false });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

/**
 * Register billing routes
 */
export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  // Public routes
  app.get('/api/billing/plans', handleGetPlans);

  // Webhook route (no auth, signature verified in handler)
  app.post(
    '/api/billing/webhook',
    {
      config: { rawBody: true }, // Required for signature verification
    },
    handleWebhook
  );

  // Protected routes
  app.get(
    '/api/billing/subscription',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetSubscription
  );

  app.post(
    '/api/billing/checkout',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreateCheckout
  );

  app.post(
    '/api/billing/portal',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreatePortal
  );

  logger.info('Registered billing routes');
}
