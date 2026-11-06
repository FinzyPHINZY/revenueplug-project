/**
 * Test Setup and Utilities
 *
 * Common setup functions and utilities for billing tests
 */

import { prisma } from '../../../infrastructure/postgres.js';
import Stripe from 'stripe';
import type { Organization, User } from '@prisma/client';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-12-15.clover',
});

/**
 * Create a test organization with optional Stripe customer
 */
export async function createTestOrganization(
  options: {
    withStripeCustomer?: boolean;
    withSubscription?: boolean;
    plan?: 'starter' | 'pro' | 'enterprise';
  } = {}
): Promise<Organization> {
  const timestamp = Date.now();
  const org = await prisma.organization.create({
    data: {
      name: `Test Org ${timestamp}`,
      slug: `test-org-${timestamp}`,
      email: `test-${timestamp}@example.com`,
    },
  });

  if (options.withStripeCustomer) {
    const customer = await stripe.customers.create({
      email: org.email,
      name: org.name,
      metadata: {
        organizationId: org.id,
      },
    });

    await prisma.organization.update({
      where: { id: org.id },
      data: { stripeCustomerId: customer.id },
    });
  }

  if (options.withSubscription && options.plan) {
    const priceId = getPriceIdForPlan(options.plan);

    await prisma.organization.update({
      where: { id: org.id },
      data: {
        stripePriceId: priceId,
        billingStatus: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  return org;
}

/**
 * Create a test user with organization
 */
export async function createTestUser(
  options: {
    organizationId?: string;
  } = {}
): Promise<{ user: User; organization: Organization }> {
  const timestamp = Date.now();
  const email = `test-user-${timestamp}@example.com`;

  let organization: Organization;

  if (options.organizationId) {
    organization = (await prisma.organization.findUnique({
      where: { id: options.organizationId },
    })) as Organization;
  } else {
    organization = await createTestOrganization();
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: 'Test User',
      passwordHash: 'hashed_password', // Not used in tests
      organizationId: organization.id,
      role: 'OWNER',
      isEmailVerified: true,
    },
  });

  return { user, organization };
}

/**
 * Clean up test organization and related resources
 */
export async function cleanupTestOrganization(
  organizationId: string
): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
  });

  if (!org) return;

  // Cancel Stripe subscription
  if (org.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(org.stripeSubscriptionId);
    } catch (error) {
      // Ignore if subscription doesn't exist
    }
  }

  // Delete Stripe customer
  if (org.stripeCustomerId) {
    try {
      await stripe.customers.del(org.stripeCustomerId);
    } catch (error) {
      // Ignore if customer doesn't exist
    }
  }

  // Delete users
  await prisma.user.deleteMany({
    where: { organizationId },
  });

  // Delete organization
  await prisma.organization.delete({
    where: { id: organizationId },
  });
}

/**
 * Get price ID for a given plan
 */
export function getPriceIdForPlan(
  plan: 'starter' | 'pro' | 'enterprise',
  billingCycle: 'monthly' | 'annual' = 'monthly'
): string {
  const envKey = `PRICE_ID_${plan.toUpperCase()}_${billingCycle.toUpperCase()}`;
  const priceId = process.env[envKey];

  if (!priceId) {
    throw new Error(`Environment variable ${envKey} is not set`);
  }

  return priceId;
}

/**
 * Create a test Stripe subscription
 */
export async function createTestSubscription(
  customerId: string,
  plan: 'starter' | 'pro' | 'enterprise'
): Promise<Stripe.Subscription> {
  const priceId = getPriceIdForPlan(plan);

  return await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
  });
}

/**
 * Mock Stripe webhook signature
 */
export function generateWebhookSignature(
  payload: string,
  secret: string
): string {
  // In production, use Stripe's actual signature generation
  // For tests, we can mock it or use Stripe's constructEvent with a test secret
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=test_signature`;
}

/**
 * Create a test webhook event
 */
export function createTestWebhookEvent(
  type: string,
  data: any
): { event: any; signature: string } {
  const event = {
    id: `evt_test_${Date.now()}`,
    type,
    data: {
      object: data,
    },
    created: Math.floor(Date.now() / 1000),
  };

  const payload = JSON.stringify(event);
  const signature = generateWebhookSignature(
    payload,
    process.env.STRIPE_WEBHOOK_SECRET_BILLING || 'whsec_test'
  );

  return { event, signature };
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error('Timeout waiting for condition');
}

/**
 * Assert that two dates are approximately equal (within 1 second)
 */
export function assertDatesEqual(date1: Date, date2: Date): void {
  const diff = Math.abs(date1.getTime() - date2.getTime());
  if (diff > 1000) {
    throw new Error(
      `Dates are not equal: ${date1.toISOString()} vs ${date2.toISOString()}`
    );
  }
}

/**
 * Test data generators
 */
export const testData = {
  organization: {
    name: () => `Test Org ${Date.now()}`,
    slug: () => `test-org-${Date.now()}`,
    email: () => `org-${Date.now()}@example.com`,
  },
  user: {
    email: () => `user-${Date.now()}@example.com`,
    name: () => 'Test User',
    password: () => 'SecurePassword123!',
  },
  subscription: {
    monthlyRevenue: {
      small: 25000, // $25K
      medium: 100000, // $100K
      large: 500000, // $500K
      enterprise: 2000000, // $2M
    },
    customerCount: {
      small: 500,
      medium: 5000,
      large: 25000,
      enterprise: 100000,
    },
  },
};

/**
 * Environment check
 */
export function checkTestEnvironment(): void {
  const requiredEnvVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET_BILLING',
    'PRICE_ID_STARTER_MONTHLY',
    'PRICE_ID_PRO_MONTHLY',
    'PRICE_ID_ENTERPRISE_MONTHLY',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.warn(
      `⚠️  Warning: Missing environment variables: ${missing.join(', ')}`
    );
    console.warn(
      'Some tests may be skipped. Run "npm run stripe:setup" to configure Stripe.'
    );
  }

  // Ensure we're using test mode
  if (
    process.env.STRIPE_SECRET_KEY &&
    !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')
  ) {
    throw new Error(
      '❌ ERROR: Tests must use Stripe test mode keys (sk_test_). Found live mode key!'
    );
  }
}

// Run environment check when this module is imported
checkTestEnvironment();
