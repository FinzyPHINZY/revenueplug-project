/**
 * Payment Failure Trigger Handler
 * Automatically triggers recovery campaigns when payment failures are detected
 */

import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import { triggerCampaign } from '../service.js';

const log = logger.child({ module: 'payment-trigger' });

export interface PaymentFailureEvent {
  customerId: string;
  invoiceId: string;
  invoiceExternalId: string;
  amount: number; // In cents
  currency: string;
  attemptCount: number;
  failureReason?: string;
  nextPaymentAttempt?: Date;
  subscriptionId?: string;
  subscriptionExternalId?: string;
}

/**
 * Handle payment failure event
 * Called when invoice.payment_failed webhook is received
 */
export async function onPaymentFailed(event: PaymentFailureEvent): Promise<void> {
  const operationLog = log.child({
    operation: 'onPaymentFailed',
    customerId: event.customerId,
    invoiceId: event.invoiceExternalId,
    amount: event.amount,
    attemptCount: event.attemptCount,
  });

  operationLog.info('Payment failure detected, evaluating recovery strategies');

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

    // Find active retention strategies that match payment failure triggers
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

    // Filter strategies that match payment failure trigger conditions
    const matchingStrategies = strategies.filter((strategy) => {
      const conditions = strategy.triggerConditions as any;

      // Check if strategy has payment failure trigger
      if (!conditions.paymentFailed) {
        return false;
      }

      // Check if minimum failure count is specified
      if (
        conditions.paymentFailureCount &&
        event.attemptCount < conditions.paymentFailureCount
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
          triggerType: 'PAYMENT_FAILURE',
          triggerContext: {
            invoiceId: event.invoiceExternalId,
            invoiceAmount: event.amount,
            invoiceCurrency: event.currency,
            attemptCount: event.attemptCount,
            failureReason: event.failureReason,
            nextPaymentAttempt: event.nextPaymentAttempt?.toISOString(),
            subscriptionId: event.subscriptionExternalId,
          },
        });

        if (campaign) {
          operationLog.info(
            {
              campaignId: campaign.id,
              strategyId: strategy.id,
              strategyName: strategy.name,
            },
            'Recovery campaign triggered'
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
    operationLog.error({ error }, 'Failed to process payment failure trigger');
  }
}

/**
 * Handle payment retry attempt
 * Called when Stripe retries a failed payment
 */
export async function onPaymentRetry(event: {
  customerId: string;
  invoiceExternalId: string;
  attemptCount: number;
}): Promise<void> {
  const operationLog = log.child({
    operation: 'onPaymentRetry',
    customerId: event.customerId,
    invoiceId: event.invoiceExternalId,
    attemptCount: event.attemptCount,
  });

  operationLog.info('Payment retry detected');

  // Find active PAYMENT_FAILURE campaigns for this customer
  const campaigns = await prisma.campaign.findMany({
    where: {
      customerId: event.customerId,
      triggerType: 'PAYMENT_FAILURE',
      status: 'ACTIVE',
    },
  });

  // Log context about ongoing campaigns
  if (campaigns.length > 0) {
    operationLog.info(
      { campaignCount: campaigns.length },
      'Customer has active payment failure campaigns'
    );
  }
}

/**
 * Handle successful payment after failure
 * Called when invoice.payment_succeeded is received after a previous failure
 */
export async function onPaymentRecovered(event: {
  customerId: string;
  invoiceExternalId: string;
  amount: number;
  wasRetry: boolean;
}): Promise<void> {
  const operationLog = log.child({
    operation: 'onPaymentRecovered',
    customerId: event.customerId,
    invoiceId: event.invoiceExternalId,
    amount: event.amount,
  });

  operationLog.info('Payment recovered after failure');

  try {
    // Find active PAYMENT_FAILURE campaigns for this customer
    const campaigns = await prisma.campaign.findMany({
      where: {
        customerId: event.customerId,
        triggerType: 'PAYMENT_FAILURE',
        status: 'ACTIVE',
      },
      orderBy: {
        startedAt: 'desc',
      },
    });

    if (campaigns.length === 0) {
      operationLog.debug('No active payment failure campaigns found');
      return;
    }

    // Mark the most recent campaign as converted
    const campaign = campaigns[0];

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: 'CONVERTED',
        convertedAt: new Date(),
        revenueRecovered: event.amount,
        completedAt: new Date(),
      },
    });

    // Cancel any other active campaigns
    if (campaigns.length > 1) {
      await prisma.campaign.updateMany({
        where: {
          id: { in: campaigns.slice(1).map((c) => c.id) },
          status: 'ACTIVE',
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      });
    }

    operationLog.info(
      {
        campaignId: campaign.id,
        revenueRecovered: event.amount,
        cancelledCampaigns: campaigns.length - 1,
      },
      'Payment failure campaign marked as converted'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to process payment recovery');
  }
}
