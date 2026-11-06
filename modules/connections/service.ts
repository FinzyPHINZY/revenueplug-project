/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/postgres/index.js';
import type { PlatformCredentials } from '../../platforms/types.js';
import { logger } from '../../shared/logger/index.js';
import type { AuthType, ConnectionStatus, Platform } from '../../shared/types/index.js';
import * as billingService from '../billing/service.js';
import { decryptCredentials, encryptCredentials } from './encryption.js';

/**
 * Connection service
 * Manages platform connections with encrypted credentials
 */

export interface CreateConnectionParams {
  organizationId: string;
  platform: Platform;
  authType: AuthType;
  credentials: PlatformCredentials;
  metadata?: Record<string, unknown>;
}

export interface ConnectionWithCredentials {
  id: string;
  organizationId: string;
  platform: Platform;
  authType: AuthType;
  status: ConnectionStatus;
  credentials: PlatformCredentials;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create a new platform connection
 */
export async function createConnection(
  params: CreateConnectionParams
): Promise<ConnectionWithCredentials> {
  try {
    const encryptedCredentials = encryptCredentials(
      params.credentials as unknown as Record<string, unknown>
    );

    const connection = await prisma.connection.create({
      data: {
        organizationId: params.organizationId,
        platform: params.platform as any,
        authType: params.authType as any,
        credentials: encryptedCredentials,
        metadata: params.metadata ? (params.metadata as Prisma.JsonObject) : Prisma.JsonNull,
        status: 'ACTIVE',
      },
    });

    logger.info(
      {
        connectionId: connection.id,
        organizationId: params.organizationId,
        platform: params.platform,
      },
      'Connection created'
    );

    // Update connection count for billing
    await billingService
      .updateConnectionCount(params.organizationId)
      .catch((err) => logger.error({ err }, 'Failed to update connection count'));

    return {
      ...connection,
      platform: params.platform,
      authType: params.authType,
      credentials: params.credentials,
      metadata: connection.metadata as Record<string, unknown> | null,
      status: connection.status as ConnectionStatus,
    };
  } catch (error) {
    logger.error(
      { error, organizationId: params.organizationId, platform: params.platform },
      'Failed to create connection'
    );
    throw error;
  }
}

/**
 * Get connection by ID with decrypted credentials
 * Validates connection belongs to the specified organization
 */
export async function getConnection(
  connectionId: string,
  organizationId: string
): Promise<ConnectionWithCredentials | null> {
  try {
    const connection = await prisma.connection.findFirst({
      where: {
        id: connectionId,
        organizationId,
      },
    });

    if (!connection) {
      return null;
    }

    const decryptedCredentials = decryptCredentials(connection.credentials as string);

    return {
      ...connection,
      platform: connection.platform as Platform,
      authType: connection.authType as AuthType,
      credentials: decryptedCredentials as unknown as PlatformCredentials,
      metadata: connection.metadata as Record<string, unknown> | null,
      status: connection.status as ConnectionStatus,
    };
  } catch (error) {
    logger.error({ error, connectionId, organizationId }, 'Failed to get connection');
    throw error;
  }
}

/**
 * Get all connections for an organization
 */
export async function getConnectionsByOrganization(
  organizationId: string
): Promise<ConnectionWithCredentials[]> {
  try {
    const connections = await prisma.connection.findMany({
      where: { organizationId },
    });

    return connections.map((connection) => ({
      ...connection,
      platform: connection.platform as Platform,
      authType: connection.authType as AuthType,
      credentials: decryptCredentials(
        connection.credentials as string
      ) as unknown as PlatformCredentials,
      metadata: connection.metadata as Record<string, unknown> | null,
      status: connection.status as ConnectionStatus,
    }));
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to get connections by organization');
    throw error;
  }
}

/**
 * Update connection credentials
 * Validates connection belongs to the specified organization
 */
export async function updateConnectionCredentials(
  connectionId: string,
  organizationId: string,
  credentials: PlatformCredentials
): Promise<void> {
  try {
    // Validate ownership first
    const connection = await prisma.connection.findFirst({
      where: { id: connectionId, organizationId },
    });

    if (!connection) {
      throw new Error('Connection not found or access denied');
    }

    const encryptedCredentials = encryptCredentials(
      credentials as unknown as Record<string, unknown>
    );

    await prisma.connection.update({
      where: { id: connectionId },
      data: {
        credentials: encryptedCredentials,
        updatedAt: new Date(),
      },
    });

    logger.info({ connectionId, organizationId }, 'Connection credentials updated');
  } catch (error) {
    logger.error({ error, connectionId, organizationId }, 'Failed to update connection credentials');
    throw error;
  }
}

/**
 * Update connection status
 * Validates connection belongs to the specified organization
 */
export async function updateConnectionStatus(
  connectionId: string,
  organizationId: string,
  status: ConnectionStatus
): Promise<void> {
  try {
    // Validate ownership first
    const connection = await prisma.connection.findFirst({
      where: { id: connectionId, organizationId },
    });

    if (!connection) {
      throw new Error('Connection not found or access denied');
    }

    await prisma.connection.update({
      where: { id: connectionId },
      data: { status: status as any, updatedAt: new Date() },
    });

    logger.info({ connectionId, organizationId, status }, 'Connection status updated');
  } catch (error) {
    logger.error({ error, connectionId, organizationId, status }, 'Failed to update connection status');
    throw error;
  }
}

/**
 * Update last synced timestamp
 */
export async function updateLastSynced(connectionId: string): Promise<void> {
  try {
    await prisma.connection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: new Date() },
    });

    logger.debug({ connectionId }, 'Connection last synced timestamp updated');
  } catch (error) {
    logger.error({ error, connectionId }, 'Failed to update last synced timestamp');
    throw error;
  }
}

/**
 * Delete a connection
 * Validates connection belongs to the specified organization
 */
export async function deleteConnection(
  connectionId: string,
  organizationId: string
): Promise<void> {
  try {
    // Validate ownership first
    const connection = await prisma.connection.findFirst({
      where: { id: connectionId, organizationId },
    });

    if (!connection) {
      throw new Error('Connection not found or access denied');
    }

    await prisma.connection.delete({
      where: { id: connectionId },
    });

    logger.info({ connectionId, organizationId }, 'Connection deleted');

    // Update connection count for billing
    await billingService
      .updateConnectionCount(organizationId)
      .catch((err) => logger.error({ err }, 'Failed to update connection count'));
  } catch (error) {
    logger.error({ error, connectionId, organizationId }, 'Failed to delete connection');
    throw error;
  }
}
