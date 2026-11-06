/**
 * Retention Campaign REST API Routes
 *
 * Endpoints for managing retention strategies, campaigns, templates, and analytics
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import {
  createStrategy,
  updateStrategy,
  listStrategies,
  getStrategy,
  deleteStrategy,
  triggerCampaign,
  markCampaignConverted,
  cancelCampaign,
  createEmailTemplate,
  updateEmailTemplate,
  renderTemplate,
} from './service.js';
import { aggregateOrganizationMetrics, runDailyAggregation } from './metrics-aggregation.js';
import { getQueueStats } from './queue.js';
import { requireAuth } from '../auth/middleware.js';
import { getOrganizationContext, requireOrganizationContext } from '../../shared/middleware/organization-context.js';

const log = logger.child({ module: 'retention-routes' });

// ============================================================================
// RETENTION STRATEGIES
// ============================================================================

/**
 * POST /api/retention/strategies
 * Create a new retention strategy
 */
async function handleCreateStrategy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const strategy = await createStrategy({
      organizationId,
      ...(request.body as any),
    });

    return reply.code(201).send(strategy);
  } catch (error) {
    log.error({ error }, 'Failed to create strategy');
    return reply.code(500).send({ error: 'Failed to create strategy' });
  }
}

/**
 * GET /api/retention/strategies
 * List all strategies for the organization
 */
async function handleListStrategies(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const status = (request.query as any).status as 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | undefined;
    const strategies = await listStrategies(organizationId, status);

    return reply.send(strategies);
  } catch (error) {
    log.error({ error }, 'Failed to list strategies');
    return reply.code(500).send({ error: 'Failed to list strategies' });
  }
}

/**
 * GET /api/retention/strategies/:id
 * Get a single strategy by ID
 */
async function handleGetStrategy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params as { id: string };

    const strategy = await getStrategy(id);

    if (!strategy) {
      return reply.code(404).send({ error: 'Strategy not found' });
    }

    // Check organization access
    if (strategy.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return reply.send(strategy);
  } catch (error) {
    log.error({ error }, 'Failed to get strategy');
    return reply.code(500).send({ error: 'Failed to get strategy' });
  }
}

/**
 * PUT /api/retention/strategies/:id
 * Update a strategy
 */
async function handleUpdateStrategy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    const strategy = await updateStrategy(id, request.body);
    return reply.send(strategy);
  } catch (error) {
    log.error({ error }, 'Failed to update strategy');
    return reply.code(500).send({ error: 'Failed to update strategy' });
  }
}

/**
 * DELETE /api/retention/strategies/:id
 * Delete (archive) a strategy
 */
async function handleDeleteStrategy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    await deleteStrategy(id);
    return reply.code(204).send();
  } catch (error) {
    log.error({ error }, 'Failed to delete strategy');
    return reply.code(500).send({ error: 'Failed to delete strategy' });
  }
}

// ============================================================================
// CAMPAIGNS
// ============================================================================

/**
 * POST /api/retention/campaigns/trigger
 * Manually trigger a campaign for a customer
 */
async function handleTriggerCampaign(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { strategyId, customerId, triggerType, triggerContext } = request.body as any;

    const campaign = await triggerCampaign({
      strategyId,
      customerId,
      triggerType,
      triggerContext,
    });

    if (!campaign) {
      return reply.code(400).send({ error: 'Campaign not triggered (cooldown or filters)' });
    }

    return reply.code(201).send(campaign);
  } catch (error) {
    log.error({ error }, 'Failed to trigger campaign');
    return reply.code(500).send({ error: 'Failed to trigger campaign' });
  }
}

/**
 * GET /api/retention/campaigns
 * List campaigns with filters
 */
async function handleListCampaigns(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const {
      status,
      strategyId,
      customerId,
      triggerType,
      limit = '50',
      offset = '0',
    } = request.query as any;

    const campaigns = await prisma.campaign.findMany({
      where: {
        organizationId,
        ...(status && { status: status as any }),
        ...(strategyId && { strategyId: strategyId as string }),
        ...(customerId && { customerId: customerId as string }),
        ...(triggerType && { triggerType: triggerType as any }),
      },
      include: {
        customer: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        strategy: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: {
            actions: true,
          },
        },
      },
      orderBy: { startedAt: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    // Get total count
    const total = await prisma.campaign.count({
      where: {
        organizationId,
        ...(status && { status: status as any }),
        ...(strategyId && { strategyId: strategyId as string }),
        ...(customerId && { customerId: customerId as string }),
        ...(triggerType && { triggerType: triggerType as any }),
      },
    });

    return reply.send({
      campaigns,
      pagination: {
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      },
    });
  } catch (error) {
    log.error({ error }, 'Failed to list campaigns');
    return reply.code(500).send({ error: 'Failed to list campaigns' });
  }
}

/**
 * GET /api/retention/campaigns/:id
 * Get campaign details with actions
 */
async function handleGetCampaign(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        customer: true,
        strategy: true,
        actions: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!campaign) {
      return reply.code(404).send({ error: 'Campaign not found' });
    }

    if (campaign.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return reply.send(campaign);
  } catch (error) {
    log.error({ error }, 'Failed to get campaign');
    return reply.code(500).send({ error: 'Failed to get campaign' });
  }
}

/**
 * POST /api/retention/campaigns/:id/convert
 * Mark a campaign as converted
 */
async function handleConvertCampaign(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    const { revenueRecovered } = request.body as any;
    await markCampaignConverted(id, revenueRecovered);
    return reply.code(200).send({ success: true });
  } catch (error) {
    log.error({ error }, 'Failed to mark campaign as converted');
    return reply.code(500).send({ error: 'Failed to mark campaign as converted' });
  }
}

/**
 * POST /api/retention/campaigns/:id/cancel
 * Cancel a campaign
 */
async function handleCancelCampaign(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    const { reason } = request.body as any;
    await cancelCampaign(id, reason);
    return reply.code(200).send({ success: true });
  } catch (error) {
    log.error({ error }, 'Failed to cancel campaign');
    return reply.code(500).send({ error: 'Failed to cancel campaign' });
  }
}

// ============================================================================
// EMAIL SEQUENCES
// ============================================================================

/**
 * POST /api/retention/campaigns/:id/sequences
 * Create a multi-step email sequence for a campaign
 */
async function handleCreateSequence(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    const { sequence } = request.body as any;

    if (!sequence) {
      return reply.code(400).send({ error: 'Sequence definition required' });
    }

    const { createSequence } = await import('./sequences.js');
    const result = await createSequence(id, sequence);

    return reply.code(201).send({
      success: true,
      scheduledActions: result.scheduledActions,
    });
  } catch (error) {
    log.error({ error }, 'Failed to create sequence');
    return reply.code(500).send({ error: 'Failed to create sequence' });
  }
}

/**
 * GET /api/retention/campaigns/:id/sequences/progress
 * Get progress of email sequences for a campaign
 */
