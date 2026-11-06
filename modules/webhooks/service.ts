/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { publishEvent } from '../../infrastructure/kafka/publisher.js';
import { publishAnalyticsEvent, AnalyticsTopics } from '../../infrastructure/kafka/analytics-publisher.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { decryptCredentials } from '../connections/encryption.js';
import {
  normalizeStripeCharge,
  normalizeStripeCustomer,
  normalizeStripeInvoice,
  normalizeStripeSubscription,
} from '../../platforms/stripe/normalizer.js';
import type {
  StripeCharge,
  StripeCustomer,
  StripeInvoice,
  StripeSubscription,
} from '../../platforms/stripe/types.js';
import type {
  NormalizedCustomer,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedSubscription,
} from '../../platforms/types.js';
import { logger } from '../../shared/logger/index.js';
import { Platform } from '../../shared/types/index.js';
import { onPaymentFailed, onPaymentRecovered } from '../retention/triggers/payment-trigger.js';
import { onTrialEnding } from '../retention/triggers/trial-trigger.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook Service
 * Handles incoming webhook events from Stripe
 */

/**
 * Verify Stripe webhook signature
 */
export function verifyStripeSignature(
  payload: string,
  signature: string,
  webhookSecret: string
): Stripe.Event {
  const stripe = new Stripe(process.env['STRIPE_SECRET_KEY'] || '', {
    apiVersion: '2025-12-15.clover',
  });

  try {
    const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    return event;
  } catch (error) {
    logger.error({ error }, 'Invalid webhook signature');
    throw new Error('Invalid signature');
  }
}

/**
 * Check if webhook event has already been processed (idempotency)
 */
export async function isEventProcessed(stripeEventId: string): Promise<boolean> {
  const existing = await prisma.webhookEvent.findUnique({
    where: { stripeEventId },
  });

  return existing !== null && existing.status === 'PROCESSED';
}

/**
 * Store webhook event for idempotency tracking
 */
export async function storeWebhookEvent(
  stripeEventId: string,
  eventType: string,
  payload: any,
  connectionId?: string
): Promise<void> {
  await prisma.webhookEvent.create({
    data: {
      stripeEventId,
      eventType,
      payload: payload as any,
      connectionId,
      status: 'PENDING',
    },
  });
}

/**
 * Mark webhook event as processed
 */
export async function markEventAsProcessed(stripeEventId: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { stripeEventId },
    data: {
      status: 'PROCESSED',
      processedAt: new Date(),
    },
  });
}

/**
 * Mark webhook event as failed
 */
export async function markEventAsFailed(
  stripeEventId: string,
  errorMessage: string
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { stripeEventId },
    data: {
      status: 'FAILED',
      errorMessage,
      processedAt: new Date(),
    },
  });
}

/**
 * Process Stripe webhook event
 */
