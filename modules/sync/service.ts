/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { randomUUID } from 'node:crypto';
import { publishEvent } from '../../infrastructure/kafka/publisher.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { platformRegistry } from '../../platforms/registry.js';
import type {
  NormalizedCustomer,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedSubscription,
} from '../../platforms/types.js';
import { logger } from '../../shared/logger/index.js';
import type { Platform } from '../../shared/types/index.js';
import * as connectionService from '../connections/service.js';

/**
 * Sync Service
 * Orchestrates data syncing from billing platforms to local database
 */

export interface SyncJobResult {
  connectionId: string;
  platform: Platform;
  customers: { synced: number; errors: number };
  subscriptions: { synced: number; errors: number };
  payments: { synced: number; errors: number };
  invoices: { synced: number; errors: number };
  duration: number;
  completedAt: Date;
}

export interface SyncProgress {
  stage: 'customers' | 'subscriptions' | 'payments' | 'invoices' | 'complete';
  percentage: number;
  counts: {
    customers: number;
    subscriptions: number;
    payments: number;
    invoices: number;
  };
  message: string;
}

export type ProgressCallback = (progress: SyncProgress) => void | Promise<void>;

/**
 * Sync all resources for a connection
 */
export async function syncConnection(
  connectionId: string,
  onProgress?: ProgressCallback
): Promise<SyncJobResult> {
  const startTime = Date.now();
  const log = logger.child({ operation: 'syncConnection', connectionId });

  log.info('Starting full sync for connection');

  const counts = { customers: 0, subscriptions: 0, payments: 0, invoices: 0 };

  try {
    // 1. Get connection with decrypted credentials
    const connection = await connectionService.getConnection(connectionId);

    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    log.info({ platform: connection.platform }, 'Retrieved connection');

    // 2. Get platform adapter
    const adapter = platformRegistry.getAdapter(connection.platform);

    // 3. Sync customers
    log.info('Syncing customers');
    if (onProgress) {
      await onProgress({
        stage: 'customers',
        percentage: 0,
        counts,
        message: 'Syncing customers...',
      });
    }
    const customerStats = await syncCustomers(connectionId, adapter, connection.credentials);
    counts.customers = customerStats.synced;
    if (onProgress) {
      await onProgress({
        stage: 'customers',
        percentage: 25,
        counts,
        message: `Found ${customerStats.synced} customers`,
      });
    }

    // 4. Sync subscriptions
    log.info('Syncing subscriptions');
    if (onProgress) {
      await onProgress({
        stage: 'subscriptions',
        percentage: 25,
        counts,
        message: 'Syncing subscriptions...',
      });
    }
    const subscriptionStats = await syncSubscriptions(
      connectionId,
      adapter,
      connection.credentials
    );
    counts.subscriptions = subscriptionStats.synced;
    if (onProgress) {
      await onProgress({
        stage: 'subscriptions',
        percentage: 50,
        counts,
        message: `Found ${subscriptionStats.synced} subscriptions`,
      });
    }

    // 5. Sync payments
    log.info('Syncing payments');
    if (onProgress) {
      await onProgress({
        stage: 'payments',
        percentage: 50,
        counts,
        message: 'Syncing payments...',
      });
    }
    const paymentStats = await syncPayments(connectionId, adapter, connection.credentials);
    counts.payments = paymentStats.synced;
    if (onProgress) {
      await onProgress({
        stage: 'payments',
        percentage: 75,
        counts,
        message: `Found ${paymentStats.synced} payments`,
      });
    }

    // 6. Sync invoices
    log.info('Syncing invoices');
    if (onProgress) {
      await onProgress({
        stage: 'invoices',
        percentage: 75,
        counts,
        message: 'Syncing invoices...',
      });
    }
    const invoiceStats = await syncInvoices(connectionId, adapter, connection.credentials);
    counts.invoices = invoiceStats.synced;
    if (onProgress) {
      await onProgress({
        stage: 'invoices',
        percentage: 100,
        counts,
        message: `Found ${invoiceStats.synced} invoices`,
      });
    }

    // 7. Update connection lastSyncedAt
    await prisma.connection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: new Date() },
    });

    const duration = Date.now() - startTime;
    const result: SyncJobResult = {
      connectionId,
      platform: connection.platform,
      customers: customerStats,
      subscriptions: subscriptionStats,
      payments: paymentStats,
      invoices: invoiceStats,
      duration,
      completedAt: new Date(),
    };

    log.info(
      {
        ...result,
        duration: `${duration}ms`,
      },
      'Sync completed successfully'
    );

    return result;
  } catch (error) {
    log.error({ error }, 'Sync failed');
    throw error;
  }
}

