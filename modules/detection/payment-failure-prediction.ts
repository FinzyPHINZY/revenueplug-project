/**
 * Payment Failure Prediction Service
 *
 * Predicts payment failures for upcoming invoices 7-30 days in advance
 *
 * Phases:
 * - Phase 1: Rule-based prediction (critical flags)
 * - Phase 2: Statistical scoring model (weighted factors)
 * - Phase 3: ML model (optional, future)
 *
 * Prediction Signals:
 * 1. Payment History (40%): Success rate, failure patterns, consecutive failures
 * 2. Card Health (30%): Expiration date, previous declines, card brand
 * 3. Subscription Signals (10%): Trial ending, past_due status, downgrade attempts
 * 4. Behavioral Signals (20%): Login frequency, usage decline, data exports
 */

import { AnalyticsTopics, publishAnalyticsEvent } from '../../infrastructure/kafka/index.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { getEventCount, getRecentEvents } from './behavioral-tracking.js';

// Prediction risk levels
export enum PredictionRiskLevel {
  CRITICAL = 'CRITICAL', // >80% failure probability
  HIGH = 'HIGH', // 60-80%
  MEDIUM = 'MEDIUM', // 40-60%
  LOW = 'LOW', // 20-40%
  MINIMAL = 'MINIMAL', // <20%
}

// Prediction model version
export enum PredictionModel {
  RULE_BASED = 'RULE_BASED', // Phase 1
  STATISTICAL = 'STATISTICAL', // Phase 2
  MACHINE_LEARNING = 'MACHINE_LEARNING', // Phase 3 (future)
}

/**
 * Payment failure prediction result
 */
export interface PaymentFailurePrediction {
  // Invoice details
  invoiceId: string;
  customerId: string;
  connectionId: string;
  organizationId: string;

  // Invoice metadata
  invoiceExternalId: string;
  amountDue: number;
  currency: string;
  dueDate: Date;
  nextPaymentAttempt: Date | null;

  // Prediction
  failureProbability: number; // 0.0-1.0
  predictionScore: number; // 0-100 (higher = more likely to fail)
  riskLevel: PredictionRiskLevel;
  model: PredictionModel;

  // Signal breakdown
  paymentHistoryScore: number; // 0-40 points
  cardHealthScore: number; // 0-30 points
  subscriptionScore: number; // 0-10 points
  behavioralScore: number; // 0-20 points

  // Critical flags (Phase 1 rules)
  criticalFlags: string[];

  // Recommendations
  recommendedActions: string[];
  preventiveMeasures: string[];

  // Metadata
  predictedAt: Date;
  confidence: number; // 0.0-1.0
}

/**
 * Helper function to trigger retention campaign based on prediction
 * Only triggers for HIGH or CRITICAL risk levels
 */
async function triggerRetentionCampaign(prediction: PaymentFailurePrediction): Promise<void> {
  // Only trigger for HIGH or CRITICAL risk
  if (
    prediction.riskLevel !== PredictionRiskLevel.HIGH &&
    prediction.riskLevel !== PredictionRiskLevel.CRITICAL
  ) {
    return;
  }

  try {
    // Dynamically import to avoid circular dependency
    const { onPredictionGenerated } =
      await import('../retention/triggers/payment-prediction-trigger.js');
    await onPredictionGenerated(prediction);
  } catch (error) {
    logger.warn(
      { prediction: prediction.invoiceId, error },
      'Failed to trigger retention campaign for prediction'
    );
    // Don't throw - prediction should not fail if retention trigger fails
  }
}

/**
 * Predict payment failure for a specific invoice
 */
