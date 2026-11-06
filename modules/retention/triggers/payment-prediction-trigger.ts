/**
 * Payment Prediction Trigger Handler
 *
 * Automatically triggers retention campaigns when payment failure predictions
 * indicate HIGH or CRITICAL risk for upcoming invoices.
 *
 * Integration Points:
 * - Called after payment failure predictions are generated
 * - Triggers preventive campaigns 7-30 days before invoice due date
 * - Prevents payment failures through proactive customer outreach
 */

import { logger } from '../../../shared/logger/index.js';
import { triggerCampaign } from '../service.js';
import { prisma } from '../../../infrastructure/postgres/index.js';
import type { PaymentFailurePrediction, PredictionRiskLevel } from '../../detection/payment-failure-prediction.js';
import { PredictionRiskLevel as RiskLevel } from '../../detection/payment-failure-prediction.js';

const log = logger.child({ module: 'payment-prediction-trigger' });

/**
 * Trigger retention campaign based on payment failure prediction
 */
export async function onPaymentFailurePredicted(
  prediction: PaymentFailurePrediction
): Promise<void> {
  const operationLog = log.child({
    operation: 'onPaymentFailurePredicted',
    invoiceId: prediction.invoiceId,
    customerId: prediction.customerId,
    riskLevel: prediction.riskLevel,
    failureProbability: prediction.failureProbability,
  });

  try {
    // Only trigger campaigns for HIGH or CRITICAL risk predictions
    if (
      prediction.riskLevel !== RiskLevel.HIGH &&
      prediction.riskLevel !== RiskLevel.CRITICAL
    ) {
      operationLog.debug('Risk level too low for campaign trigger, skipping');
      return;
    }

    // Find active payment failure prevention strategies
    const strategies = await prisma.retentionStrategy.findMany({
      where: {
        organizationId: prediction.organizationId,
        status: 'ACTIVE',
        triggerConditions: {
          path: '$.paymentFailurePredicted',
          equals: true,
        },
      },
    });

    if (strategies.length === 0) {
      operationLog.debug('No active payment prediction strategies found');
      return;
    }

    // Get invoice and customer details for campaign context
    const invoice = await prisma.invoice.findUnique({
      where: { id: prediction.invoiceId },
    });

    if (!invoice) {
      operationLog.warn('Invoice not found for prediction');
      return;
    }

    // Prepare trigger context with prediction details
    const triggerContext = {
      invoiceId: prediction.invoiceId,
      invoiceExternalId: prediction.invoiceExternalId,
      amountDue: prediction.amountDue,
      currency: prediction.currency,
      dueDate: prediction.dueDate.toISOString(),
      nextPaymentAttempt: prediction.nextPaymentAttempt?.toISOString(),
      failureProbability: prediction.failureProbability,
      predictionScore: prediction.predictionScore,
      riskLevel: prediction.riskLevel,
      model: prediction.model,
      criticalFlags: prediction.criticalFlags,
      recommendedActions: prediction.recommendedActions,
      preventiveMeasures: prediction.preventiveMeasures,
      // Signal breakdown for personalized messaging
      paymentHistoryScore: prediction.paymentHistoryScore,
      cardHealthScore: prediction.cardHealthScore,
      subscriptionScore: prediction.subscriptionScore,
      behavioralScore: prediction.behavioralScore,
      confidence: prediction.confidence,
    };

    // Trigger campaigns for each matching strategy
    for (const strategy of strategies) {
      try {
        // Check if strategy filters match this prediction
        if (!matchesStrategyFilters(strategy, prediction)) {
          operationLog.debug(
            { strategyId: strategy.id },
            'Prediction does not match strategy filters'
          );
          continue;
        }

        // Trigger campaign
        const campaign = await triggerCampaign({
          customerId: prediction.customerId,
          strategyId: strategy.id,
          triggerType: prediction.riskLevel === RiskLevel.CRITICAL
            ? 'PAYMENT_PREDICTION_CRITICAL'
            : 'PAYMENT_PREDICTION_HIGH',
          triggerContext,
        });

        operationLog.info(
          {
            campaignId: campaign.id,
            strategyId: strategy.id,
            strategyName: strategy.name,
          },
          'Payment prediction campaign triggered'
        );
      } catch (error) {
        operationLog.error(
          { strategyId: strategy.id, error },
          'Failed to trigger campaign for strategy'
        );
        // Continue with other strategies even if one fails
      }
    }
  } catch (error) {
    operationLog.error({ error }, 'Failed to process payment failure prediction');
    throw error;
  }
}