async function handleGetSequenceProgress(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    const { getSequenceProgress } = await import('./sequences.js');
    const progress = await getSequenceProgress(id);

    return reply.send(progress);
  } catch (error) {
    log.error({ error }, 'Failed to get sequence progress');
    return reply.code(500).send({ error: 'Failed to get sequence progress' });
  }
}

/**
 * POST /api/retention/campaigns/:id/sequences/:sequenceId/cancel
 * Cancel a specific sequence
 */
async function handleCancelSequence(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id, sequenceId } = request.params as { id: string; sequenceId: string };
    const { cancelSequence } = await import('./sequences.js');
    const result = await cancelSequence(id, sequenceId);

    return reply.send({
      success: true,
      cancelledActions: result.cancelledActions,
    });
  } catch (error) {
    log.error({ error }, 'Failed to cancel sequence');
    return reply.code(500).send({ error: 'Failed to cancel sequence' });
  }
}

/**
 * GET /api/retention/sequences/templates
 * Get predefined sequence templates
 */
async function handleGetSequenceTemplates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { SequenceTemplates } = await import('./sequences.js');

    // Return template definitions (without actual template IDs)
    return reply.send({
      templates: [
        {
          name: 'trialEndingSequence',
          description: '3-email trial reminder sequence (7d, 3d, 1d before trial ends)',
          steps: 3,
          stopOnConversion: true,
        },
        {
          name: 'paymentRecoverySequence',
          description: 'Escalating payment reminder sequence (gentle, urgent, final)',
          steps: 3,
          stopOnConversion: true,
        },
        {
          name: 'churnPreventionSequence',
          description: 'Multi-touch churn prevention with engagement-based branching',
          steps: 1,
          branches: 2,
          stopOnConversion: true,
        },
      ],
    });
  } catch (error) {
    log.error({ error }, 'Failed to get sequence templates');
    return reply.code(500).send({ error: 'Failed to get sequence templates' });
  }
}

// ============================================================================
// CONVERSION FUNNEL TRACKING
// ============================================================================

/**
 * GET /api/retention/analytics/funnel
 * Get conversion funnel data for campaigns
 */
async function handleGetAnalyticsFunnel(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { strategyId, days = '30', triggerType } = request.query as any;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days as string));

    const whereClause: any = {
      organizationId,
      startedAt: { gte: startDate },
    };

    if (strategyId) {
      whereClause.strategyId = strategyId as string;
    }

    if (triggerType) {
      whereClause.triggerType = triggerType;
    }

    // Get funnel counts
    const [
      triggered,
      active,
      converted,
      cancelled,
      failed,
      completed,
    ] = await Promise.all([
      prisma.campaign.count({ where: whereClause }),
      prisma.campaign.count({ where: { ...whereClause, status: 'ACTIVE' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'CONVERTED' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'CANCELLED' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'FAILED' } }),
      prisma.campaign.count({ where: { ...whereClause, status: 'COMPLETED' } }),
    ]);

    // Get action funnel for campaigns
    const campaigns = await prisma.campaign.findMany({
      where: whereClause,
      select: { id: true },
    });

    const campaignIds = campaigns.map((c) => c.id);

    const [
      actionsPending,
      actionsScheduled,
      actionsSent,
      actionsDelivered,
      actionsOpened,
      actionsClicked,
      actionsConverted,
      actionsFailed,
    ] = await Promise.all([
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'PENDING' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'SCHEDULED' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'SENT' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'DELIVERED' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'OPENED' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'CLICKED' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'CONVERTED' },
      }),
      prisma.campaignAction.count({
        where: { campaignId: { in: campaignIds }, status: 'FAILED' },
      }),
    ]);

    // Calculate conversion rates
    const campaignConversionRate = triggered > 0 ? (converted / triggered) * 100 : 0;
    const emailOpenRate = actionsDelivered > 0 ? (actionsOpened / actionsDelivered) * 100 : 0;
    const emailClickRate = actionsDelivered > 0 ? (actionsClicked / actionsDelivered) * 100 : 0;

    return reply.send({
      period: {
        days: parseInt(days as string),
        startDate: startDate.toISOString(),
        endDate: new Date().toISOString(),
      },
      campaignFunnel: {
        triggered,
        active,
        converted,
        cancelled,
        failed,
        completed,
        conversionRate: parseFloat(campaignConversionRate.toFixed(2)),
      },
      actionFunnel: {
        pending: actionsPending,
        scheduled: actionsScheduled,
        sent: actionsSent,
        delivered: actionsDelivered,
        opened: actionsOpened,
        clicked: actionsClicked,
        converted: actionsConverted,
        failed: actionsFailed,
        emailOpenRate: parseFloat(emailOpenRate.toFixed(2)),
        emailClickRate: parseFloat(emailClickRate.toFixed(2)),
      },
    });
  } catch (error) {
    log.error({ error }, 'Failed to get funnel data');
    return reply.code(500).send({ error: 'Failed to get funnel data' });
  }
}

/**
 * GET /api/retention/analytics/metrics
 * Get aggregated campaign metrics
 */
async function handleGetAnalyticsMetrics(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { strategyId, periodType = 'DAILY', limit = '30' } = request.query as any;

    const metrics = await prisma.campaignMetrics.findMany({
      where: {
        organizationId,
        ...(strategyId && { strategyId: strategyId as string }),
        periodType: periodType as any,
      },
      orderBy: { period: 'desc' },
      take: parseInt(limit as string),
    });

    return reply.send(metrics);
  } catch (error) {
    log.error({ error }, 'Failed to get metrics');
    return reply.code(500).send({ error: 'Failed to get metrics' });
  }
}

/**
 * POST /api/retention/analytics/aggregate
 * Manually trigger metrics aggregation (admin only)
 */
async function handleAggregateMetrics(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { period, periodType = 'DAILY' } = request.body as any;

    const periodDate = period ? new Date(period) : new Date();

    await aggregateOrganizationMetrics(organizationId, periodDate, periodType as any);

    return reply.send({ success: true, message: 'Metrics aggregated successfully' });
  } catch (error) {
    log.error({ error }, 'Failed to aggregate metrics');
    return reply.code(500).send({ error: 'Failed to aggregate metrics' });
  }
}

// ============================================================================
// ROI CALCULATOR
// ============================================================================

/**
 * GET /api/retention/roi
 * Calculate ROI for retention campaigns
 */
async function handleCalculateROI(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { startDate, endDate, emailCost, discountMultiplier, laborCost } = request.query as any;

    // Default to last 30 days
    const end = endDate ? new Date(endDate as string) : new Date();
    const start = startDate ? new Date(startDate as string) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const config = {
      emailCostCents: emailCost ? parseInt(emailCost as string) : undefined,
      discountCostMultiplier: discountMultiplier ? parseFloat(discountMultiplier as string) : undefined,
      laborCostPerHourCents: laborCost ? parseInt(laborCost as string) : undefined,
    };

    const { calculateROI } = await import('./roi-calculator.js');
    const metrics = await calculateROI(organizationId, start, end, config);

    return reply.send(metrics);
  } catch (error) {
    log.error({ error }, 'Failed to calculate ROI');
    return reply.code(500).send({ error: 'Failed to calculate ROI' });
  }
}

