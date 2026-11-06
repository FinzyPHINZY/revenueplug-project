/**
 * Dynamic Discount Pricing Service
 *
 * Calculate optimal discount percentages based on:
 * - Customer churn probability
 * - Customer lifetime value (LTV)
 * - Historical conversion data
 * - Discount effectiveness patterns
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { z } from 'zod';

const log = logger.child({ module: 'dynamic-pricing' });

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

/**
 * Discount recommendation
 */
export interface DiscountRecommendation {
  customerId: string;
  recommendedDiscountPercent: number;
  minDiscountPercent: number;
  maxDiscountPercent: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: {
    churnRiskFactor: number; // 0-1
    ltvFactor: number; // 0-1
    historicalFactor: number; // 0-1
    baseDiscount: number;
    adjustments: Array<{
      reason: string;
      impact: number;
    }>;
  };
  estimatedROI: number;
  breakEvenPoint: number; // Minimum months customer must stay
}

/**
 * Historical discount performance
 */
export interface DiscountPerformance {
  discountPercent: number;
  timesOffered: number;
  conversions: number;
  conversionRate: number;
  avgCustomerLTV: number;
  avgROI: number;
}

/**
 * Pricing strategy
 */
export type PricingStrategy = 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE';

const CalculateDiscountSchema = z.object({
  customerId: z.string().cuid(),
  strategy: z.enum(['AGGRESSIVE', 'BALANCED', 'CONSERVATIVE']).optional(),
  maxDiscount: z.number().min(0).max(100).optional(),
  minDiscount: z.number().min(0).max(100).optional(),
});

export type CalculateDiscountInput = z.infer<typeof CalculateDiscountSchema>;

// ============================================================================
// DISCOUNT CALCULATION
// ============================================================================

/**
 * Calculate optimal discount for a customer
 */
