/**
 * Retention Campaigns & Actions Service
 * Core business logic for campaign management, strategy evaluation, and action scheduling
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { enqueueAction } from './queue.js';
import { publishCampaignEvent, publishActionEvent } from '../../infrastructure/kafka/retention-publisher.js';
import { KafkaTopics } from '../../infrastructure/kafka/topics.js';
import type {
  ActionConfig,
  AudienceFilters,
  CalculateCampaignMetricsParams,
  CampaignStats,
  CreateEmailTemplateParams,
  CreateStrategyParams,
  RenderedTemplate,
  StrategyEvaluationResult,
  TemplateData,
  TriggerCampaignParams,
  TriggerConditions,
  UpdateEmailTemplateParams,
  UpdateStrategyParams,
} from './types.js';
import type {
  Campaign,
  CampaignMetrics,
  EmailTemplate,
  RetentionStrategy,
} from '@prisma/client';

const log = logger.child({ module: 'retention' });

// ============================================================================
// STRATEGY MANAGEMENT
// ============================================================================

/**
 * Create a new retention strategy
 */
export async function createStrategy(
  params: CreateStrategyParams
): Promise<RetentionStrategy> {
  const operationLog = log.child({
    operation: 'createStrategy',
    organizationId: params.organizationId,
  });

  try {
    const strategy = await prisma.retentionStrategy.create({
      data: {
        organizationId: params.organizationId,
        name: params.name,
        description: params.description,
        triggerConditions: params.triggerConditions as any,
        audienceFilters: params.audienceFilters as any,
        actions: params.actions as any,
        cooldownDays: params.cooldownDays,
        maxActionsPerCustomer: params.maxActionsPerCustomer || 5,
        priority: params.priority,
        status: 'ACTIVE',
      },
    });

    operationLog.info({ strategyId: strategy.id }, 'Retention strategy created');
    return strategy;
  } catch (error) {
    operationLog.error({ error }, 'Failed to create retention strategy');
    throw error;
  }
}

/**
 * Update an existing retention strategy
 */
export async function updateStrategy(
  strategyId: string,
  params: UpdateStrategyParams
): Promise<RetentionStrategy> {
  const operationLog = log.child({
    operation: 'updateStrategy',
    strategyId,
  });

  try {
    const strategy = await prisma.retentionStrategy.update({
      where: { id: strategyId },
      data: {
        ...params,
        triggerConditions: params.triggerConditions as any,
        audienceFilters: params.audienceFilters as any,
        actions: params.actions as any,
      },
    });

    operationLog.info('Retention strategy updated');
    return strategy;
  } catch (error) {
    operationLog.error({ error }, 'Failed to update retention strategy');
    throw error;
  }
}

/**
 * List all strategies for an organization
 */