/**
 * GET /api/retention/roi/strategy/:strategyId
 * Calculate ROI for a specific strategy
 */
async function handleCalculateStrategyROI(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { strategyId } = request.params as { strategyId: string };
    const { startDate, endDate } = request.query as any;

    const end = endDate ? new Date(endDate as string) : new Date();
    const start = startDate ? new Date(startDate as string) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const { calculateStrategyROI } = await import('./roi-calculator.js');
    const result = await calculateStrategyROI(strategyId, start, end);

    return reply.send(result);
  } catch (error) {
    log.error({ error }, 'Failed to calculate strategy ROI');
    return reply.code(500).send({ error: 'Failed to calculate strategy ROI' });
  }
}

/**
 * GET /api/retention/roi/trends
 * Get ROI trends over time
 */
async function handleGetROITrends(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { periodType = 'month', periods = '12' } = request.query as any;

    const { getROITrends } = await import('./roi-calculator.js');
    const trends = await getROITrends(
      organizationId,
      periodType as 'day' | 'week' | 'month',
      parseInt(periods as string)
    );

    return reply.send({ trends });
  } catch (error) {
    log.error({ error }, 'Failed to get ROI trends');
    return reply.code(500).send({ error: 'Failed to get ROI trends' });
  }
}

/**
 * GET /api/retention/roi/projection
 * Project future ROI based on current trends
 */
async function handleProjectROI(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { monthsAhead = '12' } = request.query as any;

    const { projectROI } = await import('./roi-calculator.js');
    const projection = await projectROI(organizationId, parseInt(monthsAhead as string));

    return reply.send(projection);
  } catch (error) {
    log.error({ error }, 'Failed to project ROI');
    return reply.code(500).send({ error: 'Failed to project ROI' });
  }
}

// ============================================================================
// COHORT ANALYSIS
// ============================================================================

/**
 * GET /api/retention/cohorts
 * Analyze campaigns by cohort
 */
async function handleAnalyzeCohorts(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const {
      period = 'month',
      cohortsBack = '12',
      maxAgeDays = '30',
      triggerType,
      strategyId,
    } = request.query as any;

    const { analyzeCohorts } = await import('./cohort-analysis.js');
    const analysis = await analyzeCohorts(organizationId, {
      period: period as any,
      cohortsBack: parseInt(cohortsBack as string),
      maxAgeDays: parseInt(maxAgeDays as string),
      triggerType: triggerType as string,
      strategyId: strategyId as string,
    });

    return reply.send(analysis);
  } catch (error) {
    log.error({ error }, 'Failed to analyze cohorts');
    return reply.code(500).send({ error: 'Failed to analyze cohorts' });
  }
}

/**
 * GET /api/retention/cohorts/retention-curve
 * Get cohort retention curve
 */
async function handleGetCohortRetentionCurve(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { period = 'month', maxAgeDays = '30' } = request.query as any;

    const { getCohortRetentionCurve } = await import('./cohort-analysis.js');
    const curve = await getCohortRetentionCurve(
      organizationId,
      period as any,
      parseInt(maxAgeDays as string)
    );

    return reply.send(curve);
  } catch (error) {
    log.error({ error }, 'Failed to get retention curve');
    return reply.code(500).send({ error: 'Failed to get retention curve' });
  }
}

/**
 * GET /api/retention/cohorts/compare-strategies
 * Compare cohort performance across strategies
 */
async function handleCompareCohortsByStrategy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { period = 'month', strategies } = request.query as any;

    if (!strategies) {
      return reply.code(400).send({ error: 'Strategies parameter required' });
    }

    const strategyIds = (strategies as string).split(',');

    const { compareCohortsByStrategy } = await import('./cohort-analysis.js');
    const comparison = await compareCohortsByStrategy(
      organizationId,
      period as any,
      strategyIds
    );

    return reply.send(comparison);
  } catch (error) {
    log.error({ error }, 'Failed to compare cohorts by strategy');
    return reply.code(500).send({ error: 'Failed to compare cohorts by strategy' });
  }
}

/**
 * GET /api/retention/cohorts/funnel
 * Get cohort funnel analysis
 */
async function handleGetCohortFunnel(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { startDate, endDate } = request.query as any;

    if (!startDate || !endDate) {
      return reply.code(400).send({ error: 'startDate and endDate required' });
    }

    const { getCohortFunnel } = await import('./cohort-analysis.js');
    const funnel = await getCohortFunnel(
      organizationId,
      new Date(startDate as string),
      new Date(endDate as string)
    );

    return reply.send(funnel);
  } catch (error) {
    log.error({ error }, 'Failed to get cohort funnel');
    return reply.code(500).send({ error: 'Failed to get cohort funnel' });
  }
}

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

/**
 * POST /api/retention/templates
 * Create a new email template
 */
async function handleCreateTemplate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const template = await createEmailTemplate({
      organizationId,
      ...(request.body as any),
    });

    return reply.code(201).send(template);
  } catch (error) {
    log.error({ error }, 'Failed to create template');
    return reply.code(500).send({ error: 'Failed to create template' });
  }
}

/**
 * GET /api/retention/templates
 * List email templates
 */
async function handleListTemplates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { category, status } = request.query as any;

    const templates = await prisma.emailTemplate.findMany({
      where: {
        organizationId,
        ...(category && { category: category as any }),
        ...(status && { status: status as any }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(templates);
  } catch (error) {
    log.error({ error }, 'Failed to list templates');
    return reply.code(500).send({ error: 'Failed to list templates' });
  }
}

/**
 * GET /api/retention/templates/:id
 * Get a single template
 */
async function handleGetTemplate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params as { id: string };

    const template = await prisma.emailTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }

    if (template.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return reply.send(template);
  } catch (error) {
    log.error({ error }, 'Failed to get template');
    return reply.code(500).send({ error: 'Failed to get template' });
  }
}

/**
 * PUT /api/retention/templates/:id
 * Update a template
 */
async function handleUpdateTemplate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    const template = await updateEmailTemplate(id, request.body);
    return reply.send(template);
  } catch (error) {
    log.error({ error }, 'Failed to update template');
    return reply.code(500).send({ error: 'Failed to update template' });
  }
}

/**
 * DELETE /api/retention/templates/:id
 * Delete a template
 */
async function handleDeleteTemplate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id } = request.params as { id: string };
    await prisma.emailTemplate.delete({
      where: { id },
    });

    return reply.code(204).send();
  } catch (error) {
    log.error({ error }, 'Failed to delete template');
    return reply.code(500).send({ error: 'Failed to delete template' });
  }
}