export async function processStripeWebhook(event: Stripe.Event): Promise<void> {
  const log = logger.child({
    operation: 'processStripeWebhook',
    eventId: event.id,
    eventType: event.type,
  });

  log.info('Processing webhook event');

  try {
    // Check if already processed
    if (await isEventProcessed(event.id)) {
      log.info('Event already processed, skipping');
      return;
    }

    // Find connection by Stripe account ID
    const stripeAccountId = event.account as string;
    const connection = await findConnectionByStripeAccount(stripeAccountId);

    // Store webhook event
    await storeWebhookEvent(event.id, event.type, event.data.object, connection?.id);

    // Route to appropriate handler
    switch (event.type) {
      // Invoice events
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as any, connection);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as any, connection);
        break;
      case 'invoice.created':
      case 'invoice.updated':
        await handleInvoiceUpdated(event.data.object as any, connection);
        break;
      case 'invoice.voided':
        await handleInvoiceVoided(event.data.object as any, connection);
        break;

      // Payment events
      case 'charge.failed':
        await handleChargeFailed(event.data.object as any, connection);
        break;
      case 'charge.succeeded':
        await handleChargeSucceeded(event.data.object as any, connection);
        break;

      // Subscription events
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as any, connection);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as any, connection);
        break;
      case 'customer.subscription.trial_will_end':
        await handleSubscriptionTrialWillEnd(event.data.object as any, connection);
        break;

      // Customer events
      case 'customer.created':
      case 'customer.updated':
        await handleCustomerUpdated(event.data.object as any, connection);
        break;
      case 'customer.deleted':
        await handleCustomerDeleted(event.data.object as any, connection);
        break;

      default:
        log.info({ eventType: event.type }, 'Unhandled event type');
    }

    // Mark as processed
    await markEventAsProcessed(event.id);

    log.info('Webhook event processed successfully');
  } catch (error) {
    log.error({ error }, 'Failed to process webhook event');
    await markEventAsFailed(event.id, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Find connection by Stripe account ID
 * Decrypts credentials and matches by stripe_user_id
 * Returns null if no match found (no fallback to prevent security issues)
 */
async function findConnectionByStripeAccount(stripeAccountId: string): Promise<any> {
  const log = logger.child({ operation: 'findConnectionByStripeAccount', stripeAccountId });

  const connections = await prisma.connection.findMany({
    where: {
      platform: 'STRIPE',
      status: 'ACTIVE',
    },
  });

  // Match by decrypted stripe_user_id from OAuth credentials
  for (const connection of connections) {
    try {
      const credentials = decryptCredentials(connection.credentials as string);

      // stripe_user_id is set during OAuth connection
      if (credentials['stripe_user_id'] === stripeAccountId) {
        log.info({ connectionId: connection.id }, 'Found matching connection');
        return connection;
      }
    } catch (error) {
      log.error({ error, connectionId: connection.id }, 'Failed to decrypt connection credentials');
    }
  }

  // No match found - return null instead of dangerous fallback
  log.warn('No matching connection found for Stripe account');
  return null;
}

/**
 * Handle invoice.payment_failed event
 */
async function handleInvoicePaymentFailed(invoice: StripeInvoice, connection: any): Promise<void> {
  if (!connection) {
    logger.warn({ invoiceId: invoice.id }, 'No connection found for failed invoice');
    return;
  }

  const normalized = normalizeStripeInvoice(invoice);

  // Update invoice in database
  await upsertInvoice(connection.id, normalized);

  // Publish failed payment event to Kafka
  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.invoice.payment_failed',
    event_version: '1.0',
    platform: Platform.STRIPE,
    platform_event: 'invoice.payment_failed',
    account_id: connection.organizationId,
    connection_id: connection.id,
    occurred_at: new Date().toISOString(),
    data: {
      invoice_id: invoice.id,
      customer_id: invoice.customer,
      subscription_id: invoice.subscription,
      amount_due: invoice.amount_due,
      amount_remaining: invoice.amount_remaining,
      attempt_count: invoice.attempt_count,
      failure_reason: invoice.last_finalization_error?.message,
    },
    raw_data: invoice as any,
  });

  // Also publish to analytics topic for ClickHouse
  await publishAnalyticsEvent(AnalyticsTopics.PAYMENT_EVENTS, {
    id: randomUUID(),
    customerId: invoice.customer as string,
    organizationId: connection.organizationId,
    invoiceId: invoice.id,
    amountCents: invoice.amount_due,
    currency: invoice.currency,
    status: 'failed',
    paymentMethod: invoice.default_payment_method?.toString() || 'unknown',
    failureCode: invoice.last_finalization_error?.code || '',
    failureMessage: invoice.last_finalization_error?.message || '',
    attemptCount: invoice.attempt_count || 0,
    isRetry: (invoice.attempt_count || 0) > 1,
    occurredAt: new Date().toISOString(),
  });

  logger.info(
    { invoiceId: invoice.id, connectionId: connection.id },
    'Processed invoice payment failed'
  );

  // Trigger payment failure recovery campaign
  const customer = await prisma.customer.findFirst({
    where: {
      connectionId: connection.id,
      externalId: invoice.customer as string,
    },
  });

  if (customer) {
    const subscription = await prisma.subscription.findFirst({
      where: {
        customerId: customer.id,
        externalId: invoice.subscription as string,
      },
    });

    // Get the upserted invoice from database to get its ID
    const dbInvoice = await prisma.invoice.findFirst({
      where: {
        connectionId: connection.id,
        externalId: invoice.id,
      },
    });

    await onPaymentFailed({
      customerId: customer.id,
      invoiceId: dbInvoice?.id || '',
      invoiceExternalId: invoice.id,
      amount: invoice.amount_due,
      currency: invoice.currency,
      attemptCount: invoice.attempt_count || 0,
      failureReason: invoice.last_finalization_error?.message,
      nextPaymentAttempt: invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000)
        : undefined,
      subscriptionId: subscription?.id,
      subscriptionExternalId: invoice.subscription as string,
    });
  }
}

