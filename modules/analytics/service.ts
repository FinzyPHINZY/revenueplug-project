/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import type { InvoiceStatus } from '../../shared/types/index.js';
import { getOrganizationPlan } from '../billing/plans.js';

async function validateConnectionOwnership(
  connectionId: string,
  organizationId: string
): Promise<void> {
  const connection = await prisma.connection.findFirst({
    where: { id: connectionId, organizationId },
  });

  if (!connection) {
    throw new Error('Connection not found or access denied');
  }
}

export interface FailedPayment {
  id: string;
  invoiceId: string;
  invoiceExternalId: string;
  customerId: string;
  customerEmail: string | null;
  customerName: string | null;
  subscriptionId: string | null;
  subscriptionExternalId: string | null;
  productName: string | null;

  amountDue: number;
  amountRemaining: number;
  currency: string;

  status: InvoiceStatus;
  attemptCount: number;
  failureReason: string | null;

  dueDate: Date | null;
  nextPaymentAttempt: Date | null;
  lastAttemptedAt: Date | null;

  riskType: 'active_failure' | 'upcoming_due';
  recoveryPotential: 'high' | 'medium' | 'low';
  recoveryScore: number;

  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;

  platform: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FailedPaymentsSummary {
  totalCount: number;
  totalRevenue: number;
  mrrAtRisk: number;
  currency: string;
  byRecoveryPotential: {
    high: { count: number; revenue: number };
    medium: { count: number; revenue: number };
    low: { count: number; revenue: number };
  };
  byFailureReason: Array<{
    reason: string;
    count: number;
    revenue: number;
  }>;
  trend: {
    direction: 'up' | 'down' | 'stable';
    changePercent: number;
    previousCount: number;
    currentCount: number;
  };
}

export interface GetFailedPaymentsOptions {
  connectionId: string;
  limit?: number;
  offset?: number;
  recoveryPotential?: 'high' | 'medium' | 'low';
  riskType?: 'active_failure' | 'upcoming_due' | 'all';
  minAmount?: number;
  maxAmount?: number;
  upcomingDays?: number;
}

export async function getFailedPayments(
  options: GetFailedPaymentsOptions,
  organizationId: string
): Promise<{ payments: FailedPayment[]; total: number; hasMore: boolean; hiddenCount: number }> {
  const {
    connectionId,
    limit = 50,
    offset = 0,
    recoveryPotential,
    riskType = 'all',
    minAmount,
    maxAmount,
    upcomingDays = 7,
  } = options;

  const log = logger.child({ operation: 'getFailedPayments', connectionId, organizationId });

  try {
    await validateConnectionOwnership(connectionId, organizationId);

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new Error('Organization not found');
    }

    const plan = getOrganizationPlan(org);
    const listViewLimit = plan.limits.listViewLimit;

    log.info(
      { limit, offset, recoveryPotential, riskType, listViewLimit },
      'Fetching failed payments'
    );

    const [activeFailures, upcomingBills] = await Promise.all([
      riskType === 'upcoming_due'
        ? Promise.resolve([])
        : fetchActiveFailures(connectionId, minAmount, maxAmount),

      riskType === 'active_failure'
        ? Promise.resolve([])
        : fetchUpcomingBills(connectionId, upcomingDays, minAmount, maxAmount),
    ]);

    const allPayments: FailedPayment[] = [
      ...transformInvoices(activeFailures, 'active_failure'),
      ...transformInvoices(upcomingBills, 'upcoming_due'),
    ];

    allPayments.sort((a, b) => {
      if (a.riskType !== b.riskType) {
        return a.riskType === 'active_failure' ? -1 : 1;
      }
      return b.recoveryScore - a.recoveryScore;
    });

    let filteredPayments = recoveryPotential
      ? allPayments.filter((p) => p.recoveryPotential === recoveryPotential)
      : allPayments;

    const total = filteredPayments.length;

    let effectiveLimit = limit;
    if (listViewLimit !== -1) {
      effectiveLimit = Math.min(limit, listViewLimit);
    }

    filteredPayments = filteredPayments.slice(offset, offset + effectiveLimit);

    const hasMore = total > effectiveLimit;
    const hiddenCount = hasMore ? total - effectiveLimit : 0;

    log.info(
      {
        count: filteredPayments.length,
        total,
        hasMore,
        hiddenCount,
        listViewLimit,
        effectiveLimit,
      },
      'Fetched failed payments'
    );

    return {
      payments: filteredPayments,
      total,
      hasMore,
      hiddenCount,
    };
  } catch (error) {
    log.error({ error }, 'Failed to fetch failed payments');
    throw error;
  }
}