// ============================================================================
// A/B TESTING
// ============================================================================

/**
 * POST /api/retention/ab-tests
 * Create a new A/B test for email templates
 */
async function handleCreateABTest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { createABTest } = await import('./ab-testing.js');
    const result = await createABTest(organizationId, request.body as any);

    return reply.code(201).send(result);
  } catch (error) {
    log.error({ error }, 'Failed to create A/B test');
    return reply.code(500).send({ error: 'Failed to create A/B test' });
  }
}

/**
 * GET /api/retention/ab-tests
 * List all active A/B tests
 */
async function handleListABTests(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { listABTests } = await import('./ab-testing.js');
    const tests = await listABTests(organizationId);

    return reply.send({ tests });
  } catch (error) {
    log.error({ error }, 'Failed to list A/B tests');
    return reply.code(500).send({ error: 'Failed to list A/B tests' });
  }
}

/**
 * GET /api/retention/ab-tests/:controlTemplateId/results
 * Get A/B test results with statistical analysis
 */
async function handleGetABTestResults(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { controlTemplateId } = request.params as { controlTemplateId: string };
    const { minSampleSize, confidenceLevel } = request.query as any;

    const { getABTestResults } = await import('./ab-testing.js');
    const results = await getABTestResults(controlTemplateId, {
      minSampleSize: minSampleSize ? parseInt(minSampleSize as string) : undefined,
      confidenceLevel: confidenceLevel ? parseInt(confidenceLevel as string) : undefined,
    });

    return reply.send(results);
  } catch (error) {
    log.error({ error }, 'Failed to get A/B test results');
    return reply.code(500).send({ error: 'Failed to get A/B test results' });
  }
}

/**
 * POST /api/retention/ab-tests/:variantTemplateId/promote
 * Promote a winning variant to be the new control
 */
async function handlePromoteVariant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { variantTemplateId } = request.params as { variantTemplateId: string };
    const { promoteVariant } = await import('./ab-testing.js');
    await promoteVariant(variantTemplateId);

    return reply.send({ success: true, message: 'Variant promoted successfully' });
  } catch (error) {
    log.error({ error }, 'Failed to promote variant');
    return reply.code(500).send({ error: 'Failed to promote variant' });
  }
}

// ============================================================================
// RETENTION PLAYBOOKS
// ============================================================================

/**
 * GET /api/retention/playbooks/library
 * List built-in playbook templates
 */
async function handleListBuiltinPlaybooks(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { listBuiltinPlaybooks } = await import('./playbooks.js');
    const playbooks = listBuiltinPlaybooks();

    return reply.code(200).send({ playbooks });
  } catch (error) {
    log.error({ error }, 'Failed to list built-in playbooks');
    return reply.code(500).send({ error: 'Failed to list playbooks' });
  }
}

/**
 * GET /api/retention/playbooks/library/:id
 * Get a specific built-in playbook
 */
async function handleGetBuiltinPlaybook(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { getBuiltinPlaybook } = await import('./playbooks.js');
    const playbook = getBuiltinPlaybook(request.params.id);

    if (!playbook) {
      return reply.code(404).send({ error: 'Playbook not found' });
    }

    return reply.code(200).send(playbook);
  } catch (error) {
    log.error({ error }, 'Failed to get built-in playbook');
    return reply.code(500).send({ error: 'Failed to get playbook' });
  }
}

/**
 * GET /api/retention/playbooks/export/:strategyId
 * Export a strategy as a playbook
 */
async function handleExportPlaybook(
  request: FastifyRequest<{ Params: { strategyId: string } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    // Verify strategy belongs to organization
    const strategy = await prisma.retentionStrategy.findFirst({
      where: {
        id: request.params.strategyId,
        organizationId,
      },
    });

    if (!strategy) {
      return reply.code(404).send({ error: 'Strategy not found' });
    }

    const { exportStrategyAsPlaybook } = await import('./playbooks.js');
    const playbook = await exportStrategyAsPlaybook(request.params.strategyId);

    // Set headers for download
    return reply
      .code(200)
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${playbook.name.replace(/[^a-z0-9]/gi, '-')}-playbook.json"`)
      .send(playbook);
  } catch (error) {
    log.error({ error }, 'Failed to export playbook');
    return reply.code(500).send({ error: 'Failed to export playbook' });
  }
}

/**
 * POST /api/retention/playbooks/import
 * Import a playbook and create a strategy
 */
async function handleImportPlaybook(
  request: FastifyRequest<{
    Body: {
      playbook: any;
      namePrefix?: string;
      createTemplates?: boolean;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { playbook, namePrefix, createTemplates } = request.body as any;

    if (!playbook) {
      return reply.code(400).send({ error: 'Playbook data required' });
    }

    // Validate playbook first
    const { validatePlaybook } = await import('./playbooks.js');
    const validation = validatePlaybook(playbook);

    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Invalid playbook format',
        details: validation.errors,
      });
    }

    // Import playbook
    const { importPlaybook } = await import('./playbooks.js');
    const result = await importPlaybook(organizationId, playbook, {
      namePrefix,
      createTemplates: createTemplates ?? true,
    });

    return reply.code(201).send({
      success: true,
      strategyId: result.strategyId,
      templatesCreated: result.templatesCreated,
    });
  } catch (error) {
    log.error({ error }, 'Failed to import playbook');

    if (error instanceof Error && error.message.includes('already exists')) {
      return reply.code(409).send({ error: error.message });
    }

    return reply.code(500).send({ error: 'Failed to import playbook' });
  }
}

/**
 * POST /api/retention/playbooks/validate
 * Validate a playbook without importing
 */
async function handleValidatePlaybook(
  request: FastifyRequest<{ Body: { playbook: any } }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { playbook } = request.body as any;

    if (!playbook) {
      return reply.code(400).send({ error: 'Playbook data required' });
    }

    const { validatePlaybook } = await import('./playbooks.js');
    const validation = validatePlaybook(playbook);

    return reply.code(200).send(validation);
  } catch (error) {
    log.error({ error }, 'Failed to validate playbook');
    return reply.code(500).send({ error: 'Failed to validate playbook' });
  }
}

// ============================================================================
// USAGE NUDGES
// ============================================================================

/**
 * GET /api/retention/nudges/analyze/:customerId
 * Analyze feature usage for a customer
 */
