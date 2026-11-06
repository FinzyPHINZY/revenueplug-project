/**
 * Customer Health Score Calculation
 *
 * Calculates a 0-100 health score for customers based on multiple signals:
 * - Payment health (40%): Payment history, failures, success rate
 * - Engagement (25%): Login frequency, feature usage
 * - Usage (20%): API calls, active usage trends
 * - Subscription health (10%): Tenure, plan status
 * - Support (5%): Ticket frequency and severity
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import type { Customer } from '@prisma/client';
import { logger } from '../../shared/logger/index.js';
import { publishAnalyticsEvent, AnalyticsTopics } from '../../infrastructure/kafka/index.js';

// Weights for each component (must sum to 100)
const SCORE_WEIGHTS = {
  payment: 40,
  engagement: 25,
  usage: 20,
  subscription: 10,
  support: 5,
};

interface HealthScoreBreakdown {
  paymentHealthScore: number;
  engagementScore: number;
  usageScore: number;
  subscriptionHealthScore: number;
  supportScore: number;
  overallScore: number;
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  riskFactors: string[];
  trend: 'IMPROVING' | 'STABLE' | 'DECLINING';
  breakdown: {
    payment: {
      score: number;
      weight: number;
      contribution: number;
      factors: string[];
    };
    engagement: {
      score: number;
      weight: number;
      contribution: number;
      factors: string[];
    };
    usage: {
      score: number;
      weight: number;
      contribution: number;
      factors: string[];
    };
    subscription: {
      score: number;
      weight: number;
      contribution: number;
      factors: string[];
    };
    support: {
      score: number;
      weight: number;
      contribution: number;
      factors: string[];
    };
  };
}

/**
 * Calculate customer health score
 */
export async function calculateHealthScore(
  customerId: string
): Promise<HealthScoreBreakdown> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });

  if (!customer) {
    throw new Error(`Customer ${customerId} not found`);
  }

  // Calculate component scores
  const paymentScore = await calculatePaymentHealthScore(customer);
  const engagementScore = await calculateEngagementScore(customer);
  const usageScore = await calculateUsageScore(customer);
  const subscriptionScore = await calculateSubscriptionHealthScore(customer);
  const supportScore = await calculateSupportScore(customer);

  // Calculate weighted overall score
  const overallScore = Math.round(
    (paymentScore.score * SCORE_WEIGHTS.payment +
      engagementScore.score * SCORE_WEIGHTS.engagement +
      usageScore.score * SCORE_WEIGHTS.usage +
      subscriptionScore.score * SCORE_WEIGHTS.subscription +
      supportScore.score * SCORE_WEIGHTS.support) /
      100
  );

  // Determine risk level
  const riskLevel = determineRiskLevel(overallScore);

  // Collect all risk factors
  const riskFactors = [
    ...paymentScore.factors,
    ...engagementScore.factors,
    ...usageScore.factors,
    ...subscriptionScore.factors,
    ...supportScore.factors,
  ];

  // Determine trend (compare with previous score if exists)
  const trend = await determineTrend(customerId, overallScore);

  return {
    paymentHealthScore: paymentScore.score,
    engagementScore: engagementScore.score,
    usageScore: usageScore.score,
    subscriptionHealthScore: subscriptionScore.score,
    supportScore: supportScore.score,
    overallScore,
    riskLevel,
    riskFactors,
    trend,
    breakdown: {
      payment: {
        score: paymentScore.score,
        weight: SCORE_WEIGHTS.payment,
        contribution: Math.round(
          (paymentScore.score * SCORE_WEIGHTS.payment) / 100
        ),
        factors: paymentScore.factors,
      },
      engagement: {
        score: engagementScore.score,
        weight: SCORE_WEIGHTS.engagement,
        contribution: Math.round(
          (engagementScore.score * SCORE_WEIGHTS.engagement) / 100
        ),
        factors: engagementScore.factors,
      },
      usage: {
        score: usageScore.score,
        weight: SCORE_WEIGHTS.usage,
        contribution: Math.round(
          (usageScore.score * SCORE_WEIGHTS.usage) / 100
        ),
        factors: usageScore.factors,
      },
      subscription: {
        score: subscriptionScore.score,
        weight: SCORE_WEIGHTS.subscription,
        contribution: Math.round(
          (subscriptionScore.score * SCORE_WEIGHTS.subscription) / 100
        ),
        factors: subscriptionScore.factors,
      },
      support: {
        score: supportScore.score,
        weight: SCORE_WEIGHTS.support,
        contribution: Math.round(
          (supportScore.score * SCORE_WEIGHTS.support) / 100
        ),
        factors: supportScore.factors,
      },
    },
  };
}

