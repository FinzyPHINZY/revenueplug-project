import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger/index.js';
import {
  getOrganizationContext,
  requireOrganizationContext,
} from '../../shared/middleware/organization-context.js';
import { enforceApiUsageLimit } from '../../shared/middleware/usage-limits.js';
import { requireAuth } from '../auth/middleware.js';
import * as analyticsService from './service.js';
import * as roiCalculator from './roi-calculator.js';
import * as revenueForecast from './revenue-forecasting.js';
import * as clickhouseAnalytics from '../../infrastructure/clickhouse-analytics.js';

const FailedPaymentsQuerySchema = z.object({
  connection_id: z.string().min(1),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
  recovery_potential: z.enum(['high', 'medium', 'low']).optional(),
  risk_type: z.enum(['active_failure', 'upcoming_due', 'all']).optional().default('all'),
  min_amount: z.coerce.number().min(0).optional(),
  max_amount: z.coerce.number().min(0).optional(),
  upcoming_days: z.coerce.number().min(1).max(30).optional().default(7),
});

const SummaryQuerySchema = z.object({
  connection_id: z.string().min(1),
});

const ForecastQuerySchema = z.object({
  horizon: z.enum(['THIRTY_DAYS', 'NINETY_DAYS', 'ONE_YEAR']).optional().default('THIRTY_DAYS'),
  include_growth: z.coerce.boolean().optional().default(false),
  growth_rate: z.coerce.number().min(0).max(1).optional(),
});

const RecoveryImpactQuerySchema = z.object({});

const TrendsQuerySchema = z.object({
  days: z.coerce.number().min(7).max(90).optional().default(30),
});

const RecoveredRevenueQuerySchema = z.object({
  days: z.coerce.number().min(7).max(90).optional().default(30),
});

