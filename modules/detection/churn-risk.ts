/**
 * Churn Risk Analysis Service
 *
 * Predicts likelihood of customer churn based on:
 * - Payment failure patterns
 * - Engagement decline
 * - Usage trends
 * - Support interactions
 * - Health score trajectory
 *
 * Outputs churn probability (0-1) and recommended retention actions
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import type { Customer } from '@prisma/client';
import { logger } from '../../shared/logger/index.js';
import { getLatestHealthScore } from './health-score.js';
import { publishAnalyticsEvent, AnalyticsTopics } from '../../infrastructure/kafka/index.js';
import { onChurnRiskCalculated } from '../retention/triggers/churn-trigger.js';

interface ChurnRiskAnalysis {
  score: number; // 0-100, higher = more likely to churn
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  churnProbability: number; // 0.0-1.0
  predictedChurnDate: Date | null;
  daysUntilPredictedChurn: number | null;

  // Risk factor scores (0-100 each)
  paymentFailureRisk: number;
  engagementDeclineRisk: number;
  usageDeclineRisk: number;
  supportIssueRisk: number;

  // Detected signals
  churnSignals: string[];

  // Recommended actions
  recommendedActions: string[];
  priority: 'IMMEDIATE' | 'HIGH' | 'MEDIUM' | 'LOW';

  // Trend
  trend: 'IMPROVING' | 'STABLE' | 'DECLINING';
}

/**
 * Analyze churn risk for a customer
 */
export async function analyzeChurnRisk(
  customerId: string
): Promise<ChurnRiskAnalysis> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });

  if (!customer) {
    throw new Error(`Customer ${customerId} not found`);
  }

  // Get latest health score
  const healthScore = await getLatestHealthScore(customerId);

  // Calculate risk factors
  const paymentFailureRisk = await calculatePaymentFailureRisk(customer);
  const engagementDeclineRisk = await calculateEngagementDeclineRisk(customer);
  const usageDeclineRisk = await calculateUsageDeclineRisk(customer);
  const supportIssueRisk = await calculateSupportIssueRisk(customer);

  // Calculate overall churn risk score (weighted average)
  const churnRiskScore = Math.round(
    paymentFailureRisk * 0.4 +
      engagementDeclineRisk * 0.3 +
      usageDeclineRisk * 0.2 +
      supportIssueRisk * 0.1
  );

  // Determine risk level
  const riskLevel = determineChurnRiskLevel(churnRiskScore);

  // Calculate churn probability
  const churnProbability = calculateChurnProbability(
    churnRiskScore,
    healthScore?.score || 50
  );

  // Detect churn signals
  const churnSignals = detectChurnSignals(
    customer,
    paymentFailureRisk,
    engagementDeclineRisk,
    usageDeclineRisk,
    supportIssueRisk
  );

  // Predict churn date
  const { predictedChurnDate, daysUntilPredictedChurn } =
    predictChurnDate(customer, churnProbability);

  // Generate recommended actions
  const { recommendedActions, priority } = generateRecommendedActions(
    riskLevel,
    churnSignals,
    customer
  );

  // Determine trend
  const trend = await determineChurnTrend(customerId, churnRiskScore);

  return {
    score: churnRiskScore,
    riskLevel,
    churnProbability,
    predictedChurnDate,
    daysUntilPredictedChurn,
    paymentFailureRisk,
    engagementDeclineRisk,
    usageDeclineRisk,
    supportIssueRisk,
    churnSignals,
    recommendedActions,
    priority,
    trend,
  };
}

/**
 * Calculate payment failure risk (0-100)
 */
async function calculatePaymentFailureRisk(
  customer: Customer & { subscriptions: any[] }
): Promise<number> {
  let risk = 0;

  // Get payment pattern
  const paymentPattern = await prisma.paymentPattern.findFirst({
    where: { customerId: customer.id },
    orderBy: { calculatedAt: 'desc' },
  });

  if (paymentPattern) {
    // High risk if consecutive failures
    if (paymentPattern.consecutiveFailures >= 3) {
      risk += 80;
    } else if (paymentPattern.consecutiveFailures >= 2) {
      risk += 60;
    } else if (paymentPattern.consecutiveFailures >= 1) {
      risk += 40;
    }

    // Increase risk based on failure rate
    const failureRate = 1 - paymentPattern.successRate;
    risk += failureRate * 50;

    // High likelihood of next failure
    if (paymentPattern.likelihoodOfNextFailure > 0.7) {
      risk += 40;
    } else if (paymentPattern.likelihoodOfNextFailure > 0.5) {
      risk += 25;
    }
  }

  // Check for past_due subscription
  const pastDueSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'past_due'
  );

  if (pastDueSubscription) {
    risk += 50;
  }

  // Check for cancelled subscription
  const cancelledSubscription = customer.subscriptions.find(
    (sub) => sub.cancelAtPeriodEnd === true
  );

  if (cancelledSubscription) {
    risk += 70;
  }

  return Math.min(100, risk);
}

