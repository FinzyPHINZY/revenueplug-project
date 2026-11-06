import type {
  AuthType,
  InvoiceStatus,
  PaymentStatus,
  Platform,
  SubscriptionStatus,
} from '../shared/types/index.js';

export interface OAuthCredentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  token_type?: string;
  metadata?: Record<string, unknown>;
}

export interface ApiKeyCredentials {
  api_key: string;
}

export type PlatformCredentials = OAuthCredentials | ApiKeyCredentials;

export interface ConnectionMetadata {
  webhook_secret?: string;
  api_version?: string;
  account_id?: string;
  [key: string]: unknown;
}

export interface NormalizedConnection {
  platform: Platform;
  authType: AuthType;
  credentials: PlatformCredentials;
  metadata?: ConnectionMetadata;
}

export interface NormalizedCustomer {
  externalId: string;
  email?: string;
  name?: string;
  platform: Platform;
  rawData: Record<string, unknown>;
}

export interface NormalizedSubscription {
  externalId: string;
  customerExternalId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  amount: number; // In smallest currency unit (cents)
  currency: string;
  trialEnd?: Date;
  cancelledAt?: Date;
  cancelAtEnd?: boolean;
  productName?: string;
  productId?: string;
  interval?: string; // 'month', 'year', etc.
  intervalCount?: number;
  platform: Platform;
  rawData: Record<string, unknown>;
}

export interface NormalizedPayment {
  externalId: string;
  status: PaymentStatus;
  amount: number; // In smallest currency unit
  currency: string;
  subscriptionExternalId?: string;
  customerExternalId?: string;
  failureReason?: string;
  paidAt?: Date;
  refundedAt?: Date;
  refundedAmount?: number;
  platform: Platform;
  rawData: Record<string, unknown>;
}

export interface NormalizedInvoice {
  externalId: string;
  status: InvoiceStatus;
  subscriptionExternalId?: string;
  customerExternalId?: string;
  amountDue: number; // In smallest currency unit
  amountPaid: number;
  amountRemaining: number;
  currency: string;
  dueDate?: Date;
  paidAt?: Date;
  nextPaymentAttempt?: Date;
  attemptCount: number;
  failureReason?: string;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
  platform: Platform;
  rawData: Record<string, unknown>;
}

export interface NormalizedEvent {
  event: string; // Normalized event name (e.g., 'subscription.created')
  platformEvent: string; // Original platform event name
  occurredAt: Date;
  accountId?: string;
  connectionId?: string;
  data: Record<string, unknown>; // Normalized event data
  rawData: Record<string, unknown>; // Original platform payload
}

export interface WebhookVerificationResult {
  valid: boolean;
  event?: NormalizedEvent;
  error?: string;
}

export interface SyncResult<T> {
  data: T[];
  hasMore: boolean;
  nextCursor?: string;
  errors?: Array<{ item: string; error: string }>;
}

export interface IPlatformAdapter {
  readonly platform: Platform;

  readonly supportedAuthTypes: AuthType[];

  getOAuthUrl(state: string, redirectUri: string): string;

  exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthCredentials>;

  refreshOAuthToken(refreshToken: string): Promise<OAuthCredentials>;

  validateApiKey(apiKey: string): Promise<boolean>;

  syncCustomers(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedCustomer>>;

  syncSubscriptions(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedSubscription>>;

  syncPayments(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedPayment>>;

  syncInvoices(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedInvoice>>;

  verifyWebhook(payload: string, signature: string, secret: string): WebhookVerificationResult;

  parseWebhook(payload: unknown): NormalizedEvent;
}
