import Stripe from 'stripe';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import type { OAuthCredentials } from '../types.js';


const STRIPE_OAUTH_BASE_URL = 'https://connect.stripe.com/oauth';


export function getStripeOAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.STRIPE_CLIENT_ID || '',
    state,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read_write',
  });

  return `${STRIPE_OAUTH_BASE_URL}/authorize?${params.toString()}`;
}

interface StripeOAuthTokenResponse {
  access_token: string;
  livemode: boolean;
  refresh_token?: string;
  token_type: 'bearer';
  stripe_publishable_key: string;
  stripe_user_id: string;
  scope: string;
}


export async function exchangeStripeOAuthCode(
  code: string,
  _redirectUri: string
): Promise<OAuthCredentials> {
  const log = logger.child({ operation: 'exchangeStripeOAuthCode' });

  try {
    const response = await fetch(`${STRIPE_OAUTH_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_secret: config.STRIPE_CLIENT_SECRET || '',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error({ error, status: response.status }, 'Failed to exchange OAuth code');
      throw new Error(`Stripe OAuth token exchange failed: ${error}`);
    }

    const data = (await response.json()) as StripeOAuthTokenResponse;

    log.info(
      {
        stripe_user_id: data.stripe_user_id,
        livemode: data.livemode,
        scope: data.scope,
      },
      'Successfully exchanged OAuth code'
    );

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      scope: data.scope,
      metadata: {
        stripe_user_id: data.stripe_user_id,
        stripe_publishable_key: data.stripe_publishable_key,
        livemode: data.livemode,
      },
    };
  } catch (error) {
    log.error({ error }, 'Error during OAuth token exchange');
    throw error;
  }
}


export async function refreshStripeOAuthToken(
  refreshToken: string
): Promise<OAuthCredentials> {
  const log = logger.child({ operation: 'refreshStripeOAuthToken' });

  if (!refreshToken) {
    log.warn('No refresh token provided, Stripe tokens do not expire');
    throw new Error('Refresh token required');
  }

  log.info('Stripe tokens do not expire, returning existing token');
  return {
    access_token: refreshToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
  };
}


export async function validateStripeApiKey(apiKey: string): Promise<boolean> {
  const log = logger.child({ operation: 'validateStripeApiKey' });

  try {
    const stripe = new Stripe(apiKey, {
      apiVersion: '2025-12-15.clover',
    });

    await stripe.accounts.retrieve();

    log.info('Stripe API key validated successfully');
    return true;
  } catch (error) {
    log.error({ error }, 'Failed to validate Stripe API key');
    return false;
  }
}