export async function listStrategies(
  organizationId: string,
  status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
): Promise<RetentionStrategy[]> {
  return prisma.retentionStrategy.findMany({
    where: {
      organizationId,
      ...(status && { status }),
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get a single strategy by ID
 */
export async function getStrategy(strategyId: string): Promise<RetentionStrategy | null> {
  return prisma.retentionStrategy.findUnique({
    where: { id: strategyId },
  });
}

/**
 * Delete a strategy (soft delete by archiving)
 */
export async function deleteStrategy(strategyId: string): Promise<void> {
  await prisma.retentionStrategy.update({
    where: { id: strategyId },
    data: { status: 'ARCHIVED' },
  });

  log.info({ strategyId }, 'Retention strategy archived');
}

// ============================================================================
// CAMPAIGN TRIGGERING & MANAGEMENT
// ============================================================================

/**
 * Trigger a campaign for a customer based on a strategy
 * Checks cooldown period and audience filters before creating campaign
 */
export async function triggerCampaign(
  params: TriggerCampaignParams
): Promise<Campaign | null> {
  const operationLog = log.child({
    operation: 'triggerCampaign',
    strategyId: params.strategyId,
    customerId: params.customerId,
    triggerType: params.triggerType,
  });

  try {
    // Get strategy
    const strategy = await prisma.retentionStrategy.findUnique({
      where: { id: params.strategyId },
    });

    if (!strategy || strategy.status !== 'ACTIVE') {
      operationLog.info('Strategy not found or inactive, skipping campaign');
      return null;
    }

    // Check cooldown
    const inCooldown = await isInCooldown(params.customerId, params.strategyId);
    if (inCooldown) {
      operationLog.info('Customer in cooldown period, skipping campaign');
      return null;
    }

    // Check audience filters
    const matchesAudience = await evaluateAudienceFilters(
      params.customerId,
      strategy.audienceFilters as AudienceFilters | null
    );

    if (!matchesAudience) {
      operationLog.info('Customer does not match audience filters, skipping campaign');
      return null;
    }

    // Check email preferences - ensure customer hasn't unsubscribed
    const {canSendEmail, getCategoryFromTriggerType } = await import('./email-preferences.js');
    const emailCategory = getCategoryFromTriggerType(params.triggerType);
    const canSend = await canSendEmail(
      params.customerId,
      strategy.organizationId,
      emailCategory
    );

    if (!canSend) {
      operationLog.info(
        { emailCategory },
        'Customer has unsubscribed from this email category, skipping campaign'
      );
      return null;
    }

    // Create campaign
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: strategy.organizationId,
        strategyId: params.strategyId,
        customerId: params.customerId,
        status: 'ACTIVE',
        priority: strategy.priority,
        triggerType: params.triggerType,
        triggerContext: params.triggerContext as any,
        startedAt: new Date(),
      },
      include: {
        customer: true,
      },
    });

    operationLog.info({ campaignId: campaign.id }, 'Campaign triggered');

    // Publish campaign triggered event to Kafka
    await publishCampaignEvent(KafkaTopics.RETENTION_CAMPAIGN_TRIGGERED, {
      campaignId: campaign.id,
      strategyId: params.strategyId,
      customerId: params.customerId,
      organizationId: strategy.organizationId,
      triggerType: params.triggerType,
      campaignStatus: 'ACTIVE',
      campaignPriority: strategy.priority,
      triggerContext: params.triggerContext,
    });

    // Schedule actions
    await scheduleActions(campaign.id, strategy.actions as ActionConfig[]);

    // Create cooldown record
    await prisma.campaignCooldown.upsert({
      where: {
        customerId_strategyId: {
          customerId: params.customerId,
          strategyId: params.strategyId,
        },
      },
      create: {
        customerId: params.customerId,
        strategyId: params.strategyId,
        lastCampaignId: campaign.id,
        lastTriggeredAt: new Date(),
        cooldownEndsAt: new Date(Date.now() + strategy.cooldownDays * 24 * 60 * 60 * 1000),
        campaignCount: 1,
      },
      update: {
        lastCampaignId: campaign.id,
        lastTriggeredAt: new Date(),
        cooldownEndsAt: new Date(Date.now() + strategy.cooldownDays * 24 * 60 * 60 * 1000),
        campaignCount: { increment: 1 },
      },
    });

    return campaign;
  } catch (error) {
    operationLog.error({ error }, 'Failed to trigger campaign');
    throw error;
  }
}

/**
 * Check if customer is in cooldown period for a strategy
 */
export async function isInCooldown(
  customerId: string,
  strategyId: string
): Promise<boolean> {
  const cooldown = await prisma.campaignCooldown.findUnique({
    where: {
      customerId_strategyId: { customerId, strategyId },
    },
  });

  if (!cooldown) {
    return false;
  }

  // Check if cooldown period has ended
  return cooldown.cooldownEndsAt > new Date();
}

/**
 * Evaluate if customer matches strategy trigger conditions
 */
export async function evaluateStrategyTrigger(
  strategyId: string,
  customerId: string
): Promise<StrategyEvaluationResult> {
  const strategy = await prisma.retentionStrategy.findUnique({
    where: { id: strategyId },
  });

  if (!strategy) {
    return { matches: false, reason: 'Strategy not found' };
  }

  const conditions = strategy.triggerConditions as TriggerConditions;

  // Get customer data
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      churnRiskScores: { orderBy: { calculatedAt: 'desc' }, take: 1 },
      healthScores: { orderBy: { calculatedAt: 'desc' }, take: 1 },
      subscriptions: { where: { status: 'ACTIVE' }, take: 1 },
    },
  });

  if (!customer) {
    return { matches: false, reason: 'Customer not found' };
  }

  // Evaluate churn risk conditions
  if (conditions.churnRiskLevel && customer.churnRiskScores[0]) {
    const churnScore = customer.churnRiskScores[0];
    if (!conditions.churnRiskLevel.includes(churnScore.riskLevel)) {
      return { matches: false, reason: 'Churn risk level does not match' };
    }
  }

  if (conditions.minChurnScore && customer.churnRiskScores[0]) {
    if (customer.churnRiskScores[0].score < conditions.minChurnScore) {
      return { matches: false, reason: 'Churn score below minimum' };
    }
  }

  // Evaluate health score conditions
  if (conditions.minHealthScore && customer.healthScores[0]) {
    if (customer.healthScores[0].score < conditions.minHealthScore) {
      return { matches: false, reason: 'Health score below minimum' };
    }
  }

  if (conditions.maxHealthScore && customer.healthScores[0]) {
    if (customer.healthScores[0].score > conditions.maxHealthScore) {
      return { matches: false, reason: 'Health score above maximum' };
    }
  }

  // If all conditions pass
  return {
    matches: true,
    context: {
      churnScore: customer.churnRiskScores[0]?.score,
      churnRiskLevel: customer.churnRiskScores[0]?.riskLevel,
      healthScore: customer.healthScores[0]?.score,
      subscriptionStatus: customer.subscriptions[0]?.status,
    },
  };
}