/**
 * Sync customers with pagination
 */
async function syncCustomers(
  connectionId: string,
  adapter: any,
  credentials: any
): Promise<{ synced: number; errors: number }> {
  const log = logger.child({ operation: 'syncCustomers', connectionId });

  let synced = 0;
  let errors = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await adapter.syncCustomers(connectionId, credentials, cursor);

      // Store in database
      for (const customer of result.data) {
        try {
          await storeCustomer(connectionId, customer);
          await publishCustomerEvent(connectionId, customer);
          synced++;
        } catch (error) {
          log.error({ error, customerId: customer.externalId }, 'Failed to store customer');
          errors++;
        }
      }

      hasMore = result.hasMore;
      cursor = result.nextCursor;

      log.info({ page: synced / 100, synced, hasMore }, `Synced ${synced} customers so far`);
    } catch (error) {
      log.error({ error, cursor }, 'Failed to fetch customers page');
      hasMore = false;
      errors++;
    }
  }

  return { synced, errors };
}

/**
 * Sync subscriptions with pagination
 */
async function syncSubscriptions(
  connectionId: string,
  adapter: any,
  credentials: any
): Promise<{ synced: number; errors: number }> {
  const log = logger.child({ operation: 'syncSubscriptions', connectionId });

  let synced = 0;
  let errors = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await adapter.syncSubscriptions(connectionId, credentials, cursor);

      // Store in database
      for (const subscription of result.data) {
        try {
          await storeSubscription(connectionId, subscription);
          await publishSubscriptionEvent(connectionId, subscription);
          synced++;
        } catch (error) {
          log.error(
            { error, subscriptionId: subscription.externalId },
            'Failed to store subscription'
          );
          errors++;
        }
      }

      hasMore = result.hasMore;
      cursor = result.nextCursor;

      log.info({ page: synced / 100, synced, hasMore }, `Synced ${synced} subscriptions so far`);
    } catch (error) {
      log.error({ error, cursor }, 'Failed to fetch subscriptions page');
      hasMore = false;
      errors++;
    }
  }

  return { synced, errors };
}

/**
 * Sync payments with pagination
 */
async function syncPayments(
  connectionId: string,
  adapter: any,
  credentials: any
): Promise<{ synced: number; errors: number }> {
  const log = logger.child({ operation: 'syncPayments', connectionId });

  let synced = 0;
  let errors = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await adapter.syncPayments(connectionId, credentials, cursor);

      // Store in database
      for (const payment of result.data) {
        try {
          await storePayment(connectionId, payment);
          await publishPaymentEvent(connectionId, payment);
          synced++;
        } catch (error) {
          log.error({ error, paymentId: payment.externalId }, 'Failed to store payment');
          errors++;
        }
      }

      hasMore = result.hasMore;
      cursor = result.nextCursor;

      log.info({ page: synced / 100, synced, hasMore }, `Synced ${synced} payments so far`);
    } catch (error) {
      log.error({ error, cursor }, 'Failed to fetch payments page');
      hasMore = false;
      errors++;
    }
  }

  return { synced, errors };
}

/**
 * Sync invoices with pagination
 */
async function syncInvoices(
  connectionId: string,
  adapter: any,
  credentials: any
): Promise<{ synced: number; errors: number }> {
  const log = logger.child({ operation: 'syncInvoices', connectionId });

  let synced = 0;
  let errors = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    try {
      const result = await adapter.syncInvoices(connectionId, credentials, cursor);

      // Store in database
      for (const invoice of result.data) {
        try {
          await storeInvoice(connectionId, invoice);
          await publishInvoiceEvent(connectionId, invoice);
          synced++;
        } catch (error) {
          log.error({ error, invoiceId: invoice.externalId }, 'Failed to store invoice');
          errors++;
        }
      }

      hasMore = result.hasMore;
      cursor = result.nextCursor;

      log.info({ page: synced / 100, synced, hasMore }, `Synced ${synced} invoices so far`);
    } catch (error) {
      log.error({ error, cursor }, 'Failed to fetch invoices page');
      hasMore = false;
      errors++;
    }
  }

  return { synced, errors };
}

// =============================================================================
// DATABASE STORAGE
// =============================================================================