/**
 * Handle invoice.paid event
 */
async function handleInvoicePaid(invoice: StripeInvoice, connection: any): Promise<void> {
  if (!connection) {
    logger.warn({ invoiceId: invoice.id }, 'No connection found for paid invoice');
    return;
  }

  const normalized = normalizeStripeInvoice(invoice);

  // Update invoice in database
  await upsertInvoice(connection.id, normalized);

  // Publish paid event to Kafka
  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.invoice.paid',
    event_version: '1.0',
    platform: Platform.STRIPE,
    platform_event: 'invoice.paid',
    account_id: connection.organizationId,
    connection_id: connection.id,
    occurred_at: new Date().toISOString(),
    data: {
      invoice_id: invoice.id,
      customer_id: invoice.customer,
      subscription_id: invoice.subscription,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency,
    },
    raw_data: invoice as any,
  });

  // Also publish to analytics topic for ClickHouse
  await publishAnalyticsEvent(AnalyticsTopics.PAYMENT_EVENTS, {
    id: randomUUID(),
    customerId: invoice.customer as string,
    organizationId: connection.organizationId,
    invoiceId: invoice.id,
    amountCents: invoice.amount_paid,
    currency: invoice.currency,
    status: 'paid',
    paymentMethod: invoice.default_payment_method?.toString() || 'unknown',
    failureCode: '',
    failureMessage: '',
    attemptCount: invoice.attempt_count || 1,
    isRetry: (invoice.attempt_count || 0) > 1,
    occurredAt: new Date().toISOString(),
  });

  logger.info({ invoiceId: invoice.id, connectionId: connection.id }, 'Processed invoice paid');

  // Mark payment failure campaigns as recovered
  const customer = await prisma.customer.findFirst({
    where: {
      connectionId: connection.id,
      externalId: invoice.customer as string,
    },
  });

  if (customer && invoice.attempt_count && invoice.attempt_count > 1) {
    await onPaymentRecovered({
      customerId: customer.id,
      invoiceExternalId: invoice.id,
      amount: invoice.amount_paid,
      wasRetry: true,
    });
  }
}

/**
 * Handle invoice.created/updated event
 */
async function handleInvoiceUpdated(invoice: StripeInvoice, connection: any): Promise<void> {
  if (!connection) return;

  const normalized = normalizeStripeInvoice(invoice);
  await upsertInvoice(connection.id, normalized);

  logger.info({ invoiceId: invoice.id, connectionId: connection.id }, 'Processed invoice updated');
}

/**
 * Handle invoice.voided event
 */
async function handleInvoiceVoided(invoice: StripeInvoice, connection: any): Promise<void> {
  if (!connection) return;

  const normalized = normalizeStripeInvoice(invoice);
  await upsertInvoice(connection.id, normalized);

  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.invoice.voided',
    event_version: '1.0',
    platform: Platform.STRIPE,
    platform_event: 'invoice.voided',
    account_id: connection.organizationId,
    connection_id: connection.id,
    occurred_at: new Date().toISOString(),
    data: {
      invoice_id: invoice.id,
    },
    raw_data: invoice as any,
  });

  logger.info({ invoiceId: invoice.id, connectionId: connection.id }, 'Processed invoice voided');
}

/**
 * Handle charge.failed event
 */
