import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import {
  checkClickHouseHealth,
  connectClickHouse,
  disconnectClickHouse,
} from './infrastructure/clickhouse/index.js';
import {
  checkKafkaHealth,
  connectKafka,
  disconnectKafka,
  startAnalyticsConsumer,
  stopAnalyticsConsumer,
} from './infrastructure/kafka/index.js';

// infrastructure
import {
  checkDatabaseHealth,
  connectDatabase,
  disconnectDatabase,
} from './infrastructure/postgres/index.js';
import {
  checkRedisHealth,
  closeQueues,
  connectRedis,
  disconnectRedis,
  initializeQueues,
} from './infrastructure/redis/index.js';
import { registerAnalyticsRoutes } from './modules/analytics/index.js';
import { registerAPIKeyRoutes } from './modules/api-keys/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import {
  registerAccountRoutes,
  registerAuthRoutes,
  registerMFARoutes,
  registerOAuthRoutes,
} from './modules/auth/index.js';
import { registerRecoveryCreditRoutes } from './modules/billing/recovery-credit-routes.js';
import { registerBillingRoutes } from './modules/billing/routes.js';
import { validateEncryptionKey } from './modules/connections/index.js';
import { registerConnectionRoutes } from './modules/connections/routes.js';
import { registerDetectionRoutes } from './modules/detection/routes.js';
import { registerOrganizationRoutes } from './modules/organizations/index.js';
import { registerRetentionRoutes } from './modules/retention/routes.js';
import { registerSalesRoutes } from './modules/sales/routes.js';
import { registerSettingsRoutes } from './modules/settings/routes.js';
import {
  closeSyncQueue,
  closeSyncWorker,
  initializeSyncQueue,
  initializeSyncWorker,
} from './modules/sync/index.js';
import { registerSyncRoutes } from './modules/sync/routes.js';
import { registerWebhookRoutes } from './modules/webhooks/index.js';
// platforms
import { initializePlatformRegistry } from './platforms/index.js';
import { config } from './shared/config/index.js';
import { generateCorrelationId, logger } from './shared/logger/index.js';
// types
import type { HealthStatus, LivenessStatus, ReadinessStatus } from './shared/types/health.js';
import { startAccountDeletionWorker } from './workers/account-deletion.js';

// create fastify application
const app = Fastify({
  logger: false, // use our custom pino logger
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'correlationId',
  genReqId: () => generateCorrelationId(),
});

// register cors
await app.register(cors, {
  origin: true, // configure based on environment
  credentials: true,
});

// register cookie plugin for http-only auth cookies
await app.register(cookie, {
  secret: config.COOKIE_SECRET,
});

// add correlation ID to all requests
app.addHook('onRequest', async (request, reply) => {
  const correlationId = request.id;
  reply.header('x-correlation-id', correlationId);
});

// log all requests
app.addHook('onRequest', async (request) => {
  logger.info(
    {
      correlationId: request.id,
      method: request.method,
      url: request.url,
    },
    'Incoming request'
  );
});

// log all responses
app.addHook('onResponse', async (request, reply) => {
  logger.info(
    {
      correlationId: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    },
    'Request completed'
  );
});

// liveness probe
app.get('/health/liveness', async () => {
  const response: LivenessStatus = {
    status: 'alive',
    timestamp: new Date().toISOString(),
  };

  return response;
});

// readiness probe. indicates if the application is ready to serve traffic
// checks all infrastructure dependencies
app.get('/health/readiness', async (_request, reply) => {
  const checks = {
    postgres: await checkDatabaseHealth(),
    redis: await checkRedisHealth(),
    kafka: await checkKafkaHealth(),
    clickhouse: await checkClickHouseHealth(),
  };

  const isReady = Object.values(checks).every((check) => check === true);

  const response: ReadinessStatus = {
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
  };

  reply.code(isReady ? 200 : 503);
  return response;
});

// general health check. combines liveness and readiness with additional metadata
app.get('/health', async (_request, reply) => {
  const checks = {
    postgres: await checkDatabaseHealth(),
    redis: await checkRedisHealth(),
    kafka: await checkKafkaHealth(),
    clickhouse: await checkClickHouseHealth(),
  };

  const isHealthy = Object.values(checks).every((check) => check === true);

  const response: HealthStatus = {
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  };

  reply.code(isHealthy ? 200 : 503);
  return response;
});

app.get('/', async () => {
  return {
    name: 'RevenuePlug API',
    version: '0.1.0',
    environment: config.NODE_ENV,
  };
});

app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  logger.error(
    {
      correlationId: request.id,
      error,
      url: request.url,
      method: request.method,
    },
    'Request error'
  );

  reply.status(error.statusCode || 500).send({
    error: 'Internal Server Error',
    message: config.NODE_ENV === 'development' ? error.message : 'An error occurred',
    correlationId: request.id,
  });
});

// Initialize all infrastructure connections
async function initialize(): Promise<void> {
  logger.info('Initializing RevenuePlug');

  try {
    // validate encryption key
    logger.info('Validating encryption key');
    if (!validateEncryptionKey()) {
      throw new Error('Invalid encryption key');
    }

    // connect to infrastructure
    logger.info('Connecting to infrastructure');
    await connectDatabase();
    await connectRedis();
    await connectKafka();
    await connectClickHouse();

    // initialize BullMQ queues
    logger.info('Initializing BullMQ queues');
    await initializeQueues();

    // start background workers
    await startAccountDeletionWorker();

    // initialize sync queue and worker
    logger.info('Initializing sync queue and worker');
    initializeSyncQueue();
    await initializeSyncWorker();

    // initialize platform registry
    logger.info('Initializing platform registry');
    await initializePlatformRegistry();

    // start analytics consumer (kafka → clickhouse)
    logger.info('Starting analytics consumer');
    // await startAnalyticsConsumer();

    // register API routes
    logger.info('Registering API routes');
    await registerAuthRoutes(app);
    await registerOAuthRoutes(app);
    await registerAccountRoutes(app);
    await registerMFARoutes(app);
    await registerOrganizationRoutes(app);
    await registerConnectionRoutes(app);
    await registerBillingRoutes(app);
    await registerRecoveryCreditRoutes(app);
    await registerSalesRoutes(app);
    await registerSyncRoutes(app);
    await registerAnalyticsRoutes(app);
    await registerWebhookRoutes(app);
    await registerAPIKeyRoutes(app);
    // await registerDetectionRoutes(app);
    await registerRetentionRoutes(app);
    await registerAuditRoutes(app);
    await registerSettingsRoutes(app);

    logger.info('Initialization complete');
  } catch (error) {
    logger.fatal({ error }, 'Failed to initialize application');
    throw error;
  }
}

// graceful shutdown. ensures all connections are closed properly
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');

  try {
    // stop accepting new requests
    logger.info('Stopping server');
    await app.close();

    // close infrastructure connections
    logger.info('Closing infrastructure connections');
    await closeSyncWorker();
    await closeSyncQueue();
    await closeQueues();
    await stopAnalyticsConsumer();
    await disconnectKafka();
    await disconnectClickHouse();
    await disconnectRedis();
    await disconnectDatabase();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

// handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

async function start(): Promise<void> {
  try {
    // initialize infrastructure
    await initialize();

    // start server
    await app.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });

    logger.info(
      {
        port: config.PORT,
        environment: config.NODE_ENV,
      },
      'RevenuePlug started successfully'
    );
  } catch (error) {
    logger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
}

// start the application
start();

export { app };
