import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { checkAndAwardFirstRecoveryCredit } from '../billing/recovery-credit.js';
import type { Platform, PaymentStatus } from '@prisma/client';

const log = logger.child({ module: 'recovery-detector' });


export async function detectPaymentRecovery(params: {
  connectionId: string;
  paymentExternalId: string;
  oldStatus: PaymentStatus;
  newStatus: PaymentStatus;
  amount: string | number;
  customerExternalId?: string;
}): Promise<void> {
  try {
    // Only track FAILED → SUCCEEDED transitions
    if (params.oldStatus !== 'FAILED' || params.newStatus !== 'SUCCEEDED') {
      return;
    }

    log.info(
      {
        connectionId: params.connectionId,
        paymentExternalId: params.paymentExternalId,
        amount: params.amount,
      },
      'Payment recovery detected'
    );

    // Get connection to find organization
    const connection = await prisma.connection.findUnique({
      where: { id: params.connectionId },
      select: {
        organizationId: true,
        platform: true,
      },
    });

    if (!connection) {
      log.error({ connectionId: params.connectionId }, 'Connection not found');
      return;
    }

    // Check if this qualifies for first recovery credit
    const result = await checkAndAwardFirstRecoveryCredit({
      organizationId: connection.organizationId,
      paymentExternalId: params.paymentExternalId,
      customerExternalId: params.customerExternalId || 'unknown',
      recoveredAmount: params.amount,
      platform: connection.platform,
    });

    if (result.awarded) {
      log.info(
        {
          organizationId: connection.organizationId,
          creditId: result.creditId,
        },
        'First recovery credit awarded for payment recovery'
      );

      // TODO: Trigger notification to user (email, in-app, etc.)
      // await sendRecoveryCreditNotification({
      //   organizationId: connection.organizationId,
      //   creditAmount: 1000,
      //   recoveredAmount: params.amount,
      // });
    } else if (result.reason) {
      log.debug(
        { organizationId: connection.organizationId, reason: result.reason },
        'Payment recovery did not qualify for credit'
      );
    }
  } catch (error) {
    log.error(
      { error, paymentExternalId: params.paymentExternalId },
      'Failed to detect payment recovery'
    );
  }
}


export async function trackRecoveryMetrics(params: {
  organizationId: string;
  connectionId: string;
  paymentExternalId: string;
  customerExternalId?: string;
  recoveredAmount: string | number;
  platform: Platform;
}): Promise<void> {
  try {

    log.debug(
      {
        organizationId: params.organizationId,
        recoveredAmount: params.recoveredAmount,
      },
      'Recovery metrics tracked'
    );
  } catch (error) {
    log.error({ error, organizationId: params.organizationId }, 'Failed to track recovery metrics');
  }
}


export async function getRecoveryStats(organizationId: string): Promise<{
  totalRecoveries: number;
  totalRecoveredAmount: number;
  firstRecoveryDate: Date | null;
}> {
   const payments = await prisma.payment.findMany({
    where: {
      connection: {
        organizationId,
      },
      status: 'SUCCEEDED',
    },
    orderBy: {
      paidAt: 'asc',
    },
    select: {
      amount: true,
      paidAt: true,
    },
  });

  const totalRecoveredAmount = payments.reduce((sum, p) => sum + Number(p.amount), 0);

  return {
    totalRecoveries: payments.length,
    totalRecoveredAmount,
    firstRecoveryDate: payments[0]?.paidAt || null,
  };
}