async function handleChargeFailed(charge: StripeCharge, connection: any): Promise<void> {
  if (!connection) return;

  // Normalize charge to payment
  const normalized = normalizeStripeCharge(charge);
  await upsertPayment(connection.id, normalized);

  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.payment.failed',
    event_version: '1.0',
    platform: Platform.STRIPE,
    platform_event: 'charge.failed',
    account_id: connection.organizationId,
    connection_id: connection.id,
    occurred_at: new Date().toISOString(),
    data: {
      payment_id: charge.id,
      customer_id: charge.customer,
      amount: charge.amount,
      currency: charge.currency,
      failure_reason: charge.failure_message,
    },
    raw_data: charge,
  });

  // Publish to analytics for ClickHouse
  await publishAnalyticsEvent(AnalyticsTopics.PAYMENT_EVENTS, {
    id: randomUUID(),
    customerId: charge.customer as string,
    organizationId: connection.organizationId,
    invoiceId: charge.invoice?.toString() || '',
    amountCents: charge.amount,
    currency: charge.currency,
    status: 'failed',
    paymentMethod: charge.payment_method_details?.type || 'unknown',
    failureCode: charge.failure_code || '',
    failureMessage: charge.failure_message || '',
    attemptCount: 1,
    isRetry: false,
    occurredAt: new Date((charge.created || Date.now() / 1000) * 1000).toISOString(),
  });

  logger.info({ chargeId: charge.id, connectionId: connection.id }, 'Processed charge failed');
}

/**
 * Handle charge.succeeded event
 */
async function handleChargeSucceeded(charge: StripeCharge, connection: any): Promise<void> {
  if (!connection) return;

  const normalized = normalizeStripeCharge(charge);
  await upsertPayment(connection.id, normalized);

  // Publish to analytics for ClickHouse
  await publishAnalyticsEvent(AnalyticsTopics.PAYMENT_EVENTS, {
    id: randomUUID(),
    customerId: charge.customer as string,
    organizationId: connection.organizationId,
    invoiceId: charge.invoice?.toString() || '',
    amountCents: charge.amount,
    currency: charge.currency,
    status: 'paid',
    paymentMethod: charge.payment_method_details?.type || 'unknown',
    failureCode: '',
    failureMessage: '',
    attemptCount: 1,
    isRetry: false,
    occurredAt: new Date((charge.created || Date.now() / 1000) * 1000).toISOString(),
  });

  logger.info({ chargeId: charge.id, connectionId: connection.id }, 'Processed charge succeeded');
}

/**
 * Handle subscription updated event
 */
async function handleSubscriptionUpdated(
  subscription: StripeSubscription,
  connection: any
): Promise<void> {
  if (!connection) return;

  const normalized = normalizeStripeSubscription(subscription);

  // Get previous subscription state to detect trial → active conversion
  const previousSubscription = await prisma.subscription.findFirst({
    where: {
      connectionId: connection.id,
      externalId: subscription.id,
    },
  });

  await upsertSubscription(connection.id, normalized);

  // Check if subscription just converted from trial to active
  if (
    previousSubscription?.status === 'TRIALING' &&
    subscription.status === 'active' &&
    !subscription.cancel_at_period_end
  ) {
    const customer = await prisma.customer.findFirst({
      where: {
        connectionId: connection.id,
        externalId: subscription.customer as string,
      },
    });

    if (customer) {
      const { onTrialConverted } = await import('../retention/triggers/trial-trigger.js');

      await onTrialConverted({
        customerId: customer.id,
        subscriptionExternalId: subscription.id,
        amount: subscription.items?.data[0]?.price?.unit_amount || 0,
        planName: (subscription.items?.data[0]?.price?.product as string) || 'Unknown Plan',
      });
    }
  }

  logger.info(
    { subscriptionId: subscription.id, connectionId: connection.id },
    'Processed subscription updated'
  );
}

/**
 * Handle subscription deleted event
 */
