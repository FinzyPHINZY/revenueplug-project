
import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

export interface CreateAPIKeyParams {
  organizationId: string;
  createdBy: string;
  name: string;
  scopes?: string[];
  expiresAt?: Date;
}

export interface APIKeyWithSecret {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  secret: string;
}

export interface APIKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  enabled: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}


function generateAPIKey(environment: 'live' | 'test' = 'live'): string {
  const randomPart = randomBytes(32).toString('hex');
  return `rp_${environment}_${randomPart}`;
}


function hashAPIKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function getKeyPrefix(key: string): string {
  const parts = key.split('_');
  if (parts.length >= 3) {
    return `${parts[0]}_${parts[1]}_${parts[2].substring(0, 8)}`;
  }
  return key.substring(0, 16);
}


export async function createAPIKey(
  params: CreateAPIKeyParams
): Promise<APIKeyWithSecret> {
  const log = logger.child({
    operation: 'createAPIKey',
    organizationId: params.organizationId,
  });

  try {
    const apiKey = generateAPIKey('live');
    const keyHash = hashAPIKey(apiKey);
    const keyPrefix = getKeyPrefix(apiKey);

    const key = await prisma.aPIKey.create({
      data: {
        organizationId: params.organizationId,
        createdBy: params.createdBy,
        name: params.name,
        keyPrefix,
        keyHash,
        scopes: params.scopes || [],
        expiresAt: params.expiresAt || null,
        enabled: true,
      },
    });

    log.info({ keyId: key.id, keyPrefix, name: params.name }, 'Created API key');

    return {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      enabled: key.enabled,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      secret: apiKey,
    };
  } catch (error) {
    log.error({ error }, 'Failed to create API key');
    throw error;
  }
}

export async function listAPIKeys(organizationId: string): Promise<APIKeyInfo[]> {
  const keys = await prisma.aPIKey.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });

  return keys.map((key) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    enabled: key.enabled,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    usageCount: key.usageCount,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  }));
}

export async function getAPIKey(
  keyId: string,
  organizationId: string
): Promise<APIKeyInfo | null> {
  const key = await prisma.aPIKey.findFirst({
    where: {
      id: keyId,
      organizationId,
    },
  });

  if (!key) {
    return null;
  }

  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    enabled: key.enabled,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    usageCount: key.usageCount,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}


export async function revokeAPIKey(
  keyId: string,
  organizationId: string
): Promise<void> {
  const log = logger.child({ operation: 'revokeAPIKey', keyId });

  try {
    await prisma.aPIKey.updateMany({
      where: {
        id: keyId,
        organizationId,
      },
      data: {
        enabled: false,
        revokedAt: new Date(),
      },
    });

    log.info('Revoked API key');
  } catch (error) {
    log.error({ error }, 'Failed to revoke API key');
    throw error;
  }
}


export async function deleteAPIKey(
  keyId: string,
  organizationId: string
): Promise<void> {
  const log = logger.child({ operation: 'deleteAPIKey', keyId });

  try {
    await prisma.aPIKey.deleteMany({
      where: {
        id: keyId,
        organizationId,
      },
    });

    log.info('Deleted API key');
  } catch (error) {
    log.error({ error }, 'Failed to delete API key');
    throw error;
  }
}


export async function verifyAPIKey(apiKey: string): Promise<{
  valid: boolean;
  organizationId?: string;
  scopes?: string[];
  keyId?: string;
}> {
  const log = logger.child({ operation: 'verifyAPIKey' });

  try {
    const keyHash = hashAPIKey(apiKey);


    const key = await prisma.aPIKey.findUnique({
      where: { keyHash },
    });

    if (!key) {
      log.debug('API key not found');
      return { valid: false };
    }


    if (!key.enabled) {
      log.warn({ keyId: key.id }, 'API key is disabled');
      return { valid: false };
    }


    if (key.expiresAt && key.expiresAt < new Date()) {
      log.warn({ keyId: key.id, expiresAt: key.expiresAt }, 'API key expired');
      return { valid: false };
    }


    setImmediate(async () => {
      try {
        await prisma.aPIKey.update({
          where: { id: key.id },
          data: {
            lastUsedAt: new Date(),
            usageCount: { increment: 1 },
          },
        });
      } catch (error) {
        log.error({ error, keyId: key.id }, 'Failed to update API key usage');
      }
    });

    return {
      valid: true,
      organizationId: key.organizationId,
      scopes: key.scopes,
      keyId: key.id,
    };
  } catch (error) {
    log.error({ error }, 'Failed to verify API key');
    return { valid: false };
  }
}


export function hasScope(keyScopes: string[], requiredScope: string): boolean {

  if (keyScopes.includes('*')) {
    return true;
  }


  if (keyScopes.includes(requiredScope)) {
    return true;
  }


  for (const scope of keyScopes) {
    if (scope.endsWith(':*')) {
      const prefix = scope.slice(0, -2);
      if (requiredScope.startsWith(prefix + ':')) {
        return true;
      }
    }
  }

  return false;
}





export const API_SCOPES = {

  READ_CUSTOMERS: 'read:customers',
  READ_SUBSCRIPTIONS: 'read:subscriptions',
  READ_INVOICES: 'read:invoices',
  READ_CAMPAIGNS: 'read:campaigns',
  READ_ANALYTICS: 'read:analytics',
  READ_SETTINGS: 'read:settings',


  WRITE_CUSTOMERS: 'write:customers',
  WRITE_CAMPAIGNS: 'write:campaigns',
  WRITE_SETTINGS: 'write:settings',


  ADMIN: '*',
};
