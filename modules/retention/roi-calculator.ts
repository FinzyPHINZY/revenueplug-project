/**
 * Retention ROI Calculator
 *
 * Calculate return on investment for retention campaigns
 * Tracks revenue recovered, costs, and net ROI across campaigns
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

const log = logger.child({ module: 'roi-calculator' });

/**
 * ROI calculation configuration
 */
export interface ROIConfig {
  emailCostCents?: number; // Cost per email sent (default: 10 cents)
  discountCostMultiplier?: number; // Multiplier for discount costs (default: 1.0)
  laborCostPerHourCents?: number; // Cost per hour for personal outreach (default: $50)
  averageOutreachMinutes?: number; // Average time per outreach task (default: 15 min)
}

/**
 * Campaign cost breakdown
 */
export interface CampaignCosts {
  emailCosts: number; // Cost of emails sent
  discountCosts: number; // Value of discounts offered
  outreachCosts: number; // Cost of personal outreach time
  totalCosts: number;
}

/**
 * Campaign revenue breakdown
 */
export interface CampaignRevenue {
  directRevenue: number; // Revenue directly recovered from conversions
  preventedChurnValue: number; // Value of prevented churn (customer LTV)
  totalRevenue: number;
}

/**
 * ROI metrics for a time period
 */
export interface ROIMetrics {
  period: {
    start: Date;
    end: Date;
  };
  campaigns: {
    total: number;
    converted: number;
    conversionRate: number;
  };
  costs: CampaignCosts;
  revenue: CampaignRevenue;
  roi: {
    percentage: number; // (revenue - costs) / costs * 100
    netRevenue: number; // revenue - costs
    paybackMultiple: number; // revenue / costs
  };
  customers: {
    reached: number;
    converted: number;
    churnPrevented: number;
  };
  breakdown: {
    byTriggerType: Record<string, { revenue: number; costs: number; roi: number }>;
    byStrategy: Record<string, { revenue: number; costs: number; roi: number }>;
  };
}

/**
 * Calculate ROI for retention campaigns
 */