async function handleSubscriptionDeleted(
  subscription: StripeSubscription,
  connection: any
): Promise<void> {
  if (!connection) return;

  const normalized = normalizeStripeSubscription(subscription);
  await upsertSubscription(connection.id, normalized);

  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.subscription.cancelled',
    event_version: '1.0',
    platform: Platform.STRIPE,
    platform_event: 'customer.subscription.deleted',
    account_id: connection.organizationId,
    connection_id: connection.id,
    occurred_at: new Date().toISOString(),
    data: {
      subscription_id: subscription.id,
      customer_id: subscription.customer,
    },
    raw_data: subscription as any,
  });

  logger.info(
    { subscriptionId: subscription.id, connectionId: connection.id },
    'Processed subscription deleted'
  );
}

/**
 * Handle subscription.trial_will_end event
 * Fired 3 days before trial ends to trigger proactive retention
 */
async function handleSubscriptionTrialWillEnd(
  subscription: StripeSubscription,
  connection: any
): Promise<void> {
  if (!connection) {
    logger.warn(
      { subscriptionId: subscription.id },
      'No connection found for trial ending subscription'
    );
    return;
  }

  const log = logger.child({
    operation: 'handleSubscriptionTrialWillEnd',
    subscriptionId: subscription.id,
    customerId: subscription.customer,
    connectionId: connection.id,
  });

  // Update subscription in database
  const normalized = normalizeStripeSubscription(subscription);
  await upsertSubscription(connection.id, normalized);

  // Calculate trial end date and days remaining
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
  const now = new Date();
  const daysRemaining = trialEnd
    ? Math.ceil((trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Find customer in database
  const customer = await prisma.customer.findFirst({
    where: {
      connectionId: connection.id,
      externalId: subscription.customer as string,
    },
  });

  if (!customer) {
    log.warn('Customer not found for trial ending subscription');
    return;
  }

  // Publish trial ending event to Kafka for retention campaigns
  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.subscription.trial_will_end',
    event_version: '1.0',
    platform: Platform.STRIPE,
    platform_event: 'customer.subscription.trial_will_end',
    account_id: connection.organizationId,
    connection_id: connection.id,
    occurred_at: new Date().toISOString(),
    data: {
      subscription_id: subscription.id,
      customer_id: subscription.customer,
      customer_email: customer.email,
      customer_name: customer.name,
      trial_end: trialEnd?.toISOString(),
      days_remaining: daysRemaining,
      plan_amount: subscription.items?.data[0]?.price?.unit_amount || 0,
      plan_currency: subscription.items?.data[0]?.price?.currency || 'usd',
      plan_interval: subscription.items?.data[0]?.price?.recurring?.interval || 'month',
    },
    raw_data: subscription as any,
  });

  log.info(
    {
      trialEnd,
      daysRemaining,
      customerEmail: customer.email,
    },
    'Processed trial will end event - triggering retention campaign'
  );

  // Trigger trial ending conversion campaign
  const dbSubscription = await prisma.subscription.findFirst({
    where: {
      connectionId: connection.id,
      externalId: subscription.id,
    },
  });

  await onTrialEnding({
    customerId: customer.id,
    subscriptionId: dbSubscription?.id || '',
    subscriptionExternalId: subscription.id,
    trialEndDate: trialEnd || new Date(),
    daysRemaining,
    planName: subscription.items?.data[0]?.price?.product as string,
    planAmount: subscription.items?.data[0]?.price?.unit_amount || 0,
    planCurrency: subscription.items?.data[0]?.price?.currency || 'usd',
  });
}

/**
 * Handle customer updated event
 */
async function handleCustomerUpdated(customer: StripeCustomer, connection: any): Promise<void> {
  if (!connection) return;

  const normalized = normalizeStripeCustomer(customer);
  await upsertCustomer(connection.id, normalized);

  logger.info(
    { customerId: customer.id, connectionId: connection.id },
    'Processed customer updated'
  );
}

/**
 * Handle customer deleted event
 */
async function handleCustomerDeleted(customer: StripeCustomer, connection: any): Promise<void> {
  if (!connection) return;

  // Soft delete - mark as deleted
  await prisma.customer.updateMany({
    where: {
      connectionId: connection.id,
      externalId: customer.id,
    },
    data: {
      updatedAt: new Date(),
    },
  });

  logger.info(
    { customerId: customer.id, connectionId: connection.id },
    'Processed customer deleted'
  );
}

