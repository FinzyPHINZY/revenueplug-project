/**
 * Usage Nudge Service
 *
 * Analyze feature usage patterns and send behavioral nudges to increase engagement
 * Identifies underutilized features and triggers in-app messages via Mixpanel
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { z } from 'zod';

const log = logger.child({ module: 'usage-nudge' });

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

/**
 * Feature usage tracking schema
 */
export interface FeatureUsage {
  featureId: string;
  featureName: string;
  category: string;
  lastUsedAt: Date | null;
  usageCount: number;
  avgUsagePerWeek: number;
  percentile: number; // 0-100, where customer ranks vs others
}

/**
 * Nudge recommendation
 */
export interface NudgeRecommendation {
  customerId: string;
  featureId: string;
  featureName: string;
  category: string;
  reason: 'NEVER_USED' | 'RARELY_USED' | 'DECLINING_USAGE' | 'BELOW_AVERAGE';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  impact: 'ENGAGEMENT' | 'RETENTION' | 'REVENUE';
  recommendedAction: string;
  templateKey: string; // Mixpanel template identifier
  context: Record<string, any>;
}

/**
 * Nudge trigger types
 */
export type NudgeType =
  | 'FEATURE_HIGHLIGHT' // Showcase feature benefits
  | 'USAGE_TIP' // How to use feature better
  | 'SUCCESS_STORY' // Share customer success with feature
  | 'QUICK_WIN' // Easy action for immediate value
  | 'PRODUCTIVITY_BOOST'; // Time-saving tip

const CreateNudgeSchema = z.object({
  customerId: z.string().cuid(),
  featureId: z.string(),
  nudgeType: z.enum([
    'FEATURE_HIGHLIGHT',
    'USAGE_TIP',
    'SUCCESS_STORY',
    'QUICK_WIN',
    'PRODUCTIVITY_BOOST',
  ]),
  message: z.string().min(1),
  ctaText: z.string().optional(),
  ctaUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
});

export type CreateNudgeInput = z.infer<typeof CreateNudgeSchema>;

// ============================================================================
// FEATURE USAGE ANALYSIS
// ============================================================================

/**
 * Analyze feature usage for a customer
 */
export async function analyzeCustomerUsage(
  customerId: string,
  options: {
    lookbackDays?: number;
    minUsageThreshold?: number;
  } = {}
): Promise<FeatureUsage[]> {
  const operationLog = log.child({
    operation: 'analyzeCustomerUsage',
    customerId,
  });

  try {
    const lookbackDays = options.lookbackDays || 30;
    const minUsageThreshold = options.minUsageThreshold || 1;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);

    // Get customer's feature usage from behavioral events
    // This assumes you have a BehavioralEvent model or similar tracking
    // For now, we'll use a placeholder query structure

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        connection: {
          select: {
            organizationId: true,
          },
        },
      },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    // Define features to track (this would come from your feature catalog)
    const features = getFeatureCatalog();

    // Analyze usage for each feature
    const usageAnalysis: FeatureUsage[] = [];

    for (const feature of features) {
      // Query usage events (placeholder - adapt to your event tracking system)
      const usage = await analyzeFeatureUsage(
        customerId,
        feature.id,
        startDate,
        new Date()
      );

      usageAnalysis.push({
        featureId: feature.id,
        featureName: feature.name,
        category: feature.category,
        lastUsedAt: usage.lastUsedAt,
        usageCount: usage.count,
        avgUsagePerWeek: usage.avgPerWeek,
        percentile: usage.percentile,
      });
    }

    operationLog.info(
      { featuresAnalyzed: usageAnalysis.length },
      'Customer usage analyzed'
    );

    return usageAnalysis;
  } catch (error) {
    operationLog.error({ error }, 'Failed to analyze customer usage');
    throw error;
  }
}

/**
 * Get nudge recommendations for a customer
 */