async function fetchActiveFailures(connectionId: string, minAmount?: number, maxAmount?: number) {
  const where: any = {
    connectionId,
    status: 'OPEN',
    attemptCount: { gte: 1 },
    amountRemaining: { gt: 0 },
  };

  if (minAmount) {
    where.amountRemaining = { ...where.amountRemaining, gte: minAmount };
  }

  if (maxAmount) {
    where.amountRemaining = { ...where.amountRemaining, lte: maxAmount };
  }

  return await prisma.invoice.findMany({
    where,
    include: {
      connection: {
        include: {
          customers: true,
          subscriptions: true,
        },
      },
    },
  });
}


async function fetchUpcomingBills(
  connectionId: string,
  upcomingDays: number,
  minAmount?: number,
  maxAmount?: number
) {
  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(now.getDate() + upcomingDays);

  const where: any = {
    connectionId,
    status: 'OPEN',
    attemptCount: 0,
    amountRemaining: { gt: 0 },
    dueDate: {
      gte: now,
      lte: futureDate,
    },
  };

  if (minAmount) {
    where.amountRemaining = { ...where.amountRemaining, gte: minAmount };
  }

  if (maxAmount) {
    where.amountRemaining = { ...where.amountRemaining, lte: maxAmount };
  }

  return await prisma.invoice.findMany({
    where,
    include: {
      connection: {
        include: {
          customers: true,
          subscriptions: true,
        },
      },
    },
  });
}

/**
 * Helper: Transform invoices to FailedPayment format
 */
