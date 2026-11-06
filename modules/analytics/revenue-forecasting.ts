import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { z } from 'zod';

const log = logger.child({ module: 'revenue-forecasting' });

export type ForecastHorizon = 'THIRTY_DAYS' | 'NINETY_DAYS' | 'ONE_YEAR';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RevenueForecast {
  organizationId: string;
  horizon: ForecastHorizon;
  horizonDays: number;
  generatedAt: Date;

  currentMRR: number;
  currentARR: number;
  activeSubscriptions: number;

  forecastedMRR: number;
  forecastedARR: number;
  projectedChange: number;
  projectedChangeAmount: number;

  breakdown: {
    retainedRevenue: number;
    churnedRevenue: number;
    recoveredRevenue: number;
    newRevenue: number;
    upgradeRevenue: number;
    downgradeRevenue: number;
  };

  metrics: {
    expectedChurnRate: number;
    expectedRecoveryRate: number;
    averageSubscriptionValue: number;
    customersAtRisk: number;
    activeCampaigns: number;
  };

  confidence: ConfidenceLevel;
  confidenceFactors: {
    hasChurnData: boolean;
    hasCampaignData: boolean;
    hasHistoricalData: boolean;
    sampleSize: number;
  };
}

export interface RecoveryImpact {
  organizationId: string;

  customersAtRisk: number;
  revenueAtRisk: number;

  activeCampaigns: number;
  campaignsTriggered30Days: number;
  historicalRecoveryRate: number;

  expectedRecoveries: number;
  expectedRecoveredRevenue: number;
  projectedImpact30Days: number;
  projectedImpact90Days: number;
  projectedImpact365Days: number;

  confidence: ConfidenceLevel;
}

const ForecastInputSchema = z.object({
  organizationId: z.string().cuid(),
  horizon: z.enum(['THIRTY_DAYS', 'NINETY_DAYS', 'ONE_YEAR']).optional(),
  includeGrowth: z.boolean().optional(),
  growthRate: z.number().min(0).max(100).optional(),
});

export type ForecastInput = z.infer<typeof ForecastInputSchema>;

export async function generateRevenueForecast(input: ForecastInput): Promise<RevenueForecast> {
  const operationLog = log.child({
    operation: 'generateRevenueForecast',
    organizationId: input.organizationId,
  });

  try {
    const validated = ForecastInputSchema.parse(input);
    const horizon = validated.horizon || 'NINETY_DAYS';
    const horizonDays = getHorizonDays(horizon);
    const includeGrowth = validated.includeGrowth || false;
    const growthRate = validated.growthRate || 0;

    const currentState = await calculateCurrentMRR(validated.organizationId);

    const churnProjection = await projectChurnImpact(
      validated.organizationId,
      horizonDays,
      currentState.activeSubscriptions
    );

    const recoveryProjection = await projectRecoveryImpact(validated.organizationId, horizonDays);

    const growthProjection = includeGrowth
      ? await projectGrowthImpact(currentState.currentMRR, growthRate, horizonDays)
      : { newRevenue: 0, upgradeRevenue: 0, downgradeRevenue: 0 };

    const retainedRevenue = currentState.currentMRR - churnProjection.churnedRevenue;
    const forecastedMRR =
      retainedRevenue +
      recoveryProjection.recoveredRevenue +
      growthProjection.newRevenue +
      growthProjection.upgradeRevenue -
      growthProjection.downgradeRevenue;

    const projectedChangeAmount = forecastedMRR - currentState.currentMRR;
    const projectedChange =
      currentState.currentMRR > 0 ? (projectedChangeAmount / currentState.currentMRR) * 100 : 0;

    const confidence = calculateForecastConfidence(
      currentState.activeSubscriptions,
      churnProjection.hasChurnData,
      recoveryProjection.hasCampaignData
    );

    const forecast: RevenueForecast = {
      organizationId: validated.organizationId,
      horizon,
      horizonDays,
      generatedAt: new Date(),

      currentMRR: currentState.currentMRR,
      currentARR: currentState.currentARR,
      activeSubscriptions: currentState.activeSubscriptions,

      forecastedMRR,
      forecastedARR: forecastedMRR * 12,
      projectedChange,
      projectedChangeAmount,

      breakdown: {
        retainedRevenue,
        churnedRevenue: churnProjection.churnedRevenue,
        recoveredRevenue: recoveryProjection.recoveredRevenue,
        newRevenue: growthProjection.newRevenue,
        upgradeRevenue: growthProjection.upgradeRevenue,
        downgradeRevenue: growthProjection.downgradeRevenue,
      },

      metrics: {
        expectedChurnRate: churnProjection.expectedChurnRate,
        expectedRecoveryRate: recoveryProjection.expectedRecoveryRate,
        averageSubscriptionValue: currentState.averageSubscriptionValue,
        customersAtRisk: churnProjection.customersAtRisk,
        activeCampaigns: recoveryProjection.activeCampaigns,
      },

      confidence,
      confidenceFactors: {
        hasChurnData: churnProjection.hasChurnData,
        hasCampaignData: recoveryProjection.hasCampaignData,
        hasHistoricalData: currentState.hasHistoricalData,
        sampleSize: currentState.activeSubscriptions,
      },
    };

    operationLog.info(
      {
        currentMRR: currentState.currentMRR,
        forecastedMRR,
        projectedChange,
        confidence,
      },
      'Revenue forecast generated'
    );

    return forecast;
  } catch (error) {
    operationLog.error({ error }, 'Failed to generate revenue forecast');
    throw error;
  }
}

