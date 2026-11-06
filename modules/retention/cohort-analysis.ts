/**
 * Cohort Analysis for Retention Campaigns
 *
 * Analyze campaign performance by cohorts (groups of campaigns started in same period)
 * Track conversion rates, revenue, and retention patterns over time
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

const log = logger.child({ module: 'cohort-analysis' });

/**
 * Cohort grouping options
 */
export type CohortPeriod = 'day' | 'week' | 'month' | 'quarter';

/**
 * Cohort metrics
 */
export interface CohortMetrics {
  cohortName: string; // e.g., "2025-01" or "Week of 2025-01-06"
  cohortStart: Date;
  cohortEnd: Date;
  campaignsStarted: number;
  uniqueCustomers: number;

  // Performance by age (days since campaign started)
  performanceByAge: Array<{
    ageInDays: number;
    campaignsActive: number;
    campaignsConverted: number;
    conversionRate: number;
    revenueRecovered: number;
    cumulativeConversionRate: number;
    cumulativeRevenue: number;
  }>;

  // Final metrics (at end of observation period)
  finalMetrics: {
    totalConverted: number;
    finalConversionRate: number;
    totalRevenue: number;
    avgTimeToConversion: number; // in days
    avgRevenuePerConversion: number;
  };
}

/**
 * Cohort comparison data
 */
export interface CohortComparison {
  cohorts: CohortMetrics[];
  summary: {
    totalCohorts: number;
    avgConversionRate: number;
    bestPerformingCohort: string;
    worstPerformingCohort: string;
    conversionRateTrend: 'improving' | 'declining' | 'stable';
  };
}

/**
 * Analyze campaigns by cohort
 */
export async function analyzeCohorts(
  organizationId: string,
  options: {
    period: CohortPeriod;
    cohortsBack?: number; // Number of cohorts to analyze (default: 12)
    maxAgeDays?: number; // Max campaign age to track (default: 30)
    triggerType?: string; // Filter by trigger type
    strategyId?: string; // Filter by strategy
  }
): Promise<CohortComparison> {
  const operationLog = log.child({
    operation: 'analyzeCohorts',
    organizationId,
    period: options.period,
  });

  try {
    const cohortsBack = options.cohortsBack || 12;
    const maxAgeDays = options.maxAgeDays || 30;

    // Generate cohort periods
    const cohortPeriods = generateCohortPeriods(options.period, cohortsBack);

    // Analyze each cohort
    const cohortMetrics: CohortMetrics[] = [];

    for (const cohortPeriod of cohortPeriods) {
      const metrics = await analyzeSingleCohort(
        organizationId,
        cohortPeriod.start,
        cohortPeriod.end,
        cohortPeriod.name,
        maxAgeDays,
        options.triggerType,
        options.strategyId
      );

      if (metrics.campaignsStarted > 0) {
        cohortMetrics.push(metrics);
      }
    }

    // Calculate summary statistics
    const avgConversionRate =
      cohortMetrics.reduce((sum, c) => sum + c.finalMetrics.finalConversionRate, 0) /
      cohortMetrics.length;

    const sortedByConversion = [...cohortMetrics].sort(
      (a, b) => b.finalMetrics.finalConversionRate - a.finalMetrics.finalConversionRate
    );

    const bestPerforming = sortedByConversion[0]?.cohortName || 'N/A';
    const worstPerforming = sortedByConversion[sortedByConversion.length - 1]?.cohortName || 'N/A';

    // Determine trend
    const recentCohorts = cohortMetrics.slice(-3);
    const olderCohorts = cohortMetrics.slice(0, 3);

    const recentAvg =
      recentCohorts.reduce((sum, c) => sum + c.finalMetrics.finalConversionRate, 0) /
      recentCohorts.length;
    const olderAvg =
      olderCohorts.reduce((sum, c) => sum + c.finalMetrics.finalConversionRate, 0) /
      olderCohorts.length;

    let conversionRateTrend: 'improving' | 'declining' | 'stable' = 'stable';
    if (recentAvg > olderAvg * 1.1) {
      conversionRateTrend = 'improving';
    } else if (recentAvg < olderAvg * 0.9) {
      conversionRateTrend = 'declining';
    }

    const comparison: CohortComparison = {
      cohorts: cohortMetrics,
      summary: {
        totalCohorts: cohortMetrics.length,
        avgConversionRate,
        bestPerformingCohort: bestPerforming,
        worstPerformingCohort: worstPerforming,
        conversionRateTrend,
      },
    };

    operationLog.info(
      {
        totalCohorts: cohortMetrics.length,
        avgConversionRate,
        trend: conversionRateTrend,
      },
      'Cohort analysis completed'
    );

    return comparison;
  } catch (error) {
    operationLog.error({ error }, 'Failed to analyze cohorts');
    throw error;
  }
}

/**
 * Analyze a single cohort
 */
