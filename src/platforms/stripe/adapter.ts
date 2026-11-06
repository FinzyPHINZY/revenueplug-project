import Stripe from 'stripe';
import { AuthType, Platform } from '../../shared/types/index.js';
import { BasePlatformAdapter } from '../base-adapter.js';
import type {
  NormalizedCustomer,
  NormalizedEvent,
  NormalizedInvoice,
  NormalizedPayment,
  NormalizedSubscription,
  OAuthCredentials,
  PlatformCredentials,
  SyncResult,
  WebhookVerificationResult,
} from '../types.js';
import {
  normalizeStripeCharge,
  normalizeStripeCustomer,
  normalizeStripeInvoice,
  normalizeStripeSubscription,
} from './normalizer.js';
import {
  exchangeStripeOAuthCode,
  getStripeOAuthUrl,
  refreshStripeOAuthToken,
  validateStripeApiKey,
} from './oauth.js';
import type {
  StripeCharge,
  StripeCustomer,
  StripeInvoice,
  StripeSubscription,
  StripeWebhookEvent,
} from './types.js';
import { parseStripeWebhook, verifyStripeWebhook } from './webhook.js';

class StripeAdapter extends BasePlatformAdapter {
  readonly platform = Platform.STRIPE;
  readonly supportedAuthTypes = [AuthType.OAUTH, AuthType.API_KEY];

  getOAuthUrl(state: string, redirectUri: string): string {
    return getStripeOAuthUrl(state, redirectUri);
  }

  async exchangeOAuthCode(code: string, redirectUri: string): Promise<OAuthCredentials> {
    try {
      return await exchangeStripeOAuthCode(code, redirectUri);
    } catch (error) {
      this.handleApiError('exchangeOAuthCode', error);
    }
  }

  async refreshOAuthToken(refreshToken: string): Promise<OAuthCredentials> {
    try {
      return await refreshStripeOAuthToken(refreshToken);
    } catch (error) {
      this.handleApiError('refreshOAuthToken', error);
    }
  }

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      return await validateStripeApiKey(apiKey);
    } catch (error) {
      this.logger.error({ error }, 'Failed to validate Stripe API key');
      return false;
    }
  }

  async syncCustomers(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedCustomer>> {
    this.logSyncStart('customers', connectionId);

    try {
      const stripe = this.getStripeClient(credentials);

      const customers = await stripe.customers.list({
        limit: 100, // Max per page
        starting_after: cursor,
      });

      const normalized = customers.data.map((customer) =>
        normalizeStripeCustomer(customer as unknown as StripeCustomer)
      );

      const result: SyncResult<NormalizedCustomer> = {
        data: normalized,
        hasMore: customers.has_more,
        nextCursor: customers.has_more ? customers.data[customers.data.length - 1]?.id : undefined,
      };

      this.logSyncComplete('customers', connectionId, result.data.length);
      return result;
    } catch (error) {
      this.handleApiError('syncCustomers', error);
    }
  }

  async syncSubscriptions(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedSubscription>> {
    this.logSyncStart('subscriptions', connectionId);

    try {
      const stripe = this.getStripeClient(credentials);

      const subscriptions = await stripe.subscriptions.list({
        limit: 100,
        starting_after: cursor,
        expand: ['data.items.data.price.product'], // Expand to get product names
      });

      const normalized = subscriptions.data.map((subscription) =>
        normalizeStripeSubscription(subscription as unknown as StripeSubscription)
      );

      const result: SyncResult<NormalizedSubscription> = {
        data: normalized,
        hasMore: subscriptions.has_more,
        nextCursor: subscriptions.has_more
          ? subscriptions.data[subscriptions.data.length - 1]?.id
          : undefined,
      };

      this.logSyncComplete('subscriptions', connectionId, result.data.length);
      return result;
    } catch (error) {
      this.handleApiError('syncSubscriptions', error);
    }
  }

  async syncPayments(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedPayment>> {
    this.logSyncStart('payments', connectionId);

    try {
      const stripe = this.getStripeClient(credentials);

      const charges = await stripe.charges.list({
        limit: 100,
        starting_after: cursor,
      });

      const normalized = charges.data.map((charge) =>
        normalizeStripeCharge(charge as unknown as StripeCharge)
      );

      const result: SyncResult<NormalizedPayment> = {
        data: normalized,
        hasMore: charges.has_more,
        nextCursor: charges.has_more ? charges.data[charges.data.length - 1]?.id : undefined,
      };

      this.logSyncComplete('payments', connectionId, result.data.length);
      return result;
    } catch (error) {
      this.handleApiError('syncPayments', error);
    }
  }

  async syncInvoices(
    connectionId: string,
    credentials: PlatformCredentials,
    cursor?: string
  ): Promise<SyncResult<NormalizedInvoice>> {
    this.logSyncStart('invoices', connectionId);

    try {
      const stripe = this.getStripeClient(credentials);

      const invoices = await stripe.invoices.list({
        limit: 100,
        starting_after: cursor,
      });

      const normalized = invoices.data.map((invoice) =>
        normalizeStripeInvoice(invoice as unknown as StripeInvoice)
      );

      const result: SyncResult<NormalizedInvoice> = {
        data: normalized,
        hasMore: invoices.has_more,
        nextCursor: invoices.has_more ? invoices.data[invoices.data.length - 1]?.id : undefined,
      };

      this.logSyncComplete('invoices', connectionId, result.data.length);
      return result;
    } catch (error) {
      this.handleApiError('syncInvoices', error);
    }
  }

  private getStripeClient(credentials: PlatformCredentials): Stripe {
    const apiKey = this.getApiKeyFromCredentials(credentials);

    return new Stripe(apiKey, {
      apiVersion: '2025-12-15.clover',
    });
  }

  private getApiKeyFromCredentials(credentials: PlatformCredentials): string {
    if ('access_token' in credentials) {
      return credentials.access_token;
    }

    if ('api_key' in credentials) {
      return credentials.api_key;
    }

    throw new Error('Invalid credentials: no access_token or api_key found');
  }

  verifyWebhook(payload: string, signature: string, secret: string): WebhookVerificationResult {
    return verifyStripeWebhook(payload, signature, secret);
  }

  parseWebhook(payload: unknown): NormalizedEvent {
    return parseStripeWebhook(payload as StripeWebhookEvent);
  }
}

export const stripeAdapter = new StripeAdapter();