/**
 * Evaluate if customer matches audience filters
 */
async function evaluateAudienceFilters(
  customerId: string,
  filters: AudienceFilters | null
): Promise<boolean> {
  if (!filters) {
    return true; // No filters = match all
  }

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      subscriptions: { where: { status: 'ACTIVE' }, take: 1 },
    },
  });

  if (!customer) {
    return false;
  }

  const subscription = customer.subscriptions[0];

  // Subscription status filter
  if (filters.subscriptionStatus && subscription) {
    if (!filters.subscriptionStatus.includes(subscription.status)) {
      return false;
    }
  }

  // MRR filter
  if (subscription) {
    const mrr = Number(subscription.amount);
    if (filters.minMRR && mrr < filters.minMRR) {
      return false;
    }
    if (filters.maxMRR && mrr > filters.maxMRR) {
      return false;
    }
  }

  // Customer email filters
  if (filters.customerEmail && customer.email) {
    if (!filters.customerEmail.includes(customer.email)) {
      return false;
    }
  }

  if (filters.customerExclude && customer.email) {
    if (filters.customerExclude.includes(customer.email)) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// ACTION SCHEDULING
// ============================================================================

/**
 * Schedule campaign actions in background queue
 */
export async function scheduleActions(
  campaignId: string,
  actions: ActionConfig[]
): Promise<void> {
  const operationLog = log.child({ operation: 'scheduleActions', campaignId });

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) {
    throw new Error('Campaign not found');
  }

  const campaignStartTime = campaign.startedAt.getTime();

  for (const actionConfig of actions) {
    const scheduledFor = new Date(campaignStartTime + actionConfig.delayMinutes * 60 * 1000);

    // Create action record
    const action = await prisma.campaignAction.create({
      data: {
        campaignId,
        actionType: actionConfig.type,
        status: 'PENDING',
        delayMinutes: actionConfig.delayMinutes,
        scheduledFor,
        actionData: actionConfig as any,
      },
    });

    // Enqueue for background processing
    const delayMs = scheduledFor.getTime() - Date.now();
    await enqueueAction(action, Math.max(0, delayMs));

    operationLog.info(
      {
        actionId: action.id,
        actionType: action.actionType,
        scheduledFor,
      },
      'Action scheduled'
    );
  }
}

/**
 * Execute a single campaign action
 * Delegates to specific action executors based on action type
 */