// ============================================================================
// MIXPANEL WEBHOOK HANDLERS
// ============================================================================

/**
 * Verify Mixpanel webhook signature
 * Uses HMAC-SHA256 to validate webhook authenticity
 */
export function verifyMixpanelSignature(
  payload: string,
  signature: string,
  webhookSecret: string
): boolean {
  try {
    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, actualBuffer);
  } catch (error) {
    logger.error({ error }, 'Failed to verify Mixpanel signature');
    return false;
  }
}

/**
 * Process Mixpanel webhook event
 * Handles behavioral events from Mixpanel for churn prediction enhancement
 */
export async function processMixpanelWebhook(payload: any): Promise<void> {
  const log = logger.child({
    operation: 'processMixpanelWebhook',
    eventType: payload.event,
  });

  log.info('Processing Mixpanel webhook event');

  try {
    const { event, properties } = payload;

    // Extract user/customer identifier
    const distinctId = properties?.distinct_id;
    const email = properties?.email || properties?.$email;

    if (!distinctId && !email) {
      log.warn('No customer identifier found in Mixpanel event');
      return;
    }

    // Find customer by email or external ID
    const customer = await prisma.customer.findFirst({
      where: {
        OR: [
          { email: email || undefined },
          { externalId: distinctId || undefined },
        ],
      },
      include: {
        connection: true,
      },
    });

    if (!customer) {
      log.warn({ email, distinctId }, 'Customer not found for Mixpanel event');
      return;
    }

    // Publish behavioral event to Kafka for churn prediction
    await publishEvent({
      event_id: randomUUID(),
      event: 'behavioral.user_activity',
      event_version: '1.0',
      platform: 'MIXPANEL' as any,
      platform_event: event,
      account_id: customer.connection.organizationId,
      connection_id: customer.connectionId,
      occurred_at: properties?.time ? new Date(properties.time).toISOString() : new Date().toISOString(),
      data: {
        customer_id: customer.id,
        customer_email: customer.email,
        event_name: event,
        properties: properties,
        // Extract key engagement metrics
        session_duration: properties?.session_duration,
        feature_used: properties?.feature_name,
        action_count: properties?.action_count,
      },
      raw_data: payload,
    });

    log.info(
      {
        customerId: customer.id,
        eventName: event,
        email: customer.email,
      },
      'Processed Mixpanel behavioral event'
    );
  } catch (error) {
    log.error({ error }, 'Failed to process Mixpanel webhook');
    throw error;
  }
}

// ============================================================================
// HUBSPOT WEBHOOK HANDLERS
// ============================================================================

/**
 * Verify HubSpot webhook signature
 * Uses HMAC-SHA256 with app secret and request details
 */
export function verifyHubSpotSignature(
  payload: string,
  signature: string,
  webhookSecret: string,
  requestUrl: string,
  method: string
): boolean {
  try {
    // HubSpot uses app secret + method + url + payload
    const sourceString = method + requestUrl + payload;

    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(sourceString)
      .digest('hex');

    return signature === expectedSignature;
  } catch (error) {
    logger.error({ error }, 'Failed to verify HubSpot signature');
    return false;
  }
}

/**
 * Process HubSpot webhook event
 * Handles CRM updates (task completions, contact changes, deal updates)
 */
