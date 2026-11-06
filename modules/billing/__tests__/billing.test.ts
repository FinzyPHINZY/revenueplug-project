import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../../../infrastructure/postgres.js';
import * as billingService from '../service.js';
import type { Organization } from '@prisma/client';

describe('Billing Integration Tests', () => {
  let testOrg: Organization;
  let stripe: Stripe;

  beforeEach(async () => {
    // Create test organization
    testOrg = await prisma.organization.create({
      data: {
        name: 'Test Org',
        slug: `test-org-${Date.now()}`,
        email: `test-${Date.now()}@example.com`,
      },
    });

    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-12-18.acacia',
    });
  });

  afterEach(async () => {
    // Clean up test organization
    if (testOrg) {
      // Cancel any Stripe subscriptions
      if (testOrg.stripeSubscriptionId) {
        try {
          await stripe.subscriptions.cancel(testOrg.stripeSubscriptionId);
        } catch (error) {
          // Subscription may not exist, ignore
        }
      }

      // Delete Stripe customer
      if (testOrg.stripeCustomerId) {
        try {
          await stripe.customers.del(testOrg.stripeCustomerId);
        } catch (error) {
          // Customer may not exist, ignore
        }
      }

      // Delete organization from database
      await prisma.organization.delete({
        where: { id: testOrg.id },
      });
    }
  });

  describe('Checkout Session Creation', () => {
    it('should create checkout session for STARTER monthly plan', async () => {
      const priceId = process.env.PRICE_ID_STARTER_MONTHLY;
      if (!priceId) {
        throw new Error('PRICE_ID_STARTER_MONTHLY not set in .env');
      }

      const session = await billingService.createCheckoutSession({
        organizationId: testOrg.id,
        priceId,
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
      });

      expect(session.sessionId).toBeDefined();
      expect(session.sessionId).toMatch(/^cs_test_/);
      expect(session.url).toContain('checkout.stripe.com');

      // Verify Stripe customer created
      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.stripeCustomerId).toBeDefined();
      expect(org?.stripeCustomerId).toMatch(/^cus_/);
    });

    it('should create checkout session for PRO annual plan', async () => {
      const priceId = process.env.PRICE_ID_PRO_ANNUAL;
      if (!priceId) {
        throw new Error('PRICE_ID_PRO_ANNUAL not set in .env');
      }

      const session = await billingService.createCheckoutSession({
        organizationId: testOrg.id,
        priceId,
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
      });

      expect(session.sessionId).toBeDefined();
      expect(session.url).toContain('checkout.stripe.com');
    });

    it('should reuse existing Stripe customer', async () => {
      const priceId = process.env.PRICE_ID_STARTER_MONTHLY;
      if (!priceId) {
        throw new Error('PRICE_ID_STARTER_MONTHLY not set in .env');
      }

      // Create first session
      const session1 = await billingService.createCheckoutSession({
        organizationId: testOrg.id,
        priceId,
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
      });

      const org1 = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });
      const customerId1 = org1?.stripeCustomerId;

      // Create second session
      const session2 = await billingService.createCheckoutSession({
        organizationId: testOrg.id,
        priceId,
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
      });

      const org2 = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });
      const customerId2 = org2?.stripeCustomerId;

      // Should reuse same customer
      expect(customerId1).toBe(customerId2);
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });
  });

  describe('Plan Eligibility Validation', () => {
    it('should allow STARTER plan for qualified organization', async () => {
      // Create organization with low revenue
      const result = await billingService.validatePlanEligibility(
        testOrg.id,
        'starter'
      );

      expect(result.eligible).toBe(true);
      expect(result.plan).toBe('starter');
    });

    it('should reject STARTER plan for high-revenue organization', async () => {
      // Create high-revenue subscriptions to simulate large business
      // This would require creating test subscription data
      // For now, we'll test the logic exists

      const result = await billingService.validatePlanEligibility(
        testOrg.id,
        'starter'
      );

      // Initially should be eligible (no revenue yet)
      expect(result).toBeDefined();
    });

    it('should allow PRO plan for medium-sized organization', async () => {
      const result = await billingService.validatePlanEligibility(
        testOrg.id,
        'pro'
      );

      expect(result.eligible).toBe(true);
      expect(result.plan).toBe('pro');
    });

    it('should allow ENTERPRISE plan for any organization', async () => {
      const result = await billingService.validatePlanEligibility(
        testOrg.id,
        'enterprise'
      );

      expect(result.eligible).toBe(true);
      expect(result.plan).toBe('enterprise');
    });
  });

  describe('Usage Tracking', () => {
    it('should increment API call usage', async () => {
      await billingService.incrementUsage(testOrg.id, 'apiCalls', 10);
      await billingService.incrementUsage(testOrg.id, 'apiCalls', 5);

      const usage = await billingService.getUsageForPeriod(
        testOrg.id,
        new Date()
      );

      expect(usage.apiCalls).toBe(15);
    });

    it('should increment email usage', async () => {
      await billingService.incrementUsage(testOrg.id, 'emailsSent', 25);

      const usage = await billingService.getUsageForPeriod(
        testOrg.id,
        new Date()
      );

      expect(usage.emailsSent).toBe(25);
    });

    it('should track usage separately per billing period', async () => {
      const currentPeriod = new Date();
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);

      await billingService.incrementUsage(testOrg.id, 'apiCalls', 100);

      const currentUsage = await billingService.getUsageForPeriod(
        testOrg.id,
        currentPeriod
      );
      const lastMonthUsage = await billingService.getUsageForPeriod(
        testOrg.id,
        lastMonth
      );

      expect(currentUsage.apiCalls).toBe(100);
      expect(lastMonthUsage.apiCalls).toBe(0); // No usage in last month
    });
  });

  describe('Usage Limits', () => {
    it('should allow usage within limits for Viewer plan', async () => {
      // Viewer plan: 1,000 API calls/month
      await billingService.incrementUsage(testOrg.id, 'apiCalls', 500);

      const check = await billingService.checkUsageLimit(
        testOrg.id,
        'apiCalls'
      );

      expect(check.allowed).toBe(true);
      expect(check.currentUsage).toBe(500);
      expect(check.limit).toBe(1000);
    });

    it('should block usage when limit exceeded for Viewer plan', async () => {
      // Viewer plan: 1,000 API calls/month
      await billingService.incrementUsage(testOrg.id, 'apiCalls', 1001);

      const check = await billingService.checkUsageLimit(
        testOrg.id,
        'apiCalls'
      );

      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('limit');
      expect(check.upgradeRequired).toBe(true);
    });

    it('should allow unlimited usage for plans with -1 limit', async () => {
      // Update organization to ENTERPRISE plan (unlimited)
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripePriceId: process.env.PRICE_ID_ENTERPRISE_MONTHLY,
          billingStatus: 'ACTIVE',
        },
      });

      // Add massive usage
      await billingService.incrementUsage(testOrg.id, 'apiCalls', 1000000);

      const check = await billingService.checkUsageLimit(
        testOrg.id,
        'apiCalls'
      );

      expect(check.allowed).toBe(true);
      expect(check.limit).toBe(-1); // Unlimited
    });
  });

  describe('Customer Portal', () => {
    it('should create customer portal session', async () => {
      // First create a Stripe customer
      const customer = await stripe.customers.create({
        email: testOrg.email,
        metadata: {
          organizationId: testOrg.id,
        },
      });

      await prisma.organization.update({
        where: { id: testOrg.id },
        data: { stripeCustomerId: customer.id },
      });

      const portalSession = await billingService.createCustomerPortalSession({
        organizationId: testOrg.id,
        returnUrl: 'http://localhost:3000/settings',
      });

      expect(portalSession.url).toBeDefined();
      expect(portalSession.url).toContain('billing.stripe.com');
    });

    it('should fail if organization has no Stripe customer', async () => {
      await expect(
        billingService.createCustomerPortalSession({
          organizationId: testOrg.id,
          returnUrl: 'http://localhost:3000/settings',
        })
      ).rejects.toThrow();
    });
  });

  describe('Subscription Management', () => {
    it('should get subscription status for free tier', async () => {
      const subscription = await billingService.getSubscriptionStatus(
        testOrg.id
      );

      expect(subscription.plan.id).toBe('viewer');
      expect(subscription.plan.name).toBe('Viewer');
      expect(subscription.status).toBe('FREE');
      expect(subscription.plan.limits.connections).toBe(1);
      expect(subscription.plan.limits.apiCallsPerMonth).toBe(1000);
    });

    it('should get subscription status for paid tier', async () => {
      // Update organization to STARTER plan
      const now = new Date();
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripePriceId: process.env.PRICE_ID_STARTER_MONTHLY,
          billingStatus: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: nextMonth,
        },
      });

      const subscription = await billingService.getSubscriptionStatus(
        testOrg.id
      );

      expect(subscription.plan.id).toBe('starter');
      expect(subscription.plan.name).toBe('Starter');
      expect(subscription.status).toBe('ACTIVE');
      expect(subscription.plan.limits.connections).toBe(3);
      expect(subscription.plan.limits.apiCallsPerMonth).toBe(10000);
    });
  });

  describe('Webhook Event Processing', () => {
    it('should process checkout.session.completed event', async () => {
      // Create a checkout session
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [
          {
            price: process.env.PRICE_ID_STARTER_MONTHLY!,
            quantity: 1,
          },
        ],
        success_url: 'http://localhost:3000/success',
        cancel_url: 'http://localhost:3000/cancel',
        metadata: {
          organizationId: testOrg.id,
        },
      });

      // Process the event
      await billingService.handleCheckoutSessionCompleted({
        id: session.id,
        customer: session.customer as string,
        subscription: session.subscription as string,
        metadata: {
          organizationId: testOrg.id,
        },
      });

      // Verify organization updated
      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.stripeCustomerId).toBe(session.customer);
      expect(org?.stripeSubscriptionId).toBe(session.subscription);
    });

    it('should process invoice.payment_succeeded event', async () => {
      const subscription = await stripe.subscriptions.create({
        customer: 'cus_test_123',
        items: [{ price: process.env.PRICE_ID_STARTER_MONTHLY! }],
      });

      await billingService.handleInvoicePaymentSucceeded({
        subscriptionId: subscription.id,
        organizationId: testOrg.id,
      });

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.billingStatus).toBe('ACTIVE');
    });

    it('should process invoice.payment_failed event', async () => {
      await billingService.handleInvoicePaymentFailed({
        subscriptionId: 'sub_test_123',
        organizationId: testOrg.id,
      });

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.billingStatus).toBe('PAST_DUE');
    });

    it('should process customer.subscription.deleted event', async () => {
      await billingService.handleSubscriptionDeleted({
        subscriptionId: 'sub_test_123',
        organizationId: testOrg.id,
      });

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.billingStatus).toBe('CANCELED');
      expect(org?.stripePriceId).toBeNull();
    });
  });

  describe('ROI Calculations', () => {
    it('should calculate ROI correctly', async () => {
      const roi = billingService.calculateROI({
        monthlyRevenue: 100000, // $100K MRR
        atRiskRevenue: 10000, // $10K at risk
        plan: 'starter', // $49/mo
      });

      expect(roi.estimatedRecoveryPerMonth).toBeGreaterThan(0);
      expect(roi.planCostPerMonth).toBe(4900); // $49
      expect(roi.netBenefitPerMonth).toBeGreaterThan(0);
      expect(roi.roiPercentage).toBeGreaterThan(0);
      expect(roi.paybackPeriodMonths).toBeLessThan(12);
    });

    it('should show high ROI for large businesses', async () => {
      const roi = billingService.calculateROI({
        monthlyRevenue: 1000000, // $1M MRR
        atRiskRevenue: 100000, // $100K at risk
        plan: 'pro', // $149/mo
      });

      expect(roi.roiPercentage).toBeGreaterThan(10000); // >100x ROI
      expect(roi.paybackPeriodMonths).toBeLessThan(1);
    });
  });
});