/**
 * Calculate payment health score (0-100)
 * Based on: payment success rate, failures, recency
 */
async function calculatePaymentHealthScore(
  customer: Customer & { subscriptions: any[] }
): Promise<{ score: number; factors: string[] }> {
  const factors: string[] = [];
  let score = 100; // Start at perfect

  // Get payment pattern if exists
  const paymentPattern = await prisma.paymentPattern.findFirst({
    where: { customerId: customer.id },
    orderBy: { calculatedAt: 'desc' },
  });

  if (paymentPattern) {
    // Reduce score based on success rate
    const successRate = paymentPattern.successRate;
    if (successRate < 0.5) {
      score -= 50;
      factors.push('low_payment_success_rate');
    } else if (successRate < 0.7) {
      score -= 30;
      factors.push('moderate_payment_failures');
    } else if (successRate < 0.9) {
      score -= 15;
    }

    // Consecutive failures are critical
    if (paymentPattern.consecutiveFailures >= 3) {
      score -= 40;
      factors.push('multiple_consecutive_failures');
    } else if (paymentPattern.consecutiveFailures >= 2) {
      score -= 25;
      factors.push('consecutive_payment_failures');
    } else if (paymentPattern.consecutiveFailures >= 1) {
      score -= 10;
      factors.push('recent_payment_failure');
    }

    // High payment risk score
    if (paymentPattern.paymentRiskScore > 70) {
      score -= 20;
      factors.push('high_payment_risk');
    }
  }

  // Check for active subscription
  const activeSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'active' || sub.status === 'trialing'
  );

  if (!activeSubscription) {
    score -= 30;
    factors.push('no_active_subscription');
  }

  // Check for past_due status
  const pastDueSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'past_due'
  );

  if (pastDueSubscription) {
    score -= 35;
    factors.push('subscription_past_due');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
  };
}

/**
 * Calculate engagement score (0-100)
 * Based on: login frequency, feature usage, last activity
 */
async function calculateEngagementScore(
  customer: Customer
): Promise<{ score: number; factors: string[] }> {
  const factors: string[] = [];
  let score = 100;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Count logins in last 30 days
  const recentLogins = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'LOGIN',
      occurredAt: { gte: thirtyDaysAgo },
    },
  });

  if (recentLogins === 0) {
    score -= 60;
    factors.push('no_logins_30d');
  } else if (recentLogins < 5) {
    score -= 40;
    factors.push('low_login_frequency');
  } else if (recentLogins < 10) {
    score -= 20;
    factors.push('moderate_login_frequency');
  }

  // Check last activity
  const lastActivity = await prisma.behavioralEvent.findFirst({
    where: { customerId: customer.id },
    orderBy: { occurredAt: 'desc' },
  });

  if (!lastActivity) {
    score -= 30;
    factors.push('no_activity_recorded');
  } else {
    const daysSinceActivity = Math.floor(
      (now.getTime() - lastActivity.occurredAt.getTime()) /
        (24 * 60 * 60 * 1000)
    );

    if (daysSinceActivity > 30) {
      score -= 50;
      factors.push('inactive_30d');
    } else if (daysSinceActivity > 14) {
      score -= 30;
      factors.push('inactive_14d');
    } else if (daysSinceActivity > 7) {
      score -= 15;
      factors.push('inactive_7d');
    }
  }

  // Count feature usage in last 7 days
  const recentFeatureUsage = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'FEATURE_USED',
      occurredAt: { gte: sevenDaysAgo },
    },
  });

  if (recentFeatureUsage === 0) {
    score -= 25;
    factors.push('no_feature_usage_7d');
  } else if (recentFeatureUsage < 3) {
    score -= 10;
    factors.push('low_feature_usage');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
  };
}

/**
 * Calculate usage score (0-100)
 * Based on: API usage trends, data volume, integration activity
 */
