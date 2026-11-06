import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { getOrganizationPlan } from '../billing/plans.js';

const log = logger.child({ module: 'roi-calculator' });

export interface ROIMetrics {
  monthlySubscriptionCost: number;
  yearlySubscriptionCost: number;
  billingCycle: 'monthly' | 'annual' | 'free';

  totalRecoveredRevenue: number;
  recoveryCount: number;
  averageRecoveryAmount: number;

  roiMultiplier: number;
  roiPercentage: number;
  netGain: number;

  potentialRecoverableRevenue: number;
  potentialAdditionalROI: number;

  periodStart: Date;
  periodEnd: Date;
  daysInPeriod: number;

  currentPlan: string;
  planLimits: {
    emailsUsed: number;
    emailsLimit: number;
    emailsRemaining: number;
    approachingLimit: boolean;
  };

  upgradeRecommendation?: {
    suggestedPlan: string;
    reason: string;
    potentialAdditionalRevenue: number;
  };
}

export async function calculateROI(organizationId: string): Promise<ROIMetrics> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new Error('Organization not found');
    }

    const plan = getOrganizationPlan(org);

    const periodStart = org.currentPeriodStart || getFirstDayOfMonth(new Date());
    const periodEnd = org.currentPeriodEnd || getLastDayOfMonth(periodStart);
    const daysInPeriod = Math.ceil(
      (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
    );

    const recoveryMetrics = await getRecoveryMetrics(organizationId, periodStart, periodEnd);

    const potentialRevenue = await getPotentialRecoverableRevenue(organizationId);

    const billingCycle = org.stripePriceId
      ? org.stripePriceId.includes('annual')
        ? 'annual'
        : 'monthly'
      : 'free';

    const subscriptionCost =
      billingCycle === 'annual'
        ? plan.price.yearly
        : billingCycle === 'monthly'
          ? plan.price.monthly
          : 0;

    const roiMultiplier =
      subscriptionCost > 0 ? recoveryMetrics.totalRecovered / subscriptionCost : 0;
    const roiPercentage = subscriptionCost > 0 ? (roiMultiplier - 1) * 100 : 0;
    const netGain = recoveryMetrics.totalRecovered - subscriptionCost;

    const usage = await prisma.usageTracking.findUnique({
      where: {
        organizationId_period: {
          organizationId,
          period: periodStart,
        },
      },
    });

    const emailsUsed = usage?.emailsSent || 0;
    const emailsLimit = plan.limits.emailsPerMonth;
    const emailsRemaining = emailsLimit === -1 ? Infinity : emailsLimit - emailsUsed;
    const approachingLimit = emailsLimit !== -1 && emailsUsed >= emailsLimit * 0.9;

    const upgradeRecommendation = generateUpgradeRecommendation(
      plan,
      emailsUsed,
      potentialRevenue,
      recoveryMetrics.totalRecovered
    );

    const metrics: ROIMetrics = {
      monthlySubscriptionCost: plan.price.monthly,
      yearlySubscriptionCost: plan.price.yearly,
      billingCycle,

      totalRecoveredRevenue: recoveryMetrics.totalRecovered,
      recoveryCount: recoveryMetrics.count,
      averageRecoveryAmount: recoveryMetrics.average,

      roiMultiplier: Number(roiMultiplier.toFixed(1)),
      roiPercentage: Number(roiPercentage.toFixed(0)),
      netGain,

      potentialRecoverableRevenue: potentialRevenue,
      potentialAdditionalROI:
        subscriptionCost > 0
          ? (potentialRevenue + recoveryMetrics.totalRecovered) / subscriptionCost
          : 0,

      periodStart,
      periodEnd,
      daysInPeriod,

      currentPlan: plan.name,
      planLimits: {
        emailsUsed,
        emailsLimit,
        emailsRemaining: emailsRemaining === Infinity ? -1 : emailsRemaining,
        approachingLimit,
      },

      upgradeRecommendation,
    };

    log.debug({ organizationId, metrics }, 'Calculated ROI metrics');

    return metrics;
  } catch (error) {
    log.error({ error, organizationId }, 'Failed to calculate ROI');
    throw error;
  }
}

