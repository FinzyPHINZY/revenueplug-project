import type { Organization } from '@prisma/client';

/**
 * Billing plan configuration for RevenuePlug platform
 * Plans are hardcoded here and created manually in Stripe Dashboard
 */

export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  priceIds: {
    monthly: string; // Stripe price ID for monthly billing
    annual: string; // Stripe price ID for annual billing
  };
  price: {
    monthly: number; // In cents
    yearly: number; // In cents (with 17% discount)
  };
  limits: {
    connections: number;
    apiCallsPerMonth: number;
    emailsPerMonth: number;
    listViewLimit: number; // Max items shown in lists (top 10 for Viewer, -1 for unlimited)
  };
  features: string[];
}

export const BILLING_PLANS: Record<string, BillingPlan> = {
  FREE: {
    id: 'viewer',
    name: 'Viewer',
    description: 'See your revenue at risk - Free forever',
    priceIds: {
      monthly: '', // No Stripe price
      annual: '', // No Stripe price
    },
    price: {
      monthly: 0,
      yearly: 0,
    },
    limits: {
      connections: 1,
      apiCallsPerMonth: 1000,
      emailsPerMonth: 100, // For testing only - recovery actions blocked
      listViewLimit: 10, // Show only top 10 results
    },
    features: [
      '1 platform connection',
      'Full analytics dashboard (read-only)',
      'Risk detection and scoring',
      'Failed payment tracking',
      'Top 10 list views only',
      'See total recoverable revenue',
    ],
  },

  STARTER: {
    id: 'starter',
    name: 'Starter',
    description: 'For small to medium businesses ready to recover revenue',
    priceIds: {
      monthly: process.env.PRICE_ID_STARTER_MONTHLY || '',
      annual: process.env.PRICE_ID_STARTER_ANNUAL || '',
    },
    price: {
      monthly: 4900, // $49/month
      yearly: 49000, // $490/year (17% discount)
    },
    limits: {
      connections: 3,
      apiCallsPerMonth: 10000,
      emailsPerMonth: 1000, // Warn at 900, hard stop at 1000
      listViewLimit: -1, // Unlimited list views
    },
    features: [
      '3 platform connections',
      '10,000 API calls/month',
      '1,000 recovery emails/month',
      'Automated recovery campaigns',
      'Full list views (unlimited results)',
      'Basic recovery actions',
      'Webhook integrations',
      'Email support',
    ],
  },

  PRO: {
    id: 'pro',
    name: 'Professional',
    description: 'For growing businesses with multiple platforms',
    priceIds: {
      monthly: process.env.PRICE_ID_PRO_MONTHLY || '',
      annual: process.env.PRICE_ID_PRO_ANNUAL || '',
    },
    price: {
      monthly: 14900, // $149/month
      yearly: 149000, // $1,490/year (17% discount)
    },
    limits: {
      connections: 10,
      apiCallsPerMonth: 100000,
      emailsPerMonth: 10000, // Warn at 9000, hard stop at 10000
      listViewLimit: -1, // Unlimited list views
    },
    features: [
      '10 platform connections',
      '100,000 API calls/month',
      '10,000 recovery emails/month',
      'Manual risk threshold configuration',
      'Advanced recovery actions',
      'Multi-step campaigns',
      'A/B testing for recovery emails',
      'Priority analytics (90-day history)',
      'Team collaboration',
      'Priority support (24hr response)',
      'API access',
    ],
  },

  ENTERPRISE: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For large organizations - Starting at $499/mo (Contact Sales)',
    priceIds: {
      monthly: process.env.PRICE_ID_ENTERPRISE_MONTHLY || '',
      annual: process.env.PRICE_ID_ENTERPRISE_ANNUAL || '',
    },
    price: {
      monthly: 49900, // $499/month (starting point - actual pricing is custom)
      yearly: 499000, // $4,990/year (17% discount)
    },
    limits: {
      connections: -1, // Unlimited
      apiCallsPerMonth: -1, // Unlimited
      emailsPerMonth: -1, // Unlimited
      listViewLimit: -1, // Unlimited list views
    },
    features: [
      'Unlimited connections',
      'Unlimited API calls',
      'Unlimited emails',
      'Dedicated infrastructure (isolated VPC)',
      'Custom recovery strategies',
      'White-label options',
      'SLA guarantee (99.9% uptime)',
      'Dedicated support (4hr response)',
      'Custom integrations (200 eng hours/year)',
      'Advanced security (SOC 2, HIPAA)',
      'Custom contracts',
      'Contact Sales for custom pricing',
    ],
  },
};

/**
 * Get plan by Stripe price ID (checks both monthly and annual)
 */
export function getPlanByPriceId(priceId: string): BillingPlan | null {
  return (
    Object.values(BILLING_PLANS).find(
      (p) => p.priceIds.monthly === priceId || p.priceIds.annual === priceId
    ) || null
  );
}

/**
 * Get plan ID from Stripe price ID
 * Useful for checking which plan a price ID corresponds to
 */
export function getPlanIdByPriceId(priceId: string): string | null {
  const plan = getPlanByPriceId(priceId);
  return plan?.id || null;
}

/**
 * Get plan for organization
 */
export function getOrganizationPlan(org: Organization): BillingPlan {
  if (!org.stripePriceId) {
    return BILLING_PLANS.FREE;
  }

  const plan = getPlanByPriceId(org.stripePriceId);
  return plan || BILLING_PLANS.FREE;
}

/**
 * Check if limit is exceeded (-1 means unlimited)
 */
export function isLimitExceeded(current: number, limit: number): boolean {
  if (limit === -1) return false; // Unlimited
  return current >= limit;
}