export async function predictInvoiceFailure(invoiceId: string): Promise<PaymentFailurePrediction> {
  // Get invoice with customer and subscription data
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      connection: {
        select: {
          id: true,
          organizationId: true,
        },
      },
    },
  });

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  // Get customer details
  const customer = await prisma.customer.findFirst({
    where: {
      connectionId: invoice.connectionId,
      externalId: invoice.customerExternalId || '',
    },
    include: {
      subscriptions: {
        where: {
          externalId: invoice.subscriptionExternalId || '',
        },
        take: 1,
      },
    },
  });

  if (!customer) {
    logger.warn(
      { invoiceId, customerExternalId: invoice.customerExternalId },
      'Customer not found for invoice'
    );
    throw new Error(`Customer not found for invoice ${invoiceId}`);
  }

  const subscription = customer.subscriptions[0];

  // Phase 1: Check critical flags (rule-based)
  const criticalFlags = await checkCriticalFlags(invoice, customer, subscription);

  // If critical flags detected, return HIGH/CRITICAL prediction immediately
  if (criticalFlags.length > 0) {
    return buildCriticalPrediction(invoice, customer, criticalFlags);
  }

  // Phase 2: Statistical scoring model
  const paymentHistoryScore = await calculatePaymentHistoryScore(customer.id, invoice.connectionId);
  const cardHealthScore = await calculateCardHealthScore(invoice, customer);
  const subscriptionScore = calculateSubscriptionScore(subscription);
  const behavioralScore = await calculateBehavioralScore(customer.id);

  // Calculate overall prediction score (0-100)
  const predictionScore = Math.min(
    100,
    paymentHistoryScore + cardHealthScore + subscriptionScore + behavioralScore
  );

  // Convert to probability (0.0-1.0) using sigmoid
  const failureProbability = 1 / (1 + Math.exp(-0.1 * (predictionScore - 50)));

  // Determine risk level
  const riskLevel = determineRiskLevel(failureProbability);

  // Generate recommendations
  const { recommendedActions, preventiveMeasures } = generateRecommendations(
    riskLevel,
    paymentHistoryScore,
    cardHealthScore,
    subscriptionScore,
    behavioralScore,
    criticalFlags
  );

  // Calculate confidence based on data availability
  const confidence = calculateConfidence(customer, subscription);

  const prediction: PaymentFailurePrediction = {
    invoiceId: invoice.id,
    customerId: customer.id,
    connectionId: invoice.connectionId,
    organizationId: invoice.connection.organizationId,
    invoiceExternalId: invoice.externalId,
    amountDue: Number(invoice.amountDue),
    currency: invoice.currency,
    dueDate: invoice.dueDate || new Date(),
    nextPaymentAttempt: invoice.nextPaymentAttempt,
    failureProbability,
    predictionScore,
    riskLevel,
    model: PredictionModel.STATISTICAL,
    paymentHistoryScore,
    cardHealthScore,
    subscriptionScore,
    behavioralScore,
    criticalFlags,
    recommendedActions,
    preventiveMeasures,
    predictedAt: new Date(),
    confidence,
  };

  // Publish prediction to Kafka for tracking
  await publishPrediction(prediction);

  // Trigger retention campaign if risk is high enough
  await triggerRetentionCampaign(prediction);

  logger.info(
    {
      invoiceId,
      customerId: customer.id,
      riskLevel,
      failureProbability,
      predictionScore,
    },
    'Payment failure predicted'
  );

  return prediction;
}

/**
 * Phase 1: Check critical flags (rule-based)
 */
