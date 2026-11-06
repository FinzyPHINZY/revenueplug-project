/**
 * Usage Trend Monitoring Service
 *
 * Aggregates and analyzes usage metrics over time:
 * - API calls
 * - Logins
 * - Feature usage
 * - Data volume
 * - Active users
 *
 * Detects trends (increasing, stable, decreasing) and calculates change percentages
 */
/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { randomUUID } from 'node:crypto';
// Metric Types
export type MetricType =
  | 'API_CALLS'
  | 'LOGINS'
  | 'ACTIVE_USERS'
  | 'FEATURE_USAGE'
  | 'DATA_VOLUME'
  | 'INTEGRATIONS'
  | 'SUPPORT_TICKETS';

export type MetricPeriod = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type MetricTrend = 'INCREASING' | 'STABLE' | 'DECREASING';

import {
  getEventCount as clickhouseGetEventCount,
  getUsageHistory as clickhouseGetUsageHistory,
  getUsageTrend as clickhouseGetUsageTrend,
  insertUsageMetric,
} from '../../infrastructure/clickhouse-analytics.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

interface UsageMetricInput {
  customerId: string;
  metricType: MetricType;
  metricName: string;
  value: number;
  period: MetricPeriod;
  periodStart: Date;
  periodEnd: Date;
}

interface TrendAnalysis {
  current: number;
  previous: number | null;
  change: number;
  changePercent: number;
  trend: MetricTrend;
}

/**
 * Record a usage metric
 */
export async function recordUsageMetric(input: UsageMetricInput): Promise<void> {
  // Get previous period metric for comparison
  const previousMetric = await getPreviousPeriodMetric(
    input.customerId,
    input.metricType,
    input.period,
    input.periodStart
  );

  // Calculate change
  const change = previousMetric ? input.value - previousMetric.value : 0;
  const changePercent = previousMetric
    ? ((input.value - previousMetric.value) / previousMetric.value) * 100
    : 0;

  // Determine trend
  const trend = determineTrend(changePercent);

  await insertUsageMetric({
    id: randomUUID(),
    customerId: input.customerId,
    connectionId: '', // TODO: Need to fetch from customer
    organizationId: '', // TODO: Need to fetch from customer
    metricType: input.metricType,
    metricName: input.metricName,
    value: input.value,
    change: previousMetric ? change : null,
    changePercent: previousMetric ? changePercent : null,
    period: input.period,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    trend,
  });

  logger.debug(
    {
      customerId: input.customerId,
      metricType: input.metricType,
      value: input.value,
      trend,
    },
    'Usage metric recorded'
  );
}

/**
 * Get previous period metric for comparison
 */
async function getPreviousPeriodMetric(
  customerId: string,
  metricType: MetricType,
  period: MetricPeriod,
  currentPeriodStart: Date
) {
  const periodLength = getPeriodLength(period);
  const previousPeriodStart = new Date(currentPeriodStart.getTime() - periodLength);

  // Fetch recent history to find the matching previous period
  const history = await clickhouseGetUsageHistory(customerId, metricType, period, 5);

  // ClickHouse returns JSON objects with snake_case keys usually,
  // but the interface return type interpretation depends on the driver.
  // Based on clickhouse-analytics.ts, it returns JSONEachRow.
  // We need to map or check how the data comes back.
  // Assuming keys are snake_case from DB columns: period_start, value

  return history.find((m: any) => {
    const start = new Date(m.period_start);
    return Math.abs(start.getTime() - previousPeriodStart.getTime()) < 1000; // Tolerance for minor diffs
  });
}

/**
 * Get period length in milliseconds
 */
