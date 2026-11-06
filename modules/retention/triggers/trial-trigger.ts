/**
 * Trial Ending Trigger Handler
 * Automatically triggers conversion campaigns when trial periods are ending
 */

import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import { triggerCampaign } from '../service.js';

const log = logger.child({ module: 'trial-trigger' });

export interface TrialEndingEvent {
  customerId: string;
  subscriptionId: string;
  subscriptionExternalId: string;
  trialEndDate: Date;
  daysRemaining: number;
  planName?: string;
  planAmount?: number;
  planCurrency?: string;
}

/**
 * Handle trial ending event
 * Called when customer.subscription.trial_will_end webhook is received
 */
export async function onTrialEnding(event: TrialEndingEvent): Promise<void> {
  const operationLog = log.child({
    operation: 'onTrialEnding',
    customerId: event.customerId,
    subscriptionId: event.subscriptionExternalId,
    daysRemaining: event.daysRemaining,
  });

  operationLog.info('Trial ending detected, evaluating conversion strategies');

  try {
    // Get customer with organization
    const customer = await prisma.customer.findUnique({
      where: { id: event.customerId },
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

    // Find active retention strategies that match trial ending triggers
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

    // Filter strategies that match trial ending trigger conditions
    const matchingStrategies = strategies.filter((strategy) => {
      const conditions = strategy.triggerConditions as any;

      // Check if strategy has trial ending trigger
      if (!conditions.trialEnding) {
        return false;
      }

      // Check if max days remaining is specified
      if (
        conditions.trialDaysRemaining &&
        event.daysRemaining > conditions.trialDaysRemaining
      ) {
        return false;
      }

      return true;
    });

    operationLog.info(
      { matchingStrategies: matchingStrategies.length },
      'Found matching strategies'
    );

    // Trigger campaigns for each matching strategy
    for (const strategy of matchingStrategies) {
      try {
        const campaign = await triggerCampaign({
          strategyId: strategy.id,
          customerId: event.customerId,
          triggerType: 'TRIAL_ENDING',
          triggerContext: {
            subscriptionId: event.subscriptionExternalId,
            trialEndDate: event.trialEndDate.toISOString(),
            daysRemaining: event.daysRemaining,
            planName: event.planName,
            planAmount: event.planAmount,
            planCurrency: event.planCurrency,
          },
        });

        if (campaign) {
          operationLog.info(
            {
              campaignId: campaign.id,
              strategyId: strategy.id,
              strategyName: strategy.name,
            },
            'Trial conversion campaign triggered'
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
    operationLog.error({ error }, 'Failed to process trial ending trigger');
  }
}

/**
 * Handle trial ended event
 * Called when trial period has expired without conversion
 */
export async function onTrialEnded(event: {
  customerId: string;
  subscriptionExternalId: string;
  convertedToPaid: boolean;
}): Promise<void> {
  const operationLog = log.child({
    operation: 'onTrialEnded',
    customerId: event.customerId,
    subscriptionId: event.subscriptionExternalId,
    converted: event.convertedToPaid,
  });

  operationLog.info('Trial ended');

  try {
    // Find active TRIAL_ENDING campaigns for this customer
    const campaigns = await prisma.campaign.findMany({
      where: {
        customerId: event.customerId,
        triggerType: 'TRIAL_ENDING',
        status: 'ACTIVE',
      },
    });

    if (campaigns.length === 0) {
      operationLog.debug('No active trial ending campaigns found');
      return;
    }

    if (event.convertedToPaid) {
      // Mark campaigns as converted
      await prisma.campaign.updateMany({
        where: {
          id: { in: campaigns.map((c) => c.id) },
        },
        data: {
          status: 'CONVERTED',
          convertedAt: new Date(),
          completedAt: new Date(),
        },
      });

      operationLog.info(
        { campaignCount: campaigns.length },
        'Trial campaigns marked as converted'
      );
    } else {
      // Mark campaigns as completed without conversion
      await prisma.campaign.updateMany({
        where: {
          id: { in: campaigns.map((c) => c.id) },
        },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      operationLog.info(
        { campaignCount: campaigns.length },
        'Trial campaigns completed without conversion'
      );
    }
  } catch (error) {
    operationLog.error({ error }, 'Failed to process trial ended event');
  }
}

/**
 * Handle trial converted event
 * Called when customer subscribes during trial period
 */
export async function onTrialConverted(event: {
  customerId: string;
  subscriptionExternalId: string;
  amount: number;
  planName: string;
}): Promise<void> {
  const operationLog = log.child({
    operation: 'onTrialConverted',
    customerId: event.customerId,
    subscriptionId: event.subscriptionExternalId,
    amount: event.amount,
  });

  operationLog.info('Trial converted to paid subscription');

  try {
    // Find active TRIAL_ENDING campaigns for this customer
    const campaigns = await prisma.campaign.findMany({
      where: {
        customerId: event.customerId,
        triggerType: 'TRIAL_ENDING',
        status: 'ACTIVE',
      },
      orderBy: {
        startedAt: 'desc',
      },
    });

    if (campaigns.length === 0) {
      operationLog.debug('No active trial ending campaigns found');
      return;
    }

    // Mark the most recent campaign as converted with revenue
    const campaign = campaigns[0];

    // Calculate first year revenue (MRR * 12) as the value
    const firstYearRevenue = event.amount * 12;

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: 'CONVERTED',
        convertedAt: new Date(),
        revenueRecovered: firstYearRevenue,
        completedAt: new Date(),
      },
    });

    // Complete any other active campaigns
    if (campaigns.length > 1) {
      await prisma.campaign.updateMany({
        where: {
          id: { in: campaigns.slice(1).map((c) => c.id) },
          status: 'ACTIVE',
        },
        data: {
          status: 'CONVERTED',
          convertedAt: new Date(),
          completedAt: new Date(),
        },
      });
    }

    operationLog.info(
      {
        campaignId: campaign.id,
        revenueRecovered: firstYearRevenue,
        planName: event.planName,
      },
      'Trial campaign marked as converted'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to process trial conversion');
  }
}