/**
 * Calculate engagement decline risk (0-100)
 */
async function calculateEngagementDeclineRisk(
  customer: Customer
): Promise<number> {
  let risk = 0;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Get login counts for last 30 days and previous 30 days
  const [recentLogins, previousLogins] = await Promise.all([
    prisma.behavioralEvent.count({
      where: {
        customerId: customer.id,
        eventType: 'LOGIN',
        occurredAt: { gte: thirtyDaysAgo },
      },
    }),
    prisma.behavioralEvent.count({
      where: {
        customerId: customer.id,
        eventType: 'LOGIN',
        occurredAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
    }),
  ]);

  // No logins in 30 days is critical
  if (recentLogins === 0) {
    risk += 80;
  } else {
    // Calculate decline percentage
    if (previousLogins > 0) {
      const declinePercent = ((previousLogins - recentLogins) / previousLogins) * 100;

      if (declinePercent > 70) {
        risk += 50;
      } else if (declinePercent > 50) {
        risk += 35;
      } else if (declinePercent > 30) {
        risk += 20;
      }
    }

    // Low absolute engagement
    if (recentLogins < 3) {
      risk += 30;
    } else if (recentLogins < 7) {
      risk += 15;
    }
  }

  // Check last activity
  const lastActivity = await prisma.behavioralEvent.findFirst({
    where: { customerId: customer.id },
    orderBy: { occurredAt: 'desc' },
  });

  if (lastActivity) {
    const daysSinceActivity = Math.floor(
      (now.getTime() - lastActivity.occurredAt.getTime()) /
        (24 * 60 * 60 * 1000)
    );

    if (daysSinceActivity > 60) {
      risk += 70;
    } else if (daysSinceActivity > 30) {
      risk += 50;
    } else if (daysSinceActivity > 14) {
      risk += 25;
    }
  }

  return Math.min(100, risk);
}

/**
 * Calculate usage decline risk (0-100)
 */
async function calculateUsageDeclineRisk(
  customer: Customer
): Promise<number> {
  let risk = 0;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Get recent usage metrics
  const recentMetrics = await prisma.usageMetric.findMany({
    where: {
      customerId: customer.id,
      metricType: 'API_CALLS',
      periodStart: { gte: thirtyDaysAgo },
    },
    orderBy: { periodStart: 'desc' },
    take: 4,
  });

  if (recentMetrics.length === 0) {
    risk += 60;
    return risk;
  }

  // Check for declining trend
  const decliningMetrics = recentMetrics.filter(
    (m) => m.trend === 'DECREASING'
  );

  if (decliningMetrics.length >= 3) {
    risk += 50; // Consistent decline
  } else if (decliningMetrics.length >= 2) {
    risk += 30;
  }

  // Check for significant drops
  const latestMetric = recentMetrics[0];
  if (latestMetric?.changePercent) {
    if (latestMetric.changePercent < -70) {
      risk += 60;
    } else if (latestMetric.changePercent < -50) {
      risk += 40;
    } else if (latestMetric.changePercent < -30) {
      risk += 25;
    }
  }

  // Very low absolute usage
  if (latestMetric?.value && latestMetric.value < 5) {
    risk += 40;
  } else if (latestMetric?.value && latestMetric.value < 20) {
    risk += 20;
  }

  return Math.min(100, risk);
}

/**
 * Calculate support issue risk (0-100)
 */
async function calculateSupportIssueRisk(
  customer: Customer
): Promise<number> {
  let risk = 0;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Count recent support tickets
  const supportTickets = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'SUPPORT_TICKET_CREATED',
      occurredAt: { gte: thirtyDaysAgo },
    },
  });

  if (supportTickets > 15) {
    risk += 70;
  } else if (supportTickets > 10) {
    risk += 50;
  } else if (supportTickets > 5) {
    risk += 30;
  }

  // Data export is a strong churn signal
  const dataExports = await prisma.behavioralEvent.count({
    where: {
      customerId: customer.id,
      eventType: 'EXPORT_DATA',
      occurredAt: { gte: thirtyDaysAgo },
    },
  });

  if (dataExports > 0) {
    risk += 50; // Strong signal they're leaving
  }

  return Math.min(100, risk);
}

/**
 * Determine churn risk level
 */
function determineChurnRiskLevel(
  score: number
): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate churn probability (0.0-1.0)
 * Combines churn risk score with health score
 */
