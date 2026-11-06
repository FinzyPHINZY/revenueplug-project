/**
 * Usage Nudge Action Executor
 * Sends behavioral events to Mixpanel to trigger in-app notifications or nudges
 */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import type { CampaignAction } from '@prisma/client';
import { sendUsageNudge } from '../../../infrastructure/mixpanel/client.js';
import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import type {
  CampaignWithRelations,
  ExecuteActionResult,
  FeatureHighlightActionConfig,
  UsageNudgeActionConfig,
} from '../types.js';

const log = logger.child({ module: 'nudge-action' });

/**
 * Execute a usage nudge action
 */
export async function executeUsageNudgeAction(
  action: CampaignAction,
  campaign: CampaignWithRelations
): Promise<ExecuteActionResult> {
  const operationLog = log.child({
    operation: 'executeUsageNudgeAction',
    actionId: action.id,
    campaignId: campaign.id,
    actionType: action.actionType,
  });

  try {
    const actionData = action.actionData as unknown as
      | UsageNudgeActionConfig
      | FeatureHighlightActionConfig;

    let nudgeType: string;
    let message: string;
    let properties: Record<string, any>;

    if (action.actionType === 'USAGE_NUDGE') {
      const nudgeData = actionData as UsageNudgeActionConfig;
      nudgeType = 'usage_nudge';
      message = nudgeData.message || 'Get the most out of your subscription';
      properties = {
        event_name: nudgeData.eventName,
        ...nudgeData.properties,
      };
    } else if (action.actionType === 'FEATURE_HIGHLIGHT') {
      const highlightData = actionData as FeatureHighlightActionConfig;
      nudgeType = 'feature_highlight';
      message = highlightData.message;
      properties = {
        feature: highlightData.feature,
        template_id: highlightData.templateId,
      };
    } else {
      const error = `Unknown action type: ${action.actionType}`;
      operationLog.error(error);
      return { success: false, error };
    }

    // Send nudge to Mixpanel
    const result = await sendUsageNudge({
      userId: campaign.customer.externalId, // Use external customer ID
      nudgeType,
      message,
      properties: {
        campaign_id: campaign.id,
        action_id: action.id,
        organization_id: campaign.organizationId,
        trigger_type: campaign.triggerType,
        customer_email: campaign.customer.email,
        customer_name: campaign.customer.name,
        ...properties,
      },
    });

    if (!result.success) {
      operationLog.error({ error: result.error }, 'Failed to send usage nudge to Mixpanel');

      await prisma.campaignAction.update({
        where: { id: action.id },
        data: {
          status: 'FAILED',
          errorMessage: result.error,
          retryCount: { increment: 1 },
        },
      });

      return { success: false, error: result.error };
    }

    // Update action status
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'SENT',
        executedAt: new Date(),
        executionResult: {
          nudgeType,
          message,
          properties,
          sentAt: new Date().toISOString(),
        },
      },
    });

    operationLog.info({ nudgeType }, 'Usage nudge sent successfully');

    return {
      success: true,
      result: {
        mixpanelEventId: undefined, // Mixpanel doesn't return event IDs
        eventName: nudgeType,
        properties,
        sentAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute usage nudge action');

    // Update action with error
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        retryCount: { increment: 1 },
      },
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