export async function calculateROI(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  config: ROIConfig = {}
): Promise<ROIMetrics> {
  const operationLog = log.child({
    operation: 'calculateROI',
    organizationId,
    startDate,
    endDate,
  });

  try {
    // Set default costs
    const emailCostCents = config.emailCostCents || 10; // $0.10 per email
    const discountCostMultiplier = config.discountCostMultiplier || 1.0;
    const laborCostPerHourCents = config.laborCostPerHourCents || 5000; // $50/hour
    const averageOutreachMinutes = config.averageOutreachMinutes || 15;

    // Get all campaigns in period
    const campaigns = await prisma.campaign.findMany({
      where: {
        organizationId,
        startedAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        actions: true,
        strategy: {
          select: {
            id: true,
            name: true,
          },
        },
        customer: {
          select: {
            id: true,
            subscriptions: {
              where: {
                status: { in: ['ACTIVE', 'TRIALING'] },
              },
              select: {
                amount: true,
                interval: true,
              },
              take: 1,
            },
          },
        },
      },
    });

    const totalCampaigns = campaigns.length;
    const convertedCampaigns = campaigns.filter((c) => c.status === 'CONVERTED');
    const conversionRate = totalCampaigns > 0 ? (convertedCampaigns.length / totalCampaigns) * 100 : 0;

    // Calculate costs
    const costs = await calculateCampaignCosts(
      campaigns,
      emailCostCents,
      discountCostMultiplier,
      laborCostPerHourCents,
      averageOutreachMinutes
    );

    // Calculate revenue
    const revenue = await calculateCampaignRevenue(campaigns, organizationId);

    // Calculate ROI
    const netRevenue = revenue.totalRevenue - costs.totalCosts;
    const roiPercentage = costs.totalCosts > 0
      ? ((revenue.totalRevenue - costs.totalCosts) / costs.totalCosts) * 100
      : 0;
    const paybackMultiple = costs.totalCosts > 0 ? revenue.totalRevenue / costs.totalCosts : 0;

    // Calculate customer metrics
    const uniqueCustomers = new Set(campaigns.map((c) => c.customerId));
    const convertedCustomers = new Set(convertedCampaigns.map((c) => c.customerId));
    const churnPreventedCustomers = convertedCampaigns.filter(
      (c) => c.triggerType === 'CHURN_RISK_HIGH' || c.triggerType === 'CHURN_RISK_CRITICAL'
    );

    // Calculate breakdown by trigger type
    const byTriggerType: Record<string, { revenue: number; costs: number; roi: number }> = {};
    const triggerTypes = [...new Set(campaigns.map((c) => c.triggerType))];

    for (const triggerType of triggerTypes) {
      const typeCampaigns = campaigns.filter((c) => c.triggerType === triggerType);
      const typeCosts = await calculateCampaignCosts(
        typeCampaigns,
        emailCostCents,
        discountCostMultiplier,
        laborCostPerHourCents,
        averageOutreachMinutes
      );
      const typeRevenue = await calculateCampaignRevenue(typeCampaigns, organizationId);
      const typeROI = typeCosts.totalCosts > 0
        ? ((typeRevenue.totalRevenue - typeCosts.totalCosts) / typeCosts.totalCosts) * 100
        : 0;

      byTriggerType[triggerType] = {
        revenue: typeRevenue.totalRevenue,
        costs: typeCosts.totalCosts,
        roi: typeROI,
      };
    }

    // Calculate breakdown by strategy
    const byStrategy: Record<string, { revenue: number; costs: number; roi: number }> = {};
    const strategies = [...new Set(campaigns.map((c) => c.strategyId).filter(Boolean))];

    for (const strategyId of strategies as string[]) {
      const strategyCampaigns = campaigns.filter((c) => c.strategyId === strategyId);
      const strategyName = strategyCampaigns[0]?.strategy?.name || strategyId;
      const strategyCosts = await calculateCampaignCosts(
        strategyCampaigns,
        emailCostCents,
        discountCostMultiplier,
        laborCostPerHourCents,
        averageOutreachMinutes
      );
      const strategyRevenue = await calculateCampaignRevenue(strategyCampaigns, organizationId);
      const strategyROI = strategyCosts.totalCosts > 0
        ? ((strategyRevenue.totalRevenue - strategyCosts.totalCosts) / strategyCosts.totalCosts) * 100
        : 0;

      byStrategy[strategyName] = {
        revenue: strategyRevenue.totalRevenue,
        costs: strategyCosts.totalCosts,
        roi: strategyROI,
      };
    }

    const metrics: ROIMetrics = {
      period: {
        start: startDate,
        end: endDate,
      },
      campaigns: {
        total: totalCampaigns,
        converted: convertedCampaigns.length,
        conversionRate,
      },
      costs,
      revenue,
      roi: {
        percentage: roiPercentage,
        netRevenue,
        paybackMultiple,
      },
      customers: {
        reached: uniqueCustomers.size,
        converted: convertedCustomers.size,
        churnPrevented: churnPreventedCustomers.length,
      },
      breakdown: {
        byTriggerType,
        byStrategy,
      },
    };

    operationLog.info(
      {
        totalCampaigns,
        convertedCampaigns: convertedCampaigns.length,
        totalRevenue: revenue.totalRevenue,
        totalCosts: costs.totalCosts,
        roi: roiPercentage,
      },
      'ROI calculated'
    );

    return metrics;
  } catch (error) {
    operationLog.error({ error }, 'Failed to calculate ROI');
    throw error;
  }
}

/**
 * Calculate total costs for campaigns
 */
async function calculateCampaignCosts(
  campaigns: any[],
  emailCostCents: number,
  discountCostMultiplier: number,
  laborCostPerHourCents: number,
  averageOutreachMinutes: number
): Promise<CampaignCosts> {
  let emailCosts = 0;
  let discountCosts = 0;
  let outreachCosts = 0;

  for (const campaign of campaigns) {
    // Email costs
    const emailActions = campaign.actions.filter(
      (a: any) => a.actionType === 'EMAIL' && ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'].includes(a.status)
    );
    emailCosts += emailActions.length * emailCostCents;

    // Discount costs
    const discountActions = campaign.actions.filter(
      (a: any) => a.actionType === 'DISCOUNT' && a.status === 'COMPLETED'
    );
    for (const action of discountActions) {
      const actionData = action.actionData as any;
      if (actionData?.discountAmount) {
        discountCosts += actionData.discountAmount * discountCostMultiplier;
      }
    }

    // Outreach costs (labor)
    const outreachActions = campaign.actions.filter(
      (a: any) => a.actionType === 'PERSONAL_OUTREACH' && a.status === 'COMPLETED'
    );
    const outreachHours = (outreachActions.length * averageOutreachMinutes) / 60;
    outreachCosts += outreachHours * laborCostPerHourCents;
  }

  return {
    emailCosts,
    discountCosts,
    outreachCosts,
    totalCosts: emailCosts + discountCosts + outreachCosts,
  };
}

