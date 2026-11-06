/**
 * Payment Failure Prediction Service
 *
 * Analyzes payment history to predict future payment failures:
 * - Success rate patterns
 * - Failure reasons and frequency
 * - Timing patterns
 * - Recovery patterns
 *
 * Outputs risk score and likelihood of next payment failure
 */

import { prisma } from '../../infrastructure/postgres.js';
import type { Customer } from '@prisma/client';
import { logger } from '../../utils/logger.js';

interface PaymentPatternAnalysis {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  successRate: number;

  // Timing
  averageDaysBetweenPayments: number | null;
  lastPaymentDate: Date | null;
  nextExpectedPaymentDate: Date | null;

  // Failure patterns
  consecutiveFailures: number;
  failureReasons: string[];
  mostCommonFailureReason: string | null;

  // Risk
  paymentRiskScore: number; // 0-100
  likelihoodOfNextFailure: number; // 0.0-1.0

  // Recovery
  averageRecoveryTime: number | null; // Days to recover from failure
  hasRecoveredFromFailure: boolean;
}

/**
 * Analyze payment patterns for a customer
 */
export async function analyzePaymentPattern(
  customerId: string
): Promise<PaymentPatternAnalysis> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!customer) {
    throw new Error(`Customer ${customerId} not found`);
  }

  // Get all invoices from subscriptions
  const allInvoices: any[] = [];
  for (const subscription of customer.subscriptions) {
    if (subscription.rawData && typeof subscription.rawData === 'object') {
      const data = subscription.rawData as any;
      // Invoices might be in rawData
      if (data.invoices && Array.isArray(data.invoices)) {
        allInvoices.push(...data.invoices);
      }
    }
  }

  // If no invoice data, infer from subscription status
  if (allInvoices.length === 0) {
    return inferPaymentPatternFromSubscription(customer);
  }

  // Analyze invoices
  const totalPayments = allInvoices.length;
  const successfulPayments = allInvoices.filter(
    (inv) => inv.status === 'paid' || inv.paid === true
  ).length;
  const failedPayments = allInvoices.filter(
    (inv) =>
      inv.status === 'uncollectible' ||
      inv.status === 'void' ||
      inv.attempted === true && inv.paid === false
  ).length;

  const successRate =
    totalPayments > 0 ? successfulPayments / totalPayments : 0;

  // Calculate timing patterns
  const paidInvoices = allInvoices
    .filter((inv) => inv.status === 'paid' || inv.paid === true)
    .sort((a, b) => (a.created || 0) - (b.created || 0));

  let averageDaysBetweenPayments: number | null = null;
  if (paidInvoices.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < paidInvoices.length; i++) {
      const daysDiff = Math.floor(
        ((paidInvoices[i].created || 0) - (paidInvoices[i - 1].created || 0)) /
          (24 * 60 * 60)
      );
      intervals.push(daysDiff);
    }
    averageDaysBetweenPayments =
      intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
  }

  const lastPaymentDate = paidInvoices.length > 0
    ? new Date((paidInvoices[paidInvoices.length - 1].created || 0) * 1000)
    : null;

  const nextExpectedPaymentDate =
    lastPaymentDate && averageDaysBetweenPayments
      ? new Date(
          lastPaymentDate.getTime() +
            averageDaysBetweenPayments * 24 * 60 * 60 * 1000
        )
      : null;

  // Analyze failure patterns
  const failedInvoices = allInvoices.filter(
    (inv) => inv.attempted === true && inv.paid === false
  );

  const failureReasons = failedInvoices
    .map((inv) => inv.last_payment_error?.message || 'unknown')
    .filter((reason, index, self) => self.indexOf(reason) === index);

  const mostCommonFailureReason = getMostCommonFailureReason(failedInvoices);

  // Calculate consecutive failures
  const recentInvoices = allInvoices
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, 10);

  let consecutiveFailures = 0;
  for (const invoice of recentInvoices) {
    if (invoice.attempted === true && invoice.paid === false) {
      consecutiveFailures++;
    } else if (invoice.paid === true) {
      break;
    }
  }

  // Calculate risk score
  const paymentRiskScore = calculatePaymentRiskScore({
    successRate,
    consecutiveFailures,
    failedPayments,
    totalPayments,
  });

  // Calculate likelihood of next failure
  const likelihoodOfNextFailure = calculateFailureLikelihood({
    successRate,
    consecutiveFailures,
    recentFailureRate: failedPayments / Math.min(totalPayments, 5),
  });

  // Analyze recovery patterns
  const { averageRecoveryTime, hasRecoveredFromFailure } =
    analyzeRecoveryPatterns(allInvoices);

  return {
    totalPayments,
    successfulPayments,
    failedPayments,
    successRate,
    averageDaysBetweenPayments,
    lastPaymentDate,
    nextExpectedPaymentDate,
    consecutiveFailures,
    failureReasons,
    mostCommonFailureReason,
    paymentRiskScore,
    likelihoodOfNextFailure,
    averageRecoveryTime,
    hasRecoveredFromFailure,
  };
}

