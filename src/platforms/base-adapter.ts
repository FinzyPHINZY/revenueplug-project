import { logger } from '../shared/logger/index.js';
import type { AuthType, Platform } from '../shared/types/index.js';
import type {
  IPlatformAdapter,
  NormalizedCustomer,
  NormalizedEvent,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedSubscription,
  OAuthCredentials,
  PlatformCredentials,
  SyncResult,
  WebhookVerificationResult,
} from './types.js';


export abstract class BasePlatformAdapter implements IPlatformAdapter {
  abstract readonly platform: Platform;
  abstract readonly supportedAuthTypes: AuthType[];

  protected get logger() {
    return logger.child({ platform: this.platform });
  }

  abstract getOAuthUrl(state: string, redirectUri: string): string;
  abstract exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthCredentials>;
  abstract refreshOAuthToken(refreshToken: string): Promise<OAuthCredentials>;
  abstract validateApiKey(apiKey: string): Promise<boolean>;


  abstract syncCustomers(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedCustomer>>;

  abstract syncSubscriptions(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedSubscription>>;

  abstract syncPayments(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedPayment>>;

  abstract syncInvoices(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedInvoice>>;


  abstract verifyWebhook(
    payload: string,
    signature: string,
    secret: string
  ): WebhookVerificationResult;

  abstract parseWebhook(payload: unknown): NormalizedEvent;

  protected isAuthTypeSupported(authType: AuthType): boolean {
    return this.supportedAuthTypes.includes(authType);
  }

  protected logSyncStart(resource: string, connectionId: string): void {
    this.logger.info({ resource, connectionId }, `Starting ${resource} sync`);
  }

  protected logSyncComplete(resource: string, connectionId: string, count: number): void {
    this.logger.info({ resource, connectionId, count }, `Completed ${resource} sync`);
  }

  protected logSyncError(resource: string, connectionId: string, error: unknown): void {
    this.logger.error({ resource, connectionId, error }, `Failed ${resource} sync`);
  }

  protected handleApiError(operation: string, error: unknown): never {
    this.logger.error({ operation, error }, `API error during ${operation}`);
    throw new Error(`${this.platform} API error: ${operation}`);
  }
}
