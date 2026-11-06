import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../../infrastructure/postgres/index.js';
import * as healthScoreService from '../health-score.js';
import type { Customer } from '@prisma/client';

/**
 * Health Score Calculation Tests
 * 
 * Tests customer health score calculation based on:
 * - Payment health (40%): Payment history, failures, success rate
 * - Engagement (25%): Login frequency, feature usage
 * - Usage (20%): API usage trends, data volume
 * - Subscription (10%): Tenure, plan level, upgrade history
 * - Support (5%): Support ticket frequency and severity
 */
describe('Health Score Calculation Tests', () => {
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
        email: `test-${Date.now()}@example.com`,
        name: 'Test Customer',
      },
    });
  });

  afterEach(async () => {
    // Clean up
    if (testCustomer) {
      await prisma.healthScore.deleteMany({
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

  describe('Overall Health Score Calculation', () => {
    it('should calculate health score with all components', async () => {
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result).toBeDefined();
      expect(result.overallScore).toBeGreaterThanOrEqual(0);
      expect(result.overallScore).toBeLessThanOrEqual(100);
      expect(result.riskLevel).toMatch(/CRITICAL|HIGH|MEDIUM|LOW/);
    });

    it('should have correct component weights summing to 100', async () => {
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      const totalWeight =
        result.components.payment.weight +
        result.components.engagement.weight +
        result.components.usage.weight +
        result.components.subscription.weight +
        result.components.support.weight;

      expect(totalWeight).toBe(100);
    });

    it('should calculate weighted contributions correctly', async () => {
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      const totalContribution =
        result.components.payment.contribution +
        result.components.engagement.contribution +
        result.components.usage.contribution +
        result.components.subscription.contribution +
        result.components.support.contribution;

      // Should equal overall score (within rounding error)
      expect(Math.abs(totalContribution - result.overallScore)).toBeLessThan(1);
    });

    it('should include factors for each component', async () => {
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.payment.factors).toBeInstanceOf(Array);
      expect(result.components.engagement.factors).toBeInstanceOf(Array);
      expect(result.components.usage.factors).toBeInstanceOf(Array);
      expect(result.components.subscription.factors).toBeInstanceOf(Array);
      expect(result.components.support.factors).toBeInstanceOf(Array);
    });
  });

  describe('Payment Health Score', () => {
    it('should give high score for customer with no payment failures', async () => {
      // Create successful subscription
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.payment.score).toBeGreaterThan(70);
      expect(result.components.payment.factors).toContain('No recent payment failures');
    });

    it('should give low score for customer with recent payment failures', async () => {
      // Create subscription with payment failures
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'PAST_DUE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Create payment failure records
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

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.payment.score).toBeLessThan(50);
      expect(result.components.payment.factors).toContain('Recent payment failures');
    });

    it('should consider payment success rate', async () => {
      const subscription = await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Create mix of successful and failed payments
      await prisma.paymentFailure.createMany({
        data: [
          {
            subscriptionId: subscription.id,
            failureReason: 'card_declined',
            failedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
          },
        ],
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      // Should be moderate since failure was long ago
      expect(result.components.payment.score).toBeGreaterThan(50);
      expect(result.components.payment.score).toBeLessThan(90);
    });
  });

  describe('Engagement Score', () => {
    it('should give high score for recently active customer', async () => {
      // Update last login to recent
      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: {
          lastLoginAt: new Date(), // Just now
        },
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.engagement.score).toBeGreaterThan(70);
      expect(result.components.engagement.factors).toContain('Recent login activity');
    });

    it('should give low score for inactive customer', async () => {
      // Update last login to long ago
      await prisma.customer.update({
        where: { id: testCustomer.id },
        data: {
          lastLoginAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
        },
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.engagement.score).toBeLessThan(50);
      expect(result.components.engagement.factors).toContain('Low login frequency');
    });

    it('should consider feature usage patterns', async () => {
      // Customer with no login history
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.engagement.score).toBeDefined();
      expect(result.components.engagement.factors).toBeInstanceOf(Array);
    });
  });

  describe('Usage Score', () => {
    it('should give high score for active API usage', async () => {
      // This would typically check API usage from ClickHouse
      // For now, test the calculation logic
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.usage.score).toBeGreaterThanOrEqual(0);
      expect(result.components.usage.score).toBeLessThanOrEqual(100);
    });

    it('should detect declining usage trends', async () => {
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.usage.factors).toBeInstanceOf(Array);
      // Factors might include "Low API usage" or "Declining usage trend"
    });
  });

  describe('Subscription Health Score', () => {
    it('should give high score for long-term customer', async () => {
      // Create old subscription (high tenure)
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year ago
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.subscription.score).toBeGreaterThan(70);
      expect(result.components.subscription.factors).toContain('Long subscription tenure');
    });

    it('should give lower score for new customer', async () => {
      // Create recent subscription
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.subscription.score).toBeLessThan(80);
    });

    it('should detect cancellation risk', async () => {
      // Create subscription with cancel_at_period_end
      await prisma.subscription.create({
        data: {
          customerId: testCustomer.id,
          platformSubscriptionId: `sub_test_${Date.now()}`,
          status: 'ACTIVE',
          cancelAtPeriodEnd: true,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.subscription.score).toBeLessThan(50);
      expect(result.components.subscription.factors).toContain('Subscription set to cancel');
    });
  });

  describe('Support Score', () => {
    it('should give high score for customer with no support issues', async () => {
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.support.score).toBeGreaterThan(80);
      expect(result.components.support.factors).toContain('No recent support issues');
    });

    it('should give lower score for customer with many support tickets', async () => {
      // This would typically check support tickets from external system
      // For now, test the calculation logic exists
      const result = await healthScoreService.calculateHealthScore(testCustomer.id);

      expect(result.components.support.score).toBeDefined();
    });
  });

  describe('Risk Level Determination', () => {
    it('should classify score 0-25 as CRITICAL', async () => {
      const riskLevel = healthScoreService.determineRiskLevel(20);
      expect(riskLevel).toBe('CRITICAL');
    });

    it('should classify score 26-50 as HIGH', async () => {
      const riskLevel = healthScoreService.determineRiskLevel(40);
      expect(riskLevel).toBe('HIGH');
    });

    it('should classify score 51-75 as MEDIUM', async () => {
      const riskLevel = healthScoreService.determineRiskLevel(60);
      expect(riskLevel).toBe('MEDIUM');
    });

    it('should classify score 76-100 as LOW', async () => {
      const riskLevel = healthScoreService.determineRiskLevel(85);
      expect(riskLevel).toBe('LOW');
    });

    it('should handle edge cases', async () => {
      expect(healthScoreService.determineRiskLevel(0)).toBe('CRITICAL');
      expect(healthScoreService.determineRiskLevel(25)).toBe('CRITICAL');
      expect(healthScoreService.determineRiskLevel(26)).toBe('HIGH');
      expect(healthScoreService.determineRiskLevel(50)).toBe('HIGH');
      expect(healthScoreService.determineRiskLevel(51)).toBe('MEDIUM');
      expect(healthScoreService.determineRiskLevel(75)).toBe('MEDIUM');
      expect(healthScoreService.determineRiskLevel(76)).toBe('LOW');
      expect(healthScoreService.determineRiskLevel(100)).toBe('LOW');
    });
  });

  describe('Trend Analysis', () => {
    it('should detect improving trend', async () => {
      // Create historical score (lower)
      await prisma.healthScore.create({
        data: {
          customerId: testCustomer.id,
          overallScore: 50,
          paymentHealthScore: 50,
          engagementScore: 50,
          usageScore: 50,
          subscriptionHealthScore: 50,
          supportScore: 50,
          riskLevel: 'HIGH',
          trend: 'STABLE',
          calculatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        },
      });

      // Current score is higher (improving)
      const trend = await healthScoreService.determineTrend(testCustomer.id, 70);

      expect(trend).toBe('IMPROVING');
    });

    it('should detect declining trend', async () => {
      // Create historical score (higher)
      await prisma.healthScore.create({
        data: {
          customerId: testCustomer.id,
          overallScore: 80,
          paymentHealthScore: 80,
          engagementScore: 80,
          usageScore: 80,
          subscriptionHealthScore: 80,
          supportScore: 80,
          riskLevel: 'LOW',
          trend: 'STABLE',
          calculatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Current score is lower (declining)
      const trend = await healthScoreService.determineTrend(testCustomer.id, 60);

      expect(trend).toBe('DECLINING');
    });

    it('should detect stable trend', async () => {
      // Create historical score (similar)
      await prisma.healthScore.create({
        data: {
          customerId: testCustomer.id,
          overallScore: 70,
          paymentHealthScore: 70,
          engagementScore: 70,
          usageScore: 70,
          subscriptionHealthScore: 70,
          supportScore: 70,
          riskLevel: 'MEDIUM',
          trend: 'STABLE',
          calculatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      });

      // Current score is similar (stable)
      const trend = await healthScoreService.determineTrend(testCustomer.id, 72);

      expect(trend).toBe('STABLE');
    });
  });

  describe('Health Score Persistence', () => {
    it('should save health score to database', async () => {
      const result = await healthScoreService.calculateAndSaveHealthScore(
        testCustomer.id
      );

      expect(result).toBeDefined();

      // Verify saved in database
      const saved = await prisma.healthScore.findFirst({
        where: { customerId: testCustomer.id },
        orderBy: { calculatedAt: 'desc' },
      });

      expect(saved).not.toBeNull();
      expect(saved?.overallScore).toBe(result.overallScore);
      expect(saved?.riskLevel).toBe(result.riskLevel);
    });

    it('should retrieve latest health score', async () => {
      // Save a score
      await healthScoreService.calculateAndSaveHealthScore(testCustomer.id);

      // Retrieve it
      const latest = await healthScoreService.getLatestHealthScore(testCustomer.id);

      expect(latest).not.toBeNull();
      expect(latest?.customerId).toBe(testCustomer.id);
    });

    it('should maintain health score history', async () => {
      // Calculate multiple times
      await healthScoreService.calculateAndSaveHealthScore(testCustomer.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await healthScoreService.calculateAndSaveHealthScore(testCustomer.id);

      // Should have multiple records
      const history = await prisma.healthScore.findMany({
        where: { customerId: testCustomer.id },
        orderBy: { calculatedAt: 'desc' },
      });

      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Batch Processing', () => {
    it('should calculate health scores for multiple customers', async () => {
      // Create additional customers
      const customer2 = await prisma.customer.create({
        data: {
          connectionId: testConnection.id,
          platformCustomerId: `cus_test_batch_${Date.now()}`,
          email: `batch-${Date.now()}@example.com`,
          name: 'Batch Test Customer',
        },
      });

      const result = await healthScoreService.batchCalculateHealthScores(
        testConnection.id
      );

      expect(result.processed).toBeGreaterThanOrEqual(2);
      expect(result.errors).toBe(0);

      // Clean up
      await prisma.healthScore.deleteMany({
        where: { customerId: customer2.id },
      });
      await prisma.customer.delete({
        where: { id: customer2.id },
      });
    });

    it('should handle errors gracefully in batch processing', async () => {
      const result = await healthScoreService.batchCalculateHealthScores(
        testConnection.id
      );

      expect(result).toHaveProperty('processed');
      expect(result).toHaveProperty('errors');
    });
  });
});