async function getRecoveryMetrics(
  organizationId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<{
  totalRecovered: number;
  count: number;
  average: number;
}> {
  const recoveredPayments = await prisma.payment.findMany({
    where: {
      connection: {
        organizationId,
      },
      status: 'SUCCEEDED',
      paidAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
    select: {
      amount: true,
    },
  });

  const totalRecovered = recoveredPayments.reduce(
    (sum, payment) => sum + Number(payment.amount),
    0
  );

  const count = recoveredPayments.length;
  const average = count > 0 ? totalRecovered / count : 0;

  return {
    totalRecovered,
    count,
    average,
  };
}

async function getPotentialRecoverableRevenue(organizationId: string): Promise<number> {
  const failedPayments = await prisma.payment.findMany({
    where: {
      connection: {
        organizationId,
      },
      status: 'FAILED',

      createdAt: {
        gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      },
    },
    select: {
      amount: true,
    },
  });

  return failedPayments.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

function generateUpgradeRecommendation(
  plan: any,
  emailsUsed: number,
  potentialRevenue: number,
  recoveredRevenue: number
): ROIMetrics['upgradeRecommendation'] {
  if (plan.id === 'viewer') {
    return {
      suggestedPlan: 'STARTER',
      reason: `You've identified $${(potentialRevenue / 100).toFixed(2)} in recoverable revenue. Upgrade to STARTER ($49/mo) to start recovering it with automated campaigns.`,
      potentialAdditionalRevenue: potentialRevenue,
    };
  }

  if (plan.id === 'starter') {
    const emailLimit = plan.limits.emailsPerMonth;

    if (emailsUsed >= emailLimit * 0.9) {
      return {
        suggestedPlan: 'PRO',
        reason: `You've used ${emailsUsed}/${emailLimit} recovery emails this month. Upgrade to PRO for 10,000 emails/month and advanced recovery features.`,
        potentialAdditionalRevenue: potentialRevenue,
      };
    }

    if (potentialRevenue > 50000) {
      return {
        suggestedPlan: 'PRO',
        reason: `You have $${(potentialRevenue / 100).toFixed(2)} in recoverable revenue. PRO plan ($149/mo) offers advanced campaigns and A/B testing to maximize recovery rate.`,
        potentialAdditionalRevenue: potentialRevenue,
      };
    }
  }

  if (plan.id === 'pro') {
    const emailLimit = plan.limits.emailsPerMonth;

    if (emailsUsed >= emailLimit * 0.9) {
      return {
        suggestedPlan: 'ENTERPRISE',
        reason: `You've used ${emailsUsed}/${emailLimit} recovery emails. ENTERPRISE offers unlimited emails, dedicated support, and custom recovery strategies.`,
        potentialAdditionalRevenue: potentialRevenue,
      };
    }

    if (recoveredRevenue > 500000) {
      return {
        suggestedPlan: 'ENTERPRISE',
        reason: `You're recovering $${(recoveredRevenue / 100).toFixed(2)}/month. ENTERPRISE offers custom pricing, dedicated infrastructure, and white-label options.`,
        potentialAdditionalRevenue: potentialRevenue,
      };
    }
  }

  return undefined;
}

export async function getROISummary(organizationId: string): Promise<{
  roi: number;
  recovered: number;
  potential: number;
  message: string;
}> {
  const metrics = await calculateROI(organizationId);

  let message = '';
  if (metrics.billingCycle === 'free') {
    message = `See $${(metrics.potentialRecoverableRevenue / 100).toFixed(2)} at risk. Upgrade to start recovering.`;
  } else if (metrics.roiMultiplier >= 10) {
    message = `Amazing! You're getting ${metrics.roiMultiplier}x return on your investment.`;
  } else if (metrics.roiMultiplier >= 5) {
    message = `Great! You're getting ${metrics.roiMultiplier}x return on your investment.`;
  } else if (metrics.roiMultiplier >= 2) {
    message = `You're getting ${metrics.roiMultiplier}x return. Keep recovering!`;
  } else if (metrics.roiMultiplier > 0) {
    message = `You've recovered $${(metrics.totalRecoveredRevenue / 100).toFixed(2)} so far. There's $${(metrics.potentialRecoverableRevenue / 100).toFixed(2)} more to recover!`;
  } else {
    message = `Start recovering! You have $${(metrics.potentialRecoverableRevenue / 100).toFixed(2)} in failed payments.`;
  }

  return {
    roi: metrics.roiMultiplier,
    recovered: metrics.totalRecoveredRevenue,
    potential: metrics.potentialRecoverableRevenue,
    message,
  };
}

function getFirstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getLastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}