export async function executeAction(actionId: string): Promise<{
  success: boolean;
  result?: any;
  error?: string;
}> {
  const operationLog = log.child({ operation: 'executeAction', actionId });

  try {
    const action = await prisma.campaignAction.findUnique({
      where: { id: actionId },
      include: {
        campaign: {
          include: {
            customer: true,
            organization: true,
          },
        },
      },
    });

    if (!action) {
      throw new Error('Action not found');
    }

    // Update status to executing
    await prisma.campaignAction.update({
      where: { id: actionId },
      data: { status: 'EXECUTING' },
    });

    operationLog.info({ actionType: action.actionType }, 'Executing action');

    // Import action executors dynamically
    const { executeEmailAction } = await import('./actions/email.js');
    const { executeDiscountAction } = await import('./actions/discount.js');
    const { executePersonalOutreachAction } = await import('./actions/outreach.js');
    const { executeUsageNudgeAction } = await import('./actions/nudge.js');

    let result;

    // Delegate to specific executor
    switch (action.actionType) {
      case 'EMAIL':
        result = await executeEmailAction(action, action.campaign);
        break;
      case 'DISCOUNT':
        result = await executeDiscountAction(action, action.campaign);
        break;
      case 'PERSONAL_OUTREACH':
        result = await executePersonalOutreachAction(action, action.campaign);
        break;
      case 'USAGE_NUDGE':
      case 'FEATURE_HIGHLIGHT':
        result = await executeUsageNudgeAction(action, action.campaign);
        break;
      default:
        throw new Error(`Unknown action type: ${action.actionType}`);
    }

    if (result.success) {
      operationLog.info({ result: result.result }, 'Action executed successfully');
    } else {
      operationLog.error({ error: result.error }, 'Action execution failed');
    }

    return result;
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute action');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Mark a campaign as converted (customer took desired action)
 */
export async function markCampaignConverted(
  campaignId: string,
  revenueRecovered?: number
): Promise<void> {
  const operationLog = log.child({
    operation: 'markCampaignConverted',
    campaignId,
  });

  const campaign = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: 'CONVERTED',
      convertedAt: new Date(),
      completedAt: new Date(),
      revenueRecovered,
    },
  });

  // Calculate time to conversion
  const timeToConversionSeconds = campaign.startedAt
    ? Math.floor((new Date().getTime() - campaign.startedAt.getTime()) / 1000)
    : undefined;

  // Publish campaign converted event to Kafka
  await publishCampaignEvent(KafkaTopics.RETENTION_CAMPAIGN_CONVERTED, {
    campaignId: campaign.id,
    strategyId: campaign.strategyId,
    customerId: campaign.customerId,
    organizationId: campaign.organizationId,
    triggerType: campaign.triggerType,
    campaignStatus: 'CONVERTED',
    campaignPriority: campaign.priority,
    triggerContext: campaign.triggerContext as any,
    revenueRecovered,
    timeToConversionSeconds,
  });

  // Cancel any pending actions (including sequences)
  await prisma.campaignAction.updateMany({
    where: {
      campaignId,
      status: { in: ['PENDING', 'SCHEDULED', 'WAITING_FOR_CONDITION'] },
    },
    data: {
      status: 'CANCELLED',
    },
  });

  // Cancel all sequences for this campaign
  const sequenceActions = await prisma.campaignAction.findMany({
    where: { campaignId, sequenceId: { not: null } },
    select: { sequenceId: true },
    distinct: ['sequenceId'],
  });

  if (sequenceActions.length > 0) {
    const { cancelSequence } = await import('./sequences.js');
    for (const action of sequenceActions) {
      if (action.sequenceId) {
        await cancelSequence(campaignId, action.sequenceId).catch((error) => {
          operationLog.error({ error, sequenceId: action.sequenceId }, 'Failed to cancel sequence');
        });
      }
    }
  }

  operationLog.info({ revenueRecovered, timeToConversionSeconds }, 'Campaign marked as converted');
}

/**
 * Cancel a campaign
 */
export async function cancelCampaign(
  campaignId: string,
  reason?: string
): Promise<void> {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  });

  // Cancel pending actions
  await prisma.campaignAction.updateMany({
    where: {
      campaignId,
      status: { in: ['PENDING', 'SCHEDULED'] },
    },
    data: {
      status: 'CANCELLED',
    },
  });

  log.info({ campaignId, reason }, 'Campaign cancelled');
}

// ============================================================================
// EMAIL TEMPLATE MANAGEMENT
// ============================================================================

/**
 * Create an email template
 */