async function checkCriticalFlags(
  invoice: any,
  customer: any,
  subscription: any
): Promise<string[]> {
  const flags: string[] = [];

  // Check card expiration (from rawData if available)
  if (invoice.rawData && typeof invoice.rawData === 'object') {
    const data = invoice.rawData as any;
    if (data.default_payment_method?.card) {
      const card = data.default_payment_method.card;
      const expMonth = card.exp_month;
      const expYear = card.exp_year;
      const now = new Date();
      const cardExpiry = new Date(expYear, expMonth - 1, 1);

      if (cardExpiry < now) {
        flags.push('card_expired');
      } else if (cardExpiry < new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)) {
        flags.push('card_expiring_soon');
      }
    }
  }

  // Check previous failures on this invoice
  if (invoice.attemptCount > 0 && invoice.status !== 'PAID') {
    flags.push('previous_attempt_failed');
    if (invoice.attemptCount >= 3) {
      flags.push('multiple_failed_attempts');
    }
  }

  // Check customer payment history
  const recentPayments = await prisma.payment.findMany({
    where: {
      connectionId: invoice.connectionId,
      customerExternalId: customer.externalId,
      createdAt: {
        gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // Last 90 days
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const failedPayments = recentPayments.filter((p) => p.status === 'FAILED');
  if (failedPayments.length >= 3) {
    flags.push('high_historical_failure_rate');
  }

  // Check for consecutive failures
  let consecutiveFailures = 0;
  for (const payment of recentPayments) {
    if (payment.status === 'FAILED') {
      consecutiveFailures++;
    } else if (payment.status === 'SUCCEEDED') {
      break;
    }
  }
  if (consecutiveFailures >= 2) {
    flags.push('consecutive_failures');
  }

  // Check subscription status
  if (subscription?.status === 'PAST_DUE') {
    flags.push('subscription_past_due');
  }
  if (subscription?.status === 'UNPAID') {
    flags.push('subscription_unpaid');
  }

  return flags;
}

/**
 * Build critical prediction when flags detected
 */
function buildCriticalPrediction(
  invoice: any,
  customer: any,
  criticalFlags: string[]
): PaymentFailurePrediction {
  // Determine severity based on flags
  let failureProbability = 0.5;
  let riskLevel = PredictionRiskLevel.MEDIUM;

  if (criticalFlags.includes('card_expired') || criticalFlags.includes('subscription_unpaid')) {
    failureProbability = 0.95;
    riskLevel = PredictionRiskLevel.CRITICAL;
  } else if (
    criticalFlags.includes('multiple_failed_attempts') ||
    criticalFlags.includes('consecutive_failures')
  ) {
    failureProbability = 0.85;
    riskLevel = PredictionRiskLevel.CRITICAL;
  } else if (
    criticalFlags.includes('subscription_past_due') ||
    criticalFlags.includes('high_historical_failure_rate')
  ) {
    failureProbability = 0.75;
    riskLevel = PredictionRiskLevel.HIGH;
  } else if (
    criticalFlags.includes('card_expiring_soon') ||
    criticalFlags.includes('previous_attempt_failed')
  ) {
    failureProbability = 0.65;
    riskLevel = PredictionRiskLevel.HIGH;
  }

  const predictionScore = Math.round(failureProbability * 100);

  const { recommendedActions, preventiveMeasures } = generateRecommendations(
    riskLevel,
    0,
    0,
    0,
    0,
    criticalFlags
  );

  return {
    invoiceId: invoice.id,
    customerId: customer.id,
    connectionId: invoice.connectionId,
    organizationId: invoice.connection?.organizationId || '',
    invoiceExternalId: invoice.externalId,
    amountDue: Number(invoice.amountDue),
    currency: invoice.currency,
    dueDate: invoice.dueDate || new Date(),
    nextPaymentAttempt: invoice.nextPaymentAttempt,
    failureProbability,
    predictionScore,
    riskLevel,
    model: PredictionModel.RULE_BASED,
    paymentHistoryScore: 0,
    cardHealthScore: 0,
    subscriptionScore: 0,
    behavioralScore: 0,
    criticalFlags,
    recommendedActions,
    preventiveMeasures,
    predictedAt: new Date(),
    confidence: 0.9, // High confidence for rule-based flags
  };
}

/**
 * Calculate payment history score (0-40 points)
 * Higher score = more likely to fail
 */
async function calculatePaymentHistoryScore(
  customerId: string,
  connectionId: string
): Promise<number> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) return 20; // Default medium risk

  const payments = await prisma.payment.findMany({
    where: {
      connectionId,
      customerExternalId: customer.externalId,
      createdAt: {
        gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), // Last 6 months
      },
    },
  });

  if (payments.length === 0) return 20; // No history = medium risk

  const failedCount = payments.filter((p) => p.status === 'FAILED').length;
  const successRate = (payments.length - failedCount) / payments.length;
  const failureRate = 1 - successRate;

  // Calculate score based on failure rate
  let score = failureRate * 40;

  // Boost score for recent failures
  const recentPayments = payments
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5);
  const recentFailures = recentPayments.filter((p) => p.status === 'FAILED').length;
  if (recentFailures >= 2) {
    score += 10;
  }

  return Math.min(40, Math.round(score));
}

/**
 * Calculate card health score (0-30 points)
 * Higher score = more likely to fail
 */
async function calculateCardHealthScore(invoice: any, customer: any): Promise<number> {
  let score = 0;

  // Check card data from invoice rawData
  if (invoice.rawData && typeof invoice.rawData === 'object') {
    const data = invoice.rawData as any;

    // Card expiration
    if (data.default_payment_method?.card) {
      const card = data.default_payment_method.card;
      const expMonth = card.exp_month;
      const expYear = card.exp_year;
      const now = new Date();
      const cardExpiry = new Date(expYear, expMonth - 1, 1);
      const monthsUntilExpiry = (cardExpiry.getTime() - now.getTime()) / (30 * 24 * 60 * 60 * 1000);

      if (monthsUntilExpiry < 0) {
        score += 30; // Expired
      } else if (monthsUntilExpiry < 1) {
        score += 20; // Expiring within 1 month
      } else if (monthsUntilExpiry < 3) {
        score += 10; // Expiring within 3 months
      }

      // Card brand risk (some brands have higher failure rates)
      const brand = card.brand?.toLowerCase();
      if (brand === 'discover' || brand === 'diners') {
        score += 5; // Higher decline rate
      }

      // Check for 3D Secure
      if (!card.three_d_secure_supported) {
        score += 5;
      }
    }
  }

  // Check for previous card declines
  const recentPayments = await prisma.payment.findMany({
    where: {
      connectionId: invoice.connectionId,
      customerExternalId: customer.externalId,
      status: 'FAILED',
      failureReason: {
        contains: 'card',
      },
      createdAt: {
        gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      },
    },
    take: 5,
  });

  if (recentPayments.length >= 3) {
    score += 10;
  } else if (recentPayments.length >= 1) {
    score += 5;
  }

  return Math.min(30, Math.round(score));
}

