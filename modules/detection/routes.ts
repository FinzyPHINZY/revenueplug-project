/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  getChurnRiskHistory,
  getHealthScoreHistory,
} from '../../infrastructure/clickhouse-analytics.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import { requireAuth } from '../auth/index.js';

import {
  analyzeAndSaveChurnRisk,
  analyzeAndSavePaymentPattern,
  analyzeBehavioralPatterns,
  calculateAndSaveHealthScore,
  getEventTimeline,
  getHighPaymentRiskCustomers,
  getHighRiskCustomers,
  getHighRiskPredictions as getHighRiskPaymentPredictions,
  getLatestChurnRisk,
  getLatestHealthScore,
  getLatestPaymentPattern,
  getRecentEvents,
  getUsageHistory,
  getUsageSummary,
  predictInvoiceFailure,
  predictUpcomingInvoiceFailures,
} from './index.js';

// Validation schemas
const CustomerIdSchema = z.object({
  customerId: z.string(),
});

const ConnectionIdSchema = z.object({
  connectionId: z.string(),
});

const UsageHistorySchema = z.object({
  customerId: z.string(),
  metricType: z.enum([
    'API_CALLS',
    'LOGINS',
    'ACTIVE_USERS',
    'FEATURE_USAGE',
    'DATA_VOLUME',
    'INTEGRATIONS',
    'SUPPORT_TICKETS',
  ]),
  period: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});

/**
 * Register detection engine routes
 */
export async function registerDetectionRoutes(app: FastifyInstance): Promise<void> {
  // All routes require authentication
  app.addHook('preHandler', requireAuth);
  // All routes require organization context
  app.addHook('preHandler', requireOrganizationContext);

  // Health Score endpoints
  app.get('/api/detection/health-score/:customerId', handleGetHealthScore);
  app.get('/api/detection/health-score/:customerId/history', handleGetHealthScoreHistory);
  app.post('/api/detection/health-score/:customerId/calculate', handleCalculateHealthScore);

  // Churn Risk endpoints
  app.get('/api/detection/churn-risk/:customerId', handleGetChurnRisk);
  app.get('/api/detection/churn-risk/:customerId/history', handleGetChurnRiskHistory);
  app.post('/api/detection/churn-risk/:customerId/analyze', handleAnalyzeChurnRisk);
  app.get('/api/detection/churn-risk/high-risk/:connectionId', handleGetHighRiskCustomers);

  // Behavioral Analytics endpoints
  app.get('/api/detection/behavioral/:customerId/patterns', handleGetBehavioralPatterns);
  app.get('/api/detection/behavioral/:customerId/events', handleGetRecentEvents);
  app.get('/api/detection/behavioral/:customerId/timeline', handleGetBehavioralTimeline);

  // Usage Analytics endpoints
  app.get('/api/detection/usage/:customerId/summary', handleGetUsageSummary);
  app.get('/api/detection/usage/:customerId/history', handleGetUsageHistory);

  // Payment Pattern endpoints
  app.get('/api/detection/payment-pattern/:customerId', handleGetPaymentPattern);
  app.post('/api/detection/payment-pattern/:customerId/analyze', handleAnalyzePaymentPattern);
  app.get('/api/detection/payment-pattern/high-risk/:connectionId', handleGetHighPaymentRisk);

  // Comprehensive customer analysis
  app.get('/api/detection/customer/:customerId/analysis', handleGetCustomerAnalysis);

  // Payment Failure Prediction endpoints
  app.post('/api/detection/prediction/invoice/:invoiceId', handlePredictInvoiceFailure);
  app.post('/api/detection/prediction/upcoming/:organizationId', handlePredictUpcomingInvoices);
  app.get('/api/detection/prediction/high-risk/:organizationId', handleGetHighRiskPredictions);
}

/**
 * Get health score for a customer
 */