export async function getRecoveryImpact(organizationId: string): Promise<RecoveryImpact> {
  const operationLog = log.child({
    operation: 'getRecoveryImpact',
    organizationId,
  });

  try {
    const atRiskCustomers = await prisma.customer.findMany({
      where: {
        connection: { organizationId },
        subscriptions: {
          some: {
            status: 'ACTIVE',
          },
        },
        churnRiskScores: {
          some: {
            riskLevel: {
              in: ['HIGH', 'CRITICAL'],
            },
          },
        },
      },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          select: { amount: true, interval: true },
        },
        churnRiskScores: {
          orderBy: { calculatedAt: 'desc' },
          take: 1,
        },
      },
    });

    let revenueAtRisk = 0;
    for (const customer of atRiskCustomers) {
      const subscription = customer.subscriptions[0];
      if (subscription) {
        const amountNumber =
          typeof subscription.amount === 'number'
            ? subscription.amount
            : subscription.amount.toNumber();
        const monthlyValue = subscription.interval === 'year' ? amountNumber / 12 : amountNumber;
        revenueAtRisk += monthlyValue;
      }
    }

    const activeCampaigns = await prisma.campaign.count({
      where: {
        organizationId,
        status: {
          in: ['ACTIVE', 'PENDING'],
        },
      },
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentCampaigns = await prisma.campaign.findMany({
      where: {
        organizationId,
        startedAt: { gte: thirtyDaysAgo },
      },
      select: {
        status: true,
      },
    });

    const campaignsTriggered30Days = recentCampaigns.length;
    const conversions = recentCampaigns.filter((c) => c.status === 'CONVERTED').length;
    const historicalRecoveryRate =
      campaignsTriggered30Days > 0 ? conversions / campaignsTriggered30Days : 0.15;

    const expectedRecoveries = Math.round(atRiskCustomers.length * historicalRecoveryRate);
    const expectedRecoveredRevenue = revenueAtRisk * historicalRecoveryRate;

    const projectedImpact30Days = expectedRecoveredRevenue;
    const projectedImpact90Days = expectedRecoveredRevenue * 3;
    const projectedImpact365Days = expectedRecoveredRevenue * 12;

    const confidence =
      campaignsTriggered30Days >= 20 ? 'HIGH' : campaignsTriggered30Days >= 5 ? 'MEDIUM' : 'LOW';

    const impact: RecoveryImpact = {
      organizationId,
      customersAtRisk: atRiskCustomers.length,
      revenueAtRisk,
      activeCampaigns,
      campaignsTriggered30Days,
      historicalRecoveryRate,
      expectedRecoveries,
      expectedRecoveredRevenue,
      projectedImpact30Days,
      projectedImpact90Days,
      projectedImpact365Days,
      confidence,
    };

    operationLog.info(
      {
        customersAtRisk: atRiskCustomers.length,
        expectedRecoveredRevenue,
        confidence,
      },
      'Recovery impact calculated'
    );

    return impact;
  } catch (error) {
    operationLog.error({ error }, 'Failed to calculate recovery impact');
    throw error;
  }
}

