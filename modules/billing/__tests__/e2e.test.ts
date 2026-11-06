import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../../../infrastructure/postgres.js';
import { app } from '../../../server.js';
import type { Organization, User } from '@prisma/client';

/**
 * End-to-End Billing Flow Tests
 *
 * These tests simulate real user journeys through the billing system.
 * They require a running server and valid Stripe test keys.
 *
 * Run with: npm test -- e2e.test.ts
 */
describe('E2E Billing Flow Tests', () => {
  let testUser: User;
  let testOrg: Organization;
  let accessToken: string;
  let stripe: Stripe;

  beforeAll(async () => {
    // Create test user and organization
    const email = `e2e-test-${Date.now()}@example.com`;

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email,
        password: 'SecurePassword123!',
        name: 'E2E Test User',
        organizationName: `E2E Test Org ${Date.now()}`,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    accessToken = body.access_token;

    // Get created user and org
    testUser = await prisma.user.findUnique({
      where: { email },
    }) as User;

    testOrg = await prisma.organization.findUnique({
      where: { id: testUser.organizationId },
    }) as Organization;

    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-12-18.acacia',
    });
  });

  afterAll(async () => {
    // Clean up Stripe resources
    if (testOrg?.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.cancel(testOrg.stripeSubscriptionId);
      } catch (error) {
        // Ignore
      }
    }

    if (testOrg?.stripeCustomerId) {
      try {
        await stripe.customers.del(testOrg.stripeCustomerId);
      } catch (error) {
        // Ignore
      }
    }

    // Clean up database
    if (testUser) {
      await prisma.user.delete({ where: { id: testUser.id } });
    }
    if (testOrg) {
      await prisma.organization.delete({ where: { id: testOrg.id } });
    }
  });

  describe('Journey 1: Free to STARTER Upgrade', () => {
    it('Step 1: New user should start on free tier', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.plan.id).toBe('viewer');
      expect(body.plan.name).toBe('Viewer');
      expect(body.status).toBe('FREE');
      expect(body.plan.limits.connections).toBe(1);
      expect(body.plan.limits.apiCallsPerMonth).toBe(1000);
    });

    it('Step 2: Create checkout session for STARTER plan', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        payload: {
          price_id: process.env.PRICE_ID_STARTER_MONTHLY!,
          success_url: 'http://localhost:3000/success',
          cancel_url: 'http://localhost:3000/cancel',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.sessionId).toBeDefined();
      expect(body.sessionId).toMatch(/^cs_test_/);
      expect(body.url).toContain('checkout.stripe.com');

      // Verify Stripe customer created
      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.stripeCustomerId).toBeDefined();
    });

    it('Step 3: After checkout, subscription should be active', async () => {
      // In a real test, user would complete checkout and webhook would fire
      // For this test, we'll simulate the subscription activation

      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripePriceId: process.env.PRICE_ID_STARTER_MONTHLY!,
          billingStatus: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.plan.id).toBe('starter');
      expect(body.plan.name).toBe('Starter');
      expect(body.status).toBe('ACTIVE');
      expect(body.plan.limits.connections).toBe(3);
      expect(body.plan.limits.apiCallsPerMonth).toBe(10000);
    });
  });

  describe('Journey 2: STARTER to PRO Upgrade', () => {
    it('Step 1: User should be on STARTER plan', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.plan.id).toBe('starter');
    });

    it('Step 2: Create checkout session for PRO plan', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        payload: {
          price_id: process.env.PRICE_ID_PRO_MONTHLY!,
          success_url: 'http://localhost:3000/success',
          cancel_url: 'http://localhost:3000/cancel',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.url).toContain('checkout.stripe.com');
    });

    it('Step 3: After upgrade, should be on PRO plan', async () => {
      // Simulate upgrade
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripePriceId: process.env.PRICE_ID_PRO_MONTHLY!,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.plan.id).toBe('pro');
      expect(body.plan.name).toBe('Professional');
      expect(body.plan.limits.connections).toBe(10);
      expect(body.plan.limits.apiCallsPerMonth).toBe(100000);
    });
  });

  describe('Journey 3: Customer Portal Access', () => {
    it('Step 1: Create customer portal session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/portal',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        payload: {
          return_url: 'http://localhost:3000/settings',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.url).toBeDefined();
      expect(body.url).toContain('billing.stripe.com');
    });

    it('Step 2: Simulate subscription cancellation', async () => {
      // User cancels through portal, webhook fires
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          billingStatus: 'CANCELED',
          cancelAtPeriodEnd: true,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.status).toBe('CANCELED');
      expect(body.cancelAtPeriodEnd).toBe(true);
      // Should still have access until period end
      expect(body.plan.id).toBe('pro');
    });
  });

  describe('Journey 4: Usage Tracking and Limits', () => {
    it('Step 1: Track API usage', async () => {
      // Make 10 API calls
      for (let i = 0; i < 10; i++) {
        await app.inject({
          method: 'GET',
          url: '/api/connections',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
      }

      // Check usage
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.usage).toBeDefined();
      expect(body.usage.apiCalls).toBeGreaterThan(0);
    });

    it('Step 2: Check usage limits', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/usage-limits',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.apiCalls).toBeDefined();
      expect(body.apiCalls.limit).toBe(100000); // PRO plan
      expect(body.apiCalls.allowed).toBe(true);
    });

    it('Step 3: Simulate exceeding limit', async () => {
      // Simulate usage exceeding limit
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripePriceId: process.env.PRICE_ID_STARTER_MONTHLY!, // Downgrade to STARTER
        },
      });

      // Add usage exceeding STARTER limit (10,000)
      // This would be tracked in a separate usage table
      // For now, just verify the limit check logic

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/usage-limits',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.apiCalls.limit).toBe(10000); // STARTER limit
    });
  });

  describe('Journey 5: Annual Billing', () => {
    it('Step 1: Switch to annual billing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/checkout',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        payload: {
          price_id: process.env.PRICE_ID_PRO_ANNUAL!,
          success_url: 'http://localhost:3000/success',
          cancel_url: 'http://localhost:3000/cancel',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.url).toContain('checkout.stripe.com');
    });

    it('Step 2: Verify annual subscription', async () => {
      // Simulate annual subscription activation
      const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripePriceId: process.env.PRICE_ID_PRO_ANNUAL!,
          currentPeriodEnd: oneYearFromNow,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.plan.id).toBe('pro');

      // Check period end is ~1 year away
      const periodEnd = new Date(body.currentPeriodEnd);
      const daysUntilEnd = (periodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(daysUntilEnd).toBeGreaterThan(350);
    });
  });

  describe('Journey 6: Failed Payment Recovery', () => {
    it('Step 1: Simulate payment failure', async () => {
      // Webhook: invoice.payment_failed
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          billingStatus: 'PAST_DUE',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.status).toBe('PAST_DUE');
    });

    it('Step 2: Simulate payment recovery', async () => {
      // Webhook: invoice.payment_succeeded
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          billingStatus: 'ACTIVE',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/billing/subscription',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const body = JSON.parse(response.body);
      expect(body.status).toBe('ACTIVE');
    });
  });

  describe('Journey 7: ROI Calculator', () => {
    it('Should calculate ROI for different plans', async () => {
      const scenarios = [
        {
          monthlyRevenue: 50000,
          atRiskRevenue: 5000,
          plan: 'starter',
        },
        {
          monthlyRevenue: 200000,
          atRiskRevenue: 20000,
          plan: 'pro',
        },
        {
          monthlyRevenue: 1000000,
          atRiskRevenue: 100000,
          plan: 'enterprise',
        },
      ];

      for (const scenario of scenarios) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/billing/roi-calculator',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          payload: scenario,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);

        expect(body.estimatedRecoveryPerMonth).toBeGreaterThan(0);
        expect(body.planCostPerMonth).toBeGreaterThan(0);
        expect(body.netBenefitPerMonth).toBeGreaterThan(0);
        expect(body.roiPercentage).toBeGreaterThan(0);
        expect(body.paybackPeriodMonths).toBeLessThan(12);
      }
    });
  });
});