export async function processHubSpotWebhook(payload: any): Promise<void> {
  const log = logger.child({
    operation: 'processHubSpotWebhook',
    subscriptionType: payload.subscriptionType,
  });

  log.info('Processing HubSpot webhook event');

  try {
    const { subscriptionType, objectId, propertyName, propertyValue } = payload;

    // Suppress unused variable warnings - used in specific handlers
    void propertyName;
    void propertyValue;

    // Handle task completion events
    if (subscriptionType === 'task.completion') {
      await handleHubSpotTaskCompletion(payload);
    }

    // Handle contact property changes (email, lifecycle stage, etc.)
    else if (subscriptionType === 'contact.propertyChange') {
      await handleHubSpotContactChange(payload);
    }

    // Handle deal stage changes (won/lost)
    else if (subscriptionType === 'deal.propertyChange') {
      await handleHubSpotDealChange(payload);
    }

    else {
      log.info({ subscriptionType }, 'Unhandled HubSpot webhook type');
    }

    log.info({ subscriptionType, objectId }, 'Processed HubSpot webhook event');
  } catch (error) {
    log.error({ error }, 'Failed to process HubSpot webhook');
    throw error;
  }
}

/**
 * Handle HubSpot task completion event
 * Updates retention campaign action status when personal outreach tasks are completed
 */
async function handleHubSpotTaskCompletion(payload: any): Promise<void> {
  const log = logger.child({
    operation: 'handleHubSpotTaskCompletion',
    taskId: payload.objectId,
  });

  const { objectId, properties } = payload;

  // Find campaign action associated with this HubSpot task
  const action = await prisma.campaignAction.findFirst({
    where: {
      actionType: 'PERSONAL_OUTREACH',
      executionResult: {
        path: ['hubspot_task_id'],
        equals: objectId,
      },
    },
    include: {
      campaign: true,
    },
  });

  if (!action) {
    log.warn('No campaign action found for HubSpot task');
    return;
  }

  // Update action status based on task completion
  const taskStatus = properties?.hs_task_status;

  if (taskStatus === 'COMPLETED') {
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'SENT', // Mark as sent/completed
        executedAt: new Date(),
      },
    });

    log.info(
      {
        actionId: action.id,
        campaignId: action.campaignId,
      },
      'Updated campaign action from HubSpot task completion'
    );
  }
}

/**
 * Handle HubSpot contact property changes
 * Can track customer engagement through CRM updates
 */
async function handleHubSpotContactChange(payload: any): Promise<void> {
  const log = logger.child({
    operation: 'handleHubSpotContactChange',
    contactId: payload.objectId,
    property: payload.propertyName,
  });

  const { objectId, propertyName, propertyValue } = payload;

  // Suppress unused variable warnings - kept for future use
  void objectId;
  void propertyName;
  void propertyValue;

  // Track lifecycle stage changes (subscriber -> lead -> customer)
  if (propertyName === 'lifecyclestage') {
    log.info(
      {
        contactId: objectId,
        newStage: propertyValue,
      },
      'Contact lifecycle stage changed'
    );

    // Could trigger different retention strategies based on lifecycle stage
    // This is a hook for future enhancement
  }

  // Track email address changes
  if (propertyName === 'email') {
    log.info(
      {
        contactId: objectId,
        newEmail: propertyValue,
      },
      'Contact email changed'
    );
  }
}

/**
 * Handle HubSpot deal stage changes
 * Tracks when retention efforts result in deal wins/losses
 */