async function calculateCurrentMRR(organizationId: string): Promise<{
  currentMRR: number;
  currentARR: number;
  activeSubscriptions: number;
  averageSubscriptionValue: number;
  hasHistoricalData: boolean;
}> {
  const subscriptions = await prisma.subscription.findMany({
    where: {
      customer: {
        connection: { organizationId },
      },
      status: 'ACTIVE',
    },
    select: {
      amount: true,
      interval: true,
    },
  });

  let totalMRR = 0;
  for (const sub of subscriptions) {
    const amountNumber = typeof sub.amount === 'number' ? sub.amount : sub.amount.toNumber();
    const monthlyValue = sub.interval === 'year' ? amountNumber / 12 : amountNumber;
    totalMRR += monthlyValue;
  }

  const averageSubscriptionValue = subscriptions.length > 0 ? totalMRR / subscriptions.length : 0;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const historicalCampaigns = await prisma.campaign.count({
    where: {
      organizationId,
      startedAt: { lt: thirtyDaysAgo },
    },
  });

  return {
    currentMRR: totalMRR,
    currentARR: totalMRR * 12,
    activeSubscriptions: subscriptions.length,
    averageSubscriptionValue,
    hasHistoricalData: historicalCampaigns > 0,
  };
}

/**
 * Project churn impact over forecast horizon
 */
async function projectChurnImpact(
  organizationId: string,
  horizonDays: number,
  totalSubscriptions: number
): Promise<{
  churnedRevenue: number;
  expectedChurnRate: number;
  customersAtRisk: number;
  hasChurnData: boolean;
}> {
  const customersWithRisk = await prisma.customer.findMany({
    where: {
      connection: { organizationId },
      subscriptions: {
        some: { status: 'ACTIVE' },
      },
      churnRiskScores: {
        some: {},
      },
    },
    include: {
      subscriptions: {
        where: { status: 'ACTIVE' },
        select: { amount: true, interval: true },
      },
      churnRiskScores: {
        orderBy: { calculatedAt: 'desc' },
        take: 1,
      },
    },
  });

  if (customersWithRisk.length === 0) {
    return {
      churnedRevenue: 0,
      expectedChurnRate: 5,
      customersAtRisk: 0,
      hasChurnData: false,
    };
  }

  let expectedChurnRevenue = 0;
  let customersAtRisk = 0;

  for (const customer of customersWithRisk) {
    const riskScore = customer.churnRiskScores[0];
    if (!riskScore) continue;

    const churnProbability = getChurnProbability(riskScore.riskLevel);

    const adjustedProbability = Math.min(churnProbability * (horizonDays / 30), 1);

    const subscription = customer.subscriptions[0];
    if (subscription) {
      const amountNumber =
        typeof subscription.amount === 'number'
          ? subscription.amount
          : subscription.amount.toNumber();
      const monthlyValue = subscription.interval === 'year' ? amountNumber / 12 : amountNumber;

      expectedChurnRevenue += monthlyValue * adjustedProbability;

      if (riskScore.riskLevel === 'HIGH' || riskScore.riskLevel === 'CRITICAL') {
        customersAtRisk++;
      }
    }
  }

  const expectedChurnRate =
    totalSubscriptions > 0
      ? (expectedChurnRevenue / (await calculateCurrentMRR(organizationId)).currentMRR) * 100
      : 5;

  return {
    churnedRevenue: expectedChurnRevenue,
    expectedChurnRate,
    customersAtRisk,
    hasChurnData: true,
  };
}