async function analyzeSingleCohort(
  organizationId: string,
  cohortStart: Date,
  cohortEnd: Date,
  cohortName: string,
  maxAgeDays: number,
  triggerType?: string,
  strategyId?: string
): Promise<CohortMetrics> {
  // Get all campaigns that started in this cohort period
  const campaigns = await prisma.campaign.findMany({
    where: {
      organizationId,
      startedAt: {
        gte: cohortStart,
        lt: cohortEnd,
      },
      ...(triggerType && { triggerType: triggerType as any }),
      ...(strategyId && { strategyId }),
    },
    include: {
      customer: {
        select: { id: true },
      },
    },
  });

  const campaignsStarted = campaigns.length;
  const uniqueCustomers = new Set(campaigns.map((c) => c.customerId)).size;

  // Track performance by age
  const performanceByAge: CohortMetrics['performanceByAge'] = [];
  let cumulativeConverted = 0;
  let cumulativeRevenue = 0;

  for (let age = 0; age <= maxAgeDays; age++) {
    const ageDate = new Date(cohortEnd.getTime() + age * 24 * 60 * 60 * 1000);

    // Count campaigns that converted by this age
    const convertedByAge = campaigns.filter((c) => {
      if (c.status !== 'CONVERTED' || !c.convertedAt) return false;

      const campaignAge = Math.floor(
        (c.convertedAt.getTime() - c.startedAt.getTime()) / (1000 * 60 * 60 * 24)
      );

      return campaignAge <= age;
    });

    const newConversions = convertedByAge.length - cumulativeConverted;
    cumulativeConverted = convertedByAge.length;

    const newRevenue = convertedByAge
      .slice(-newConversions)
      .reduce((sum, c) => sum + (c.revenueRecovered || 0), 0);
    cumulativeRevenue += newRevenue;

    const conversionRate = campaignsStarted > 0 ? (newConversions / campaignsStarted) * 100 : 0;
    const cumulativeConversionRate = campaignsStarted > 0
      ? (cumulativeConverted / campaignsStarted) * 100
      : 0;

    performanceByAge.push({
      ageInDays: age,
      campaignsActive: campaignsStarted - cumulativeConverted,
      campaignsConverted: newConversions,
      conversionRate,
      revenueRecovered: newRevenue,
      cumulativeConversionRate,
      cumulativeRevenue,
    });
  }

  // Calculate final metrics
  const convertedCampaigns = campaigns.filter((c) => c.status === 'CONVERTED');
  const totalConverted = convertedCampaigns.length;
  const finalConversionRate = campaignsStarted > 0 ? (totalConverted / campaignsStarted) * 100 : 0;
  const totalRevenue = convertedCampaigns.reduce((sum, c) => sum + (c.revenueRecovered || 0), 0);

  const avgTimeToConversion =
    totalConverted > 0
      ? convertedCampaigns.reduce((sum, c) => {
          if (!c.convertedAt || !c.startedAt) return sum;
          const days = Math.floor(
            (c.convertedAt.getTime() - c.startedAt.getTime()) / (1000 * 60 * 60 * 24)
          );
          return sum + days;
        }, 0) / totalConverted
      : 0;

  const avgRevenuePerConversion = totalConverted > 0 ? totalRevenue / totalConverted : 0;

  return {
    cohortName,
    cohortStart,
    cohortEnd,
    campaignsStarted,
    uniqueCustomers,
    performanceByAge,
    finalMetrics: {
      totalConverted,
      finalConversionRate,
      totalRevenue,
      avgTimeToConversion,
      avgRevenuePerConversion,
    },
  };
}

/**
 * Generate cohort periods
 */
function generateCohortPeriods(
  period: CohortPeriod,
  count: number
): Array<{ name: string; start: Date; end: Date }> {
  const periods: Array<{ name: string; start: Date; end: Date }> = [];
  const now = new Date();

  for (let i = count - 1; i >= 0; i--) {
    const end = new Date(now);
    const start = new Date(now);

    switch (period) {
      case 'day':
        start.setDate(now.getDate() - i - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(now.getDate() - i);
        end.setHours(0, 0, 0, 0);
        break;

      case 'week':
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay() - i * 7); // Start of week (Sunday)
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 7);
        start.setTime(weekStart.getTime());
        end.setTime(weekEnd.getTime());
        break;

      case 'month':
        start.setMonth(now.getMonth() - i - 1);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        end.setMonth(now.getMonth() - i);
        end.setDate(1);
        end.setHours(0, 0, 0, 0);
        break;

      case 'quarter':
        const currentQuarter = Math.floor(now.getMonth() / 3);
        const targetQuarter = currentQuarter - i - 1;
        const targetYear = now.getFullYear() + Math.floor(targetQuarter / 4);
        const normalizedQuarter = ((targetQuarter % 4) + 4) % 4;

        start.setFullYear(targetYear);
        start.setMonth(normalizedQuarter * 3);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);

        end.setFullYear(targetYear);
        end.setMonth(normalizedQuarter * 3 + 3);
        end.setDate(1);
        end.setHours(0, 0, 0, 0);
        break;
    }

    periods.push({
      name: formatCohortName(start, period),
      start,
      end,
    });
  }

  return periods;
}

