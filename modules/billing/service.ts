import Stripe from 'stripe';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { BILLING_PLANS, getOrganizationPlan, isLimitExceeded } from './plans.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-12-15.clover',
});

const log = logger.child({ module: 'billing' });

/**
 * Create Stripe checkout session for organization subscription
 */
export async function createCheckoutSession(params: {
  organizationId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ sessionId: string; url: string }> {
  const org = await prisma.organization.findUnique({
    where: { id: params.organizationId },
  });

  if (!org) {
    throw new Error('Organization not found');
  }

  // Create or retrieve Stripe customer
  let customerId = org.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: org.email || undefined,
      name: org.name,
      metadata: {
        organizationId: org.id,
        slug: org.slug,
      },
    });

    customerId = customer.id;

    await prisma.organization.update({
      where: { id: org.id },
      data: { stripeCustomerId: customerId },
    });

    log.info({ organizationId: org.id, customerId }, 'Created Stripe customer');
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [
      {
        price: params.priceId,
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: {
      organizationId: org.id,
    },
  });

  log.info({ organizationId: org.id, sessionId: session.id }, 'Created checkout session');

  return {
    sessionId: session.id,
    url: session.url!,
  };
}

/**
 * Create Stripe customer portal session
 */
export async function createPortalSession(params: {
  organizationId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const org = await prisma.organization.findUnique({
    where: { id: params.organizationId },
  });

  if (!org || !org.stripeCustomerId) {
    throw new Error('No Stripe customer found for organization');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: params.returnUrl,
  });

  log.info({ organizationId: org.id }, 'Created portal session');

  return { url: session.url };
}

/**
 * Get current usage for organization's billing period
 */
export async function getUsageForPeriod(
  organizationId: string,
  period: Date
): Promise<{
  apiCalls: number;
  emailsSent: number;
  connections: number;
}> {
  const usage = await prisma.usageTracking.findUnique({
    where: {
      organizationId_period: {
        organizationId,
        period,
      },
    },
  });

  return {
    apiCalls: usage?.apiCalls || 0,
    emailsSent: usage?.emailsSent || 0,
    connections: usage?.connections || 0,
  };
}

/**
 * Increment usage counter (upsert pattern for real-time tracking)
 */
export async function incrementUsage(
  organizationId: string,
  metric: 'apiCalls' | 'emailsSent',
  amount: number = 1
): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currentPeriodStart: true },
  });

  if (!org) {
    throw new Error('Organization not found');
  }

  // Use billing period start, or default to current month
  const period = org.currentPeriodStart || getFirstDayOfMonth(new Date());

  await prisma.usageTracking.upsert({
    where: {
      organizationId_period: { organizationId, period },
    },
    create: {
      organizationId,
      period,
      [metric]: amount,
      connections: 0,
    },
    update: {
      [metric]: {
        increment: amount,
      },
    },
  });

  log.debug({ organizationId, metric, amount, period }, 'Incremented usage');
}

/**
 * Update connection count
 */
export async function updateConnectionCount(organizationId: string): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { currentPeriodStart: true },
  });

  if (!org) {
    throw new Error('Organization not found');
  }

  const period = org.currentPeriodStart || getFirstDayOfMonth(new Date());

  // Count active connections
  const connectionCount = await prisma.connection.count({
    where: {
      organizationId,
      status: 'ACTIVE',
    },
  });

  await prisma.usageTracking.upsert({
    where: {
      organizationId_period: { organizationId, period },
    },
    create: {
      organizationId,
      period,
      connections: connectionCount,
      apiCalls: 0,
      emailsSent: 0,
    },
    update: {
      connections: connectionCount,
    },
  });

  log.debug({ organizationId, connectionCount, period }, 'Updated connection count');
}

/**
 * Check if organization can perform action based on limits
 */
export async function checkUsageLimit(
  organizationId: string,
  metric: 'apiCalls' | 'emailsSent' | 'connections'
): Promise<{ allowed: boolean; reason?: string }> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
  });

  if (!org) {
    return { allowed: false, reason: 'Organization not found' };
  }

  const plan = getOrganizationPlan(org);
  const period = org.currentPeriodStart || getFirstDayOfMonth(new Date());
  const usage = await getUsageForPeriod(organizationId, period);

  const limit =
    plan.limits[
      metric === 'apiCalls'
        ? 'apiCallsPerMonth'
        : metric === 'emailsSent'
          ? 'emailsPerMonth'
          : 'connections'
    ];

  if (isLimitExceeded(usage[metric], limit)) {
    return {
      allowed: false,
      reason: `${plan.name} plan limit reached: ${usage[metric]}/${limit === -1 ? 'unlimited' : limit} ${metric}`,
    };
  }

  return { allowed: true };
}

/**
 * Helper: Get first day of month
 */
function getFirstDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Get organization stats from connected platforms
 * Used for plan qualification (checking MRR, customer count)
 */