async function handleAnalyzeUsage(
  request: FastifyRequest<{
    Params: {
      customerId: string;
    };
    Querystring: {
      lookbackDays?: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleAnalyzeUsage' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params;
    const lookbackDays = request.query.lookbackDays
      ? parseInt(request.query.lookbackDays, 10)
      : 30;

    // Verify customer belongs to organization
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        connection: {
          organizationId,
        },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const { analyzeCustomerUsage } = await import('./usage-nudge.js');
    const usage = await analyzeCustomerUsage(customerId, { lookbackDays });

    operationLog.info({ customerId }, 'Usage analyzed');

    return reply.code(200).send({ usage });
  } catch (error) {
    operationLog.error({ error }, 'Failed to analyze usage');
    return reply.code(500).send({
      error: 'Failed to analyze usage',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/retention/nudges/recommendations/:customerId
 * Get nudge recommendations for a customer
 */
async function handleGetNudgeRecommendations(
  request: FastifyRequest<{
    Params: {
      customerId: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleGetNudgeRecommendations' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params;

    // Verify customer belongs to organization
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        connection: {
          organizationId,
        },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const { getNudgeRecommendations } = await import('./usage-nudge.js');
    const recommendations = await getNudgeRecommendations(customerId);

    operationLog.info({ customerId, count: recommendations.length }, 'Recommendations generated');

    return reply.code(200).send({ recommendations });
  } catch (error) {
    operationLog.error({ error }, 'Failed to get recommendations');
    return reply.code(500).send({
      error: 'Failed to get recommendations',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/retention/nudges/send
 * Send a usage nudge
 */
async function handleSendNudge(
  request: FastifyRequest<{
    Body: {
      customerId: string;
      featureId: string;
      nudgeType: string;
      message: string;
      ctaText?: string;
      ctaUrl?: string;
      metadata?: Record<string, any>;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleSendNudge' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const body = request.body;

    // Verify customer belongs to organization
    const customer = await prisma.customer.findFirst({
      where: {
        id: body.customerId,
        connection: {
          organizationId,
        },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const { sendUsageNudge } = await import('./usage-nudge.js');
    const result = await sendUsageNudge(body as any);

    operationLog.info({ nudgeId: result.nudgeId }, 'Nudge sent');

    return reply.code(201).send(result);
  } catch (error) {
    operationLog.error({ error }, 'Failed to send nudge');
    return reply.code(500).send({
      error: 'Failed to send nudge',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/retention/nudges/send-recommended/:customerId
 * Send recommended nudges for a customer
 */
async function handleSendRecommendedNudges(
  request: FastifyRequest<{
    Params: {
      customerId: string;
    };
    Body: {
      maxNudges?: number;
      priorityFilter?: string[];
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleSendRecommendedNudges' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params;
    const body = request.body || {};

    // Verify customer belongs to organization
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        connection: {
          organizationId,
        },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const { sendRecommendedNudges } = await import('./usage-nudge.js');
    const result = await sendRecommendedNudges(customerId, {
      maxNudges: body.maxNudges,
      priorityFilter: body.priorityFilter as any,
    });

    operationLog.info({ customerId, ...result }, 'Recommended nudges sent');

    return reply.code(200).send(result);
  } catch (error) {
    operationLog.error({ error }, 'Failed to send recommended nudges');
    return reply.code(500).send({
      error: 'Failed to send recommended nudges',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/retention/nudges/:nudgeId/track
 * Track nudge interaction
 */
async function handleTrackNudgeInteraction(
  request: FastifyRequest<{
    Params: {
      nudgeId: string;
    };
    Body: {
      interaction: 'VIEWED' | 'CLICKED' | 'DISMISSED';
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleTrackNudgeInteraction' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { nudgeId } = request.params;
    const { interaction } = request.body;

    // Verify nudge belongs to organization
    const nudge = await prisma.campaignAction.findFirst({
      where: {
        id: nudgeId,
        campaign: {
          organizationId,
        },
      },
    });

    if (!nudge) {
      return reply.code(404).send({ error: 'Nudge not found' });
    }

    const { trackNudgeInteraction } = await import('./usage-nudge.js');
    await trackNudgeInteraction(nudgeId, interaction);

    operationLog.info({ nudgeId, interaction }, 'Interaction tracked');

    return reply.code(200).send({ success: true });
  } catch (error) {
    operationLog.error({ error }, 'Failed to track interaction');
    return reply.code(500).send({
      error: 'Failed to track interaction',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// DYNAMIC PRICING
// ============================================================================

/**
 * POST /api/retention/pricing/calculate/:customerId
 * Calculate optimal discount for a customer
 */
async function handleCalculateOptimalDiscount(
  request: FastifyRequest<{
    Params: { customerId: string };
    Body: {
      strategy?: 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE';
      maxDiscount?: number;
      minDiscount?: number;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleCalculateOptimalDiscount' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params;
    const body = request.body;

    // Verify customer belongs to organization
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        connection: { organizationId },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const { calculateOptimalDiscount } = await import('./dynamic-pricing.js');
    const recommendation = await calculateOptimalDiscount({
      customerId,
      ...body,
    } as any);

    operationLog.info(
      { customerId, recommendedDiscount: recommendation.recommendedDiscountPercent },
      'Discount calculated'
    );

    return reply.code(200).send(recommendation);
  } catch (error) {
    operationLog.error({ error }, 'Failed to calculate discount');
    return reply.code(500).send({
      error: 'Failed to calculate discount',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/retention/pricing/performance
 * Get discount performance analytics
 */
async function handleGetDiscountPerformance(
  request: FastifyRequest<{
    Querystring: {
      strategyId?: string;
      minSampleSize?: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleGetDiscountPerformance' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { strategyId, minSampleSize } = request.query;

    const { getDiscountPerformance } = await import('./dynamic-pricing.js');
    const performance = await getDiscountPerformance(organizationId, {
      strategyId,
      minSampleSize: minSampleSize ? parseInt(minSampleSize) : undefined,
    });

    operationLog.info({ performanceGroups: performance.length }, 'Performance retrieved');

    return reply.code(200).send({ performance });
  } catch (error) {
    operationLog.error({ error }, 'Failed to get discount performance');
    return reply.code(500).send({
      error: 'Failed to get discount performance',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/retention/pricing/history/:customerId
 * Get customer's discount history
 */
async function handleGetCustomerDiscountHistory(
  request: FastifyRequest<{
    Params: { customerId: string };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleGetCustomerDiscountHistory' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params;

    // Verify customer belongs to organization
    const customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        connection: { organizationId },
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const { getCustomerDiscountHistory } = await import('./dynamic-pricing.js');
    const history = await getCustomerDiscountHistory(customerId);

    operationLog.info({ customerId, discountsReceived: history.discountsReceived }, 'History retrieved');

    return reply.code(200).send(history);
  } catch (error) {
    operationLog.error({ error }, 'Failed to get discount history');
    return reply.code(500).send({
      error: 'Failed to get discount history',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// CAMPAIGN SCHEDULES
// ============================================================================

/**
 * POST /api/retention/schedules
 * Create a new campaign schedule
 */
async function handleCreateSchedule(
  request: FastifyRequest<{
    Body: {
      strategyId: string;
      name: string;
      description?: string;
      scheduleType: string;
      scheduledAt?: string;
      cronExpression?: string;
      dayOfWeek?: number;
      dayOfMonth?: number;
      timeOfDay?: string;
      audienceFilters?: Record<string, any>;
      maxRuns?: number;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleCreateSchedule' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const body = request.body;

    const { createSchedule } = await import('./scheduler.js');

    const schedule = await createSchedule({
      ...body,
      organizationId,
    } as any);

    operationLog.info({ scheduleId: schedule.id }, 'Schedule created');

    return reply.code(201).send({
      id: schedule.id,
      name: schedule.name,
      description: schedule.description,
      strategyId: schedule.strategyId,
      scheduleType: schedule.scheduleType,
      status: schedule.status,
      nextRunAt: schedule.nextRunAt,
      scheduledAt: schedule.scheduledAt,
      cronExpression: schedule.cronExpression,
      dayOfWeek: schedule.dayOfWeek,
      dayOfMonth: schedule.dayOfMonth,
      timeOfDay: schedule.timeOfDay,
      audienceFilters: schedule.audienceFilters,
      maxRuns: schedule.maxRuns,
      runCount: schedule.runCount,
      lastRunAt: schedule.lastRunAt,
      lastRunCampaignCount: schedule.lastRunCampaignCount,
      createdAt: schedule.createdAt,
    });
  } catch (error) {
    operationLog.error({ error }, 'Failed to create schedule');
    return reply.code(500).send({
      error: 'Failed to create schedule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/retention/schedules
 * List campaign schedules
 */
async function handleListSchedules(
  request: FastifyRequest<{
    Querystring: {
      strategyId?: string;
      status?: string;
      scheduleType?: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { strategyId, status, scheduleType } = request.query;

    const { listSchedules } = await import('./scheduler.js');

    const schedules = await listSchedules(organizationId, {
      strategyId,
      status: status as any,
      scheduleType: scheduleType as any,
    });

    return reply.code(200).send({ schedules });
  } catch (error) {
    log.error({ error }, 'Failed to list schedules');
    return reply.code(500).send({ error: 'Failed to list schedules' });
  }
}

/**
 * GET /api/retention/schedules/:id
 * Get a specific schedule
 */
async function handleGetSchedule(
  request: FastifyRequest<{
    Params: {
      id: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params;

    const { getSchedule } = await import('./scheduler.js');

    const schedule = await getSchedule(id);

    if (!schedule) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }

    // Check organization access
    if (schedule.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    return reply.code(200).send(schedule);
  } catch (error) {
    log.error({ error }, 'Failed to get schedule');
    return reply.code(500).send({ error: 'Failed to get schedule' });
  }
}

/**
 * PUT /api/retention/schedules/:id
 * Update a schedule
 */
async function handleUpdateSchedule(
  request: FastifyRequest<{
    Params: {
      id: string;
    };
    Body: {
      name?: string;
      description?: string;
      scheduleType?: string;
      scheduledAt?: string;
      cronExpression?: string;
      dayOfWeek?: number;
      dayOfMonth?: number;
      timeOfDay?: string;
      audienceFilters?: Record<string, any>;
      maxRuns?: number;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleUpdateSchedule' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params;

    const { getSchedule, updateSchedule } = await import('./scheduler.js');

    // Check ownership
    const existing = await getSchedule(id);
    if (!existing) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }
    if (existing.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const schedule = await updateSchedule(id, request.body as any);

    operationLog.info({ scheduleId: schedule.id }, 'Schedule updated');

    return reply.code(200).send(schedule);
  } catch (error) {
    operationLog.error({ error }, 'Failed to update schedule');
    return reply.code(500).send({
      error: 'Failed to update schedule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * DELETE /api/retention/schedules/:id
 * Delete a schedule
 */
async function handleDeleteSchedule(
  request: FastifyRequest<{
    Params: {
      id: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleDeleteSchedule' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params;

    const { getSchedule, deleteSchedule } = await import('./scheduler.js');

    // Check ownership
    const existing = await getSchedule(id);
    if (!existing) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }
    if (existing.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    await deleteSchedule(id);

    operationLog.info({ scheduleId: id }, 'Schedule deleted');

    return reply.code(200).send({ success: true });
  } catch (error) {
    operationLog.error({ error }, 'Failed to delete schedule');
    return reply.code(500).send({ error: 'Failed to delete schedule' });
  }
}

/**
 * POST /api/retention/schedules/:id/pause
 * Pause a schedule
 */
async function handlePauseSchedule(
  request: FastifyRequest<{
    Params: {
      id: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handlePauseSchedule' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params;

    const { getSchedule, pauseSchedule } = await import('./scheduler.js');

    // Check ownership
    const existing = await getSchedule(id);
    if (!existing) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }
    if (existing.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const schedule = await pauseSchedule(id);

    operationLog.info({ scheduleId: id }, 'Schedule paused');

    return reply.code(200).send(schedule);
  } catch (error) {
    operationLog.error({ error }, 'Failed to pause schedule');
    return reply.code(500).send({ error: 'Failed to pause schedule' });
  }
}

/**
 * POST /api/retention/schedules/:id/resume
 * Resume a paused schedule
 */
async function handleResumeSchedule(
  request: FastifyRequest<{
    Params: {
      id: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleResumeSchedule' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params;

    const { getSchedule, resumeSchedule } = await import('./scheduler.js');

    // Check ownership
    const existing = await getSchedule(id);
    if (!existing) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }
    if (existing.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const schedule = await resumeSchedule(id);

    operationLog.info({ scheduleId: id }, 'Schedule resumed');

    return reply.code(200).send(schedule);
  } catch (error) {
    operationLog.error({ error }, 'Failed to resume schedule');
    return reply.code(500).send({ error: 'Failed to resume schedule' });
  }
}

/**
 * POST /api/retention/schedules/:id/execute
 * Manually execute a schedule (for testing)
 */
async function handleExecuteSchedule(
  request: FastifyRequest<{
    Params: {
      id: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> {
  const operationLog = log.child({ operation: 'handleExecuteSchedule' });

  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { id } = request.params;

    const { getSchedule, executeSchedule } = await import('./scheduler.js');

    // Check ownership
    const existing = await getSchedule(id);
    if (!existing) {
      return reply.code(404).send({ error: 'Schedule not found' });
    }
    if (existing.organizationId !== organizationId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const campaignCount = await executeSchedule(id);

    operationLog.info({ scheduleId: id, campaignCount }, 'Schedule executed manually');

    return reply.code(200).send({
      success: true,
      campaignsTriggered: campaignCount,
    });
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute schedule');
    return reply.code(500).send({
      error: 'Failed to execute schedule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================================
// SYSTEM / MONITORING
// ============================================================================

/**
 * GET /api/retention/queue/stats
 * Get queue statistics
 */
async function handleGetQueueStats(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const stats = await getQueueStats();
    return reply.send(stats);
  } catch (error) {
    log.error({ error }, 'Failed to get queue stats');
    return reply.code(500).send({ error: 'Failed to get queue stats' });
  }
}

/**
 * POST /api/retention/jobs/payment-predictions
 * Manually trigger payment prediction processing for organization
 */
async function handleProcessPaymentPredictions(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { daysAhead = 30 } = request.body as any;

    // Import and run payment prediction processing
    const { processPaymentPredictions } = await import('./triggers/payment-prediction-trigger.js');
    const result = await processPaymentPredictions(organizationId, daysAhead);

    return reply.send({
      message: 'Payment prediction processing completed',
      ...result,
    });
  } catch (error) {
    log.error({ error }, 'Failed to process payment predictions');
    return reply.code(500).send({ error: 'Failed to process payment predictions' });
  }
}

/**
 * POST /api/retention/jobs/daily-metrics
 * Manually trigger daily metrics aggregation
 */
async function handleRunDailyMetrics(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    await runDailyAggregation();

    return reply.send({ message: 'Daily metrics aggregation completed' });
  } catch (error) {
    log.error({ error }, 'Failed to run daily metrics aggregation');
    return reply.code(500).send({ error: 'Failed to run daily metrics aggregation' });
  }
}

/**
 * POST /api/retention/jobs/run-all
 * Manually trigger all scheduled retention jobs
 */
async function handleRunAllJobs(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { runAllRetentionJobs } = await import('./scheduled-jobs.js');
    await runAllRetentionJobs();

    return reply.send({ message: 'All retention jobs completed successfully' });
  } catch (error) {
    log.error({ error }, 'Failed to run all retention jobs');
    return reply.code(500).send({ error: 'Failed to run all retention jobs' });
  }
}

// ============================================================================
// DEFAULT TEMPLATES & SEEDING
// ============================================================================

/**
 * GET /api/retention/templates/defaults
 * List available default templates
 */
async function handleListDefaultTemplates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { listDefaultTemplates, getTemplateCategories } = await import(
      './templates/seed-templates.js'
    );

    const templates = listDefaultTemplates();
    const categories = getTemplateCategories();

    return reply.send({
      templates,
      categories,
      total: templates.length,
    });
  } catch (error) {
    log.error({ error }, 'Failed to list default templates');
    return reply.code(500).send({ error: 'Failed to list default templates' });
  }
}

/**
 * POST /api/retention/templates/seed
 * Seed default templates for organization
 * Body: { overwrite?: boolean, categories?: string[] }
 */
async function handleSeedTemplates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { overwrite, categories } = request.body as any;

    const { seedDefaultTemplates } = await import('./templates/seed-templates.js');
    const result = await seedDefaultTemplates(organizationId, {
      overwrite,
      categories,
    });

    return reply.send({
      message: 'Templates seeded successfully',
      ...result,
    });
  } catch (error) {
    log.error({ error }, 'Failed to seed templates');
    return reply.code(500).send({ error: 'Failed to seed templates' });
  }
}

/**
 * POST /api/retention/templates/seed/:category
 * Seed templates for a specific category
 */
async function handleSeedCategoryTemplates(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { category } = request.params as { category: string };

    const { seedCategoryTemplates } = await import('./templates/seed-templates.js');
    const result = await seedCategoryTemplates(organizationId, category);

    return reply.send({
      message: `${category} templates seeded successfully`,
      ...result,
    });
  } catch (error) {
    log.error({ error }, 'Failed to seed category templates');
    return reply.code(500).send({ error: 'Failed to seed category templates' });
  }
}

// ============================================================================
// EMAIL PREFERENCES & UNSUBSCRIBE
// ============================================================================

/**
 * GET /api/retention/preferences/:customerId
 * Get email preferences for a customer
 */
async function handleGetEmailPreferences(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params as { customerId: string };

    const { getOrCreateEmailPreferences } = await import('./email-preferences.js');
    const preferences = await getOrCreateEmailPreferences(customerId, organizationId);

    return reply.send(preferences);
  } catch (error) {
    log.error({ error }, 'Failed to get email preferences');
    return reply.code(500).send({ error: 'Failed to get email preferences' });
  }
}

/**
 * PATCH /api/retention/preferences/:customerId
 * Update email preferences for a customer
 */
async function handleUpdateEmailPreferences(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params as { customerId: string };

    const { updateEmailPreferences } = await import('./email-preferences.js');
    await updateEmailPreferences(customerId, organizationId, request.body);

    return reply.send({ message: 'Email preferences updated successfully' });
  } catch (error) {
    log.error({ error }, 'Failed to update email preferences');
    return reply.code(500).send({ error: 'Failed to update email preferences' });
  }
}

/**
 * POST /api/retention/unsubscribe
 * Unsubscribe customer from emails (public endpoint)
 * Body: { customerId, organizationId, category?, reason?, source? }
 */
async function handleUnsubscribe(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { unsubscribeCustomer } = await import('./email-preferences.js');
    await unsubscribeCustomer(request.body as any);

    return reply.send({ message: 'Successfully unsubscribed' });
  } catch (error) {
    log.error({ error }, 'Failed to unsubscribe customer');
    return reply.code(500).send({ error: 'Failed to unsubscribe' });
  }
}

/**
 * GET /api/retention/unsubscribe/:token
 * One-click unsubscribe using token (public endpoint)
 * Query: ?category=CHURN_PREVENTION (optional)
 */
async function handleUnsubscribeByToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { token } = request.params as { token: string };
    const { category } = request.query as any;

    const { unsubscribeByToken } = await import('./email-preferences.js');
    await unsubscribeByToken(token, category as any, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    // Return simple success page
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Unsubscribed - RevenuePlug</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              max-width: 600px;
              margin: 100px auto;
              padding: 20px;
              text-align: center;
            }
            h1 { color: #2563eb; }
            p { color: #64748b; line-height: 1.6; }
            a { color: #2563eb; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>✓ Successfully Unsubscribed</h1>
          <p>You've been unsubscribed ${category ? `from ${category.toLowerCase().replace('_', ' ')} emails` : 'from all emails'}.</p>
          <p><a href="/email-preferences?token=${token}">Manage your email preferences</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    log.error({ error }, 'Failed to unsubscribe by token');
    return reply.code(400).type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Error - RevenuePlug</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              max-width: 600px;
              margin: 100px auto;
              padding: 20px;
              text-align: center;
            }
            h1 { color: #dc2626; }
            p { color: #64748b; }
          </style>
        </head>
        <body>
          <h1>⚠ Invalid Token</h1>
          <p>This unsubscribe link is invalid or has expired.</p>
        </body>
      </html>
    `);
  }
}

/**
 * POST /api/retention/resubscribe/:customerId
 * Resubscribe customer to all emails
 */
async function handleResubscribe(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);
    const { customerId } = request.params as { customerId: string };

    const { resubscribeCustomer } = await import('./email-preferences.js');
    await resubscribeCustomer(customerId, organizationId);

    return reply.send({ message: 'Successfully resubscribed' });
  } catch (error) {
    log.error({ error }, 'Failed to resubscribe customer');
    return reply.code(500).send({ error: 'Failed to resubscribe' });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

/**
 * Register retention routes
 */
export async function registerRetentionRoutes(app: FastifyInstance): Promise<void> {
  // Protected routes - Retention Strategies
  app.post(
    '/api/retention/strategies',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreateStrategy
  );
  app.get(
    '/api/retention/strategies',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListStrategies
  );
  app.get(
    '/api/retention/strategies/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetStrategy
  );
  app.put(
    '/api/retention/strategies/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleUpdateStrategy
  );
  app.delete(
    '/api/retention/strategies/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleDeleteStrategy
  );

  // Protected routes - Campaigns
  app.post(
    '/api/retention/campaigns/trigger',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleTriggerCampaign
  );
  app.get(
    '/api/retention/campaigns',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListCampaigns
  );
  app.get(
    '/api/retention/campaigns/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetCampaign
  );
  app.post(
    '/api/retention/campaigns/:id/convert',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleConvertCampaign
  );
  app.post(
    '/api/retention/campaigns/:id/cancel',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCancelCampaign
  );

  // Protected routes - Email Sequences
  app.post(
    '/api/retention/campaigns/:id/sequences',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreateSequence
  );
  app.get(
    '/api/retention/campaigns/:id/sequences/progress',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetSequenceProgress
  );
  app.post(
    '/api/retention/campaigns/:id/sequences/:sequenceId/cancel',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCancelSequence
  );
  app.get(
    '/api/retention/sequences/templates',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetSequenceTemplates
  );

  // Protected routes - Analytics & Funnel
  app.get(
    '/api/retention/analytics/funnel',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetAnalyticsFunnel
  );
  app.get(
    '/api/retention/analytics/metrics',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetAnalyticsMetrics
  );
  app.post(
    '/api/retention/analytics/aggregate',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleAggregateMetrics
  );

  // Protected routes - ROI Calculator
  app.get(
    '/api/retention/roi',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCalculateROI
  );
  app.get(
    '/api/retention/roi/strategy/:strategyId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCalculateStrategyROI
  );
  app.get(
    '/api/retention/roi/trends',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetROITrends
  );
  app.get(
    '/api/retention/roi/projection',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleProjectROI
  );

  // Protected routes - Cohort Analysis
  app.get(
    '/api/retention/cohorts',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleAnalyzeCohorts
  );
  app.get(
    '/api/retention/cohorts/retention-curve',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetCohortRetentionCurve
  );
  app.get(
    '/api/retention/cohorts/compare-strategies',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCompareCohortsByStrategy
  );
  app.get(
    '/api/retention/cohorts/funnel',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetCohortFunnel
  );

  // Protected routes - Email Templates
  app.post(
    '/api/retention/templates',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreateTemplate
  );
  app.get(
    '/api/retention/templates',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListTemplates
  );
  app.get(
    '/api/retention/templates/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetTemplate
  );
  app.put(
    '/api/retention/templates/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleUpdateTemplate
  );
  app.delete(
    '/api/retention/templates/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleDeleteTemplate
  );

  // Protected routes - A/B Testing
  app.post(
    '/api/retention/ab-tests',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreateABTest
  );
  app.get(
    '/api/retention/ab-tests',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListABTests
  );
  app.get(
    '/api/retention/ab-tests/:controlTemplateId/results',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetABTestResults
  );
  app.post(
    '/api/retention/ab-tests/:variantTemplateId/promote',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handlePromoteVariant
  );

  // Protected routes - System / Monitoring
  app.get(
    '/api/retention/queue/stats',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetQueueStats
  );
  app.post(
    '/api/retention/jobs/payment-predictions',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleProcessPaymentPredictions
  );
  app.post(
    '/api/retention/jobs/daily-metrics',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleRunDailyMetrics
  );
  app.post(
    '/api/retention/jobs/run-all',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleRunAllJobs
  );

  // Protected routes - Default Templates & Seeding
  app.get(
    '/api/retention/templates/defaults',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListDefaultTemplates
  );
  app.post(
    '/api/retention/templates/seed',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleSeedTemplates
  );
  app.post(
    '/api/retention/templates/seed/:category',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleSeedCategoryTemplates
  );

  // Protected routes - Email Preferences
  app.get(
    '/api/retention/preferences/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetEmailPreferences
  );
  app.patch(
    '/api/retention/preferences/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleUpdateEmailPreferences
  );
  app.post(
    '/api/retention/resubscribe/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleResubscribe
  );

  // Protected routes - Retention Playbooks
  app.get(
    '/api/retention/playbooks/library',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListBuiltinPlaybooks
  );
  app.get(
    '/api/retention/playbooks/library/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetBuiltinPlaybook
  );
  app.get(
    '/api/retention/playbooks/export/:strategyId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleExportPlaybook
  );
  app.post(
    '/api/retention/playbooks/import',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleImportPlaybook
  );
  app.post(
    '/api/retention/playbooks/validate',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleValidatePlaybook
  );

  // Protected routes - Usage Nudges
  app.get(
    '/api/retention/nudges/analyze/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleAnalyzeUsage
  );
  app.get(
    '/api/retention/nudges/recommendations/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetNudgeRecommendations
  );
  app.post(
    '/api/retention/nudges/send',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleSendNudge
  );
  app.post(
    '/api/retention/nudges/send-recommended/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleSendRecommendedNudges
  );
  app.post(
    '/api/retention/nudges/:nudgeId/track',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleTrackNudgeInteraction
  );

  // Protected routes - Dynamic Pricing
  app.post(
    '/api/retention/pricing/calculate/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCalculateOptimalDiscount
  );
  app.get(
    '/api/retention/pricing/performance',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetDiscountPerformance
  );
  app.get(
    '/api/retention/pricing/history/:customerId',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetCustomerDiscountHistory
  );

  // Protected routes - Campaign Schedules
  app.post(
    '/api/retention/schedules',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleCreateSchedule
  );
  app.get(
    '/api/retention/schedules',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListSchedules
  );
  app.get(
    '/api/retention/schedules/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetSchedule
  );
  app.put(
    '/api/retention/schedules/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleUpdateSchedule
  );
  app.delete(
    '/api/retention/schedules/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleDeleteSchedule
  );
  app.post(
    '/api/retention/schedules/:id/pause',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handlePauseSchedule
  );
  app.post(
    '/api/retention/schedules/:id/resume',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleResumeSchedule
  );
  app.post(
    '/api/retention/schedules/:id/execute',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleExecuteSchedule
  );

  // Public routes - Unsubscribe (no auth required)
  app.post('/api/retention/unsubscribe', handleUnsubscribe);
  app.get('/api/retention/unsubscribe/:token', handleUnsubscribeByToken);

  logger.info('Registered retention routes');
}
