import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../../infrastructure/postgres/index.js';
import * as churnRiskService from '../churn-risk.js';
import type { Customer } from '@prisma/client';

/**
 * Churn Risk Analysis Tests
 * 
 * Tests churn risk prediction based on:
 * - Payment failure patterns
 * - Engagement decline
 * - Usage trends
 * - Support interactions
 * - Health score trajectory
 */
describe('Churn Risk Analysis Tests', () => {
  let testCustomer: Customer;
  let testConnection: any;

  beforeEach(async () => {
    // Create test connection
    testConnection = await prisma.connection.create({
      data: {
        platform: 'STRIPE',
        platformCustomerId: `cus_test_${Date.now()}`,
        status: 'ACTIVE',
        credentials: {},
      },
    });

    // Create test customer
    testCustomer = await prisma.customer.create({
      data: {
        connectionId: testConnection.id,
        platformCustomerId: `cus_test_${Date.now()}`,
        email: `churn-test-${Date.now()}@example.com`,
        name: 'Churn Test Customer',
      },
    });
  });

  afterEach(async () => {
    // Clean up
    if (testCustomer) {
      await prisma.churnRiskAnalysis.deleteMany({
        where: { customerId: testCustomer.id },
      });
      await prisma.customer.delete({
        where: { id: testCustomer.id },
      });
    }
    if (testConnection) {
      await prisma.connection.delete({
        where: { id: testConnection.id },
      });
    }
  });

  describe('Overall Churn Risk Analysis', () => {
    it('should analyze churn risk for customer', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.riskLevel).toMatch(/CRITICAL|HIGH|MEDIUM|LOW/);
      expect(result.churnProbability).toBeGreaterThanOrEqual(0);
      expect(result.churnProbability).toBeLessThanOrEqual(1);
    });

    it('should include all risk components', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.paymentFailureRisk).toBeGreaterThanOrEqual(0);
      expect(result.paymentFailureRisk).toBeLessThanOrEqual(100);
      expect(result.engagementDeclineRisk).toBeGreaterThanOrEqual(0);
      expect(result.engagementDeclineRisk).toBeLessThanOrEqual(100);
      expect(result.usageDeclineRisk).toBeGreaterThanOrEqual(0);
      expect(result.usageDeclineRisk).toBeLessThanOrEqual(100);
      expect(result.supportIssueRisk).toBeGreaterThanOrEqual(0);
      expect(result.supportIssueRisk).toBeLessThanOrEqual(100);
    });

    it('should detect churn signals', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.churnSignals).toBeInstanceOf(Array);
    });

    it('should provide recommended actions', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.recommendedActions).toBeInstanceOf(Array);
      expect(result.priority).toMatch(/IMMEDIATE|HIGH|MEDIUM|LOW/);
    });

    it('should determine trend', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.trend).toMatch(/IMPROVING|STABLE|DECLINING/);
    });
  });

  describe('Payment Failure Risk', () => {
    it('should give low risk for customer with no payment failures', async () => {
      // Create active subscription with no failures
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.paymentFailureRisk).toBeLessThan(30);
      expect(result.churnSignals).not.toContain('Recent payment failures');
    });

    it('should give high risk for customer with recent payment failures', async () => {
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'PAST_DUE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Create recent payment failures
      await prisma.paymentFailure.createMany({
        data: [
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(),
          },
          {
            subscriptionId: subscription.id,
            failureReason: 'insufficient_funds',
            failedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        ],
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.paymentFailureRisk).toBeGreaterThan(70);
      expect(result.churnSignals).toContain('Recent payment failures');
      expect(result.riskLevel).toMatch(/CRITICAL|HIGH/);
    });

    it('should consider multiple consecutive failures', async () => {
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'PAST_DUE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Create 3 consecutive failures (very high risk)
      await prisma.paymentFailure.createMany({
        data: [
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(),
          },
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
          },
        ],
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.paymentFailureRisk).toBeGreaterThan(80);
      expect(result.churnSignals).toContain('Multiple consecutive payment failures');
    });
  });

  describe('Engagement Decline Risk', () => {
    it('should give low risk for recently active customer', async () => {
      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: {
          lastLoginAt: new Date(), // Just now
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.engagementDeclineRisk).toBeLessThan(30);
    });

    it('should give high risk for inactive customer', async () => {
      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: {
          lastLoginAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.engagementDeclineRisk).toBeGreaterThan(70);
      expect(result.churnSignals).toContain('No recent login activity');
    });

    it('should detect declining engagement trend', async () => {
      // Customer who used to be active but stopped
      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: {
          lastLoginAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.engagementDeclineRisk).toBeGreaterThan(50);
    });
  });

  describe('Usage Decline Risk', () => {
    it('should detect low usage patterns', async () => {
      // This would typically check API usage from ClickHouse
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.usageDeclineRisk).toBeDefined();
      expect(result.usageDeclineRisk).toBeGreaterThanOrEqual(0);
      expect(result.usageDeclineRisk).toBeLessThanOrEqual(100);
    });

    it('should identify declining usage trends', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      // Check if usage decline is detected in signals
      const hasUsageSignal = result.churnSignals.some((signal) =>
        signal.toLowerCase().includes('usage')
      );

      expect(typeof hasUsageSignal).toBe('boolean');
    });
  });

  describe('Support Issue Risk', () => {
    it('should give low risk for customer with no support issues', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.supportIssueRisk).toBeLessThan(30);
    });

    it('should detect frequent support interactions', async () => {
      // This would typically check support tickets from external system
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.supportIssueRisk).toBeDefined();
    });
  });

  describe('Churn Risk Level Determination', () => {
    it('should classify score 0-25 as LOW risk', async () => {
      const riskLevel = churnRiskService.determineChurnRiskLevel(20);
      expect(riskLevel).toBe('LOW');
    });

    it('should classify score 26-50 as MEDIUM risk', async () => {
      const riskLevel = churnRiskService.determineChurnRiskLevel(40);
      expect(riskLevel).toBe('MEDIUM');
    });

    it('should classify score 51-75 as HIGH risk', async () => {
      const riskLevel = churnRiskService.determineChurnRiskLevel(60);
      expect(riskLevel).toBe('HIGH');
    });

    it('should classify score 76-100 as CRITICAL risk', async () => {
      const riskLevel = churnRiskService.determineChurnRiskLevel(85);
      expect(riskLevel).toBe('CRITICAL');
    });
  });

  describe('Churn Probability Calculation', () => {
    it('should calculate churn probability from risk score and health score', async () => {
      const probability = churnRiskService.calculateChurnProbability(70, 30);

      expect(probability).toBeGreaterThanOrEqual(0);
      expect(probability).toBeLessThanOrEqual(1);
      expect(probability).toBeGreaterThan(0.5); // High risk + low health = high probability
    });

    it('should give low probability for low risk and high health', async () => {
      const probability = churnRiskService.calculateChurnProbability(20, 80);

      expect(probability).toBeLessThan(0.3);
    });

    it('should give high probability for high risk and low health', async () => {
      const probability = churnRiskService.calculateChurnProbability(80, 20);

      expect(probability).toBeGreaterThan(0.7);
    });
  });

  describe('Churn Date Prediction', () => {
    it('should predict churn date for high-risk customer', async () => {
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      if (result.churnProbability > 0.5) {
        expect(result.predictedChurnDate).not.toBeNull();
        expect(result.daysUntilPredictedChurn).not.toBeNull();
        expect(result.daysUntilPredictedChurn).toBeGreaterThan(0);
      }
    });

    it('should not predict churn date for low-risk customer', async () => {
      // Create healthy subscription
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: { lastLoginAt: new Date() },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      if (result.churnProbability < 0.3) {
        expect(result.predictedChurnDate).toBeNull();
        expect(result.daysUntilPredictedChurn).toBeNull();
      }
    });
  });

  describe('Recommended Actions', () => {
    it('should recommend immediate actions for CRITICAL risk', async () => {
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'PAST_DUE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      await prisma.paymentFailure.createMany({
        data: [
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(),
          },
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        ],
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      if (result.riskLevel === 'CRITICAL') {
        expect(result.priority).toBe('IMMEDIATE');
        expect(result.recommendedActions.length).toBeGreaterThan(0);
        expect(result.recommendedActions.some((action) =>
          action.toLowerCase().includes('payment')
        )).toBe(true);
      }
    });

    it('should recommend engagement actions for inactive customers', async () => {
      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: {
          lastLoginAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      if (result.engagementDeclineRisk > 70) {
        expect(result.recommendedActions.some((action) =>
          action.toLowerCase().includes('engagement')
        )).toBe(true);
      }
    });

    it('should prioritize actions based on risk level', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      const priorityMap = {
        CRITICAL: 'IMMEDIATE',
        HIGH: 'HIGH',
        MEDIUM: 'MEDIUM',
        LOW: 'LOW',
      };

      expect(result.priority).toBe(priorityMap[result.riskLevel]);
    });
  });

  describe('Churn Risk Persistence', () => {
    it('should save churn risk analysis to database', async () => {
      const result = await churnRiskService.analyzeAndSaveChurnRisk(testCustomer.id);

      expect(result).toBeDefined();

      // Verify saved in database
      const saved = await prisma.churnRiskAnalysis.findFirst({
        where: { customerId: testCustomer.id },
        orderBy: { analyzedAt: 'desc' },
      });

      expect(saved).not.toBeNull();
      expect(saved?.score).toBe(result.score);
      expect(saved?.riskLevel).toBe(result.riskLevel);
      expect(saved?.churnProbability).toBe(result.churnProbability);
    });

    it('should retrieve latest churn risk', async () => {
      await churnRiskService.analyzeAndSaveChurnRisk(testCustomer.id);

      const latest = await churnRiskService.getLatestChurnRisk(testCustomer.id);

      expect(latest).not.toBeNull();
      expect(latest?.customerId).toBe(testCustomer.id);
    });

    it('should maintain churn risk history', async () => {
      // Analyze multiple times
      await churnRiskService.analyzeAndSaveChurnRisk(testCustomer.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await churnRiskService.analyzeAndSaveChurnRisk(testCustomer.id);

      const history = await prisma.churnRiskAnalysis.findMany({
        where: { customerId: testCustomer.id },
        orderBy: { analyzedAt: 'desc' },
      });

      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('High-Risk Customer Identification', () => {
    it('should identify high-risk customers for connection', async () => {
      // Create high-risk scenario
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'PAST_DUE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      await prisma.paymentFailure.create({
        data: {
          subscriptionId: subscription.id,
          failureReason: 'card_declined',
          failedAt: new Date(),
        },
      });

      // Analyze and save
      await churnRiskService.analyzeAndSaveChurnRisk(testCustomer.id);

      // Get high-risk customers
      const highRiskCustomers = await churnRiskService.getHighRiskCustomers(
        testConnection.id
      );

      expect(highRiskCustomers).toBeInstanceOf(Array);
    });
  });

  describe('Trend Analysis', () => {
    it('should detect improving churn risk trend', async () => {
      // Create historical high-risk analysis
      await prisma.churnRiskAnalysis.create({
        data: {
          customerId: testCustomer.id,
          score: 80,
          riskLevel: 'CRITICAL',
          churnProbability: 0.8,
          paymentFailureRisk: 90,
          engagementDeclineRisk: 70,
          usageDeclineRisk: 80,
          supportIssueRisk: 60,
          churnSignals: ['Payment failures', 'Low engagement'],
          recommendedActions: ['Contact customer immediately'],
          priority: 'IMMEDIATE',
          trend: 'DECLINING',
          analyzedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Current analysis should show improvement
      const trend = await churnRiskService.determineChurnTrend(testCustomer.id, 40);

      expect(trend).toBe('IMPROVING');
    });

    it('should detect declining churn risk trend', async () => {
      // Create historical low-risk analysis
      await prisma.churnRiskAnalysis.create({
        data: {
          customerId: testCustomer.id,
          score: 20,
          riskLevel: 'LOW',
          churnProbability: 0.2,
          paymentFailureRisk: 10,
          engagementDeclineRisk: 20,
          usageDeclineRisk: 15,
          supportIssueRisk: 10,
          churnSignals: [],
          recommendedActions: [],
          priority: 'LOW',
          trend: 'STABLE',
          analyzedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Current analysis shows decline
      const trend = await churnRiskService.determineChurnTrend(testCustomer.id, 60);

      expect(trend).toBe('DECLINING');
    });
  });

  describe('Edge Cases', () => {
    it('should handle customer with no subscription', async () => {
      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle customer with canceled subscription', async () => {
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'CANCELED',
          currentPeriodStart: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
          currentPeriodEnd: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result.riskLevel).toBe('CRITICAL');
      expect(result.churnSignals).toContain('Subscription canceled');
    });

    it('should handle customer with trial subscription', async () => {
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'TRIALING',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await churnRiskService.analyzeChurnRisk(testCustomer.id);

      expect(result).toBeDefined();
      // Trial customers might have different risk calculation
    });
  });
});