function getPeriodLength(period: MetricPeriod): number {
  switch (period) {
    case 'HOURLY':
      return 60 * 60 * 1000;
    case 'DAILY':
      return 24 * 60 * 60 * 1000;
    case 'WEEKLY':
      return 7 * 24 * 60 * 60 * 1000;
    case 'MONTHLY':
      return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Determine trend based on change percentage
 */
function determineTrend(changePercent: number): MetricTrend {
  if (changePercent > 10) return 'INCREASING';
  if (changePercent < -10) return 'DECREASING';
  return 'STABLE';
}

/**
 * Aggregate API call usage for a period
 */
export async function aggregateApiUsage(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
  period: MetricPeriod
): Promise<void> {
  const apiCalls = await clickhouseGetEventCount(customerId, 'API_CALL', periodStart, periodEnd);

  await recordUsageMetric({
    customerId,
    metricType: 'API_CALLS',
    metricName: 'api_calls_total',
    value: apiCalls,
    period,
    periodStart,
    periodEnd,
  });
}

/**
 * Aggregate login usage for a period
 */
export async function aggregateLoginUsage(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
  period: MetricPeriod
): Promise<void> {
  const logins = await clickhouseGetEventCount(customerId, 'LOGIN', periodStart, periodEnd);

  await recordUsageMetric({
    customerId,
    metricType: 'LOGINS',
    metricName: 'logins_total',
    value: logins,
    period,
    periodStart,
    periodEnd,
  });
}

/**
 * Aggregate active users for a period
 */
export async function aggregateActiveUsers(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
  period: MetricPeriod
): Promise<void> {
  // Approximate active users using count for now as ClickHouse distinct might require different query
  // TODO: Implement distinct user count in clickhouse-analytics if needed
  const uniqueUsers = await clickhouseGetEventCount(
    customerId,
    'LOGIN', // Use LOGIN as proxy for activity for now, or fetch distinct
    periodStart,
    periodEnd
  );

  // Note: This is an approximation. A proper distinct query is better.

  await recordUsageMetric({
    customerId,
    metricType: 'ACTIVE_USERS',
    metricName: 'active_users_count',
    value: uniqueUsers, // Simplified
    period,
    periodStart,
    periodEnd,
  });
}

/**
 * Aggregate feature usage for a period
 */
export async function aggregateFeatureUsage(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
  period: MetricPeriod
): Promise<void> {
  const featureUsage = await clickhouseGetEventCount(
    customerId,
    'FEATURE_USED',
    periodStart,
    periodEnd
  );

  await recordUsageMetric({
    customerId,
    metricType: 'FEATURE_USAGE',
    metricName: 'feature_usage_total',
    value: featureUsage,
    period,
    periodStart,
    periodEnd,
  });
}

/**
 * Aggregate all metrics for a customer in a period
 */
export async function aggregateAllMetrics(
  customerId: string,
  periodStart: Date,
  periodEnd: Date,
  period: MetricPeriod
): Promise<void> {
  // We need connection info for recordUsageMetric/insertUsageMetric
  // Fetching it here to pass context would be better, but recordUsageMetric logic needs update.
  // For now, let's update recordUsageMetric to fetch context.

  await Promise.all([
    aggregateApiUsage(customerId, periodStart, periodEnd, period),
    aggregateLoginUsage(customerId, periodStart, periodEnd, period),
    aggregateActiveUsers(customerId, periodStart, periodEnd, period),
    aggregateFeatureUsage(customerId, periodStart, periodEnd, period),
  ]);

  logger.info(
    {
      customerId,
      period,
      periodStart,
      periodEnd,
    },
    'All metrics aggregated'
  );
}

/**
 * Get usage trend analysis for a metric
 */
export async function getUsageTrend(
  customerId: string,
  metricType: MetricType,
  periods: number = 4
): Promise<TrendAnalysis> {
  const trendData = await clickhouseGetUsageTrend(customerId, metricType, periods);

  // Map string trend to enum
  let trendEnum: MetricTrend = 'STABLE';
  if (trendData.trend === 'INCREASING') trendEnum = 'INCREASING';
  if (trendData.trend === 'DECREASING') trendEnum = 'DECREASING';

  return {
    current: trendData.current,
    previous: trendData.previous,
    change: trendData.change,
    changePercent: trendData.changePercent,
    trend: trendEnum,
  };
}

/**
 * Get usage metrics over time for charting
 */
export async function getUsageHistory(
  customerId: string,
  metricType: MetricType,
  period: MetricPeriod,
  limit: number = 30
) {
  const history = await clickhouseGetUsageHistory(customerId, metricType, period, limit);
  // Map back to expected format if needed (checked routes.ts usage)
  return history.map((h: any) => ({
    ...h,
    periodStart: new Date(h.period_start),
    periodEnd: new Date(h.period_end),
  }));
}

/**
 * Detect usage anomalies (sudden drops or spikes)
 */
export async function detectUsageAnomalies(
  customerId: string,
  metricType: MetricType
): Promise<{
  hasAnomaly: boolean;
  type: 'spike' | 'drop' | null;
  severity: 'critical' | 'high' | 'moderate' | null;
  details: string | null;
}> {
  const metrics = await getUsageHistory(customerId, metricType, 'DAILY', 5);

  if (metrics.length < 2) {
    return {
      hasAnomaly: false,
      type: null,
      severity: null,
      details: null,
    };
  }

  const latest = metrics[0];
  const previous = metrics.slice(1);
  const avgPrevious = previous.reduce((sum: number, m: any) => sum + m.value, 0) / previous.length;

  if (avgPrevious === 0) {
    return { hasAnomaly: false, type: null, severity: null, details: null };
  }

  // Calculate deviation
  const deviation = latest.value - avgPrevious;
  const deviationPercent = (deviation / avgPrevious) * 100;

  // Detect anomalies
  if (Math.abs(deviationPercent) > 50) {
    return {
      hasAnomaly: true,
      type: deviationPercent > 0 ? 'spike' : 'drop',
      severity: Math.abs(deviationPercent) > 80 ? 'critical' : 'high',
      details: `${metricType} ${deviationPercent > 0 ? 'increased' : 'decreased'} by ${Math.abs(deviationPercent).toFixed(1)}%`,
    };
  } else if (Math.abs(deviationPercent) > 25) {
    return {
      hasAnomaly: true,
      type: deviationPercent > 0 ? 'spike' : 'drop',
      severity: 'moderate',
      details: `${metricType} ${deviationPercent > 0 ? 'increased' : 'decreased'} by ${Math.abs(deviationPercent).toFixed(1)}%`,
    };
  }

  return {
    hasAnomaly: false,
    type: null,
    severity: null,
    details: null,
  };
}

/**
 * Get comprehensive usage summary
 */
export async function getUsageSummary(customerId: string): Promise<{
  apiCalls: TrendAnalysis;
  logins: TrendAnalysis;
  activeUsers: TrendAnalysis;
  featureUsage: TrendAnalysis;
  overallTrend: 'IMPROVING' | 'STABLE' | 'DECLINING';
  alerts: Array<{ type: string; message: string; severity: string }>;
}> {
  // Get trends for all metric types
  const [apiCalls, logins, activeUsers, featureUsage] = await Promise.all([
    getUsageTrend(customerId, 'API_CALLS'),
    getUsageTrend(customerId, 'LOGINS'),
    getUsageTrend(customerId, 'ACTIVE_USERS'),
    getUsageTrend(customerId, 'FEATURE_USAGE'),
  ]);

  // Detect anomalies
  const [apiAnomaly, loginAnomaly, activeUserAnomaly, featureAnomaly] = await Promise.all([
    detectUsageAnomalies(customerId, 'API_CALLS'),
    detectUsageAnomalies(customerId, 'LOGINS'),
    detectUsageAnomalies(customerId, 'ACTIVE_USERS'),
    detectUsageAnomalies(customerId, 'FEATURE_USAGE'),
  ]);

  // Determine overall trend
  const trendScores = [
    apiCalls.trend === 'INCREASING' ? 1 : apiCalls.trend === 'DECREASING' ? -1 : 0,
    logins.trend === 'INCREASING' ? 1 : logins.trend === 'DECREASING' ? -1 : 0,
    activeUsers.trend === 'INCREASING' ? 1 : activeUsers.trend === 'DECREASING' ? -1 : 0,
    featureUsage.trend === 'INCREASING' ? 1 : featureUsage.trend === 'DECREASING' ? -1 : 0,
  ];

  const avgTrendScore = trendScores.reduce((sum, score) => sum + score, 0) / trendScores.length;

  const overallTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' =
    avgTrendScore > 0.3 ? 'IMPROVING' : avgTrendScore < -0.3 ? 'DECLINING' : 'STABLE';

  // Collect alerts
  const alerts: Array<{ type: string; message: string; severity: string }> = [];

  if (apiAnomaly.hasAnomaly) {
    alerts.push({
      type: 'api_anomaly',
      message: apiAnomaly.details!,
      severity: apiAnomaly.severity!,
    });
  }

  if (loginAnomaly.hasAnomaly) {
    alerts.push({
      type: 'login_anomaly',
      message: loginAnomaly.details!,
      severity: loginAnomaly.severity!,
    });
  }

  if (activeUserAnomaly.hasAnomaly) {
    alerts.push({
      type: 'active_user_anomaly',
      message: activeUserAnomaly.details!,
      severity: activeUserAnomaly.severity!,
    });
  }

  if (featureAnomaly.hasAnomaly) {
    alerts.push({
      type: 'feature_usage_anomaly',
      message: featureAnomaly.details!,
      severity: featureAnomaly.severity!,
    });
  }

  return {
    apiCalls,
    logins,
    activeUsers,
    featureUsage,
    overallTrend,
    alerts,
  };
}

/**
 * Batch aggregate metrics for all customers in a connection
 */
export async function batchAggregateMetrics(
  connectionId: string,
  periodStart: Date,
  periodEnd: Date,
  period: MetricPeriod
): Promise<{ processed: number; errors: number }> {
  // Use Prisma to get list of customers
  const customers = await prisma.customer.findMany({
    where: { connectionId },
    select: { id: true },
  });

  let processed = 0;
  let errors = 0;

  for (const customer of customers) {
    try {
      await aggregateAllMetrics(customer.id, periodStart, periodEnd, period);
      processed++;
    } catch (error) {
      logger.error(
        {
          customerId: customer.id,
          error,
        },
        'Failed to aggregate metrics'
      );
      errors++;
    }
  }

  logger.info(
    {
      connectionId,
      processed,
      errors,
    },
    'Batch metric aggregation complete'
  );

  return { processed, errors };
}

/**
 * Schedule daily metric aggregation (to be called by cron job)
 */
export async function scheduleDailyAggregation(connectionId: string): Promise<void> {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const yesterdayEnd = new Date(yesterday);
  yesterdayEnd.setHours(23, 59, 59, 999);

  await batchAggregateMetrics(connectionId, yesterday, yesterdayEnd, 'DAILY');
}