export async function getOrganizationStats(organizationId: string): Promise<{
  totalCustomers: number;
  monthlyRevenue: number;
  annualRevenue: number;
  activeSubscriptions: number;
  platform: string;
}> {
  // Get all active connections for this org
  const connections = await prisma.connection.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
    },
  });

  if (connections.length === 0) {
    // No connections yet - return zeros
    return {
      totalCustomers: 0,
      monthlyRevenue: 0,
      annualRevenue: 0,
      activeSubscriptions: 0,
      platform: 'none',
    };
  }

  let totalCustomers = 0;
  let monthlyRevenue = 0;
  let activeSubscriptions = 0;

  // Aggregate stats across all connections
  for (const connection of connections) {
    // Count unique customers for this connection
    const customerCount = await prisma.customer.count({
      where: {
        connectionId: connection.id,
      },
    });
    totalCustomers += customerCount;

    // Get active subscriptions and calculate MRR
    const subscriptions = await prisma.subscription.findMany({
      where: {
        connectionId: connection.id,
        status: 'ACTIVE',
      },
    });

    activeSubscriptions += subscriptions.length;

    // Calculate MRR from active subscriptions
    for (const sub of subscriptions) {
      const amount = Number(sub.amount);
      let monthlyAmount = amount;

      // Convert to monthly recurring revenue based on interval
      if (sub.interval === 'year') {
        monthlyAmount = amount / 12; // Annual → Monthly
      } else if (sub.interval === 'week') {
        monthlyAmount = amount * 4; // Weekly → Monthly (approx)
      } else if (sub.interval === 'day') {
        monthlyAmount = amount * 30; // Daily → Monthly (approx)
      }
      // 'month' interval stays as is

      // Account for interval count (e.g., every 3 months)
      const intervalCount = sub.intervalCount || 1;
      if (intervalCount > 1 && sub.interval !== 'month') {
        monthlyAmount = monthlyAmount / intervalCount;
      }

      monthlyRevenue += monthlyAmount;
    }
  }

  // Convert from cents to dollars
  monthlyRevenue = Math.round(monthlyRevenue / 100);

  return {
    totalCustomers,
    monthlyRevenue,
    annualRevenue: monthlyRevenue * 12,
    activeSubscriptions,
    platform: connections[0]?.platform || 'unknown',
  };
}

/**
 * Validate if organization is eligible for a plan based on their size
 * Returns eligibility status and suggested plan if not eligible
 */
export async function validatePlanEligibility(
  organizationId: string,
  requestedPlanId: string
): Promise<{
  eligible: boolean;
  reason?: string;
  suggestedPlan?: string;
  stats?: {
    monthlyRevenue: number;
    totalCustomers: number;
    annualRevenue: number;
  };
}> {
  const stats = await getOrganizationStats(organizationId);

  // Viewer tier has no restrictions
  if (requestedPlanId === 'viewer' || requestedPlanId === 'free') {
    return { eligible: true };
  }

  // STARTER plan qualification: <$50K MRR, <1,000 customers
  if (requestedPlanId === 'starter') {
    if (stats.monthlyRevenue > 50000) {
      return {
        eligible: false,
        reason: `STARTER plan is for companies with <$50K MRR. Your business ($${(stats.monthlyRevenue / 1000).toFixed(0)}K MRR) requires PRO or ENTERPRISE.`,
        suggestedPlan: stats.monthlyRevenue > 500000 ? 'enterprise' : 'pro',
        stats: {
          monthlyRevenue: stats.monthlyRevenue,
          totalCustomers: stats.totalCustomers,
          annualRevenue: stats.annualRevenue,
        },
      };
    }

    if (stats.totalCustomers > 1000) {
      return {
        eligible: false,
        reason: `STARTER plan is for companies with <1,000 customers. Your business (${stats.totalCustomers} customers) requires PRO or ENTERPRISE.`,
        suggestedPlan: stats.totalCustomers > 10000 ? 'enterprise' : 'pro',
        stats: {
          monthlyRevenue: stats.monthlyRevenue,
          totalCustomers: stats.totalCustomers,
          annualRevenue: stats.annualRevenue,
        },
      };
    }
  }

  // PRO plan qualification: <$500K MRR, <10,000 customers
  if (requestedPlanId === 'pro') {
    if (stats.monthlyRevenue > 500000) {
      return {
        eligible: false,
        reason: `PRO plan is for companies with <$500K MRR. Your business ($${(stats.monthlyRevenue / 1000).toFixed(0)}K MRR) requires ENTERPRISE pricing. Contact our sales team.`,
        suggestedPlan: 'enterprise',
        stats: {
          monthlyRevenue: stats.monthlyRevenue,
          totalCustomers: stats.totalCustomers,
          annualRevenue: stats.annualRevenue,
        },
      };
    }

    if (stats.totalCustomers > 10000) {
      return {
        eligible: false,
        reason: `PRO plan is for companies with <10,000 customers. Your business (${stats.totalCustomers} customers) requires ENTERPRISE pricing. Contact our sales team.`,
        suggestedPlan: 'enterprise',
        stats: {
          monthlyRevenue: stats.monthlyRevenue,
          totalCustomers: stats.totalCustomers,
          annualRevenue: stats.annualRevenue,
        },
      };
    }
  }

  // ENTERPRISE has no upper limits
  return { eligible: true };
}