/**
 * Project recovery impact from campaigns
 */
async function projectRecoveryImpact(
  organizationId: string,
  horizonDays: number
): Promise<{
  recoveredRevenue: number;
  expectedRecoveryRate: number;
  activeCampaigns: number;
  hasCampaignData: boolean;
}> {
  const activeCampaigns = await prisma.campaign.count({
    where: {
      organizationId,
      status: {
        in: ['ACTIVE', 'PENDING'],
      },
    },
  });

  const historicalCampaigns = await prisma.campaign.findMany({
    where: {
      organizationId,
      status: {
        in: ['COMPLETED', 'CONVERTED', 'FAILED'],
      },
    },
    include: {
      customer: {
        include: {
          subscriptions: {
            where: { status: 'ACTIVE' },
            select: { amount: true, interval: true },
          },
        },
      },
    },
  });

  if (historicalCampaigns.length < 5) {
    return {
      recoveredRevenue: 0,
      expectedRecoveryRate: 15,
      activeCampaigns,
      hasCampaignData: false,
    };
  }

  const conversions = historicalCampaigns.filter((c) => c.status === 'CONVERTED').length;
  const recoveryRate = conversions / historicalCampaigns.length;

  let totalRecoveredRevenue = 0;
  for (const campaign of historicalCampaigns.filter((c) => c.status === 'CONVERTED')) {
    const subscription = campaign.customer.subscriptions[0];
    if (subscription) {
      const amountNumber =
        typeof subscription.amount === 'number'
          ? subscription.amount
          : subscription.amount.toNumber();
      const monthlyValue = subscription.interval === 'year' ? amountNumber / 12 : amountNumber;
      totalRecoveredRevenue += monthlyValue;
    }
  }

  const avgRecoveredPerConversion = conversions > 0 ? totalRecoveredRevenue / conversions : 0;

  const expectedConversions = activeCampaigns * recoveryRate;
  const projectedRecovery = expectedConversions * avgRecoveredPerConversion;

  const timeAdjustedRecovery = projectedRecovery * (horizonDays / 30);

  return {
    recoveredRevenue: timeAdjustedRecovery,
    expectedRecoveryRate: recoveryRate * 100,
    activeCampaigns,
    hasCampaignData: true,
  };
}

/**
 * Project growth impact (new customers)
 */
async function projectGrowthImpact(
  currentMRR: number,
  growthRate: number,
  horizonDays: number
): Promise<{
  newRevenue: number;
  upgradeRevenue: number;
  downgradeRevenue: number;
}> {
  const monthlyGrowthRate = growthRate / 100;
  const months = horizonDays / 30;
  const growthMultiplier = Math.pow(1 + monthlyGrowthRate, months);
  const projectedMRR = currentMRR * growthMultiplier;
  const newRevenue = projectedMRR - currentMRR;

  return {
    newRevenue,
    upgradeRevenue: 0,
    downgradeRevenue: 0,
  };
}

function getHorizonDays(horizon: ForecastHorizon): number {
  switch (horizon) {
    case 'THIRTY_DAYS':
      return 30;
    case 'NINETY_DAYS':
      return 90;
    case 'ONE_YEAR':
      return 365;
  }
}

function getChurnProbability(riskLevel: string): number {
  const probabilities: Record<string, number> = {
    MINIMAL: 0.05,
    LOW: 0.15,
    MEDIUM: 0.3,
    HIGH: 0.5,
    CRITICAL: 0.75,
  };
  return probabilities[riskLevel] || 0.3;
}

function calculateForecastConfidence(
  sampleSize: number,
  hasChurnData: boolean,
  hasCampaignData: boolean
): ConfidenceLevel {
  const dataPoints = [hasChurnData, hasCampaignData, sampleSize >= 20].filter(Boolean).length;

  if (dataPoints === 3) return 'HIGH';
  if (dataPoints === 2) return 'MEDIUM';
  return 'LOW';
}