async function handleHubSpotDealChange(payload: any): Promise<void> {
  const log = logger.child({
    operation: 'handleHubSpotDealChange',
    dealId: payload.objectId,
    property: payload.propertyName,
  });

  const { objectId, propertyName, propertyValue } = payload;

  // Track deal stage changes (won/lost)
  if (propertyName === 'dealstage') {
    log.info(
      {
        dealId: objectId,
        newStage: propertyValue,
      },
      'Deal stage changed'
    );

    // If deal is won and associated with retention campaign, mark as converted
    // This would require additional tracking of deal <-> campaign associations
  }
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function upsertInvoice(connectionId: string, invoice: NormalizedInvoice): Promise<void> {
  await prisma.invoice.upsert({
    where: {
      connectionId_externalId: {
        connectionId,
        externalId: invoice.externalId,
      },
    },
    create: {
      connectionId,
      externalId: invoice.externalId,
      status: invoice.status as any,
      subscriptionExternalId: invoice.subscriptionExternalId,
      customerExternalId: invoice.customerExternalId,
      amountDue: invoice.amountDue,
      amountPaid: invoice.amountPaid,
      amountRemaining: invoice.amountRemaining,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      nextPaymentAttempt: invoice.nextPaymentAttempt,
      attemptCount: invoice.attemptCount,
      failureReason: invoice.failureReason,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      invoicePdf: invoice.invoicePdf,
      platform: invoice.platform as any,
      rawData: invoice.rawData as any,
    },
    update: {
      status: invoice.status as any,
      amountDue: invoice.amountDue,
      amountPaid: invoice.amountPaid,
      amountRemaining: invoice.amountRemaining,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      nextPaymentAttempt: invoice.nextPaymentAttempt,
      attemptCount: invoice.attemptCount,
      failureReason: invoice.failureReason,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      invoicePdf: invoice.invoicePdf,
      rawData: invoice.rawData as any,
      updatedAt: new Date(),
    },
  });
}

async function upsertPayment(connectionId: string, payment: NormalizedPayment): Promise<void> {
  await prisma.payment.upsert({
    where: {
      connectionId_externalId: {
        connectionId,
        externalId: payment.externalId,
      },
    },
    create: {
      connectionId,
      externalId: payment.externalId,
      customerExternalId: payment.customerExternalId,
      subscriptionExternalId: payment.subscriptionExternalId,
      status: payment.status as any,
      amount: payment.amount,
      currency: payment.currency,
      failureReason: payment.failureReason,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt,
      refundedAmount: payment.refundedAmount,
      platform: payment.platform as any,
      rawData: payment.rawData as any,
    },
    update: {
      status: payment.status as any,
      amount: payment.amount,
      failureReason: payment.failureReason,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt,
      refundedAmount: payment.refundedAmount,
      rawData: payment.rawData as any,
      updatedAt: new Date(),
    },
  });
}

async function upsertSubscription(
  connectionId: string,
  subscription: NormalizedSubscription
): Promise<void> {
  // Find customer
  const customer = await prisma.customer.findFirst({
    where: {
      connectionId,
      externalId: subscription.customerExternalId,
    },
  });

  if (!customer) {
    logger.warn(
      {
        customerId: subscription.customerExternalId,
        subscriptionId: subscription.externalId,
      },
      'Customer not found for subscription webhook'
    );
    return;
  }

  await prisma.subscription.upsert({
    where: {
      connectionId_externalId: {
        connectionId,
        externalId: subscription.externalId,
      },
    },
    create: {
      connectionId,
      customerId: customer.id,
      externalId: subscription.externalId,
      status: subscription.status as any,
      currentPeriodEnd: subscription.currentPeriodEnd,
      amount: subscription.amount,
      currency: subscription.currency,
      trialEnd: subscription.trialEnd,
      cancelledAt: subscription.cancelledAt,
      cancelAtEnd: subscription.cancelAtEnd ?? false,
      productName: subscription.productName,
      productId: subscription.productId,
      interval: subscription.interval,
      intervalCount: subscription.intervalCount,
      platform: subscription.platform as any,
      rawData: subscription.rawData as any,
    },
    update: {
      status: subscription.status as any,
      currentPeriodEnd: subscription.currentPeriodEnd,
      amount: subscription.amount,
      trialEnd: subscription.trialEnd,
      cancelledAt: subscription.cancelledAt,
      cancelAtEnd: subscription.cancelAtEnd ?? false,
      productName: subscription.productName,
      productId: subscription.productId,
      interval: subscription.interval,
      intervalCount: subscription.intervalCount,
      rawData: subscription.rawData as any,
      updatedAt: new Date(),
    },
  });
}

async function upsertCustomer(connectionId: string, customer: NormalizedCustomer): Promise<void> {
  await prisma.customer.upsert({
    where: {
      connectionId_externalId: {
        connectionId,
        externalId: customer.externalId,
      },
    },
    create: {
      connectionId,
      externalId: customer.externalId,
      email: customer.email,
      name: customer.name,
      platform: customer.platform as any,
      rawData: customer.rawData as any,
    },
    update: {
      email: customer.email,
      name: customer.name,
      rawData: customer.rawData as any,
      updatedAt: new Date(),
    },
  });
}