export async function createEmailTemplate(
  params: CreateEmailTemplateParams
): Promise<EmailTemplate> {
  const operationLog = log.child({
    operation: 'createEmailTemplate',
    organizationId: params.organizationId,
  });

  try {
    const template = await prisma.emailTemplate.create({
      data: {
        organizationId: params.organizationId,
        name: params.name,
        description: params.description,
        category: params.category,
        status: params.status || 'ACTIVE',
        subject: params.subject,
        htmlBody: params.htmlBody,
        textBody: params.textBody,
        availableTags: params.availableTags,
      },
    });

    operationLog.info({ templateId: template.id }, 'Email template created');
    return template;
  } catch (error) {
    operationLog.error({ error }, 'Failed to create email template');
    throw error;
  }
}

/**
 * Update an email template
 */
export async function updateEmailTemplate(
  templateId: string,
  params: UpdateEmailTemplateParams
): Promise<EmailTemplate> {
  const template = await prisma.emailTemplate.update({
    where: { id: templateId },
    data: params,
  });

  log.info({ templateId }, 'Email template updated');
  return template;
}

/**
 * List email templates for an organization
 */
export async function listEmailTemplates(
  organizationId: string,
  category?: string
): Promise<EmailTemplate[]> {
  return prisma.emailTemplate.findMany({
    where: {
      organizationId,
      ...(category && { category: category as any }),
      status: { not: 'ARCHIVED' },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Render an email template with customer data
 */
export async function renderTemplate(
  templateId: string,
  customerId: string,
  additionalData?: Record<string, any>
): Promise<RenderedTemplate> {
  const { renderEmailTemplate } = await import('./templates/renderer.js');

  const template = await prisma.emailTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new Error('Template not found');
  }

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      subscriptions: {
        where: { status: { in: ['ACTIVE', 'TRIALING'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!customer) {
    throw new Error('Customer not found');
  }

  const subscription = customer.subscriptions[0];

  const templateData: TemplateData = {
    customerName: customer.name || undefined,
    customerEmail: customer.email || undefined,
    planName: subscription?.productName || undefined,
    amount: subscription ? Number(subscription.amount) : undefined,
    currency: subscription?.currency || undefined,
    trialEndDate: subscription?.trialEnd || undefined,
    currentPeriodEnd: subscription?.currentPeriodEnd || undefined,
    ...additionalData,
  };

  return renderEmailTemplate(template, templateData);
}

// ============================================================================
// METRICS & ANALYTICS
// ============================================================================

/**
 * Calculate campaign metrics for a period
 */
export async function calculateCampaignMetrics(
  params: CalculateCampaignMetricsParams
): Promise<CampaignMetrics> {
  const { organizationId, strategyId, period, periodType } = params;

  // Calculate period end based on period type
  let periodEnd: Date;
  switch (periodType) {
    case 'DAILY':
      periodEnd = new Date(period.getTime() + 24 * 60 * 60 * 1000);
      break;
    case 'WEEKLY':
      periodEnd = new Date(period.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    case 'MONTHLY':
      periodEnd = new Date(period.getFullYear(), period.getMonth() + 1, period.getDate());
      break;
    default:
      periodEnd = new Date(period.getTime() + 24 * 60 * 60 * 1000);
  }

  // Get campaigns in period
  const campaigns = await prisma.campaign.findMany({
    where: {
      organizationId,
      ...(strategyId && { strategyId }),
      startedAt: {
        gte: period,
        lt: periodEnd,
      },
    },
    include: {
      actions: true,
    },
  });

  // Calculate counts
  const totalCampaigns = campaigns.length;
  const activeCampaigns = campaigns.filter((c) => c.status === 'ACTIVE').length;
  const completedCampaigns = campaigns.filter((c) => c.status === 'COMPLETED').length;
  const convertedCampaigns = campaigns.filter((c) => c.status === 'CONVERTED').length;
  const cancelledCampaigns = campaigns.filter((c) => c.status === 'CANCELLED').length;

  // Calculate action counts
  const allActions = campaigns.flatMap((c) => c.actions);
  const emailsSent = allActions.filter((a) => a.actionType === 'EMAIL' && a.status === 'SENT')
    .length;
  const discountsCreated = allActions.filter(
    (a) => a.actionType === 'DISCOUNT' && a.status === 'SENT'
  ).length;
  const outreachTasks = allActions.filter(
    (a) => a.actionType === 'PERSONAL_OUTREACH' && a.status === 'SENT'
  ).length;
  const usageNudges = allActions.filter((a) => a.actionType === 'USAGE_NUDGE' && a.status === 'SENT')
    .length;

  // Calculate performance metrics
  const conversionRate =
    totalCampaigns > 0 ? (convertedCampaigns / totalCampaigns) * 100 : 0;

  const convertedCampaignsWithTime = campaigns.filter(
    (c) => c.status === 'CONVERTED' && c.convertedAt && c.startedAt
  );
  const avgTimeToConversion =
    convertedCampaignsWithTime.length > 0
      ? convertedCampaignsWithTime.reduce((sum, c) => {
          const timeToConversion =
            (c.convertedAt!.getTime() - c.startedAt.getTime()) / (1000 * 60 * 60); // Hours
          return sum + timeToConversion;
        }, 0) / convertedCampaignsWithTime.length
      : null;

  const totalRevenueRecovered = campaigns.reduce(
    (sum, c) => sum + Number(c.revenueRecovered || 0),
    0
  );

  // Email metrics (would be updated by webhook handlers in real implementation)
  const emailOpenRate = null; // TODO: Calculate from action execution results
  const emailClickRate = null; // TODO: Calculate from action execution results

  // Upsert metrics
  return prisma.campaignMetrics.upsert({
    where: {
      organizationId_strategyId_period_periodType: {
        organizationId,
        strategyId: strategyId || '',
        period,
        periodType,
      },
    },
    create: {
      organizationId,
      strategyId,
      period,
      periodType,
      totalCampaigns,
      activeCampaigns,
      completedCampaigns,
      convertedCampaigns,
      cancelledCampaigns,
      emailsSent,
      discountsCreated,
      outreachTasks,
      usageNudges,
      conversionRate,
      avgTimeToConversion,
      totalRevenueRecovered,
      emailOpenRate,
      emailClickRate,
    },
    update: {
      totalCampaigns,
      activeCampaigns,
      completedCampaigns,
      convertedCampaigns,
      cancelledCampaigns,
      emailsSent,
      discountsCreated,
      outreachTasks,
      usageNudges,
      conversionRate,
      avgTimeToConversion,
      totalRevenueRecovered,
      emailOpenRate,
      emailClickRate,
    },
  });
}

/**
 * Get campaign dashboard stats
 */
export async function getCampaignStats(
  organizationId: string
): Promise<CampaignStats> {
  // Get active campaigns
  const activeCampaigns = await prisma.campaign.count({
    where: {
      organizationId,
      status: 'ACTIVE',
    },
  });

  // Get conversion rate (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentCampaigns = await prisma.campaign.findMany({
    where: {
      organizationId,
      startedAt: { gte: thirtyDaysAgo },
    },
  });

  const convertedCount = recentCampaigns.filter((c) => c.status === 'CONVERTED').length;
  const conversionRate =
    recentCampaigns.length > 0 ? (convertedCount / recentCampaigns.length) * 100 : 0;

  // Get total revenue recovered
  const revenueRecovered = recentCampaigns.reduce(
    (sum, c) => sum + Number(c.revenueRecovered || 0),
    0
  );

  // Get top strategies
  const strategies = await prisma.retentionStrategy.findMany({
    where: { organizationId },
    include: {
      campaigns: {
        where: { startedAt: { gte: thirtyDaysAgo } },
      },
    },
  });

  const topStrategies = strategies
    .map((strategy) => ({
      strategyId: strategy.id,
      strategyName: strategy.name,
      conversions: strategy.campaigns.filter((c) => c.status === 'CONVERTED').length,
      revenueRecovered: strategy.campaigns.reduce(
        (sum, c) => sum + Number(c.revenueRecovered || 0),
        0
      ),
    }))
    .sort((a, b) => b.conversions - a.conversions)
    .slice(0, 5);

  // Get recent campaigns
  const recentCampaignsList = await prisma.campaign.findMany({
    where: { organizationId },
    orderBy: { startedAt: 'desc' },
    take: 10,
    include: {
      customer: { select: { name: true } },
    },
  });

  return {
    activeCampaigns,
    conversionRate,
    revenueRecovered,
    topStrategies,
    recentCampaigns: recentCampaignsList.map((c) => ({
      id: c.id,
      customerName: c.customer.name || 'Unknown',
      status: c.status,
      triggerType: c.triggerType,
      startedAt: c.startedAt,
      convertedAt: c.convertedAt || undefined,
    })),
  };
}