export async function getNudgeRecommendations(
  customerId: string
): Promise<NudgeRecommendation[]> {
  const operationLog = log.child({
    operation: 'getNudgeRecommendations',
    customerId,
  });

  try {
    const usageData = await analyzeCustomerUsage(customerId);
    const recommendations: NudgeRecommendation[] = [];

    for (const feature of usageData) {
      // Never used - highest priority
      if (feature.usageCount === 0) {
        recommendations.push({
          customerId,
          featureId: feature.featureId,
          featureName: feature.featureName,
          category: feature.category,
          reason: 'NEVER_USED',
          priority: 'HIGH',
          impact: getFeatureImpact(feature.category),
          recommendedAction: `Try ${feature.featureName} to ${getFeatureBenefit(feature.featureId)}`,
          templateKey: `nudge_never_used_${feature.category}`,
          context: {
            featureName: feature.featureName,
            benefit: getFeatureBenefit(feature.featureId),
            quickStartUrl: getQuickStartUrl(feature.featureId),
          },
        });
      }
      // Rarely used - medium priority
      else if (feature.avgUsagePerWeek < 1 && feature.usageCount < 5) {
        recommendations.push({
          customerId,
          featureId: feature.featureId,
          featureName: feature.featureName,
          category: feature.category,
          reason: 'RARELY_USED',
          priority: 'MEDIUM',
          impact: getFeatureImpact(feature.category),
          recommendedAction: `Use ${feature.featureName} more frequently to ${getFeatureBenefit(feature.featureId)}`,
          templateKey: `nudge_rarely_used_${feature.category}`,
          context: {
            featureName: feature.featureName,
            currentUsage: feature.avgUsagePerWeek,
            recommendedUsage: 3,
            benefit: getFeatureBenefit(feature.featureId),
          },
        });
      }
      // Below average usage - low priority
      else if (feature.percentile < 25) {
        recommendations.push({
          customerId,
          featureId: feature.featureId,
          featureName: feature.featureName,
          category: feature.category,
          reason: 'BELOW_AVERAGE',
          priority: 'LOW',
          impact: getFeatureImpact(feature.category),
          recommendedAction: `Maximize ${feature.featureName} to get more value`,
          templateKey: `nudge_below_average_${feature.category}`,
          context: {
            featureName: feature.featureName,
            percentile: feature.percentile,
            benefit: getFeatureBenefit(feature.featureId),
          },
        });
      }
    }

    // Sort by priority
    recommendations.sort((a, b) => {
      const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    operationLog.info(
      { recommendationsCount: recommendations.length },
      'Nudge recommendations generated'
    );

    return recommendations;
  } catch (error) {
    operationLog.error({ error }, 'Failed to generate recommendations');
    throw error;
  }
}

// ============================================================================
// NUDGE SENDING
// ============================================================================

/**
 * Send a usage nudge via Mixpanel
 */
export async function sendUsageNudge(input: CreateNudgeInput): Promise<{
  success: boolean;
  nudgeId: string;
  campaignId: string;
}> {
  const operationLog = log.child({
    operation: 'sendUsageNudge',
    customerId: input.customerId,
  });

  try {
    const validated = CreateNudgeSchema.parse(input);

    // Get customer details
    const customer = await prisma.customer.findUnique({
      where: { id: validated.customerId },
      include: {
        connection: {
          select: {
            organizationId: true,
          },
        },
      },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    const organizationId = customer.connection.organizationId;

    // Create a lightweight campaign for this nudge
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        customerId: customer.id,
        strategyId: null, // Standalone nudge, not from a strategy
        triggerType: 'MANUAL',
        triggerContext: {
          nudgeType: validated.nudgeType,
          featureId: validated.featureId,
          automated: true,
        },
        priority: 'LOW',
        status: 'ACTIVE',
        startedAt: new Date(),
      },
    });

    // Create the nudge action
    const nudge = await prisma.campaignAction.create({
      data: {
        campaignId: campaign.id,
        actionType: 'USAGE_NUDGE',
        status: 'PENDING',
        delayMinutes: 0,
        scheduledFor: new Date(),
        actionData: {
          nudgeType: validated.nudgeType,
          featureId: validated.featureId,
          message: validated.message,
          ctaText: validated.ctaText,
          ctaUrl: validated.ctaUrl,
          metadata: validated.metadata,
        },
      },
    });

    // Send to Mixpanel for in-app display (placeholder - integrate with your Mixpanel service)
    const mixpanelSuccess = true; // TODO: Integrate with Mixpanel client

    // Update nudge status
    await prisma.campaignAction.update({
      where: { id: nudge.id },
      data: {
        status: mixpanelSuccess ? 'SENT' : 'FAILED',
        executedAt: mixpanelSuccess ? new Date() : null,
        executionResult: {
          mixpanelSent: mixpanelSuccess,
          sentAt: new Date().toISOString(),
        },
      },
    });

    operationLog.info(
      { nudgeId: nudge.id, campaignId: campaign.id, mixpanelSuccess },
      'Usage nudge sent'
    );

    return {
      success: mixpanelSuccess,
      nudgeId: nudge.id,
      campaignId: campaign.id,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to send usage nudge');
    throw error;
  }
}

/**
 * Send nudges based on recommendations
 */
export async function sendRecommendedNudges(
  customerId: string,
  options: {
    maxNudges?: number;
    priorityFilter?: NudgeRecommendation['priority'][];
  } = {}
): Promise<{
  sent: number;
  failed: number;
  nudgeIds: string[];
}> {
  const operationLog = log.child({
    operation: 'sendRecommendedNudges',
    customerId,
  });

  try {
    const recommendations = await getNudgeRecommendations(customerId);
    const maxNudges = options.maxNudges || 3;
    const priorityFilter = options.priorityFilter || ['HIGH', 'MEDIUM'];

    // Filter and limit recommendations
    const filtered = recommendations
      .filter((r) => priorityFilter.includes(r.priority))
      .slice(0, maxNudges);

    const results = {
      sent: 0,
      failed: 0,
      nudgeIds: [] as string[],
    };

    for (const rec of filtered) {
      try {
        const result = await sendUsageNudge({
          customerId: rec.customerId,
          featureId: rec.featureId,
          nudgeType: 'FEATURE_HIGHLIGHT',
          message: rec.recommendedAction,
          ctaText: 'Learn More',
          ctaUrl: rec.context.quickStartUrl || '#',
          metadata: rec.context,
        });

        if (result.success) {
          results.sent++;
          results.nudgeIds.push(result.nudgeId);
        } else {
          results.failed++;
        }
      } catch (error) {
        operationLog.error(
          { error, featureId: rec.featureId },
          'Failed to send individual nudge'
        );
        results.failed++;
      }
    }

    operationLog.info(results, 'Recommended nudges sent');

    return results;
  } catch (error) {
    operationLog.error({ error }, 'Failed to send recommended nudges');
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get feature catalog
 * In production, this would come from a database or config
 */
function getFeatureCatalog(): Array<{
  id: string;
  name: string;
  category: string;
}> {
  return [
    // Analytics features
    { id: 'dashboard_view', name: 'Dashboard', category: 'analytics' },
    { id: 'revenue_reports', name: 'Revenue Reports', category: 'analytics' },
    { id: 'churn_analysis', name: 'Churn Analysis', category: 'analytics' },
    { id: 'cohort_analysis', name: 'Cohort Analysis', category: 'analytics' },

    // Retention features
    {
      id: 'retention_campaigns',
      name: 'Retention Campaigns',
      category: 'retention',
    },
    { id: 'email_sequences', name: 'Email Sequences', category: 'retention' },
    { id: 'ab_testing', name: 'A/B Testing', category: 'retention' },
    { id: 'playbooks', name: 'Playbooks', category: 'retention' },

    // Integration features
    { id: 'stripe_sync', name: 'Stripe Sync', category: 'integration' },
    { id: 'webhooks', name: 'Webhooks', category: 'integration' },
    { id: 'api_access', name: 'API Access', category: 'integration' },

    // Collaboration features
    { id: 'team_management', name: 'Team Management', category: 'collaboration' },
    { id: 'shared_dashboards', name: 'Shared Dashboards', category: 'collaboration' },
  ];
}

/**
 * Analyze feature usage (placeholder implementation)
 */
async function analyzeFeatureUsage(
  customerId: string,
  featureId: string,
  startDate: Date,
  endDate: Date
): Promise<{
  count: number;
  lastUsedAt: Date | null;
  avgPerWeek: number;
  percentile: number;
}> {
  // In production, query your behavioral events table
  // For now, return placeholder data

  // Simulate some usage patterns
  const randomUsage = Math.floor(Math.random() * 20);
  const daysDiff = Math.floor(
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
  );
  const weeks = daysDiff / 7;

  return {
    count: randomUsage,
    lastUsedAt: randomUsage > 0 ? new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000) : null,
    avgPerWeek: randomUsage / weeks,
    percentile: Math.floor(Math.random() * 100),
  };
}

/**
 * Get feature impact category
 */
function getFeatureImpact(category: string): 'ENGAGEMENT' | 'RETENTION' | 'REVENUE' {
  const impactMap: Record<string, 'ENGAGEMENT' | 'RETENTION' | 'REVENUE'> = {
    analytics: 'ENGAGEMENT',
    retention: 'RETENTION',
    integration: 'REVENUE',
    collaboration: 'ENGAGEMENT',
  };

  return impactMap[category] || 'ENGAGEMENT';
}

/**
 * Get feature benefit description
 */
function getFeatureBenefit(featureId: string): string {
  const benefits: Record<string, string> = {
    dashboard_view: 'get instant insights into your revenue health',
    revenue_reports: 'track MRR, ARR, and growth trends',
    churn_analysis: 'understand why customers leave',
    cohort_analysis: 'compare campaign performance over time',
    retention_campaigns: 'win back at-risk customers',
    email_sequences: 'automate multi-step outreach',
    ab_testing: 'optimize your messaging',
    playbooks: 'reuse proven strategies',
    stripe_sync: 'keep your data up to date',
    webhooks: 'integrate with your tools',
    api_access: 'build custom integrations',
    team_management: 'collaborate with your team',
    shared_dashboards: 'align on metrics',
  };

  return benefits[featureId] || 'improve your workflow';
}

/**
 * Get quick start URL for feature
 */
function getQuickStartUrl(featureId: string): string {
  return `https://docs.revenueplug.com/features/${featureId}`;
}

/**
 * Track nudge interaction
 */
export async function trackNudgeInteraction(
  nudgeId: string,
  interaction: 'VIEWED' | 'CLICKED' | 'DISMISSED'
): Promise<void> {
  const operationLog = log.child({
    operation: 'trackNudgeInteraction',
    nudgeId,
  });

  try {
    await prisma.campaignAction.update({
      where: { id: nudgeId },
      data: {
        status:
          interaction === 'CLICKED'
            ? 'CLICKED'
            : interaction === 'VIEWED'
            ? 'DELIVERED'
            : 'CANCELLED',
      },
    });

    operationLog.info({ interaction }, 'Nudge interaction tracked');
  } catch (error) {
    operationLog.error({ error }, 'Failed to track nudge interaction');
    throw error;
  }
}
