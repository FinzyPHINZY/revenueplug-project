import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { logger } from '../shared/logger/index.js';
import { config } from '../shared/config/index.js';

let clickhouseClient: ClickHouseClient;

export function initializeClickHouse(): ClickHouseClient {
  if (clickhouseClient) {
    return clickhouseClient;
  }

  clickhouseClient = createClient({
    url: config.CLICKHOUSE_URL,
    database: config.CLICKHOUSE_DATABASE,
    username: config.CLICKHOUSE_USERNAME,
    password: config.CLICKHOUSE_PASSWORD,
    compression: {
      request: true,
      response: true,
    },
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_max_data_size: '10485760', // 10MB
      async_insert_busy_timeout_ms: 1000, // 1 second
    },
  });

  logger.info(
    {
      url: config.CLICKHOUSE_URL,
      database: config.CLICKHOUSE_DATABASE,
    },
    'ClickHouse client initialized'
  );

  return clickhouseClient;
}

export function getClickHouse(): ClickHouseClient {
  if (!clickhouseClient) {
    return initializeClickHouse();
  }
  return clickhouseClient;
}

export async function checkClickHouseHealth(): Promise<boolean> {
  try {
    const client = getClickHouse();
    const result = await client.query({
      query: 'SELECT 1',
      format: 'JSONEachRow',
    });

    await result.json();
    return true;
  } catch (error) {
    logger.error({ error }, 'ClickHouse health check failed');
    return false;
  }
}

export async function closeClickHouse(): Promise<void> {
  if (clickhouseClient) {
    await clickhouseClient.close();
    logger.info('ClickHouse connection closed');
  }
}

export const clickhouse = {
  client: getClickHouse,
  health: checkClickHouseHealth,
  close: closeClickHouse,
};
