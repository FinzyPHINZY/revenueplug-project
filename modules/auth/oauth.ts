import { randomBytes } from 'node:crypto';
import { Google, MicrosoftEntraId, Slack } from 'arctic';
import { prisma } from '../../infrastructure/postgres/index.js';
import { getRedisClient } from '../../infrastructure/redis/index.js';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';

export type OAuthProvider = 'GOOGLE' | 'SLACK' | 'MICROSOFT';

export function createGoogleClient(): Google | null {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    return null;
  }
  return new Google(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    `${config.OAUTH_REDIRECT_BASE}/api/auth/google/callback`
  );
}

export function createSlackClient(): Slack | null {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    return null;
  }
  return new Slack(
    config.SLACK_CLIENT_ID,
    config.SLACK_CLIENT_SECRET,
    `${config.OAUTH_REDIRECT_BASE}/api/auth/slack/callback`
  );
}

export function createMicrosoftClient(): MicrosoftEntraId | null {
  if (!config.MICROSOFT_CLIENT_ID || !config.MICROSOFT_CLIENT_SECRET) {
    return null;
  }
  return new MicrosoftEntraId(
    config.MICROSOFT_TENANT_ID,
    config.MICROSOFT_CLIENT_ID,
    config.MICROSOFT_CLIENT_SECRET,
    `${config.OAUTH_REDIRECT_BASE}/api/auth/microsoft/callback`
  );
}

const OAUTH_STATE_PREFIX = 'oauth:state:';
const OAUTH_STATE_TTL = 600; // 10 minutes

export interface OAuthStateData {
  provider: OAuthProvider;
  returnUrl?: string;
  codeVerifier?: string; // For PKCE
  timestamp: number;
}

export async function generateOAuthState(
  provider: OAuthProvider,
  returnUrl?: string,
  codeVerifier?: string
): Promise<string> {
  const state = randomBytes(32).toString('hex');
  const redis = getRedisClient();

  const stateData: OAuthStateData = {
    provider,
    returnUrl,
    codeVerifier,
    timestamp: Date.now(),
  };

  await redis.setex(`${OAUTH_STATE_PREFIX}${state}`, OAUTH_STATE_TTL, JSON.stringify(stateData));

  return state;
}

export async function validateOAuthState(
  state: string,
  expectedProvider: OAuthProvider
): Promise<OAuthStateData | null> {
  const log = logger.child({ operation: 'validateOAuthState' });
  const redis = getRedisClient();

  const stateJson = await redis.get(`${OAUTH_STATE_PREFIX}${state}`);

  if (!stateJson) {
    log.warn('OAuth state not found or expired');
    return null;
  }

  // delete state to prevent replay attacks
  await redis.del(`${OAUTH_STATE_PREFIX}${state}`);

  const stateData = JSON.parse(stateJson) as OAuthStateData;

  if (stateData.provider !== expectedProvider) {
    log.warn({ expected: expectedProvider, received: stateData.provider }, 'Provider mismatch');
    return null;
  }

  return stateData;
}

export interface OAuthUserInfo {
  provider: OAuthProvider;
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export async function findOrCreateUserFromOAuth(userInfo: OAuthUserInfo): Promise<{
  user: { id: string; email: string; name: string | null };
  isNewUser: boolean;
}> {
  const log = logger.child({
    operation: 'findOrCreateUserFromOAuth',
    provider: userInfo.provider,
  });

  // security: only trust verified emails
  if (!userInfo.emailVerified) {
    throw new Error('Email not verified by OAuth provider');
  }

  return await prisma.$transaction(async (tx) => {
    // check if oauth account already exists
    const existingOAuthAccount = await tx.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: userInfo.provider,
          providerAccountId: userInfo.providerAccountId,
        },
      },
      include: { user: true },
    });

    if (existingOAuthAccount) {
      log.info({ userId: existingOAuthAccount.userId }, 'Existing OAuth account found');

      // update tokens if provided
      if (userInfo.accessToken) {
        await tx.oAuthAccount.update({
          where: { id: existingOAuthAccount.id },
          data: {
            accessToken: userInfo.accessToken,
            refreshToken: userInfo.refreshToken,
            expiresAt: userInfo.expiresAt,
          },
        });
      }

      return {
        user: {
          id: existingOAuthAccount.user.id,
          email: existingOAuthAccount.user.email,
          name: existingOAuthAccount.user.name,
        },
        isNewUser: false,
      };
    }

    // check if user with same email exists (account linking)
    const existingUser = await tx.user.findUnique({
      where: { email: userInfo.email },
    });

    if (existingUser) {
      log.info({ userId: existingUser.id }, 'Linking OAuth to existing user');

      // link OAuth account to existing user
      await tx.oAuthAccount.create({
        data: {
          userId: existingUser.id,
          provider: userInfo.provider,
          providerAccountId: userInfo.providerAccountId,
          accessToken: userInfo.accessToken,
          refreshToken: userInfo.refreshToken,
          expiresAt: userInfo.expiresAt,
        },
      });

      // mark email as verified if not already
      if (!existingUser.emailVerified) {
        await tx.user.update({
          where: { id: existingUser.id },
          data: {
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
      }

      return {
        user: {
          id: existingUser.id,
          email: existingUser.email,
          name: existingUser.name,
        },
        isNewUser: false,
      };
    }

    // create new user (OAuth-only, no password)
    log.info({ email: userInfo.email }, 'Creating new OAuth user');

    const newUser = await tx.user.create({
      data: {
        email: userInfo.email,
        name: userInfo.name || null,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: {
            provider: userInfo.provider,
            providerAccountId: userInfo.providerAccountId,
            accessToken: userInfo.accessToken,
            refreshToken: userInfo.refreshToken,
            expiresAt: userInfo.expiresAt,
          },
        },
      },
    });

    return {
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
      },
      isNewUser: true,
    };
  });
}

// get OAuth accounts linked to a user
export async function getOAuthAccountsByUserId(userId: string): Promise<
  Array<{
    provider: OAuthProvider;
    providerAccountId: string;
    createdAt: Date;
  }>
> {
  const accounts = await prisma.oAuthAccount.findMany({
    where: { userId },
    select: {
      provider: true,
      providerAccountId: true,
      createdAt: true,
    },
  });

  return accounts;
}

// unlink OAuth account from user
// prevents unlinking if it's the only auth method and no password is set
export async function unlinkOAuthAccount(
  userId: string,
  provider: OAuthProvider
): Promise<boolean> {
  const log = logger.child({
    operation: 'unlinkOAuthAccount',
    userId,
    provider,
  });

  // check if user has password or other OAuth accounts
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { oauthAccounts: true },
  });

  if (!user) {
    throw new Error('User not found');
  }

  const hasPassword = !!user.password;
  const otherOAuthAccounts = user.oauthAccounts.filter(
    (a: { provider: OAuthProvider }) => a.provider !== provider
  );

  if (!hasPassword && otherOAuthAccounts.length === 0) {
    throw new Error('Cannot unlink - this is your only authentication method');
  }

  await prisma.oAuthAccount.deleteMany({
    where: {
      userId,
      provider,
    },
  });

  log.info('OAuth account unlinked');
  return true;
}