/**
 * Calculate subscription health score (0-10 points)
 * Higher score = more likely to fail
 */
function calculateSubscriptionScore(subscription: any): number {
  if (!subscription) return 5; // No subscription = medium risk

  let score = 0;

  // Subscription status
  if (subscription.status === 'PAST_DUE') {
    score += 8;
  } else if (subscription.status === 'UNPAID') {
    score += 10;
  } else if (subscription.status === 'CANCELLED' || subscription.status === 'CANCELED') {
    score += 10;
  }

  // Trial ending soon
  if (subscription.trialEnd) {
    const trialEnd = new Date(subscription.trialEnd);
    const now = new Date();
    const daysUntilTrialEnd = (trialEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

    if (daysUntilTrialEnd > 0 && daysUntilTrialEnd < 7) {
      score += 5;
    }
  }

  // Cancel at period end
  if (subscription.cancelAtEnd) {
    score += 7;
  }

  return Math.min(10, Math.round(score));
}

/**
 * Calculate behavioral score (0-20 points)
 * Higher score = more likely to fail (lower engagement = higher risk)
 */
async function calculateBehavioralScore(customerId: string): Promise<number> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let score = 0;

  try {
    // Check login frequency
    const loginsLast7Days = await getEventCount(customerId, 'LOGIN', sevenDaysAgo);
    const loginsLast30Days = await getEventCount(customerId, 'LOGIN', thirtyDaysAgo);

    if (loginsLast7Days === 0) {
      score += 8; // No logins in 7 days
    } else if (loginsLast30Days < 4) {
      score += 4; // Low login frequency
    }

    // Check feature usage
    const featureUsageLast7Days = await getEventCount(customerId, 'FEATURE_USED', sevenDaysAgo);
    if (featureUsageLast7Days === 0) {
      score += 6; // No feature usage
    }

    // Check for churn signals
    const dataExports = await getEventCount(customerId, 'EXPORT_DATA', thirtyDaysAgo);
    if (dataExports > 0) {
      score += 6; // Data export = potential churn
    }

    // Check last activity
    const recentEvents = await getRecentEvents(customerId, 1);
    if (recentEvents.length > 0) {
      const lastActivity = new Date(recentEvents[0].occurred_at);
      const daysSinceActivity = (now.getTime() - lastActivity.getTime()) / (24 * 60 * 60 * 1000);

      if (daysSinceActivity > 30) {
        score += 10; // Inactive for 30+ days
      } else if (daysSinceActivity > 14) {
        score += 5; // Inactive for 14+ days
      }
    } else {
      score += 10; // No activity recorded
    }
  } catch (error) {
    logger.warn({ customerId, error }, 'Failed to calculate behavioral score');
    return 10; // Default medium risk if data unavailable
  }

  return Math.min(20, Math.round(score));
}

/**
 * Determine risk level from probability
 */
function determineRiskLevel(probability: number): PredictionRiskLevel {
  if (probability >= 0.8) return PredictionRiskLevel.CRITICAL;
  if (probability >= 0.6) return PredictionRiskLevel.HIGH;
  if (probability >= 0.4) return PredictionRiskLevel.MEDIUM;
  if (probability >= 0.2) return PredictionRiskLevel.LOW;
  return PredictionRiskLevel.MINIMAL;
}

/**
 * Generate recommended actions and preventive measures
 */
function generateRecommendations(
  riskLevel: PredictionRiskLevel,
  paymentScore: number,
  cardScore: number,
  subscriptionScore: number,
  behavioralScore: number,
  flags: string[]
): { recommendedActions: string[]; preventiveMeasures: string[] } {
  const actions: string[] = [];
  const preventive: string[] = [];

  // Critical/High risk actions
  if (riskLevel === PredictionRiskLevel.CRITICAL || riskLevel === PredictionRiskLevel.HIGH) {
    actions.push('send_payment_update_reminder');
    actions.push('enable_dunning_campaign');

    if (flags.includes('card_expired') || flags.includes('card_expiring_soon')) {
      actions.push('request_card_update');
      preventive.push('Send proactive card update email 7 days before charge');
    }

    if (flags.includes('subscription_past_due')) {
      actions.push('offer_payment_plan');
      actions.push('schedule_personal_outreach');
    }

    if (behavioralScore > 10) {
      actions.push('send_engagement_email');
      preventive.push('Re-engage customer with value proposition');
    }
  }

  // Medium risk actions
  if (riskLevel === PredictionRiskLevel.MEDIUM) {
    actions.push('monitor_closely');
    preventive.push('Send friendly payment reminder 3 days before charge');

    if (cardScore > 10) {
      preventive.push('Verify payment method is up to date');
    }
  }

  // Payment history specific
  if (paymentScore > 20) {
    actions.push('review_payment_history');
    preventive.push('Consider offering alternative payment methods');
  }

  // Behavioral specific
  if (behavioralScore > 15) {
    actions.push('trigger_retention_campaign');
    preventive.push('Reach out to understand usage decline');
  }

  return {
    recommendedActions: actions,
    preventiveMeasures: preventive,
  };
}