async function calculateUsageScore(
  customer: Customer
): Promise<{ score: number; factors: string[] }> {
  const factors: string[] = [];
  let score = 100;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Get recent API usage metrics
  const apiUsageMetrics = await prisma.usageMetric.findMany({
    where: {
      customerId: customer.id,
      metricType: 'API_CALLS',
      periodStart: { gte: thirtyDaysAgo },
    },
    orderBy: { periodStart: 'desc' },
    take: 4, // Last 4 weeks
  });

  if (apiUsageMetrics.length === 0) {
    score -= 40;
    factors.push('no_api_usage');
  } else {
    // Check for declining trend
    const hasDecreasingTrend = apiUsageMetrics.some(
      (metric) => metric.trend === 'DECREASING'
    );
    if (hasDecreasingTrend) {
      score -= 25;
      factors.push('declining_api_usage');
    }

    // Check for significant drop
    const latestMetric = apiUsageMetrics[0];
    if (latestMetric?.changePercent && latestMetric.changePercent < -50) {
      score -= 35;
      factors.push('api_usage_dropped_50%');
    } else if (latestMetric?.changePercent && latestMetric.changePercent < -25) {
      score -= 20;
      factors.push('api_usage_dropped_25%');
    }

    // Check for very low absolute usage
    if (latestMetric?.value && latestMetric.value < 10) {
      score -= 30;
      factors.push('very_low_api_usage');
    }
  }

  // Count active integrations
  const activeIntegrations = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'INTEGRATION_ADDED',
      occurredAt: { gte: thirtyDaysAgo },
    },
  });

  if (activeIntegrations === 0) {
    score -= 15;
    factors.push('no_integrations');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
  };
}

/**
 * Calculate subscription health score (0-100)
 * Based on: subscription tenure, plan level, upgrade/downgrade history
 */
async function calculateSubscriptionHealthScore(
  customer: Customer & { subscriptions: any[] }
): Promise<{ score: number; factors: string[] }> {
  const factors: string[] = [];
  let score = 100;

  if (customer.subscriptions.length === 0) {
    score = 0;
    factors.push('no_subscriptions');
    return { score, factors };
  }

  const activeSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'active' || sub.status === 'trialing'
  );

  if (!activeSubscription) {
    score -= 50;
    factors.push('no_active_subscription');
    return {
      score: Math.max(0, score),
      factors,
    };
  }

  // Calculate tenure (days since first subscription)
  const firstSubscription = customer.subscriptions[
    customer.subscriptions.length - 1
  ];
  const tenureDays = Math.floor(
    (new Date().getTime() - new Date(firstSubscription.createdAt).getTime()) /
      (24 * 60 * 60 * 1000)
  );

  if (tenureDays < 30) {
    score -= 20;
    factors.push('new_customer');
  } else if (tenureDays < 90) {
    score -= 10;
  }

  // Check for trial status
  if (activeSubscription.status === 'trialing') {
    score -= 15;
    factors.push('on_trial');

    // Check trial end date
    if (activeSubscription.currentPeriodEnd) {
      const trialEndsIn = Math.floor(
        (new Date(activeSubscription.currentPeriodEnd).getTime() -
          new Date().getTime()) /
          (24 * 60 * 60 * 1000)
      );

      if (trialEndsIn <= 3) {
        score -= 15;
        factors.push('trial_ending_soon');
      }
    }
  }

  // Check for cancelled subscription
  if (activeSubscription.cancelAtPeriodEnd) {
    score -= 40;
    factors.push('subscription_cancelled');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
  };
}

/**
 * Calculate support score (0-100)
 * Based on: support ticket frequency and severity
 */
async function calculateSupportScore(
  customer: Customer
): Promise<{ score: number; factors: string[] }> {
  const factors: string[] = [];
  let score = 100;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Count support tickets in last 30 days
  const recentTickets = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'SUPPORT_TICKET_CREATED',
      occurredAt: { gte: thirtyDaysAgo },
    },
  });

  if (recentTickets > 10) {
    score -= 50;
    factors.push('frequent_support_tickets');
  } else if (recentTickets > 5) {
    score -= 30;
    factors.push('moderate_support_tickets');
  } else if (recentTickets > 2) {
    score -= 15;
    factors.push('some_support_tickets');
  }

  // Check for data export events (potential churn signal)
  const dataExports = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'EXPORT_DATA',
      occurredAt: { gte: thirtyDaysAgo },
    },
  });

  if (dataExports > 0) {
    score -= 20;
    factors.push('data_export_activity');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    factors,
  };
}

