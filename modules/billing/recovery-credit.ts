import Stripe from 'stripe';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import type { Platform } from '@prisma/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-12-15.clover',
});

const log = logger.child({ module: 'recovery-credit' });

const CREDIT_AMOUNT = 1000; // $10 in cents
const CREDIT_EXPIRY_DAYS = 90;

/**
 * Check if payment recovery qualifies for first recovery credit
 * Called when a failed payment becomes successful
 */
export async function checkAndAwardFirstRecoveryCredit(params: {
  organizationId: string;
  paymentExternalId: string;
  customerExternalId: string;
  recoveredAmount: string | number;
  platform: Platform;
}): Promise<{
  awarded: boolean;
  creditId?: string;
  reason?: string;
}> {
  try {
    // Check if organization already has a recovery credit
    const existingCredit = await prisma.firstRecoveryCredit.findUnique({
      where: { organizationId: params.organizationId },
    });

    if (existingCredit) {
      log.debug({ organizationId: params.organizationId }, 'Organization already has recovery credit');
      return {
        awarded: false,
        reason: 'Organization already earned their first recovery credit',
      };
    }

    // Check if organization is on a paid plan (not Viewer)
    const org = await prisma.organization.findUnique({
      where: { id: params.organizationId },
    });

    if (!org) {
      log.error({ organizationId: params.organizationId }, 'Organization not found');
      return {
        awarded: false,
        reason: 'Organization not found',
      };
    }

    // Only award credit to paying customers (STARTER+)
    if (!org.stripePriceId || org.billingStatus === 'FREE') {
      log.debug(
        { organizationId: params.organizationId, billingStatus: org.billingStatus },
        'Viewer tier does not qualify for recovery credit'
      );
      return {
        awarded: false,
        reason: 'First recovery credit is available for STARTER plan and higher',
      };
    }

    // Create the recovery credit record
    const credit = await prisma.firstRecoveryCredit.create({
      data: {
        organizationId: params.organizationId,
        paymentExternalId: params.paymentExternalId,
        customerExternalId: params.customerExternalId,
        recoveredAmount: params.recoveredAmount.toString(),
        platform: params.platform,
        creditAmount: CREDIT_AMOUNT,
        status: 'PENDING',
      },
    });

    log.info(
      {
        organizationId: params.organizationId,
        creditId: credit.id,
        recoveredAmount: params.recoveredAmount,
      },
      'First recovery credit awarded'
    );

    // Attempt to apply credit to Stripe account
    await applyRecoveryCreditToStripe(credit.id);

    return {
      awarded: true,
      creditId: credit.id,
    };
  } catch (error) {
    log.error({ error, organizationId: params.organizationId }, 'Failed to award recovery credit');
    return {
      awarded: false,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Apply recovery credit to Stripe customer balance
 * Creates a $10 credit on their account
 */
export async function applyRecoveryCreditToStripe(creditId: string): Promise<void> {
  try {
    const credit = await prisma.firstRecoveryCredit.findUnique({
      where: { id: creditId },
      include: { organization: true },
    });

    if (!credit) {
      throw new Error('Recovery credit not found');
    }

    if (credit.status === 'APPLIED') {
      log.debug({ creditId }, 'Credit already applied');
      return;
    }

    if (!credit.organization.stripeCustomerId) {
      log.warn({ creditId, organizationId: credit.organizationId }, 'No Stripe customer ID');
      return;
    }

    // Create credit balance transaction in Stripe
    const balanceTransaction = await stripe.customers.createBalanceTransaction(
      credit.organization.stripeCustomerId,
      {
        amount: -CREDIT_AMOUNT, // Negative amount = credit
        currency: 'usd',
        description: `First Recovery Credit: Congrats on recovering $${(Number(credit.recoveredAmount) / 100).toFixed(2)}! Here's $10 off your next bill.`,
        metadata: {
          type: 'first_recovery_credit',
          credit_id: credit.id,
          organization_id: credit.organizationId,
          recovered_amount: credit.recoveredAmount.toString(),
        },
      }
    );

    // Update credit record
    await prisma.firstRecoveryCredit.update({
      where: { id: creditId },
      data: {
        status: 'APPLIED',
        stripeCreditBalanceTransactionId: balanceTransaction.id,
        appliedAt: new Date(),
      },
    });

    log.info(
      {
        creditId,
        organizationId: credit.organizationId,
        balanceTransactionId: balanceTransaction.id,
      },
      'Recovery credit applied to Stripe'
    );
  } catch (error) {
    log.error({ error, creditId }, 'Failed to apply recovery credit to Stripe');

    // Mark credit as failed (could retry later)
    await prisma.firstRecoveryCredit.update({
      where: { id: creditId },
      data: {
        status: 'PENDING', // Keep as pending for retry
      },
    });

    throw error;
  }
}

/**
 * Get recovery credit status for organization
 */
export async function getRecoveryCreditStatus(organizationId: string): Promise<{
  hasCredit: boolean;
  credit?: {
    id: string;
    creditAmount: number;
    status: string;
    recoveredAmount: string;
    appliedAt: Date | null;
    createdAt: Date;
  };
}> {
  const credit = await prisma.firstRecoveryCredit.findUnique({
    where: { organizationId },
  });

  if (!credit) {
    return { hasCredit: false };
  }

  return {
    hasCredit: true,
    credit: {
      id: credit.id,
      creditAmount: credit.creditAmount,
      status: credit.status,
      recoveredAmount: credit.recoveredAmount.toString(),
      appliedAt: credit.appliedAt,
      createdAt: credit.createdAt,
    },
  };
}

/**
 * Expire credits that are over 90 days old and still pending
 * Run this as a scheduled job (e.g., daily cron)
 */
export async function expireOldRecoveryCredits(): Promise<number> {
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() - CREDIT_EXPIRY_DAYS);

  const result = await prisma.firstRecoveryCredit.updateMany({
    where: {
      status: 'PENDING',
      createdAt: {
        lt: expiryDate,
      },
    },
    data: {
      status: 'EXPIRED',
    },
  });

  if (result.count > 0) {
    log.info({ count: result.count }, 'Expired old recovery credits');
  }

  return result.count;
}