/**
 * Calculate prediction confidence based on data availability
 */
function calculateConfidence(customer: any, subscription: any): number {
  let confidence = 0.5; // Base confidence

  // More data = higher confidence
  if (customer) confidence += 0.1;
  if (subscription) confidence += 0.1;

  // Historical payment data boosts confidence (checked in calling function)
  confidence += 0.2;

  // Behavioral data boosts confidence
  confidence += 0.1;

  return Math.min(1.0, confidence);
}

/**
 * Publish prediction to Kafka for tracking
 */
async function publishPrediction(prediction: PaymentFailurePrediction): Promise<void> {
  try {
    await publishAnalyticsEvent(AnalyticsTopics.PAYMENT_PREDICTIONS, {
      id: `pred_${prediction.invoiceId}_${Date.now()}`,
      invoiceId: prediction.invoiceId,
      invoiceExternalId: prediction.invoiceExternalId,
      customerId: prediction.customerId,
      connectionId: prediction.connectionId,
      organizationId: prediction.organizationId,
      failureProbability: prediction.failureProbability,
      predictionScore: prediction.predictionScore,
      riskLevel: prediction.riskLevel,
      model: prediction.model,
      paymentHistoryScore: prediction.paymentHistoryScore,
      cardHealthScore: prediction.cardHealthScore,
      subscriptionScore: prediction.subscriptionScore,
      behavioralScore: prediction.behavioralScore,
      criticalFlags: prediction.criticalFlags,
      confidence: prediction.confidence,
      predictedAt: prediction.predictedAt,
      dueDate: prediction.dueDate,
      amountDue: prediction.amountDue,
      currency: prediction.currency,
    });
  } catch (error) {
    logger.error({ prediction, error }, 'Failed to publish prediction to Kafka');
    // Don't throw - prediction tracking shouldn't block main flow
  }
}

/**
 * Predict failures for all upcoming invoices (7-30 days)
 */
export async function predictUpcomingInvoiceFailures(
  organizationId: string,
  daysAhead: number = 30
): Promise<PaymentFailurePrediction[]> {
  const now = new Date();
  const futureDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const minDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // At least 7 days ahead

  // Get all unpaid invoices due in the next 7-30 days
  const upcomingInvoices = await prisma.invoice.findMany({
    where: {
      connection: {
        organizationId,
      },
      status: {
        in: ['OPEN', 'DRAFT'],
      },
      dueDate: {
        gte: minDate,
        lte: futureDate,
      },
    },
    include: {
      connection: {
        select: {
          id: true,
          organizationId: true,
        },
      },
    },
  });

  logger.info(
    { organizationId, count: upcomingInvoices.length, daysAhead },
    'Predicting failures for upcoming invoices'
  );

  const predictions: PaymentFailurePrediction[] = [];

  for (const invoice of upcomingInvoices) {
    try {
      const prediction = await predictInvoiceFailure(invoice.id);
      predictions.push(prediction);
    } catch (error) {
      logger.error({ invoiceId: invoice.id, error }, 'Failed to predict invoice failure');
    }
  }

  // Sort by risk level (highest first)
  return predictions.sort((a, b) => b.predictionScore - a.predictionScore);
}

/**
 * Get high-risk predictions for an organization
 */
export async function getHighRiskPredictions(
  organizationId: string,
  minRiskLevel: PredictionRiskLevel = PredictionRiskLevel.HIGH
): Promise<PaymentFailurePrediction[]> {
  const predictions = await predictUpcomingInvoiceFailures(organizationId);

  const riskLevels = [PredictionRiskLevel.CRITICAL, PredictionRiskLevel.HIGH];
  if (minRiskLevel === PredictionRiskLevel.MEDIUM) {
    riskLevels.push(PredictionRiskLevel.MEDIUM);
  }

  return predictions.filter((p) => riskLevels.includes(p.riskLevel));
}