async function handleGetFailedPayments(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetFailedPayments' });

  try {
    const query = FailedPaymentsQuerySchema.parse(request.query);

    const { id: organizationId } = getOrganizationContext(request);

    const result = await analyticsService.getFailedPayments(
      {
        connectionId: query.connection_id,
        limit: query.limit,
        offset: query.offset,
        recoveryPotential: query.recovery_potential,
        riskType: query.risk_type,
        minAmount: query.min_amount,
        maxAmount: query.max_amount,
        upcomingDays: query.upcoming_days,
      },
      organizationId
    );

    log.info(
      {
        connection_id: query.connection_id,
        organization_id: organizationId,
        count: result.payments.length,
        total: result.total,
        hasMore: result.hasMore,
        hiddenCount: result.hiddenCount,
      },
      'Retrieved failed payments'
    );

    return reply.code(200).send({
      payments: result.payments,
      total: result.total,
      limit: query.limit,
      offset: query.offset,
      has_more: result.hasMore,
      hidden_count: result.hiddenCount,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get failed payments');
    return reply.code(500).send({
      error: 'Failed to retrieve failed payments',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetSummary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetSummary' });

  try {
    const query = SummaryQuerySchema.parse(request.query);

    const { id: organizationId } = getOrganizationContext(request);

    const summary = await analyticsService.getFailedPaymentsSummary(
      query.connection_id,
      organizationId
    );

    log.info(
      {
        connection_id: query.connection_id,
        organization_id: organizationId,
        total_count: summary.totalCount,
        total_revenue: summary.totalRevenue,
      },
      'Retrieved dashboard summary'
    );

    return reply.code(200).send(summary);
  } catch (error) {
    log.error({ error }, 'Failed to get dashboard summary');
    return reply.code(500).send({
      error: 'Failed to retrieve dashboard summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetROI(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetROI' });

  try {
    const { id: organizationId } = getOrganizationContext(request);

    const metrics = await roiCalculator.calculateROI(organizationId);

    log.info(
      {
        organizationId,
        roiMultiplier: metrics.roiMultiplier,
        recovered: metrics.totalRecoveredRevenue,
      },
      'Retrieved ROI metrics'
    );

    return reply.code(200).send(metrics);
  } catch (error) {
    log.error({ error }, 'Failed to get ROI metrics');
    return reply.code(500).send({
      error: 'Failed to retrieve ROI metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetROISummary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetROISummary' });

  try {
    const { id: organizationId } = getOrganizationContext(request);

    const summary = await roiCalculator.getROISummary(organizationId);

    log.info({ organizationId, roi: summary.roi }, 'Retrieved ROI summary');

    return reply.code(200).send(summary);
  } catch (error) {
    log.error({ error }, 'Failed to get ROI summary');
    return reply.code(500).send({
      error: 'Failed to retrieve ROI summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetForecast(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetForecast' });

  try {
    const query = ForecastQuerySchema.parse(request.query);
    const { id: organizationId } = getOrganizationContext(request);

    const forecast = await revenueForecast.generateRevenueForecast({
      organizationId,
      horizon: query.horizon,
      includeGrowth: query.include_growth,
      growthRate: query.growth_rate,
    });

    log.info(
      {
        organizationId,
        horizon: query.horizon,
        currentMRR: forecast.currentMRR,
        forecastedMRR: forecast.forecastedMRR,
        confidence: forecast.confidence,
      },
      'Generated revenue forecast'
    );

    return reply.code(200).send(forecast);
  } catch (error) {
    log.error({ error }, 'Failed to generate revenue forecast');
    return reply.code(500).send({
      error: 'Failed to generate revenue forecast',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetRecoveryImpact(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetRecoveryImpact' });

  try {
    RecoveryImpactQuerySchema.parse(request.query);
    const { id: organizationId } = getOrganizationContext(request);

    const impact = await revenueForecast.getRecoveryImpact(organizationId);

    log.info(
      {
        organizationId,
        customersAtRisk: impact.customersAtRisk,
        revenueAtRisk: impact.revenueAtRisk,
        expectedRecoveredRevenue: impact.expectedRecoveredRevenue,
      },
      'Retrieved recovery impact projection'
    );

    return reply.code(200).send(impact);
  } catch (error) {
    log.error({ error }, 'Failed to get recovery impact');
    return reply.code(500).send({
      error: 'Failed to retrieve recovery impact',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetTrends(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetTrends' });

  try {
    const query = TrendsQuerySchema.parse(request.query);
    const { id: organizationId } = getOrganizationContext(request);

    const trends = await clickhouseAnalytics.getPaymentTrends(organizationId, query.days);

    log.info(
      {
        organizationId,
        days: query.days,
        dataPoints: trends.length,
      },
      'Retrieved payment trends'
    );

    return reply.code(200).send({
      period: query.days,
      dataPoints: trends.length,
      trends,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get payment trends');
    return reply.code(500).send({
      error: 'Failed to retrieve payment trends',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetRecoveredRevenueAnalytics(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetRecoveredRevenueAnalytics' });

  try {
    const query = RecoveredRevenueQuerySchema.parse(request.query);
    const { id: organizationId } = getOrganizationContext(request);

    const data = await clickhouseAnalytics.getRecoveredRevenue(organizationId, query.days);

    log.info(
      {
        organizationId,
        days: query.days,
        totalRecovered: data.totalRecovered,
        recoveredCount: data.recoveredCount,
        avgDaysToRecover: data.avgDaysToRecover,
      },
      'Retrieved recovered revenue analytics'
    );

    return reply.code(200).send({
      period: query.days,
      totalRecovered: data.totalRecovered,
      totalRecoveredUSD: (data.totalRecovered / 100).toFixed(2),
      recoveredCount: data.recoveredCount,
      avgDaysToRecover: Math.round(data.avgDaysToRecover * 10) / 10,
      recoveredPayments: data.recoveredPayments.slice(0, 100),
    });
  } catch (error) {
    log.error({ error }, 'Failed to get recovered revenue analytics');
    return reply.code(500).send({
      error: 'Failed to retrieve recovered revenue analytics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/dashboard/failed-payments',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetFailedPayments
  );

  app.get(
    '/api/dashboard/summary',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetSummary
  );

  app.get(
    '/api/dashboard/roi',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetROI
  );

  app.get(
    '/api/dashboard/roi/summary',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetROISummary
  );

  app.get(
    '/api/dashboard/forecast',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetForecast
  );

  app.get(
    '/api/dashboard/forecast/recovery-impact',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetRecoveryImpact
  );

  app.get(
    '/api/analytics/trends',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetTrends
  );

  app.get(
    '/api/analytics/recovered-revenue',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleGetRecoveredRevenueAnalytics
  );

  logger.info('Registered analytics routes');
}