function transformInvoices(
  invoices: any[],
  riskType: 'active_failure' | 'upcoming_due'
): FailedPayment[] {
  return invoices.map((invoice) => {
    const customer = invoice.connection.customers.find(
      (c: any) => c.externalId === invoice.customerExternalId
    );
    const subscription = invoice.connection.subscriptions.find(
      (s: any) => s.externalId === invoice.subscriptionExternalId
    );

    const recoveryData = calculateRecoveryPotential(invoice, customer, subscription, riskType);

    return {
      id: invoice.id,
      invoiceId: invoice.id,
      invoiceExternalId: invoice.externalId,
      customerId: customer?.id || '',
      customerEmail: customer?.email || null,
      customerName: customer?.name || null,
      subscriptionId: subscription?.id || null,
      subscriptionExternalId: invoice.subscriptionExternalId || null,
      productName: subscription?.productName || null,
      amountDue: Number(invoice.amountDue),
      amountRemaining: Number(invoice.amountRemaining),
      currency: invoice.currency,
      status: invoice.status as InvoiceStatus,
      attemptCount: invoice.attemptCount,
      failureReason: invoice.failureReason,
      dueDate: invoice.dueDate,
      nextPaymentAttempt: invoice.nextPaymentAttempt,
      lastAttemptedAt: invoice.updatedAt,
      riskType,
      recoveryPotential: recoveryData.potential,
      recoveryScore: recoveryData.score,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      invoicePdf: invoice.invoicePdf,
      platform: invoice.platform,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  });
}


export async function getFailedPaymentsSummary(
  connectionId: string,
  organizationId: string
): Promise<FailedPaymentsSummary> {
  const log = logger.child({ operation: 'getFailedPaymentsSummary', connectionId, organizationId });

  try {
    await validateConnectionOwnership(connectionId, organizationId);

    log.info('Calculating failed payments summary');

    const { payments } = await getFailedPayments(
      {
        connectionId,
        limit: 1000,
        riskType: 'active_failure',
      },
      organizationId
    );

    const totalCount = payments.length;
    const totalRevenue = payments.reduce((sum, p) => sum + p.amountRemaining, 0);
    const currency = payments[0]?.currency || 'usd';

    const mrrAtRisk = await calculateMRRAtRisk(connectionId);

    const trend = await calculateTrend(connectionId);

    const byRecoveryPotential = {
      high: { count: 0, revenue: 0 },
      medium: { count: 0, revenue: 0 },
      low: { count: 0, revenue: 0 },
    };

    payments.forEach((p) => {
      byRecoveryPotential[p.recoveryPotential].count++;
      byRecoveryPotential[p.recoveryPotential].revenue += p.amountRemaining;
    });

    const reasonMap = new Map<string, { count: number; revenue: number }>();
    payments.forEach((p) => {
      const reason = p.failureReason || 'Unknown';
      const existing = reasonMap.get(reason) || { count: 0, revenue: 0 };
      existing.count++;
      existing.revenue += p.amountRemaining;
      reasonMap.set(reason, existing);
    });

    const byFailureReason = Array.from(reasonMap.entries())
      .map(([reason, data]) => ({ reason, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const summary: FailedPaymentsSummary = {
      totalCount,
      totalRevenue,
      mrrAtRisk,
      currency,
      byRecoveryPotential,
      byFailureReason,
      trend,
    };

    log.info({ summary }, 'Calculated failed payments summary');

    return summary;
  } catch (error) {
    log.error({ error }, 'Failed to calculate summary');
    throw error;
  }
}


async function calculateMRRAtRisk(connectionId: string): Promise<number> {
  const failedInvoices = await prisma.invoice.findMany({
    where: {
      connectionId,
      status: 'OPEN',
      attemptCount: { gte: 1 },
      subscriptionExternalId: { not: null },
    },
    select: {
      subscriptionExternalId: true,
    },
    distinct: ['subscriptionExternalId'],
  });

  const subscriptionIds = failedInvoices
    .map((inv) => inv.subscriptionExternalId)
    .filter((id): id is string => id !== null);

  if (subscriptionIds.length === 0) {
    return 0;
  }

  const subscriptionsAtRisk = await prisma.subscription.findMany({
    where: {
      connectionId,
      externalId: { in: subscriptionIds },
    },
  });

  const mrrAtRisk = subscriptionsAtRisk.reduce((total, sub) => {
    const amount = Number(sub.amount);

    let monthlyAmount = amount;

    if (sub.interval === 'year') {
      monthlyAmount = amount / 12;
    } else if (sub.interval === 'week') {
      monthlyAmount = amount * 4;
    } else if (sub.interval === 'day') {
      monthlyAmount = amount * 30;
    }

    const intervalCount = sub.intervalCount || 1;
    if (intervalCount > 1) {
      monthlyAmount = monthlyAmount / intervalCount;
    }

    return total + monthlyAmount;
  }, 0);

  return Math.round(mrrAtRisk);
}

/**
 * Calculate trend: Compare this week vs last week
 */
async function calculateTrend(connectionId: string): Promise<{
  direction: 'up' | 'down' | 'stable';
  changePercent: number;
  previousCount: number;
  currentCount: number;
}> {
  const now = new Date();
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(now.getDate() - 7);
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(now.getDate() - 14);

  const currentCount = await prisma.invoice.count({
    where: {
      connectionId,
      status: 'OPEN',
      attemptCount: { gte: 1 },
      updatedAt: { gte: oneWeekAgo },
    },
  });

  const previousCount = await prisma.invoice.count({
    where: {
      connectionId,
      status: 'OPEN',
      attemptCount: { gte: 1 },
      updatedAt: {
        gte: twoWeeksAgo,
        lt: oneWeekAgo,
      },
    },
  });

  let changePercent = 0;
  if (previousCount > 0) {
    changePercent = ((currentCount - previousCount) / previousCount) * 100;
  } else if (currentCount > 0) {
    changePercent = 100;
  }

  let direction: 'up' | 'down' | 'stable' = 'stable';
  if (Math.abs(changePercent) < 5) {
    direction = 'stable';
  } else if (changePercent > 0) {
    direction = 'up';
  } else {
    direction = 'down';
  }

  return {
    direction,
    changePercent: Math.round(changePercent * 10) / 10,
    previousCount,
    currentCount,
  };
}


function calculateRecoveryPotential(
  invoice: any,
  customer: any,
  subscription: any,
  riskType?: 'active_failure' | 'upcoming_due'
): { potential: 'high' | 'medium' | 'low'; score: number } {
  let score = 50;

  if (riskType === 'upcoming_due' || invoice.attemptCount === 0) {
    score = 60;
  }

  if (invoice.attemptCount === 0) {
    score += 15;
  } else if (invoice.attemptCount === 1) {
    score += 20;
  } else if (invoice.attemptCount === 2) {
    score += 10;
  } else if (invoice.attemptCount >= 4) {
    score -= 20;
  }

  const reason = (invoice.failureReason || '').toLowerCase();
  if (reason.includes('insufficient_funds') || reason.includes('insufficient funds')) {
    score += 15;
  } else if (reason.includes('card_declined') || reason.includes('declined')) {
    score += 5;
  } else if (reason.includes('expired')) {
    score += 10;
  } else if (reason.includes('lost') || reason.includes('stolen')) {
    score -= 10;
  } else if (reason.includes('do_not_honor') || reason.includes('fraudulent')) {
    score -= 20;
  }

  if (subscription && subscription.status === 'ACTIVE') {
    score += 15;
  } else if (subscription && subscription.status === 'CANCELLED') {
    score -= 25;
  }

  const amount = Number(invoice.amountRemaining);
  if (amount < 5000) {
    score += 10;
  } else if (amount > 50000) {
    score -= 10;
  }

  if (invoice.dueDate) {
    const daysSinceDue = Math.floor(
      (Date.now() - new Date(invoice.dueDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceDue < 7) {
      score += 10;
    } else if (daysSinceDue > 30) {
      score -= 15;
    }
  }

  if (customer?.email) {
    score += 5;
  } else {
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  let potential: 'high' | 'medium' | 'low';
  if (score >= 70) {
    potential = 'high';
  } else if (score >= 40) {
    potential = 'medium';
  } else {
    potential = 'low';
  }

  return { potential, score };
}