/**
 * Format cohort name
 */
function formatCohortName(date: Date, period: CohortPeriod): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  switch (period) {
    case 'day':
      return `${year}-${month}-${day}`;
    case 'week':
      return `Week of ${year}-${month}-${day}`;
    case 'month':
      return `${year}-${month}`;
    case 'quarter':
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      return `Q${quarter} ${year}`;
  }
}

/**
 * Get cohort retention curve
 * Shows how conversion rate evolves over campaign age
 */
export async function getCohortRetentionCurve(
  organizationId: string,
  cohortPeriod: CohortPeriod,
  maxAgeDays: number = 30
): Promise<{
  agePoints: number[];
  cohortCurves: Array<{
    cohortName: string;
    conversionRates: number[];
  }>;
}> {
  const operationLog = log.child({
    operation: 'getCohortRetentionCurve',
    organizationId,
  });

  try {
    const analysis = await analyzeCohorts(organizationId, {
      period: cohortPeriod,
      cohortsBack: 6,
      maxAgeDays,
    });

    const agePoints = Array.from({ length: maxAgeDays + 1 }, (_, i) => i);

    const cohortCurves = analysis.cohorts.map((cohort) => ({
      cohortName: cohort.cohortName,
      conversionRates: cohort.performanceByAge.map((p) => p.cumulativeConversionRate),
    }));

    operationLog.info({ cohortsAnalyzed: cohortCurves.length }, 'Retention curve generated');

    return {
      agePoints,
      cohortCurves,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to get retention curve');
    throw error;
  }
}

/**
 * Compare cohort performance by strategy
 */
export async function compareCohortsByStrategy(
  organizationId: string,
  cohortPeriod: CohortPeriod,
  strategies: string[]
): Promise<
  Record<
    string,
    {
      strategyName: string;
      cohorts: CohortMetrics[];
      avgConversionRate: number;
    }
  >
> {
  const operationLog = log.child({
    operation: 'compareCohortsByStrategy',
    organizationId,
  });

  try {
    const result: Record<string, any> = {};

    for (const strategyId of strategies) {
      const strategy = await prisma.retentionStrategy.findUnique({
        where: { id: strategyId },
        select: { name: true },
      });

      const analysis = await analyzeCohorts(organizationId, {
        period: cohortPeriod,
        cohortsBack: 12,
        strategyId,
      });

      result[strategyId] = {
        strategyName: strategy?.name || strategyId,
        cohorts: analysis.cohorts,
        avgConversionRate: analysis.summary.avgConversionRate,
      };
    }

    operationLog.info({ strategiesCompared: strategies.length }, 'Cohort comparison completed');

    return result;
  } catch (error) {
    operationLog.error({ error }, 'Failed to compare cohorts by strategy');
    throw error;
  }
}

/**
 * Get cohort funnel analysis
 * Shows drop-off at each stage of campaign lifecycle
 */
export async function getCohortFunnel(
  organizationId: string,
  cohortStart: Date,
  cohortEnd: Date
): Promise<{
  cohortName: string;
  funnel: Array<{
    stage: string;
    campaigns: number;
    dropOffPercent: number;
  }>;
}> {
  const operationLog = log.child({
    operation: 'getCohortFunnel',
    organizationId,
  });

  try {
    const campaigns = await prisma.campaign.findMany({
      where: {
        organizationId,
        startedAt: {
          gte: cohortStart,
          lt: cohortEnd,
        },
      },
    });

    const total = campaigns.length;
    const active = campaigns.filter((c) => c.status === 'ACTIVE').length;
    const converted = campaigns.filter((c) => c.status === 'CONVERTED').length;
    const cancelled = campaigns.filter((c) => c.status === 'CANCELLED').length;
    const failed = campaigns.filter((c) => c.status === 'FAILED').length;

    const funnel = [
      {
        stage: 'Started',
        campaigns: total,
        dropOffPercent: 0,
      },
      {
        stage: 'Active',
        campaigns: active,
        dropOffPercent: total > 0 ? ((total - active) / total) * 100 : 0,
      },
      {
        stage: 'Converted',
        campaigns: converted,
        dropOffPercent: total > 0 ? ((total - converted) / total) * 100 : 0,
      },
    ];

    operationLog.info({ totalCampaigns: total }, 'Cohort funnel generated');

    return {
      cohortName: formatCohortName(cohortStart, 'month'),
      funnel,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to get cohort funnel');
    throw error;
  }
}
