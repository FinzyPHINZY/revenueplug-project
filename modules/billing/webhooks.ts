import Stripe from 'stripe';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { BillingStatus } from '@prisma/client';

const log = logger.child({ module: 'billing-webhooks' });

/**
 * Process Stripe webhook event for billing
 */
export async function processBillingWebhook(event: Stripe.Event): Promise<void> {
  // Check for duplicate event
  const existingEvent = await prisma.billingWebhookEvent.findUnique({
    where: { stripeEventId: event.id },
  });

  if (existingEvent?.processed) {
    log.info({ eventId: event.id }, 'Webhook event already processed');
    return;
  }

  // Store event for idempotency
  await prisma.billingWebhookEvent.create({
    data: {
      stripeEventId: event.id,
      eventType: event.type,
      payload: event.data.object as any,
      processed: false,
    },
  });

  try {
    // Route to appropriate handler
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        log.info({ eventType: event.type }, 'Unhandled webhook event type');
    }

    // Mark as processed
    await prisma.billingWebhookEvent.updateMany({
      where: { stripeEventId: event.id },
      data: {
        processed: true,
        processedAt: new Date(),
      },
    });

    log.info({ eventId: event.id, eventType: event.type }, 'Webhook event processed');
  } catch (error) {
    log.error({ error, eventId: event.id }, 'Failed to process webhook event');

    await prisma.billingWebhookEvent.updateMany({
      where: { stripeEventId: event.id },
      data: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    throw error;
  }
}

/**
 * Handle checkout.session.completed
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const organizationId = session.metadata?.organizationId;
  if (!organizationId) {
    log.warn({ sessionId: session.id }, 'No organizationId in checkout session');
    return;
  }

  const subscriptionId = session.subscription as string;

  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      stripeSubscriptionId: subscriptionId,
      billingStatus: BillingStatus.ACTIVE,
    },
  });

  log.info({ organizationId, subscriptionId }, 'Checkout completed');
}

/**
 * Handle subscription created/updated
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const customerId = subscription.customer as string;

  const org = await prisma.organization.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!org) {
    log.warn({ customerId }, 'Organization not found for customer');
    return;
  }

  const priceId = subscription.items.data[0]?.price.id;

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      billingStatus: mapStripeStatus(subscription.status),
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    },
  });

  log.info({ organizationId: org.id, status: subscription.status }, 'Subscription updated');
}

/**
 * Handle subscription deleted
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId = subscription.customer as string;

  const org = await prisma.organization.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!org) {
    log.warn({ customerId }, 'Organization not found for customer');
    return;
  }

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      billingStatus: BillingStatus.CANCELED,
      stripePriceId: null,
      cancelAtPeriodEnd: false,
    },
  });

  log.info({ organizationId: org.id }, 'Subscription canceled');
}

/**
 * Handle invoice payment succeeded
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;

  const org = await prisma.organization.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!org) {
    return;
  }

  // If was past_due, update to active
  if (org.billingStatus === BillingStatus.PAST_DUE) {
    await prisma.organization.update({
      where: { id: org.id },
      data: {
        billingStatus: BillingStatus.ACTIVE,
      },
    });

    log.info({ organizationId: org.id }, 'Payment recovered, subscription active');
  }
}

/**
 * Handle invoice payment failed
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;

  const org = await prisma.organization.findUnique({
    where: { stripeCustomerId: customerId },
  });

  if (!org) {
    return;
  }

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      billingStatus: BillingStatus.PAST_DUE,
    },
  });

  log.warn({ organizationId: org.id, invoiceId: invoice.id }, 'Invoice payment failed');
}

/**
 * Map Stripe subscription status to our enum
 */
function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): BillingStatus {
  const mapping: Record<string, BillingStatus> = {
    active: BillingStatus.ACTIVE,
    trialing: BillingStatus.TRIALING,
    past_due: BillingStatus.PAST_DUE,
    canceled: BillingStatus.CANCELED,
    incomplete: BillingStatus.INCOMPLETE,
    incomplete_expired: BillingStatus.INCOMPLETE_EXPIRED,
    unpaid: BillingStatus.UNPAID,
  };

  return mapping[stripeStatus] || BillingStatus.FREE;
}
