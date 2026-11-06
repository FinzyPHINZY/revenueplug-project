import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';

let clickhouseClient: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!clickhouseClient) {
    throw new Error('ClickHouse client not initialized. Call connectClickHouse() first.');
  }
  return clickhouseClient;
}

export async function connectClickHouse(): Promise<void> {
  try {
    clickhouseClient = createClient({
      url: config.CLICKHOUSE_URL,
      database: config.CLICKHOUSE_DATABASE,
      request_timeout: 30000,
      compression: {
        request: true,
        response: true,
      },
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 0,
      },
    });
    await clickhouseClient.ping();

    logger.info('Connected to ClickHouse');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to ClickHouse');
    throw error;
  }
}


export async function disconnectClickHouse(): Promise<void> {
  try {
    if (clickhouseClient) {
      await clickhouseClient.close();
      clickhouseClient = null;
    }
    logger.info('Disconnected from ClickHouse');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from ClickHouse');
    throw error;
  }
}

export async function checkClickHouseHealth(): Promise<boolean> {
  try {
    if (!clickhouseClient) {
      return false;
    }

    const result = await clickhouseClient.ping();
    return result.success;
  } catch (error) {
    logger.error({ error }, 'ClickHouse health check failed');
    return false;
  }
}

export async function insertEvents<T extends Record<string, unknown>>(
  table: string,
  events: T[]
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  try {
    const client = getClickHouseClient();

    await client.insert({
      table,
      values: events,
      format: 'JSONEachRow',
    });

    logger.debug({ table, count: events.length }, 'Inserted events into ClickHouse');
  } catch (error) {
    logger.error({ error, table, count: events.length }, 'Failed to insert events into ClickHouse');
    throw error;
  }
}

export async function queryClickHouse<T = unknown>(query: string): Promise<T[]> {
  try {
    const client = getClickHouseClient();

    const resultSet = await client.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await resultSet.json<T>();

    logger.debug({ query }, 'Executed ClickHouse query');

    return rows;
  } catch (error) {
    logger.error({ error, query }, 'Failed to execute ClickHouse query');
    throw error;
  }
}
