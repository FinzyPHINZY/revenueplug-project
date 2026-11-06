/**
 * Campaign Metrics Aggregation Service
 *
 * Calculates and aggregates retention campaign performance metrics
 * Runs daily to populate CampaignMetrics table for fast dashboard queries
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

const log = logger.child({ module: 'metrics-aggregation' });

/**
 * Aggregate campaign metrics for a specific period
 */
export async function aggregateCampaignMetrics(
  organizationId: string,
  strategyId: string | null,
  period: Date,
  periodType: 'DAILY' | 'WEEKLY' | 'MONTHLY'
): Promise<void> {
  const operationLog = log.child({
    operation: 'aggregateCampaignMetrics',
    organizationId,
    strategyId,
    period: period.toISOString(),
    periodType,
  });

  try {
    // Calculate date range based on period type
    const { startDate, endDate } = getPeriodRange(period, periodType);

    // Build where clause
    const whereClause: any = {
      organizationId,
      startedAt: {
        gte: startDate,
        lt: endDate,
      },
    };

    if (strategyId) {
      whereClause.strategyId = strategyId;
    }

    // Get campaign counts by status
    const [
      totalTriggered,
      totalActive,
      totalConverted,
      totalCancelled,
      totalFailed,
      totalCompleted,
    ] = await Promise.all([
      prisma.campaign.count({ where: whereClause }),
      prisma.campaign.count({ where: { ...whereClause, status: 'ACTIVE' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'CONVERTED' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'CANCELLED' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'FAILED' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'COMPLETED' } }),
    ]);

    // Get action counts
    const campaigns = await prisma.campaign.findMany({
      where: whereClause,
      select: { id: true },
    });

    const campaignIds = campaigns.map((c) => c.id);

    const [
      totalActionsSent,
      totalActionsDelivered,
      totalActionsFailed,
      emailActions,
    ] = await Promise.all([
      prisma.campaignAction.count({
        where: {
          campaignId: { in: campaignIds },
          status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'] },
        },
      }),
      prisma.campaignAction.count({
        where: {
          campaignId: { in: campaignIds },
          status: { in: ['DELIVERED', 'OPENED', 'CLICKED'] },
        },
      }),
      prisma.campaignAction.count({
        where: {
          campaignId: { in: campaignIds },
          status: 'FAILED',
        },
      }),
      // Get email-specific actions
      prisma.campaignAction.findMany({
        where: {
          campaignId: { in: campaignIds },
          actionType: 'EMAIL',
        },
        select: {
          status: true,
        },
      }),
    ]);

    // Calculate email metrics
    const emailsSent = emailActions.length;
    const emailsDelivered = emailActions.filter((a) =>
      ['DELIVERED', 'OPENED', 'CLICKED'].includes(a.status)
    ).length;
    const emailsOpened = emailActions.filter((a) =>
      ['OPENED', 'CLICKED'].includes(a.status)
    ).length;
    const emailsClicked = emailActions.filter((a) => a.status === 'CLICKED').length;
    const emailsBounced = emailActions.filter((a) => a.status === 'FAILED').length;

    // Calculate rates
    const conversionRate = totalTriggered > 0 ? totalConverted / totalTriggered : 0;
    const emailOpenRate = emailsDelivered > 0 ? emailsOpened / emailsDelivered : 0;
    const emailClickRate = emailsDelivered > 0 ? emailsClicked / emailsDelivered : 0;
    const emailBounceRate = emailsSent > 0 ? emailsBounced / emailsSent : 0;

    // Calculate revenue and timing metrics
    const convertedCampaigns = await prisma.campaign.findMany({
      where: {
        ...whereClause,
        status: 'CONVERTED',
        convertedAt: { not: null },
      },
      select: {
        revenueRecovered: true,
        startedAt: true,
        convertedAt: true,
      },
    });

    const totalRevenueRecovered = convertedCampaigns.reduce(
      (sum, c) => sum + (c.revenueRecovered || 0),
      0
    );

    const avgRevenuePerConversion =
      totalConverted > 0 ? totalRevenueRecovered / totalConverted : 0;

    const conversionTimes = convertedCampaigns
      .filter((c) => c.startedAt && c.convertedAt)
      .map((c) =>
        Math.floor(
          (c.convertedAt!.getTime() - c.startedAt!.getTime()) / 1000
        )
      );

    const avgTimeToConversion =
      conversionTimes.length > 0
        ? conversionTimes.reduce((sum, time) => sum + time, 0) / conversionTimes.length
        : 0;

    // Upsert metrics
    await prisma.campaignMetrics.upsert({
      where: {
        organizationId_strategyId_period_periodType: {
          organizationId,
          strategyId: strategyId || '',
          period,
          periodType,
        },
      },
      create: {
        organizationId,
        strategyId,
        period,
        periodType,
        campaignsTriggered: totalTriggered,
        campaignsActive: totalActive,
        campaignsConverted: totalConverted,
        campaignsCancelled: totalCancelled,
        campaignsFailed: totalFailed,
        campaignsCompleted: totalCompleted,
        actionsSent: totalActionsSent,
        actionsDelivered: totalActionsDelivered,
        actionsFailed: totalActionsFailed,
        emailsSent,
        emailsDelivered,
        emailsOpened,
        emailsClicked,
        emailsBounced,
        conversionRate,
        emailOpenRate,
        emailClickRate,
        emailBounceRate,
        totalRevenueRecovered,
        avgRevenuePerConversion: Math.round(avgRevenuePerConversion),
        avgTimeToConversion: Math.round(avgTimeToConversion),
      },
      update: {
        campaignsTriggered: totalTriggered,
        campaignsActive: totalActive,
        campaignsConverted: totalConverted,
        campaignsCancelled: totalCancelled,
        campaignsFailed: totalFailed,
        campaignsCompleted: totalCompleted,
        actionsSent: totalActionsSent,
        actionsDelivered: totalActionsDelivered,
        actionsFailed: totalActionsFailed,
        emailsSent,
        emailsDelivered,
        emailsOpened,
        emailsClicked,
        emailsBounced,
        conversionRate,
        emailOpenRate,
        emailClickRate,
        emailBounceRate,
        totalRevenueRecovered,
        avgRevenuePerConversion: Math.round(avgRevenuePerConversion),
        avgTimeToConversion: Math.round(avgTimeToConversion),
      },
    });

    operationLog.info(
      {
        totalTriggered,
        totalConverted,
        conversionRate: (conversionRate * 100).toFixed(2) + '%',
        totalRevenueRecovered,
      },
      'Campaign metrics aggregated'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to aggregate campaign metrics');
    throw error;
  }
}

/**
 * Aggregate metrics for all strategies in an organization
 */
export async function aggregateOrganizationMetrics(
  organizationId: string,
  period: Date,
  periodType: 'DAILY' | 'WEEKLY' | 'MONTHLY'
): Promise<void> {
  const operationLog = log.child({
    operation: 'aggregateOrganizationMetrics',
    organizationId,
    period: period.toISOString(),
    periodType,
  });

  try {
    // Get all strategies for the organization
    const strategies = await prisma.retentionStrategy.findMany({
      where: { organizationId },
      select: { id: true },
    });

    // Aggregate metrics for each strategy
    await Promise.all(
      strategies.map((strategy) =>
        aggregateCampaignMetrics(organizationId, strategy.id, period, periodType)
      )
    );

    // Aggregate organization-wide metrics (strategyId = null)
    await aggregateCampaignMetrics(organizationId, null, period, periodType);

    operationLog.info(
      { strategiesProcessed: strategies.length },
      'Organization metrics aggregated'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to aggregate organization metrics');
    throw error;
  }
}

/**
 * Daily aggregation job - run this via cron or scheduler
 * Aggregates metrics for yesterday for all organizations
 */
export async function runDailyAggregation(): Promise<void> {
  const operationLog = log.child({ operation: 'runDailyAggregation' });

  try {
    // Get yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    operationLog.info({ date: yesterday.toISOString() }, 'Starting daily metrics aggregation');

    // Get all organizations with retention strategies
    const organizations = await prisma.organization.findMany({
      where: {
        retentionStrategies: {
          some: {},
        },
      },
      select: { id: true },
    });

    // Aggregate daily metrics for each organization
    await Promise.all(
      organizations.map((org) =>
        aggregateOrganizationMetrics(org.id, yesterday, 'DAILY')
      )
    );

    // Also aggregate weekly metrics if it's Sunday
    if (yesterday.getDay() === 0) {
      const weekStart = new Date(yesterday);
      weekStart.setDate(weekStart.getDate() - 6);

      await Promise.all(
        organizations.map((org) =>
          aggregateOrganizationMetrics(org.id, weekStart, 'WEEKLY')
        )
      );

      operationLog.info('Weekly metrics aggregated');
    }

    // Also aggregate monthly metrics if it's the last day of the month
    const tomorrow = new Date(yesterday);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (tomorrow.getDate() === 1) {
      const monthStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);

      await Promise.all(
        organizations.map((org) =>
          aggregateOrganizationMetrics(org.id, monthStart, 'MONTHLY')
        )
      );

      operationLog.info('Monthly metrics aggregated');
    }

    operationLog.info(
      { organizationsProcessed: organizations.length },
      'Daily metrics aggregation completed'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to run daily aggregation');
    throw error;
  }
}

/**
 * Get period date range based on period type
 */
function getPeriodRange(
  period: Date,
  periodType: 'DAILY' | 'WEEKLY' | 'MONTHLY'
): { startDate: Date; endDate: Date } {
  const startDate = new Date(period);
  const endDate = new Date(period);

  switch (periodType) {
    case 'DAILY':
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'WEEKLY':
      // Start on Sunday, end on Saturday
      const day = startDate.getDay();
      startDate.setDate(startDate.getDate() - day);
      startDate.setHours(0, 0, 0, 0);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'MONTHLY':
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setMonth(endDate.getMonth() + 1);
      endDate.setDate(0); // Last day of month
      endDate.setHours(23, 59, 59, 999);
      break;
  }

  return { startDate, endDate };
}