/**
 * Determine risk level based on overall score
 */
function determineRiskLevel(
  score: number
): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score <= 25) return 'CRITICAL';
  if (score <= 50) return 'HIGH';
  if (score <= 75) return 'MEDIUM';
  return 'LOW';
}

/**
 * Determine trend by comparing with previous score
 */
async function determineTrend(
  customerId: string,
  currentScore: number
): Promise<'IMPROVING' | 'STABLE' | 'DECLINING'> {
  const previousScore = await prisma.customerHealthScore.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });

  if (!previousScore) {
    return 'STABLE'; // No previous score to compare
  }

  const scoreDiff = currentScore - previousScore.score;

  if (scoreDiff >= 10) return 'IMPROVING';
  if (scoreDiff <= -10) return 'DECLINING';
  return 'STABLE';
}

/**
 * Save health score to database
 */
export async function saveHealthScore(
  customerId: string,
  breakdown: HealthScoreBreakdown
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // Recalculate daily

  // Get previous score for trend tracking
  const previousScore = await prisma.customerHealthScore.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });

  const savedScore = await prisma.customerHealthScore.create({
    data: {
      customerId,
      score: breakdown.overallScore,
      paymentHealthScore: breakdown.paymentHealthScore,
      engagementScore: breakdown.engagementScore,
      usageScore: breakdown.usageScore,
      subscriptionHealthScore: breakdown.subscriptionHealthScore,
      supportScore: breakdown.supportScore,
      riskLevel: breakdown.riskLevel,
      riskFactors: breakdown.riskFactors,
      trend: breakdown.trend,
      previousScore: previousScore?.score,
      scoreChange: previousScore
        ? breakdown.overallScore - previousScore.score
        : null,
      breakdown: breakdown.breakdown as any,
      expiresAt,
    },
  });

  // Get customer with organization for Kafka event
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      connection: {
        select: { organizationId: true },
      },
    },
  });

  // Publish to Kafka for historical tracking in ClickHouse
  if (customer) {
    await publishAnalyticsEvent(AnalyticsTopics.HEALTH_SCORES, {
      id: savedScore.id,
      customerId,
      organizationId: customer.connection.organizationId,
      overallScore: breakdown.overallScore,
      paymentHealthScore: breakdown.paymentHealthScore,
      engagementScore: breakdown.engagementScore,
      usageScore: breakdown.usageScore,
      subscriptionHealthScore: breakdown.subscriptionHealthScore,
      supportScore: breakdown.supportScore,
      riskLevel: breakdown.riskLevel,
      trend: breakdown.trend,
      calculatedAt: savedScore.calculatedAt,
    });
  }

  logger.info(
    {
      customerId,
      score: breakdown.overallScore,
      riskLevel: breakdown.riskLevel,
      trend: breakdown.trend,
    },
    'Health score calculated'
  );
}

/**
 * Get latest health score for customer
 */
export async function getLatestHealthScore(customerId: string) {
  return await prisma.customerHealthScore.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });
}

/**
 * Calculate and save health score for a customer
 */
export async function calculateAndSaveHealthScore(
  customerId: string
): Promise<HealthScoreBreakdown> {
  const breakdown = await calculateHealthScore(customerId);
  await saveHealthScore(customerId, breakdown);
  return breakdown;
}

/**
 * Batch calculate health scores for all customers
 */
export async function batchCalculateHealthScores(
  connectionId: string
): Promise<{ processed: number; errors: number }> {
  const customers = await prisma.customer.findMany({
    where: { connectionId },
    select: { id: true },
  });

  let processed = 0;
  let errors = 0;

  for (const customer of customers) {
    try {
      await calculateAndSaveHealthScore(customer.id);
      processed++;
    } catch (error) {
      logger.error('Failed to calculate health score', {
        customerId: customer.id,
        error,
      });
      errors++;
    }
  }

  logger.info('Batch health score calculation complete', {
    connectionId,
    processed,
    errors,
  });

  return { processed, errors };
}
