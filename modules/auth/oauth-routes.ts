import { decodeIdToken, generateCodeVerifier, type OAuth2Tokens } from 'arctic';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import { setAccessTokenCookie, setRefreshTokenCookie } from './cookies.js';
import {
  createGoogleClient,
  createMicrosoftClient,
  createSlackClient,
  findOrCreateUserFromOAuth,
  generateOAuthState,
  type OAuthUserInfo,
  validateOAuthState,
} from './oauth.js';
import * as authService from './service.js';
import { generateAccessToken, generateRefreshToken } from './tokens.js';

interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

interface SlackIdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

interface MicrosoftIdTokenClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
}

// GET /api/auth/google - Redirect to Google OAuth consent screen
async function handleGoogleAuth(
  request: FastifyRequest<{ Querystring: { returnUrl?: string } }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGoogleAuth' });

  const google = createGoogleClient();

  if (!google) {
    log.error('Google OAuth not configured');
    return reply.code(501).send({
      error: 'Not Configured',
      message: 'Google login is not configured',
    });
  }

  // generate PKCE code verifier and state
  const codeVerifier = generateCodeVerifier();
  const state = await generateOAuthState('GOOGLE', request.query.returnUrl, codeVerifier);
  const scopes = ['openid', 'email', 'profile'];
  const url = google.createAuthorizationURL(state, codeVerifier, scopes);

  return reply.redirect(url.toString());
}

// GET /api/auth/google/callback - Handle Google OAuth callback
async function handleGoogleCallback(
  request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGoogleCallback' });

  const { code, state, error } = request.query;

  if (error) {
    log.warn({ error }, 'Google OAuth error');
    return reply.redirect('/login?error=oauth_denied');
  }

  if (!code || !state) {
    log.warn('Missing code or state');
    return reply.redirect('/login?error=invalid_request');
  }

  try {
    const stateData = await validateOAuthState(state, 'GOOGLE');
    if (!stateData || !stateData.codeVerifier) {
      return reply.redirect('/login?error=invalid_state');
    }

    const google = createGoogleClient();
    if (!google) {
      return reply.redirect('/login?error=not_configured');
    }

    // exchange code for tokens with PKCE verifier
    const tokens: OAuth2Tokens = await google.validateAuthorizationCode(
      code,
      stateData.codeVerifier
    );
    const idToken = tokens.idToken();

    // decode and validate ID token
    const claims = decodeIdToken(idToken) as GoogleIdTokenClaims;

    const userInfo: OAuthUserInfo = {
      provider: 'GOOGLE',
      providerAccountId: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified,
      name: claims.name,
      picture: claims.picture,
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      expiresAt: tokens.accessTokenExpiresAt(),
    };

    // find or create user
    const { user, isNewUser } = await findOrCreateUserFromOAuth(userInfo);
    log.info({ userId: user.id, isNewUser }, 'Google OAuth login successful');

    // create session and set cookies
    await createSessionAndSetCookies(reply, user, request);

    // redirect to dashboard or return URL
    const returnUrl = stateData.returnUrl || '/dashboard';
    return reply.redirect(returnUrl);
  } catch (err) {
    log.error({ error: err }, 'Google OAuth callback failed');
    return reply.redirect('/login?error=oauth_failed');
  }
}

// GET /api/auth/slack - Redirect to Slack OAuth consent screen
async function handleSlackAuth(
  request: FastifyRequest<{ Querystring: { returnUrl?: string } }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleSlackAuth' });

  const slack = createSlackClient();
  if (!slack) {
    log.error('Slack OAuth not configured');
    return reply.code(501).send({
      error: 'Not Configured',
      message: 'Slack login is not configured',
    });
  }

  // generate PKCE code verifier and state
  const codeVerifier = generateCodeVerifier();
  const state = await generateOAuthState('SLACK', request.query.returnUrl, codeVerifier);
  const scopes = ['openid', 'email', 'profile'];
  const url = slack.createAuthorizationURL(state, scopes);

  return reply.redirect(url.toString());
}

// GET /api/auth/slack/callback - Handle Slack OAuth callback
async function handleSlackCallback(
  request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleSlackCallback' });

  const { code, state, error } = request.query;

  if (error) {
    log.warn({ error }, 'Slack OAuth error');
    return reply.redirect('/login?error=oauth_denied');
  }

  if (!code || !state) {
    log.warn('Missing code or state');
    return reply.redirect('/login?error=invalid_request');
  }

  try {
    const stateData = await validateOAuthState(state, 'SLACK');
    if (!stateData) {
      return reply.redirect('/login?error=invalid_state');
    }

    const slack = createSlackClient();
    if (!slack) {
      return reply.redirect('/login?error=not_configured');
    }

    // exchange code for tokens
    const tokens: OAuth2Tokens = await slack.validateAuthorizationCode(code);
    const idToken = tokens.idToken();

    // decode ID token
    const claims = decodeIdToken(idToken) as SlackIdTokenClaims;

    const userInfo: OAuthUserInfo = {
      provider: 'SLACK',
      providerAccountId: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified,
      name: claims.name,
      picture: claims.picture,
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      expiresAt: tokens.accessTokenExpiresAt(),
    };

    // find or create user
    const { user, isNewUser } = await findOrCreateUserFromOAuth(userInfo);
    log.info({ userId: user.id, isNewUser }, 'Slack OAuth login successful');

    // create session and set cookies
    await createSessionAndSetCookies(reply, user, request);

    // redirect to dashboard or return URL
    const returnUrl = stateData.returnUrl || '/dashboard';
    return reply.redirect(returnUrl);
  } catch (err) {
    log.error({ error: err }, 'Slack OAuth callback failed');
    return reply.redirect('/login?error=oauth_failed');
  }
}

