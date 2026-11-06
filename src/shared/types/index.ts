
export enum Platform {
  STRIPE = 'stripe',
  POLAR = 'polar',
  REVENUECAT = 'revenuecat',
  LEMON_SQUEEZY = 'lemon_squeezy',
}

export enum AuthType {
  OAUTH = 'oauth',
  API_KEY = 'api_key',
  WEBHOOK_ONLY = 'webhook_only',
}

export enum ConnectionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  FAILED = 'failed',
  DISCONNECTED = 'disconnected',
}


export enum SubscriptionStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
  PAST_DUE = 'past_due',
  TRIALING = 'trialing',
  PAUSED = 'paused',
  INCOMPLETE = 'incomplete',
  UNPAID = 'unpaid',
}


export enum PaymentStatus {
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  PENDING = 'pending',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
}


export enum InvoiceStatus {
  DRAFT = 'draft',
  OPEN = 'open',
  PAID = 'paid',
  VOID = 'void',
  UNCOLLECTIBLE = 'uncollectible',
}


export enum WebhookEventStatus {
  PENDING = 'pending',
  PROCESSED = 'processed',
  FAILED = 'failed',
}


export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
  TEST = 'test',
}


export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
}


export enum EventType {
  SUBSCRIPTION_CREATED = 'subscription.created',
  SUBSCRIPTION_UPDATED = 'subscription.updated',
  SUBSCRIPTION_CANCELLED = 'subscription.cancelled',
  SUBSCRIPTION_RENEWED = 'subscription.renewed',
  SUBSCRIPTION_PAUSED = 'subscription.paused',
  SUBSCRIPTION_RESUMED = 'subscription.resumed',
  SUBSCRIPTION_TRIAL_WILL_END = 'subscription.trial_will_end',

  CUSTOMER_CREATED = 'customer.created',
  CUSTOMER_UPDATED = 'customer.updated',
  CUSTOMER_DELETED = 'customer.deleted',

  PAYMENT_SUCCEEDED = 'payment.succeeded',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_REFUNDED = 'payment.refunded',

  INVOICE_CREATED = 'invoice.created',
  INVOICE_UPDATED = 'invoice.updated',
  INVOICE_PAID = 'invoice.paid',
  INVOICE_PAYMENT_FAILED = 'invoice.payment_failed',
  INVOICE_VOIDED = 'invoice.voided',

  CONNECTION_CREATED = 'connection.created',
  CONNECTION_FAILED = 'connection.failed',
  CONNECTION_REFRESHED = 'connection.refreshed',
}