function calculateChurnProbability(
  churnRiskScore: number,
  healthScore: number
): number {
  // Higher churn risk and lower health = higher probability
  const rawProbability = (churnRiskScore / 100 + (100 - healthScore) / 100) / 2;

  // Apply sigmoid curve for realistic probabilities
  const probability = 1 / (1 + Math.exp(-10 * (rawProbability - 0.5)));

  return Math.max(0, Math.min(1, probability));
}

/**
 * Detect specific churn signals
 */
function detectChurnSignals(
  customer: Customer & { subscriptions: any[] },
  paymentRisk: number,
  engagementRisk: number,
  usageRisk: number,
  supportRisk: number
): string[] {
  const signals: string[] = [];

  // Payment signals
  if (paymentRisk > 70) {
    signals.push('high_payment_failure_risk');
  }
  if (customer.subscriptions.some((sub) => sub.status === 'past_due')) {
    signals.push('subscription_past_due');
  }
  if (customer.subscriptions.some((sub) => sub.cancelAtPeriodEnd)) {
    signals.push('subscription_cancelled');
  }

  // Engagement signals
  if (engagementRisk > 70) {
    signals.push('severely_declining_engagement');
  } else if (engagementRisk > 50) {
    signals.push('declining_engagement');
  }

  // Usage signals
  if (usageRisk > 70) {
    signals.push('usage_dropped_significantly');
  } else if (usageRisk > 50) {
    signals.push('declining_usage');
  }

  // Support signals
  if (supportRisk > 60) {
    signals.push('high_support_activity');
  }

  return signals;
}

/**
 * Predict churn date based on current trajectory
 */
function predictChurnDate(
  customer: Customer & { subscriptions: any[] },
  churnProbability: number
): {
  predictedChurnDate: Date | null;
  daysUntilPredictedChurn: number | null;
} {
  // If subscription already cancelled, use period end
  const cancelledSubscription = customer.subscriptions.find(
    (sub) => sub.cancelAtPeriodEnd && sub.currentPeriodEnd
  );

  if (cancelledSubscription) {
    const churnDate = new Date(cancelledSubscription.currentPeriodEnd);
    const daysUntil = Math.floor(
      (churnDate.getTime() - new Date().getTime()) / (24 * 60 * 60 * 1000)
    );

    return {
      predictedChurnDate: churnDate,
      daysUntilPredictedChurn: daysUntil,
    };
  }

  // Estimate based on churn probability
  if (churnProbability > 0.8) {
    // Very high risk - predict 7-14 days
    const daysUntil = Math.round(7 + Math.random() * 7);
    const churnDate = new Date();
    churnDate.setDate(churnDate.getDate() + daysUntil);
    return { predictedChurnDate: churnDate, daysUntilPredictedChurn: daysUntil };
  } else if (churnProbability > 0.6) {
    // High risk - predict 14-30 days
    const daysUntil = Math.round(14 + Math.random() * 16);
    const churnDate = new Date();
    churnDate.setDate(churnDate.getDate() + daysUntil);
    return { predictedChurnDate: churnDate, daysUntilPredictedChurn: daysUntil };
  } else if (churnProbability > 0.4) {
    // Medium risk - predict 30-60 days
    const daysUntil = Math.round(30 + Math.random() * 30);
    const churnDate = new Date();
    churnDate.setDate(churnDate.getDate() + daysUntil);
    return { predictedChurnDate: churnDate, daysUntilPredictedChurn: daysUntil };
  }

  // Low risk - no prediction
  return { predictedChurnDate: null, daysUntilPredictedChurn: null };
}

/**
 * Generate recommended retention actions
 */
function generateRecommendedActions(
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
  churnSignals: string[],
  customer: Customer & { subscriptions: any[] }
): {
  recommendedActions: string[];
  priority: 'IMMEDIATE' | 'HIGH' | 'MEDIUM' | 'LOW';
} {
  const actions: string[] = [];
  let priority: 'IMMEDIATE' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

  if (riskLevel === 'CRITICAL') {
    priority = 'IMMEDIATE';
    actions.push('schedule_urgent_call');
    actions.push('offer_premium_discount');
    actions.push('assign_account_manager');

    if (churnSignals.includes('subscription_past_due')) {
      actions.push('payment_recovery_sequence');
    }
    if (churnSignals.includes('subscription_cancelled')) {
      actions.push('win_back_campaign');
    }
  } else if (riskLevel === 'HIGH') {
    priority = 'HIGH';
    actions.push('send_retention_email');
    actions.push('offer_discount');
    actions.push('schedule_check_in_call');

    if (churnSignals.includes('declining_usage')) {
      actions.push('feature_education_campaign');
      actions.push('usage_tips_email');
    }
    if (churnSignals.includes('declining_engagement')) {
      actions.push('re_engagement_campaign');
    }
  } else if (riskLevel === 'MEDIUM') {
    priority = 'MEDIUM';
    actions.push('monitor_closely');
    actions.push('send_value_reminder_email');

    if (churnSignals.includes('high_support_activity')) {
      actions.push('proactive_support_outreach');
    }
  } else {
    priority = 'LOW';
    actions.push('continue_monitoring');
  }

  return { recommendedActions: actions, priority };
}