/**
 * Infer payment pattern from subscription status (when no invoice data)
 */
function inferPaymentPatternFromSubscription(
  customer: Customer & { subscriptions: any[] }
): PaymentPatternAnalysis {
  const activeSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'active' || sub.status === 'trialing'
  );

  const pastDueSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'past_due'
  );

  const cancelledSubscription = customer.subscriptions.find(
    (sub) => sub.status === 'canceled' || sub.status === 'cancelled'
  );

  // Estimate based on subscription status
  let successRate = 0.5; // Default neutral
  let consecutiveFailures = 0;
  let paymentRiskScore = 50;
  let likelihoodOfNextFailure = 0.5;

  if (activeSubscription) {
    successRate = 0.9;
    paymentRiskScore = 20;
    likelihoodOfNextFailure = 0.1;
  }

  if (pastDueSubscription) {
    successRate = 0.3;
    consecutiveFailures = 1;
    paymentRiskScore = 80;
    likelihoodOfNextFailure = 0.8;
  }

  if (cancelledSubscription) {
    successRate = 0.2;
    consecutiveFailures = 3;
    paymentRiskScore = 90;
    likelihoodOfNextFailure = 0.95;
  }

  return {
    totalPayments: 0,
    successfulPayments: 0,
    failedPayments: 0,
    successRate,
    averageDaysBetweenPayments: 30, // Assume monthly
    lastPaymentDate: null,
    nextExpectedPaymentDate: null,
    consecutiveFailures,
    failureReasons: [],
    mostCommonFailureReason: null,
    paymentRiskScore,
    likelihoodOfNextFailure,
    averageRecoveryTime: null,
    hasRecoveredFromFailure: false,
  };
}

/**
 * Get most common failure reason
 */
function getMostCommonFailureReason(failedInvoices: any[]): string | null {
  const reasonCounts: Record<string, number> = {};

  for (const invoice of failedInvoices) {
    const reason = invoice.last_payment_error?.message || 'unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  const sortedReasons = Object.entries(reasonCounts).sort(
    ([, a], [, b]) => b - a
  );

  return sortedReasons.length > 0 ? sortedReasons[0][0] : null;
}

/**
 * Calculate payment risk score (0-100)
 */
function calculatePaymentRiskScore(factors: {
  successRate: number;
  consecutiveFailures: number;
  failedPayments: number;
  totalPayments: number;
}): number {
  let score = 0;

  // Success rate component (0-40 points)
  const failureRate = 1 - factors.successRate;
  score += failureRate * 40;

  // Consecutive failures component (0-40 points)
  if (factors.consecutiveFailures >= 3) {
    score += 40;
  } else if (factors.consecutiveFailures >= 2) {
    score += 30;
  } else if (factors.consecutiveFailures >= 1) {
    score += 20;
  }

  // Recent failure rate component (0-20 points)
  const recentFailureRate =
    factors.totalPayments > 0
      ? factors.failedPayments / factors.totalPayments
      : 0;
  score += recentFailureRate * 20;

  return Math.min(100, Math.round(score));
}

/**
 * Calculate likelihood of next payment failure (0.0-1.0)
 */
function calculateFailureLikelihood(factors: {
  successRate: number;
  consecutiveFailures: number;
  recentFailureRate: number;
}): number {
  // Weighted factors
  const failureRateWeight = 0.4;
  const consecutiveFailuresWeight = 0.4;
  const recentFailureWeight = 0.2;

  // Normalize consecutive failures to 0-1 range
  const normalizedConsecutive = Math.min(factors.consecutiveFailures / 3, 1);

  const rawLikelihood =
    (1 - factors.successRate) * failureRateWeight +
    normalizedConsecutive * consecutiveFailuresWeight +
    factors.recentFailureRate * recentFailureWeight;

  // Apply sigmoid curve for more realistic probabilities
  const likelihood = 1 / (1 + Math.exp(-10 * (rawLikelihood - 0.5)));

  return Math.max(0, Math.min(1, likelihood));
}