/**
 * Check if prediction matches strategy audience filters
 */
function matchesStrategyFilters(
  strategy: any,
  prediction: PaymentFailurePrediction
): boolean {
  const filters = strategy.audienceFilters as any;
  if (!filters) return true; // No filters = match all

  // Filter by minimum risk level
  if (filters.minRiskLevel) {
    const riskLevelOrder = {
      MINIMAL: 1,
      LOW: 2,
      MEDIUM: 3,
      HIGH: 4,
      CRITICAL: 5,
    };
    const predictionLevel = riskLevelOrder[prediction.riskLevel] || 0;
    const minLevel = riskLevelOrder[filters.minRiskLevel] || 0;
    if (predictionLevel < minLevel) return false;
  }

  // Filter by minimum failure probability
  if (filters.minFailureProbability) {
    if (prediction.failureProbability < filters.minFailureProbability) {
      return false;
    }
  }

  // Filter by minimum amount
  if (filters.minInvoiceAmount) {
    if (prediction.amountDue < filters.minInvoiceAmount) {
      return false;
    }
  }

  // Filter by specific critical flags
  if (filters.requiredFlags && Array.isArray(filters.requiredFlags)) {
    const hasAllFlags = filters.requiredFlags.every((flag: string) =>
      prediction.criticalFlags.includes(flag)
    );
    if (!hasAllFlags) return false;
  }

  // Filter by days until due date
  if (filters.minDaysUntilDue || filters.maxDaysUntilDue) {
    const daysUntilDue = Math.ceil(
      (prediction.dueDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    );
    if (filters.minDaysUntilDue && daysUntilDue < filters.minDaysUntilDue) {
      return false;
    }
    if (filters.maxDaysUntilDue && daysUntilDue > filters.maxDaysUntilDue) {
      return false;
    }
  }

  return true;
}

/**
 * Batch process payment predictions for an organization
 * Called by scheduled job or manual trigger
 */
export async function processPaymentPredictions(
  organizationId: string,
  daysAhead: number = 30
): Promise<{ processed: number; campaignsTriggered: number; errors: number }> {
  const operationLog = log.child({
    operation: 'processPaymentPredictions',
    organizationId,
    daysAhead,
  });

  try {
    // Import prediction service
    const { predictUpcomingInvoiceFailures } = await import(
      '../../detection/payment-failure-prediction.js'
    );

    // Get all predictions for upcoming invoices
    const predictions = await predictUpcomingInvoiceFailures(
      organizationId,
      daysAhead
    );

    operationLog.info(
      { predictionsCount: predictions.length },
      'Processing payment predictions'
    );

    let campaignsTriggered = 0;
    let errors = 0;

    // Process each prediction
    for (const prediction of predictions) {
      try {
        // Only process HIGH and CRITICAL risk predictions
        if (
          prediction.riskLevel === RiskLevel.HIGH ||
          prediction.riskLevel === RiskLevel.CRITICAL
        ) {
          await onPaymentFailurePredicted(prediction);
          campaignsTriggered++;
        }
      } catch (error) {
        operationLog.error(
          { invoiceId: prediction.invoiceId, error },
          'Failed to process prediction'
        );
        errors++;
      }
    }

    operationLog.info(
      {
        processed: predictions.length,
        campaignsTriggered,
        errors,
      },
      'Payment predictions processing completed'
    );

    return {
      processed: predictions.length,
      campaignsTriggered,
      errors,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to process payment predictions');
    throw error;
  }
}

/**
 * Hook to integrate with prediction service
 * Call this after a prediction is generated
 */
export async function onPredictionGenerated(
  prediction: PaymentFailurePrediction
): Promise<void> {
  // Trigger retention campaign if risk is high enough
  await onPaymentFailurePredicted(prediction);
}
