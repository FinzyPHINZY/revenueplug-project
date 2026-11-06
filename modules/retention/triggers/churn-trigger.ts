/**
 * Churn Risk Trigger Handler
 * Automatically triggers retention campaigns when churn risk is detected
 */

import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import { triggerCampaign } from '../service.js';
import type { ChurnRiskScore } from '@prisma/client';

const log = logger.child({ module: 'churn-trigger' });

/**
 * Handle churn risk detection event
 * Called when a new ChurnRiskScore is calculated
 */
export async function onChurnRiskCalculated(
  customerId: string,
  riskScore: ChurnRiskScore
): Promise<void> {
  const operationLog = log.child({
    operation: 'onChurnRiskCalculated',
    customerId,
    riskLevel: riskScore.riskLevel,
    score: riskScore.score,
  });

  // Only trigger for HIGH and CRITICAL risk levels
  if (riskScore.riskLevel !== 'HIGH' && riskScore.riskLevel !== 'CRITICAL') {
    operationLog.debug('Churn risk level not high enough, skipping campaign trigger');
    return;
  }

  operationLog.info('High churn risk detected, evaluating retention strategies');

  try {
    // Get customer's connection to get organization ID
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        connection: {
          select: { organizationId: true },
        },
      },
    });

    if (!customer) {
      operationLog.error('Customer not found');
      return;
    }

    // Find active retention strategies that match this trigger
    const strategies = await prisma.retentionStrategy.findMany({
      where: {
        organizationId: customer.connection.organizationId,
        status: 'ACTIVE',
      },
    });

    if (strategies.length === 0) {
      operationLog.info('No active retention strategies found');
      return;
    }

    // Filter strategies that match churn risk trigger conditions
    const matchingStrategies = strategies.filter((strategy) => {
      const conditions = strategy.triggerConditions as any;

      // Check if strategy has churn risk trigger
      if (!conditions.churnRiskLevel) {
        return false;
      }

      // Check if risk level matches
      if (Array.isArray(conditions.churnRiskLevel)) {
        return conditions.churnRiskLevel.includes(riskScore.riskLevel);
      }

      return false;
    });

    operationLog.info({ matchingStrategies: matchingStrategies.length }, 'Found matching strategies');

    // Trigger campaigns for each matching strategy
    for (const strategy of matchingStrategies) {
      try {
        const triggerType =
          riskScore.riskLevel === 'CRITICAL' ? 'CHURN_RISK_CRITICAL' : 'CHURN_RISK_HIGH';

        const campaign = await triggerCampaign({
          strategyId: strategy.id,
          customerId,
          triggerType,
          triggerContext: {
            churnScore: riskScore.score,
            churnProbability: riskScore.churnProbability,
            churnRiskLevel: riskScore.riskLevel,
            churnSignals: riskScore.churnSignals,
            recommendedActions: riskScore.recommendedActions,
            predictedChurnDate: riskScore.predictedChurnDate?.toISOString(),
            daysUntilPredictedChurn: riskScore.daysUntilPredictedChurn,
            paymentFailureRisk: riskScore.paymentFailureRisk,
            engagementDeclineRisk: riskScore.engagementDeclineRisk,
            usageDeclineRisk: riskScore.usageDeclineRisk,
            supportIssueRisk: riskScore.supportIssueRisk,
          },
        });

        if (campaign) {
          operationLog.info(
            {
              campaignId: campaign.id,
              strategyId: strategy.id,
              strategyName: strategy.name,
            },
            'Retention campaign triggered'
          );
        } else {
          operationLog.info(
            {
              strategyId: strategy.id,
              strategyName: strategy.name,
            },
            'Campaign not triggered (cooldown or audience filter)'
          );
        }
      } catch (error) {
        operationLog.error(
          {
            error,
            strategyId: strategy.id,
            strategyName: strategy.name,
          },
          'Failed to trigger campaign for strategy'
        );
      }
    }
  } catch (error) {
    operationLog.error({ error }, 'Failed to process churn risk trigger');
  }
}
