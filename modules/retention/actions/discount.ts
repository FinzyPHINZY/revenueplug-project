/**
 * Discount Action Executor
 * Creates and applies Stripe coupons for retention offers
 */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import type { CampaignAction } from '@prisma/client';
import Stripe from 'stripe';
import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import type { CampaignWithRelations, DiscountActionConfig, ExecuteActionResult } from '../types.js';

const log = logger.child({ module: 'discount-action' });

// Initialize Stripe client (uses secret key for platform operations)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-12-18.acacia' as any,
});

/**
 * Execute a discount action
 */
export async function executeDiscountAction(
  action: CampaignAction,
  campaign: CampaignWithRelations
): Promise<ExecuteActionResult> {
  const operationLog = log.child({
    operation: 'executeDiscountAction',
    actionId: action.id,
    campaignId: campaign.id,
  });

  try {
    const actionData = action.actionData as unknown as DiscountActionConfig;
    const { discountPercent, durationMonths, name } = actionData;

    // Validate discount percent
    if (discountPercent < 1 || discountPercent > 100) {
      const error = 'Invalid discount percentage (must be 1-100)';
      operationLog.error({ discountPercent }, error);

      await prisma.campaignAction.update({
        where: { id: action.id },
        data: {
          status: 'FAILED',
          errorMessage: error,
        },
      });

      return { success: false, error };
    }

    // Create Stripe coupon
    const couponName =
      name ||
      `Retention ${discountPercent}% - ${campaign.customer.name || campaign.customer.email || 'Customer'}`;

    const coupon = await stripe.coupons.create({
      percent_off: discountPercent,
      duration: durationMonths > 0 ? 'repeating' : 'once',
      duration_in_months: durationMonths > 0 ? durationMonths : undefined,
      name: couponName,
      metadata: {
        campaign_id: campaign.id,
        action_id: action.id,
        organization_id: campaign.organizationId,
        customer_id: campaign.customer.id,
        trigger_type: campaign.triggerType,
      },
    });

    operationLog.info({ couponId: coupon.id }, 'Stripe coupon created');

    // Find customer's active subscription
    const subscription = await prisma.subscription.findFirst({
      where: {
        customerId: campaign.customer.id,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    let appliedToSubscription: string | undefined;

    if (subscription) {
      try {
        // Apply coupon to subscription via Stripe
        await stripe.subscriptions.update(subscription.externalId, {
          coupon: coupon.id,
        });

        appliedToSubscription = subscription.externalId;
        operationLog.info(
          { subscriptionId: subscription.externalId },
          'Coupon applied to subscription'
        );
      } catch (error) {
        operationLog.warn(
          { error, subscriptionId: subscription.externalId },
          'Failed to apply coupon to subscription'
        );
        // Don't fail the action - coupon is created, just not auto-applied
      }
    } else {
      operationLog.info('No active subscription found, coupon created but not applied');
    }

    // Update action status
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'SENT',
        executedAt: new Date(),
        executionResult: {
          stripeCouponId: coupon.id,
          discountPercent,
          durationMonths,
          appliedToSubscription,
          createdAt: new Date().toISOString(),
        },
      },
    });

    operationLog.info({ couponId: coupon.id }, 'Discount action executed successfully');

    return {
      success: true,
      result: {
        stripeCouponId: coupon.id,
        discountPercent,
        durationMonths,
        appliedToSubscription,
      },
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute discount action');

    // Update action with error
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        retryCount: { increment: 1 },
      },
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