async function handleGetHealthScore(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    // Verify customer belongs to user's organization
    await verifyCustomerAccess(request, customerId);

    const healthScore = await getLatestHealthScore(customerId);

    if (!healthScore) {
      return reply.status(404).send({
        error: 'Health score not found',
        message: 'No health score calculated for this customer yet',
      });
    }

    return reply.send(healthScore);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get health score');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Calculate health score for a customer
 */
async function handleCalculateHealthScore(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const healthScore = await calculateAndSaveHealthScore(customerId);

    return reply.send(healthScore);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to calculate health score');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get churn risk for a customer
 */
async function handleGetChurnRisk(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const churnRisk = await getLatestChurnRisk(customerId);

    if (!churnRisk) {
      return reply.status(404).send({
        error: 'Churn risk not found',
        message: 'No churn risk analysis for this customer yet',
      });
    }

    return reply.send(churnRisk);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get churn risk');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Analyze churn risk for a customer
 */
async function handleAnalyzeChurnRisk(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const churnRisk = await analyzeAndSaveChurnRisk(customerId);

    return reply.send(churnRisk);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to analyze churn risk');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get high-risk customers for a connection
 */
async function handleGetHighRiskCustomers(
  request: FastifyRequest<{ Params: { connectionId: string } }>,
  reply: FastifyReply
) {
  try {
    const { connectionId } = ConnectionIdSchema.parse(request.params);

    await verifyConnectionAccess(request, connectionId);

    const highRiskCustomers = await getHighRiskCustomers(connectionId);

    return reply.send({
      count: highRiskCustomers.length,
      customers: highRiskCustomers,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get high-risk customers');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get behavioral patterns for a customer
 */
async function handleGetBehavioralPatterns(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const patterns = await analyzeBehavioralPatterns(customerId);

    return reply.send(patterns);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get behavioral patterns');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get recent events for a customer
 */
async function handleGetRecentEvents(
  request: FastifyRequest<{
    Params: { customerId: string };
    Querystring: { limit?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;

    await verifyCustomerAccess(request, customerId);

    const events = await getRecentEvents(customerId, limit);

    return reply.send({
      count: events.length,
      events,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get recent events');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get usage summary for a customer
 */
async function handleGetUsageSummary(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const summary = await getUsageSummary(customerId);

    return reply.send(summary);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get usage summary');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get usage history for a customer
 */
async function handleGetUsageHistory(
  request: FastifyRequest<{
    Params: { customerId: string };
    Querystring: {
      metricType?: string;
      period?: string;
      limit?: string;
    };
  }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = request.params;
    const metricType = (request.query.metricType as any) || 'API_CALLS';
    const period = (request.query.period as any) || 'DAILY';
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 30;

    await verifyCustomerAccess(request, customerId);

    const history = await getUsageHistory(customerId, metricType, period, limit);

    return reply.send({
      metricType,
      period,
      count: history.length,
      data: history,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get usage history');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get payment pattern for a customer
 */
async function handleGetPaymentPattern(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const pattern = await getLatestPaymentPattern(customerId);

    if (!pattern) {
      return reply.status(404).send({
        error: 'Payment pattern not found',
        message: 'No payment pattern analysis for this customer yet',
      });
    }

    return reply.send(pattern);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get payment pattern');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Analyze payment pattern for a customer
 */
async function handleAnalyzePaymentPattern(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    const pattern = await analyzeAndSavePaymentPattern(customerId);

    return reply.send(pattern);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to analyze payment pattern');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get high payment risk customers
 */
async function handleGetHighPaymentRisk(
  request: FastifyRequest<{ Params: { connectionId: string } }>,
  reply: FastifyReply
) {
  try {
    const { connectionId } = ConnectionIdSchema.parse(request.params);

    await verifyConnectionAccess(request, connectionId);

    const highRiskCustomers = await getHighPaymentRiskCustomers(connectionId);

    return reply.send({
      count: highRiskCustomers.length,
      customers: highRiskCustomers,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get high payment risk customers');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get comprehensive customer analysis
 */
async function handleGetCustomerAnalysis(
  request: FastifyRequest<{ Params: { customerId: string } }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);

    await verifyCustomerAccess(request, customerId);

    // Fetch all analysis data in parallel
    const [healthScore, churnRisk, behavioralPatterns, usageSummary, paymentPattern] =
      await Promise.all([
        getLatestHealthScore(customerId),
        getLatestChurnRisk(customerId),
        analyzeBehavioralPatterns(customerId),
        getUsageSummary(customerId),
        getLatestPaymentPattern(customerId),
      ]);

    // Get customer details
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return reply.send({
      customer: {
        id: customer?.id,
        email: customer?.email,
        name: customer?.name,
        platform: customer?.platform,
      },
      healthScore,
      churnRisk,
      behavioralPatterns,
      usageSummary,
      paymentPattern,
      lastUpdated: new Date(),
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get customer analysis');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get health score history for a customer (from ClickHouse)
 */
async function handleGetHealthScoreHistory(
  request: FastifyRequest<{
    Params: { customerId: string };
    Querystring: { days?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);
    const days = request.query.days ? parseInt(request.query.days, 10) : 30;

    await verifyCustomerAccess(request, customerId);

    const history = await getHealthScoreHistory(customerId, days);

    return reply.send({
      customerId,
      days,
      history,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get health score history');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get churn risk history for a customer (from ClickHouse)
 */
async function handleGetChurnRiskHistory(
  request: FastifyRequest<{
    Params: { customerId: string };
    Querystring: { days?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);
    const days = request.query.days ? parseInt(request.query.days, 10) : 30;

    await verifyCustomerAccess(request, customerId);

    const history = await getChurnRiskHistory(customerId, days);

    return reply.send({
      customerId,
      days,
      history,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get churn risk history');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get behavioral event timeline for a customer (from ClickHouse)
 */
async function handleGetBehavioralTimeline(
  request: FastifyRequest<{
    Params: { customerId: string };
    Querystring: { days?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { customerId } = CustomerIdSchema.parse(request.params);
    const days = request.query.days ? parseInt(request.query.days, 10) : 7;

    await verifyCustomerAccess(request, customerId);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const timeline = await getEventTimeline(customerId, startDate);

    return reply.send({
      customerId,
      days,
      startDate,
      timeline,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get behavioral timeline');
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Verify customer belongs to user's organization
 */
async function verifyCustomerAccess(request: any, customerId: string): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { connection: true },
  });

  if (!customer) {
    throw new Error('Customer not found');
  }

  // Ensure organization context is set
  if (!request.organization?.id) {
    throw new Error('Organization context required');
  }

  if (customer.connection.organizationId !== request.organization.id) {
    throw new Error('Unauthorized');
  }
}

/**
 * Verify connection belongs to user's organization
 */
async function verifyConnectionAccess(request: any, connectionId: string): Promise<void> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
  });

  if (!connection) {
    throw new Error('Connection not found');
  }

  // Ensure organization context is set
  if (!request.organization?.id) {
    throw new Error('Organization context required');
  }

  if (connection.organizationId !== request.organization.id) {
    throw new Error('Unauthorized');
  }
}

/**
 * Predict payment failure for a specific invoice
 */
async function handlePredictInvoiceFailure(
  request: FastifyRequest<{ Params: { invoiceId: string } }>,
  reply: FastifyReply
) {
  try {
    const { invoiceId } = request.params;

    // Get invoice to verify organization access
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { connection: true },
    });

    if (!invoice) {
      return reply.status(404).send({ error: 'Invoice not found' });
    }

    // Ensure organization context is set
    if (!request.organization?.id) {
      return reply.status(403).send({ error: 'Organization context required' });
    }

    if (invoice.connection.organizationId !== request.organization.id) {
      return reply.status(403).send({ error: 'Unauthorized' });
    }

    const prediction = await predictInvoiceFailure(invoiceId);

    return reply.send(prediction);
  } catch (error: any) {
    request.log.error({ error }, 'Failed to predict invoice failure');
    return reply.status(500).send({
      error: 'Internal server error',
      message: error.message,
    });
  }
}

/**
 * Predict failures for all upcoming invoices
 */
async function handlePredictUpcomingInvoices(
  request: FastifyRequest<{
    Params: { organizationId: string };
    Querystring: { days?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { organizationId } = request.params;

    // Verify organization access
    // If request has organization context, use that to validate param
    if (request.organization?.id && organizationId !== request.organization.id) {
      return reply.status(403).send({ error: 'Unauthorized' });
    }

    const days = request.query.days ? parseInt(request.query.days, 10) : 30;

    const predictions = await predictUpcomingInvoiceFailures(organizationId, days);

    return reply.send({
      organizationId,
      daysAhead: days,
      count: predictions.length,
      predictions,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to predict upcoming invoices');
    return reply.status(500).send({
      error: 'Internal server error',
      message: error.message,
    });
  }
}

/**
 * Get high-risk payment predictions
 */
async function handleGetHighRiskPredictions(
  request: FastifyRequest<{
    Params: { organizationId: string };
    Querystring: { minRiskLevel?: string };
  }>,
  reply: FastifyReply
) {
  try {
    const { organizationId } = request.params;

    // Verify organization access
    // If request has organization context, use that to validate param
    if (request.organization?.id && organizationId !== request.organization.id) {
      return reply.status(403).send({ error: 'Unauthorized' });
    }

    const minRiskLevel = (request.query.minRiskLevel as any) || 'HIGH';

    const predictions = await getHighRiskPaymentPredictions(organizationId, minRiskLevel);

    return reply.send({
      organizationId,
      minRiskLevel,
      count: predictions.length,
      predictions,
    });
  } catch (error: any) {
    request.log.error({ error }, 'Failed to get high-risk predictions');
    return reply.status(500).send({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