/**
 * Determine churn risk trend
 */
async function determineChurnTrend(
  customerId: string,
  currentScore: number
): Promise<'IMPROVING' | 'STABLE' | 'DECLINING'> {
  const previousScore = await prisma.churnRiskScore.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });

  if (!previousScore) {
    return 'STABLE';
  }

  const scoreDiff = currentScore - previousScore.score;

  // Note: For churn risk, increasing score is bad (DECLINING trend)
  if (scoreDiff >= 10) return 'DECLINING'; // Risk increasing
  if (scoreDiff <= -10) return 'IMPROVING'; // Risk decreasing
  return 'STABLE';
}

/**
 * Save churn risk analysis to database
 */
export async function saveChurnRiskAnalysis(
  customerId: string,
  analysis: ChurnRiskAnalysis
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // Recalculate daily

  const previousScore = await prisma.churnRiskScore.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });

  const savedRisk = await prisma.churnRiskScore.create({
    data: {
      customerId,
      score: analysis.score,
      riskLevel: analysis.riskLevel,
      churnProbability: analysis.churnProbability,
      predictedChurnDate: analysis.predictedChurnDate,
      daysUntilPredictedChurn: analysis.daysUntilPredictedChurn,
      paymentFailureRisk: analysis.paymentFailureRisk,
      engagementDeclineRisk: analysis.engagementDeclineRisk,
      usageDeclineRisk: analysis.usageDeclineRisk,
      supportIssueRisk: analysis.supportIssueRisk,
      churnSignals: analysis.churnSignals,
      recommendedActions: analysis.recommendedActions,
      priority: analysis.priority,
      trend: analysis.trend,
      previousScore: previousScore?.score,
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
    await publishAnalyticsEvent(AnalyticsTopics.CHURN_RISKS, {
      id: savedRisk.id,
      customerId,
      organizationId: customer.connection.organizationId,
      churnScore: analysis.score,
      churnProbability: analysis.churnProbability,
      riskLevel: analysis.riskLevel,
      paymentFailureRisk: analysis.paymentFailureRisk,
      engagementDeclineRisk: analysis.engagementDeclineRisk,
      usageDeclineRisk: analysis.usageDeclineRisk,
      supportIssueRisk: analysis.supportIssueRisk,
      predictedChurnDate: analysis.predictedChurnDate,
      daysUntilPredictedChurn: analysis.daysUntilPredictedChurn,
      priority: analysis.priority,
      trend: analysis.trend,
      calculatedAt: savedRisk.calculatedAt,
    });
  }

  logger.info(
    {
      customerId,
      riskLevel: analysis.riskLevel,
      churnProbability: analysis.churnProbability,
      priority: analysis.priority,
    },
    'Churn risk analyzed'
  );

  // Trigger retention campaigns if risk is HIGH or CRITICAL
  if (analysis.riskLevel === 'HIGH' || analysis.riskLevel === 'CRITICAL') {
    await onChurnRiskCalculated(customerId, savedRisk);
  }
}

/**
 * Calculate and save churn risk for a customer
 */
export async function analyzeAndSaveChurnRisk(
  customerId: string
): Promise<ChurnRiskAnalysis> {
  const analysis = await analyzeChurnRisk(customerId);
  await saveChurnRiskAnalysis(customerId, analysis);
  return analysis;
}

/**
 * Get latest churn risk for customer
 */
export async function getLatestChurnRisk(customerId: string) {
  return await prisma.churnRiskScore.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });
}

/**
 * Get all high-risk customers for a connection
 */
export async function getHighRiskCustomers(connectionId: string) {
  const customers = await prisma.customer.findMany({
    where: { connectionId },
    include: {
      churnRiskScores: {
        orderBy: { calculatedAt: 'desc' },
        take: 1,
      },
    },
  });

  return customers
    .filter(
      (c) =>
        c.churnRiskScores[0] &&
        (c.churnRiskScores[0].riskLevel === 'CRITICAL' ||
          c.churnRiskScores[0].riskLevel === 'HIGH')
    )
    .map((c) => ({
      customer: c,
      riskScore: c.churnRiskScores[0],
    }))
    .sort((a, b) => b.riskScore.score - a.riskScore.score);
}