// GET /api/auth/microsoft - Redirect to Microsoft OAuth consent screen
async function handleMicrosoftAuth(
  request: FastifyRequest<{ Querystring: { returnUrl?: string } }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleMicrosoftAuth' });

  const microsoft = createMicrosoftClient();
  if (!microsoft) {
    log.error('Microsoft OAuth not configured');
    return reply.code(501).send({
      error: 'Not Configured',
      message: 'Microsoft login is not configured',
    });
  }

  // generate PKCE code verifier and state
  const codeVerifier = generateCodeVerifier();
  const state = await generateOAuthState('MICROSOFT', request.query.returnUrl, codeVerifier);
  const scopes = ['openid', 'email', 'profile'];
  const url = microsoft.createAuthorizationURL(state, codeVerifier, scopes);

  return reply.redirect(url.toString());
}

// GET /api/auth/microsoft/callback - Handle Microsoft OAuth callback
async function handleMicrosoftCallback(
  request: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleMicrosoftCallback' });

  const { code, state, error } = request.query;

  if (error) {
    log.warn({ error }, 'Microsoft OAuth error');
    return reply.redirect('/login?error=oauth_denied');
  }

  if (!code || !state) {
    log.warn('Missing code or state');
    return reply.redirect('/login?error=invalid_request');
  }

  try {
    const stateData = await validateOAuthState(state, 'MICROSOFT');
    if (!stateData || !stateData.codeVerifier) {
      return reply.redirect('/login?error=invalid_state');
    }

    const microsoft = createMicrosoftClient();
    if (!microsoft) {
      return reply.redirect('/login?error=not_configured');
    }

    // exchange code for tokens with PKCE verifier
    const tokens: OAuth2Tokens = await microsoft.validateAuthorizationCode(
      code,
      stateData.codeVerifier
    );
    const idToken = tokens.idToken();

    // decode ID token
    const claims = decodeIdToken(idToken) as MicrosoftIdTokenClaims;

    // microsoft may return email as 'email' or 'preferred_username'
    const email = claims.email || claims.preferred_username;
    if (!email) {
      log.error('Microsoft OAuth: no email in token');
      return reply.redirect('/login?error=no_email');
    }

    const userInfo: OAuthUserInfo = {
      provider: 'MICROSOFT',
      providerAccountId: claims.sub,
      email,
      emailVerified: true, // Microsoft verifies emails
      name: claims.name,
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      expiresAt: tokens.accessTokenExpiresAt(),
    };

    // find or create user
    const { user, isNewUser } = await findOrCreateUserFromOAuth(userInfo);
    log.info({ userId: user.id, isNewUser }, 'Microsoft OAuth login successful');

    // create session and set cookies
    await createSessionAndSetCookies(reply, user, request);

    // redirect to dashboard or return URL
    const returnUrl = stateData.returnUrl || '/dashboard';
    return reply.redirect(returnUrl);
  } catch (err) {
    log.error({ error: err }, 'Microsoft OAuth callback failed');
    return reply.redirect('/login?error=oauth_failed');
  }
}

// create session and set auth cookies
async function createSessionAndSetCookies(
  reply: FastifyReply,
  user: { id: string; email: string },
  request: FastifyRequest
): Promise<void> {
  // generate tokens
  const accessToken = generateAccessToken({ id: user.id, email: user.email });
  const { token: refreshToken } = generateRefreshToken();

  // create session
  await authService.createSession({
    userId: user.id,
    refreshToken,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  });

  // set cookies
  setAccessTokenCookie(reply, accessToken);
  setRefreshTokenCookie(reply, refreshToken);
}

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  // Google
  app.get('/api/auth/google', handleGoogleAuth);
  app.get('/api/auth/google/callback', handleGoogleCallback);

  // Slack
  app.get('/api/auth/slack', handleSlackAuth);
  app.get('/api/auth/slack/callback', handleSlackCallback);

  // Microsoft
  app.get('/api/auth/microsoft', handleMicrosoftAuth);
  app.get('/api/auth/microsoft/callback', handleMicrosoftCallback);

  logger.info('Registered OAuth routes');
}