/**
 * Calculate total revenue from campaigns
 */
async function calculateCampaignRevenue(
  campaigns: any[],
  organizationId: string
): Promise<CampaignRevenue> {
  let directRevenue = 0;
  let preventedChurnValue = 0;

  for (const campaign of campaigns) {
    if (campaign.status === 'CONVERTED') {
      // Direct revenue recovered
      directRevenue += campaign.revenueRecovered || 0;

      // Prevented churn value (estimate customer LTV)
      if (
        campaign.triggerType === 'CHURN_RISK_HIGH' ||
        campaign.triggerType === 'CHURN_RISK_CRITICAL'
      ) {
        // Estimate LTV as 12x MRR (1 year)
        const subscription = campaign.customer.subscriptions[0];
        if (subscription) {
          const monthlyValue = Number(subscription.amount);
          const ltv = monthlyValue * 12; // 1 year LTV
          preventedChurnValue += ltv;
        }
      }
    }
  }

  return {
    directRevenue,
    preventedChurnValue,
    totalRevenue: directRevenue + preventedChurnValue,
  };
}

/**
 * Calculate ROI for a specific strategy
 */
export async function calculateStrategyROI(
  strategyId: string,
  startDate: Date,
  endDate: Date,
  config: ROIConfig = {}
): Promise<{
  strategyName: string;
  metrics: ROIMetrics;
}> {
  const operationLog = log.child({
    operation: 'calculateStrategyROI',
    strategyId,
  });

  try {
    const strategy = await prisma.retentionStrategy.findUnique({
      where: { id: strategyId },
      select: {
        name: true,
        organizationId: true,
      },
    });

    if (!strategy) {
      throw new Error('Strategy not found');
    }

    // Get campaigns for this strategy only
    const campaigns = await prisma.campaign.findMany({
      where: {
        strategyId,
        startedAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        actions: true,
        strategy: {
          select: {
            id: true,
            name: true,
          },
        },
        customer: {
          select: {
            id: true,
            subscriptions: {
              where: {
                status: { in: ['ACTIVE', 'TRIALING'] },
              },
              select: {
                amount: true,
                interval: true,
              },
              take: 1,
            },
          },
        },
      },
    });

    // Calculate metrics for this strategy
    const emailCostCents = config.emailCostCents || 10;
    const discountCostMultiplier = config.discountCostMultiplier || 1.0;
    const laborCostPerHourCents = config.laborCostPerHourCents || 5000;
    const averageOutreachMinutes = config.averageOutreachMinutes || 15;

    const costs = await calculateCampaignCosts(
      campaigns,
      emailCostCents,
      discountCostMultiplier,
      laborCostPerHourCents,
      averageOutreachMinutes
    );

    const revenue = await calculateCampaignRevenue(campaigns, strategy.organizationId);

    const convertedCampaigns = campaigns.filter((c) => c.status === 'CONVERTED');
    const conversionRate = campaigns.length > 0 ? (convertedCampaigns.length / campaigns.length) * 100 : 0;

    const netRevenue = revenue.totalRevenue - costs.totalCosts;
    const roiPercentage = costs.totalCosts > 0
      ? ((revenue.totalRevenue - costs.totalCosts) / costs.totalCosts) * 100
      : 0;
    const paybackMultiple = costs.totalCosts > 0 ? revenue.totalRevenue / costs.totalCosts : 0;

    const uniqueCustomers = new Set(campaigns.map((c) => c.customerId));
    const convertedCustomers = new Set(convertedCampaigns.map((c) => c.customerId));
    const churnPreventedCustomers = convertedCampaigns.filter(
      (c) => c.triggerType === 'CHURN_RISK_HIGH' || c.triggerType === 'CHURN_RISK_CRITICAL'
    );

    const metrics: ROIMetrics = {
      period: {
        start: startDate,
        end: endDate,
      },
      campaigns: {
        total: campaigns.length,
        converted: convertedCampaigns.length,
        conversionRate,
      },
      costs,
      revenue,
      roi: {
        percentage: roiPercentage,
        netRevenue,
        paybackMultiple,
      },
      customers: {
        reached: uniqueCustomers.size,
        converted: convertedCustomers.size,
        churnPrevented: churnPreventedCustomers.length,
      },
      breakdown: {
        byTriggerType: {},
        byStrategy: {},
      },
    };

    operationLog.info(
      {
        strategyName: strategy.name,
        totalCampaigns: campaigns.length,
        roi: roiPercentage,
      },
      'Strategy ROI calculated'
    );

    return {
      strategyName: strategy.name,
      metrics,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to calculate strategy ROI');
    throw error;
  }
}

/**
 * Get ROI comparison across multiple time periods
 */
export async function getROITrends(
  organizationId: string,
  periodType: 'day' | 'week' | 'month',
  periodsBack: number = 12
): Promise<
  Array<{
    period: string;
    startDate: Date;
    endDate: Date;
    roi: number;
    revenue: number;
    costs: number;
    campaigns: number;
  }>
> {
  const operationLog = log.child({
    operation: 'getROITrends',
    organizationId,
    periodType,
  });

  try {
    const trends: Array<{
      period: string;
      startDate: Date;
      endDate: Date;
      roi: number;
      revenue: number;
      costs: number;
      campaigns: number;
    }> = [];

    const now = new Date();

    for (let i = periodsBack - 1; i >= 0; i--) {
      const endDate = new Date(now);
      const startDate = new Date(now);

      switch (periodType) {
        case 'day':
          startDate.setDate(now.getDate() - i - 1);
          endDate.setDate(now.getDate() - i);
          break;
        case 'week':
          startDate.setDate(now.getDate() - (i + 1) * 7);
          endDate.setDate(now.getDate() - i * 7);
          break;
        case 'month':
          startDate.setMonth(now.getMonth() - i - 1);
          endDate.setMonth(now.getMonth() - i);
          break;
      }

      const metrics = await calculateROI(organizationId, startDate, endDate);

      trends.push({
        period: formatPeriod(startDate, periodType),
        startDate,
        endDate,
        roi: metrics.roi.percentage,
        revenue: metrics.revenue.totalRevenue,
        costs: costs.totalCosts,
        campaigns: metrics.campaigns.total,
      });
    }

    operationLog.info({ periodsCalculated: trends.length }, 'ROI trends calculated');

    return trends;
  } catch (error) {
    operationLog.error({ error }, 'Failed to calculate ROI trends');
    throw error;
  }
}

/**
 * Format period for display
 */
function formatPeriod(date: Date, periodType: 'day' | 'week' | 'month'): string {
  switch (periodType) {
    case 'day':
      return date.toISOString().split('T')[0]; // YYYY-MM-DD
    case 'week':
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      return `Week of ${weekStart.toISOString().split('T')[0]}`;
    case 'month':
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
}

/**
 * Calculate projected ROI based on current trends
 */
export async function projectROI(
  organizationId: string,
  monthsAhead: number = 12
): Promise<{
  currentMonthlyROI: number;
  projectedAnnualRevenue: number;
  projectedAnnualCosts: number;
  projectedAnnualROI: number;
  confidenceLevel: 'high' | 'medium' | 'low';
}> {
  const operationLog = log.child({
    operation: 'projectROI',
    organizationId,
  });

  try {
    // Get last 3 months of data for projection
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(endDate.getMonth() - 3);

    const metrics = await calculateROI(organizationId, startDate, endDate);

    // Calculate monthly averages
    const monthlyRevenue = metrics.revenue.totalRevenue / 3;
    const monthlyCosts = metrics.costs.totalCosts / 3;
    const monthlyROI = metrics.roi.percentage;

    // Project forward
    const projectedAnnualRevenue = monthlyRevenue * monthsAhead;
    const projectedAnnualCosts = monthlyCosts * monthsAhead;
    const projectedAnnualROI = monthlyCosts > 0
      ? ((projectedAnnualRevenue - projectedAnnualCosts) / projectedAnnualCosts) * 100
      : 0;

    // Determine confidence level
    let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
    if (metrics.campaigns.total >= 100) {
      confidenceLevel = 'high';
    } else if (metrics.campaigns.total >= 30) {
      confidenceLevel = 'medium';
    }

    operationLog.info(
      {
        currentMonthlyROI: monthlyROI,
        projectedAnnualROI,
        confidenceLevel,
      },
      'ROI projected'
    );

    return {
      currentMonthlyROI: monthlyROI,
      projectedAnnualRevenue,
      projectedAnnualCosts,
      projectedAnnualROI,
      confidenceLevel,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to project ROI');
    throw error;
  }
}