export async function calculateOptimalDiscount(
  input: CalculateDiscountInput
): Promise<DiscountRecommendation> {
  const operationLog = log.child({
    operation: 'calculateOptimalDiscount',
    customerId: input.customerId,
  });

  try {
    const validated = CalculateDiscountSchema.parse(input);
    const strategy = validated.strategy || 'BALANCED';
    const maxDiscount = validated.maxDiscount || 50;
    const minDiscount = validated.minDiscount || 5;

    // Get customer data
    const customer = await prisma.customer.findUnique({
      where: { id: validated.customerId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          select: {
            amount: true,
            interval: true,
          },
        },
        churnRiskScores: {
          orderBy: { calculatedAt: 'desc' },
          take: 1,
        },
        campaigns: {
          where: {
            status: 'CONVERTED',
          },
          include: {
            actions: {
              where: {
                actionType: 'DISCOUNT',
              },
            },
          },
        },
      },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    // Calculate churn risk factor (0-1, higher = more risk)
    const churnRiskFactor = calculateChurnRiskFactor(customer.churnRiskScores[0]);

    // Calculate LTV factor (0-1, higher = more valuable)
    const ltvFactor = calculateLTVFactor(customer.subscriptions);

    // Calculate historical effectiveness factor (0-1, based on past conversions)
    const historicalFactor = await calculateHistoricalFactor(
      validated.customerId,
      customer.campaigns
    );

    // Calculate base discount based on strategy
    const baseDiscount = calculateBaseDiscount(
      churnRiskFactor,
      ltvFactor,
      strategy
    );

    // Apply adjustments
    const adjustments: Array<{ reason: string; impact: number }> = [];
    let recommendedDiscount = baseDiscount;

    // Adjust based on historical success
    if (historicalFactor > 0) {
      const historicalAdjust = (historicalFactor - 0.5) * 10;
      adjustments.push({
        reason: 'Historical conversion data',
        impact: historicalAdjust,
      });
      recommendedDiscount += historicalAdjust;
    }

    // Adjust based on subscription value
    const subscription = customer.subscriptions[0];
    if (subscription) {
      const amountNumber = typeof subscription.amount === 'number'
        ? subscription.amount
        : subscription.amount.toNumber();
      const monthlyValue =
        subscription.interval === 'year'
          ? amountNumber / 12
          : amountNumber;

      if (monthlyValue > 20000) {
        // > $200/month
        adjustments.push({
          reason: 'High-value subscription',
          impact: 5,
        });
        recommendedDiscount += 5;
      } else if (monthlyValue < 2000) {
        // < $20/month
        adjustments.push({
          reason: 'Low-value subscription',
          impact: -5,
        });
        recommendedDiscount -= 5;
      }
    }

    // Clamp to bounds
    recommendedDiscount = Math.max(minDiscount, Math.min(maxDiscount, recommendedDiscount));

    // Calculate confidence based on data availability
    const confidence = calculateConfidence(
      customer.churnRiskScores.length > 0,
      customer.subscriptions.length > 0,
      customer.campaigns.length > 0
    );

    // Calculate estimated ROI
    const estimatedROI = calculateEstimatedROI(
      recommendedDiscount,
      ltvFactor,
      churnRiskFactor,
      subscription
    );

    // Calculate break-even point (months customer must stay)
    const breakEvenPoint = calculateBreakEvenPoint(
      recommendedDiscount,
      subscription
    );

    const recommendation: DiscountRecommendation = {
      customerId: validated.customerId,
      recommendedDiscountPercent: Math.round(recommendedDiscount),
      minDiscountPercent: Math.round(minDiscount),
      maxDiscountPercent: Math.round(maxDiscount),
      confidence,
      reasoning: {
        churnRiskFactor,
        ltvFactor,
        historicalFactor,
        baseDiscount,
        adjustments,
      },
      estimatedROI,
      breakEvenPoint,
    };

    operationLog.info(
      {
        recommendedDiscount: recommendation.recommendedDiscountPercent,
        confidence: recommendation.confidence,
      },
      'Discount calculated'
    );

    return recommendation;
  } catch (error) {
    operationLog.error({ error }, 'Failed to calculate optimal discount');
    throw error;
  }
}

/**
 * Get discount performance history
 */
export async function getDiscountPerformance(
  organizationId: string,
  options: {
    strategyId?: string;
    minSampleSize?: number;
  } = {}
): Promise<DiscountPerformance[]> {
  const operationLog = log.child({
    operation: 'getDiscountPerformance',
    organizationId,
  });

  try {
    const minSampleSize = options.minSampleSize || 5;

    // Get all discount actions
    const discountActions = await prisma.campaignAction.findMany({
      where: {
        campaign: {
          organizationId,
          ...(options.strategyId && { strategyId: options.strategyId }),
        },
        actionType: 'DISCOUNT',
      },
      include: {
        campaign: {
          select: {
            status: true,
            customer: {
              select: {
                subscriptions: {
                  select: {
                    amount: true,
                    interval: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Group by discount percent
    const discountGroups = new Map<number, Array<typeof discountActions[0]>>();

    for (const action of discountActions) {
      const discountPercent = (action.actionData as any).discountPercent || 0;
      const bucket = Math.round(discountPercent / 5) * 5; // Round to nearest 5%

      if (!discountGroups.has(bucket)) {
        discountGroups.set(bucket, []);
      }
      discountGroups.get(bucket)!.push(action);
    }

    // Calculate performance for each group
    const performance: DiscountPerformance[] = [];

    for (const [discountPercent, actions] of discountGroups.entries()) {
      if (actions.length < minSampleSize) continue;

      const conversions = actions.filter(
        (a) => a.campaign.status === 'CONVERTED'
      ).length;

      const conversionRate = conversions / actions.length;

      // Calculate average LTV
      let totalLTV = 0;
      let ltvCount = 0;

      for (const action of actions) {
        const subscription = action.campaign.customer.subscriptions[0];
        if (subscription) {
          const amountNumber = typeof subscription.amount === 'number'
            ? subscription.amount
            : subscription.amount.toNumber();
          const monthlyValue =
            subscription.interval === 'year'
              ? amountNumber / 12
              : amountNumber;
          totalLTV += monthlyValue * 12; // Assume 12-month LTV
          ltvCount++;
        }
      }

      const avgCustomerLTV = ltvCount > 0 ? totalLTV / ltvCount : 0;

      // Calculate average ROI
      const discountCost = (avgCustomerLTV * discountPercent) / 100;
      const avgROI =
        discountCost > 0
          ? ((avgCustomerLTV - discountCost) / discountCost) * 100
          : 0;

      performance.push({
        discountPercent,
        timesOffered: actions.length,
        conversions,
        conversionRate,
        avgCustomerLTV,
        avgROI,
      });
    }

    // Sort by discount percent
    performance.sort((a, b) => a.discountPercent - b.discountPercent);

    operationLog.info(
      { performanceGroups: performance.length },
      'Discount performance analyzed'
    );

    return performance;
  } catch (error) {
    operationLog.error({ error }, 'Failed to get discount performance');
    throw error;
  }
}

/**
 * Get customer discount history
 */
export async function getCustomerDiscountHistory(customerId: string): Promise<{
  discountsReceived: number;
  avgDiscountPercent: number;
  totalDiscountValue: number;
  conversionRate: number;
  lastDiscountDate: Date | null;
}> {
  const operationLog = log.child({
    operation: 'getCustomerDiscountHistory',
    customerId,
  });

  try {
    const discountActions = await prisma.campaignAction.findMany({
      where: {
        campaign: {
          customerId,
        },
        actionType: 'DISCOUNT',
      },
      include: {
        campaign: {
          select: {
            status: true,
            customer: {
              select: {
                subscriptions: {
                  select: {
                    amount: true,
                    interval: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (discountActions.length === 0) {
      return {
        discountsReceived: 0,
        avgDiscountPercent: 0,
        totalDiscountValue: 0,
        conversionRate: 0,
        lastDiscountDate: null,
      };
    }

    const totalDiscountPercent = discountActions.reduce(
      (sum, action) => sum + ((action.actionData as any).discountPercent || 0),
      0
    );

    const conversions = discountActions.filter(
      (a) => a.campaign.status === 'CONVERTED'
    ).length;

    // Calculate total discount value
    let totalDiscountValue = 0;
    for (const action of discountActions) {
      const subscription = action.campaign.customer.subscriptions[0];
      if (subscription) {
        const discountPercent = (action.actionData as any).discountPercent || 0;
        const durationMonths = (action.actionData as any).durationMonths || 1;
        const amountNumber = typeof subscription.amount === 'number'
          ? subscription.amount
          : subscription.amount.toNumber();
        const monthlyValue =
          subscription.interval === 'year'
            ? amountNumber / 12
            : amountNumber;

        totalDiscountValue +=
          (monthlyValue * discountPercent * durationMonths) / 100;
      }
    }

    operationLog.info({ discountsReceived: discountActions.length }, 'History retrieved');

    return {
      discountsReceived: discountActions.length,
      avgDiscountPercent: totalDiscountPercent / discountActions.length,
      totalDiscountValue,
      conversionRate: conversions / discountActions.length,
      lastDiscountDate: discountActions[0]?.createdAt || null,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to get customer discount history');
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate churn risk factor (0-1)
 */
function calculateChurnRiskFactor(churnRiskScore: any): number {
  if (!churnRiskScore) return 0.5; // Default medium risk

  const riskLevelMap: Record<string, number> = {
    MINIMAL: 0.1,
    LOW: 0.3,
    MEDIUM: 0.5,
    HIGH: 0.7,
    CRITICAL: 0.9,
  };

  return riskLevelMap[churnRiskScore.riskLevel] || 0.5;
}

/**
 * Calculate LTV factor (0-1)
 */
function calculateLTVFactor(subscriptions: any[]): number {
  if (subscriptions.length === 0) return 0.5;

  const subscription = subscriptions[0];
  const amountNumber = typeof subscription.amount === 'number'
    ? subscription.amount
    : subscription.amount.toNumber();
  const monthlyValue =
    subscription.interval === 'year'
      ? amountNumber / 12
      : amountNumber;

  // LTV = MRR * 12 months (simplified)
  const ltv = monthlyValue * 12;

  // Normalize to 0-1 (assuming max LTV of $50,000)
  return Math.min(ltv / 50000, 1);
}

/**
 * Calculate historical effectiveness factor (0-1)
 */
async function calculateHistoricalFactor(
  _customerId: string,
  campaigns: any[]
): Promise<number> {
  const discountCampaigns = campaigns.filter((c) =>
    c.actions.some((a: any) => a.actionType === 'DISCOUNT')
  );

  if (discountCampaigns.length === 0) {
    // No history - use organization average
    return 0.5;
  }

  // Calculate conversion rate from discount campaigns
  const conversions = discountCampaigns.filter((c) => c.status === 'CONVERTED').length;
  return conversions / discountCampaigns.length;
}

/**
 * Calculate base discount percentage
 */
function calculateBaseDiscount(
  churnRiskFactor: number,
  ltvFactor: number,
  strategy: PricingStrategy
): number {
  // Base discount tiers by churn risk
  const riskBasedDiscount = churnRiskFactor * 30; // 0-30%

  // Adjust based on LTV (willing to discount more for high-value customers)
  const ltvAdjustment = ltvFactor * 10; // 0-10%

  let baseDiscount = riskBasedDiscount + ltvAdjustment;

  // Apply strategy multiplier
  const strategyMultipliers: Record<PricingStrategy, number> = {
    AGGRESSIVE: 1.2, // 20% higher discounts
    BALANCED: 1.0, // Standard
    CONSERVATIVE: 0.8, // 20% lower discounts
  };

  baseDiscount *= strategyMultipliers[strategy];

  return baseDiscount;
}

/**
 * Calculate confidence level
 */
function calculateConfidence(
  hasChurnData: boolean,
  hasSubscriptionData: boolean,
  hasHistoricalData: boolean
): 'HIGH' | 'MEDIUM' | 'LOW' {
  const dataPoints = [hasChurnData, hasSubscriptionData, hasHistoricalData].filter(
    Boolean
  ).length;

  if (dataPoints === 3) return 'HIGH';
  if (dataPoints === 2) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate estimated ROI
 */
function calculateEstimatedROI(
  discountPercent: number,
  _ltvFactor: number,
  churnRiskFactor: number,
  subscription: any
): number {
  if (!subscription) return 0;

  const amountNumber = typeof subscription.amount === 'number'
    ? subscription.amount
    : subscription.amount.toNumber();
  const monthlyValue =
    subscription.interval === 'year'
      ? amountNumber / 12
      : amountNumber;

  // Estimate customer will stay 12 months
  const estimatedLTV = monthlyValue * 12;

  // Discount cost
  const discountCost = (estimatedLTV * discountPercent) / 100;

  // Probability of conversion (higher churn risk = higher conversion probability with discount)
  const conversionProbability = 0.3 + churnRiskFactor * 0.4; // 30-70%

  // Expected value
  const expectedRevenue = estimatedLTV * conversionProbability;
  const expectedCost = discountCost * conversionProbability;

  // ROI
  return expectedCost > 0 ? ((expectedRevenue - expectedCost) / expectedCost) * 100 : 0;
}

/**
 * Calculate break-even point (months)
 */
function calculateBreakEvenPoint(
  discountPercent: number,
  subscription: any
): number {
  if (!subscription) return 0;

  const amountNumber = typeof subscription.amount === 'number'
    ? subscription.amount
    : subscription.amount.toNumber();
  const monthlyValue =
    subscription.interval === 'year'
      ? amountNumber / 12
      : amountNumber;

  // Monthly discount cost
  const monthlyDiscountCost = (monthlyValue * discountPercent) / 100;

  // Months to recover discount cost
  const monthsToBreakEven = Math.ceil((monthlyDiscountCost * 12) / monthlyValue);

  return monthsToBreakEven;
}