/**
 * Analyze recovery patterns
 */
function analyzeRecoveryPatterns(invoices: any[]): {
  averageRecoveryTime: number | null;
  hasRecoveredFromFailure: boolean;
} {
  const sortedInvoices = invoices.sort(
    (a, b) => (a.created || 0) - (b.created || 0)
  );

  const recoveryTimes: number[] = [];
  let hasRecoveredFromFailure = false;

  for (let i = 0; i < sortedInvoices.length - 1; i++) {
    const current = sortedInvoices[i];
    const next = sortedInvoices[i + 1];

    // Check if current failed and next succeeded
    if (
      current.attempted === true &&
      current.paid === false &&
      next.paid === true
    ) {
      hasRecoveredFromFailure = true;
      const recoveryDays = Math.floor(
        ((next.created || 0) - (current.created || 0)) / (24 * 60 * 60)
      );
      recoveryTimes.push(recoveryDays);
    }
  }

  const averageRecoveryTime =
    recoveryTimes.length > 0
      ? recoveryTimes.reduce((sum, val) => sum + val, 0) / recoveryTimes.length
      : null;

  return { averageRecoveryTime, hasRecoveredFromFailure };
}

/**
 * Save payment pattern analysis to database
 */
export async function savePaymentPattern(
  customerId: string,
  analysis: PaymentPatternAnalysis
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // Recalculate daily

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  await prisma.paymentPattern.create({
    data: {
      customerId,
      totalPayments: analysis.totalPayments,
      successfulPayments: analysis.successfulPayments,
      failedPayments: analysis.failedPayments,
      successRate: analysis.successRate,
      averageDaysBetweenPayments: analysis.averageDaysBetweenPayments,
      lastPaymentDate: analysis.lastPaymentDate,
      nextExpectedPaymentDate: analysis.nextExpectedPaymentDate,
      consecutiveFailures: analysis.consecutiveFailures,
      failureReasons: analysis.failureReasons,
      mostCommonFailureReason: analysis.mostCommonFailureReason,
      paymentRiskScore: analysis.paymentRiskScore,
      likelihoodOfNextFailure: analysis.likelihoodOfNextFailure,
      averageRecoveryTime: analysis.averageRecoveryTime,
      hasRecoveredFromFailure: analysis.hasRecoveredFromFailure,
      analyzedFrom: thirtyDaysAgo,
      analyzedTo: now,
      expiresAt,
    },
  });

  logger.info('Payment pattern analyzed', {
    customerId,
    paymentRiskScore: analysis.paymentRiskScore,
    likelihoodOfNextFailure: analysis.likelihoodOfNextFailure,
  });
}

/**
 * Analyze and save payment pattern
 */
export async function analyzeAndSavePaymentPattern(
  customerId: string
): Promise<PaymentPatternAnalysis> {
  const analysis = await analyzePaymentPattern(customerId);
  await savePaymentPattern(customerId, analysis);
  return analysis;
}

/**
 * Get latest payment pattern for customer
 */
export async function getLatestPaymentPattern(customerId: string) {
  return await prisma.paymentPattern.findFirst({
    where: { customerId },
    orderBy: { calculatedAt: 'desc' },
  });
}

/**
 * Get customers with high payment failure risk
 */
export async function getHighPaymentRiskCustomers(
  connectionId: string,
  minRiskScore: number = 70
) {
  const customers = await prisma.customer.findMany({
    where: { connectionId },
    include: {
      paymentPatterns: {
        orderBy: { calculatedAt: 'desc' },
        take: 1,
      },
    },
  });

  return customers
    .filter(
      (c) =>
        c.paymentPatterns[0] &&
        c.paymentPatterns[0].paymentRiskScore >= minRiskScore
    )
    .map((c) => ({
      customer: c,
      paymentPattern: c.paymentPatterns[0],
    }))
    .sort((a, b) => b.paymentPattern.paymentRiskScore - a.paymentPattern.paymentRiskScore);
}

/**
 * Batch analyze payment patterns for all customers
 */
export async function batchAnalyzePaymentPatterns(
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
      await analyzeAndSavePaymentPattern(customer.id);
      processed++;
    } catch (error) {
      logger.error('Failed to analyze payment pattern', {
        customerId: customer.id,
        error,
      });
      errors++;
    }
  }

  logger.info('Batch payment pattern analysis complete', {
    connectionId,
    processed,
    errors,
  });

  return { processed, errors };
}
