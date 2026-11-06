import { InvoiceStatus, PaymentStatus, Platform, SubscriptionStatus } from '../../shared/types/index.js';
import type { NormalizedCustomer, NormalizedInvoice, NormalizedPayment, NormalizedSubscription } from '../types.js';
import type { StripeCharge, StripeCustomer, StripeInvoice, StripeSubscription } from './types.js';


export function normalizeStripeCustomer(customer: StripeCustomer): NormalizedCustomer {
  return {
    externalId: customer.id,
    email: customer.email,
    name: customer.name,
    platform: Platform.STRIPE,
    rawData: customer,
  };
}


export function normalizeStripeSubscription(
  subscription: StripeSubscription
): NormalizedSubscription {
  const priceItem = subscription.items.data[0];
  const price = priceItem?.price;

  return {
    externalId: subscription.id,
    customerExternalId: subscription.customer,
    status: mapStripeSubscriptionStatus(subscription.status),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    amount: price?.unit_amount || 0,
    currency: price?.currency || 'usd',
    trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : undefined,
    cancelledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : undefined,
    cancelAtEnd: subscription.cancel_at_period_end,
    productName: typeof price?.product === 'object' ? price.product.name : undefined,
    productId: typeof price?.product === 'string' ? price.product : undefined,
    interval: price?.recurring?.interval,
    intervalCount: price?.recurring?.interval_count,
    platform: Platform.STRIPE,
    rawData: subscription,
  };
}


export function normalizeStripeCharge(charge: StripeCharge): NormalizedPayment {
  return {
    externalId: charge.id,
    status: mapStripePaymentStatus(charge.status, charge.refunded),
    amount: charge.amount,
    currency: charge.currency,
    customerExternalId: charge.customer,
    subscriptionExternalId: undefined,
    failureReason: charge.failure_message,
    paidAt: new Date(charge.created * 1000),
    refundedAt: charge.refunded ? new Date(charge.created * 1000) : undefined,
    refundedAmount: charge.amount_refunded,
    platform: Platform.STRIPE,
    rawData: charge,
  };
}

function mapStripeSubscriptionStatus(status: string): SubscriptionStatus {
  const statusMap: Record<string, SubscriptionStatus> = {
    active: SubscriptionStatus.ACTIVE,
    canceled: SubscriptionStatus.CANCELLED,
    past_due: SubscriptionStatus.PAST_DUE,
    trialing: SubscriptionStatus.TRIALING,
    paused: SubscriptionStatus.PAUSED,
    incomplete: SubscriptionStatus.INCOMPLETE,
    unpaid: SubscriptionStatus.UNPAID,
  };

  return statusMap[status] || SubscriptionStatus.ACTIVE;
}


function mapStripePaymentStatus(status: string, refunded: boolean): PaymentStatus {
  if (refunded) {
    return PaymentStatus.REFUNDED;
  }

  const statusMap: Record<string, PaymentStatus> = {
    succeeded: PaymentStatus.SUCCEEDED,
    failed: PaymentStatus.FAILED,
    pending: PaymentStatus.PENDING,
  };

  return statusMap[status] || PaymentStatus.PENDING;
}


export function normalizeStripeInvoice(invoice: StripeInvoice): NormalizedInvoice {
  return {
    externalId: invoice.id,
    status: mapStripeInvoiceStatus(invoice.status),
    subscriptionExternalId: invoice.subscription,
    customerExternalId: invoice.customer,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    amountRemaining: invoice.amount_remaining,
    currency: invoice.currency,
    dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : undefined,
    paidAt: invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : undefined,
    nextPaymentAttempt: invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000)
      : undefined,
    attemptCount: invoice.attempt_count,
    failureReason: invoice.last_finalization_error?.message,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
    invoicePdf: invoice.invoice_pdf,
    platform: Platform.STRIPE,
    rawData: invoice,
  };
}


function mapStripeInvoiceStatus(status: string): InvoiceStatus {
  const statusMap: Record<string, InvoiceStatus> = {
    draft: InvoiceStatus.DRAFT,
    open: InvoiceStatus.OPEN,
    paid: InvoiceStatus.PAID,
    void: InvoiceStatus.VOID,
    uncollectible: InvoiceStatus.UNCOLLECTIBLE,
  };

  return statusMap[status] || InvoiceStatus.OPEN;
}