async function storeCustomer(connectionId: string, customer: NormalizedCustomer): Promise<void> {
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

async function storeSubscription(
  connectionId: string,
  subscription: NormalizedSubscription
): Promise<void> {
  // Find customer by externalId
  const customer = await prisma.customer.findFirst({
    where: {
      connectionId,
      externalId: subscription.customerExternalId,
    },
  });

  if (!customer) {
    throw new Error(
      `Customer ${subscription.customerExternalId} not found for subscription ${subscription.externalId}`
    );
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
      currency: subscription.currency,
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

async function storePayment(connectionId: string, payment: NormalizedPayment): Promise<void> {
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
      currency: payment.currency,
      failureReason: payment.failureReason,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt,
      refundedAmount: payment.refundedAmount,
      rawData: payment.rawData as any,
      updatedAt: new Date(),
    },
  });
}

async function storeInvoice(connectionId: string, invoice: NormalizedInvoice): Promise<void> {
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
      currency: invoice.currency,
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

// =============================================================================
// KAFKA EVENT PUBLISHING
// =============================================================================

async function publishCustomerEvent(
  connectionId: string,
  customer: NormalizedCustomer
): Promise<void> {
  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.customer.created',
    event_version: '1.0',
    platform: customer.platform,
    platform_event: 'customer.created',
    account_id: connectionId, // TODO: Get actual account ID
    connection_id: connectionId,
    occurred_at: new Date().toISOString(),
    data: {
      customer_id: customer.externalId,
      email: customer.email,
      name: customer.name,
    },
    raw_data: customer.rawData,
  });
}

async function publishSubscriptionEvent(
  connectionId: string,
  subscription: NormalizedSubscription
): Promise<void> {
  await publishEvent({
    event_id: randomUUID(),
    event: 'billing.subscription.created',
    event_version: '1.0',
    platform: subscription.platform,
    platform_event: 'subscription.created',
    account_id: connectionId,
    connection_id: connectionId,
    occurred_at: new Date().toISOString(),
    data: {
      subscription_id: subscription.externalId,
      customer_id: subscription.customerExternalId,
      status: subscription.status,
      amount: subscription.amount,
      currency: subscription.currency,
    },
    raw_data: subscription.rawData,
  });
}

async function publishPaymentEvent(
  connectionId: string,
  payment: NormalizedPayment
): Promise<void> {
  const isFailed = payment.status.toString() === 'FAILED' || payment.status === ('FAILED' as any);
  const eventType = isFailed ? 'billing.payment.failed' : 'billing.payment.succeeded';

  await publishEvent({
    event_id: randomUUID(),
    event: eventType,
    event_version: '1.0',
    platform: payment.platform,
    platform_event: isFailed ? 'payment.failed' : 'payment.succeeded',
    account_id: connectionId,
    connection_id: connectionId,
    occurred_at: (payment.paidAt || new Date()).toISOString(),
    data: {
      payment_id: payment.externalId,
      customer_id: payment.customerExternalId,
      subscription_id: payment.subscriptionExternalId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      failure_reason: payment.failureReason,
    },
    raw_data: payment.rawData,
  });
}

async function publishInvoiceEvent(
  connectionId: string,
  invoice: NormalizedInvoice
): Promise<void> {
  // Determine event type based on invoice status
  let eventType = 'billing.invoice.created';
  if (invoice.status.toString() === 'PAID' || invoice.status === ('paid' as any)) {
    eventType = 'billing.invoice.paid';
  } else if (invoice.status.toString() === 'OPEN' || invoice.status === ('open' as any)) {
    eventType = invoice.attemptCount > 0 ? 'billing.invoice.payment_failed' : 'billing.invoice.created';
  } else if (invoice.status.toString() === 'VOID' || invoice.status === ('void' as any)) {
    eventType = 'billing.invoice.voided';
  }

  await publishEvent({
    event_id: randomUUID(),
    event: eventType,
    event_version: '1.0',
    platform: invoice.platform,
    platform_event: `invoice.${invoice.status}`,
    account_id: connectionId,
    connection_id: connectionId,
    occurred_at: (invoice.paidAt || invoice.dueDate || new Date()).toISOString(),
    data: {
      invoice_id: invoice.externalId,
      customer_id: invoice.customerExternalId,
      subscription_id: invoice.subscriptionExternalId,
      status: invoice.status,
      amount_due: invoice.amountDue,
      amount_paid: invoice.amountPaid,
      amount_remaining: invoice.amountRemaining,
      currency: invoice.currency,
      attempt_count: invoice.attemptCount,
      failure_reason: invoice.failureReason,
      hosted_invoice_url: invoice.hostedInvoiceUrl,
    },
    raw_data: invoice.rawData,
  });
}
