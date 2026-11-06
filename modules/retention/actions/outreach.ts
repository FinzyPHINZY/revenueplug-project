/**
 * Personal Outreach Action Executor
 * Creates tasks in HubSpot CRM for sales team follow-up
 */

import type { CampaignAction } from '@prisma/client';
import { createTask } from '../../../infrastructure/hubspot/client.js';
import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import type {
  CampaignWithRelations,
  ExecuteActionResult,
  PersonalOutreachActionConfig,
} from '../types.js';

const log = logger.child({ module: 'outreach-action' });

/**
 * Execute a personal outreach action
 */
export async function executePersonalOutreachAction(
  action: CampaignAction,
  campaign: CampaignWithRelations
): Promise<ExecuteActionResult> {
  const operationLog = log.child({
    operation: 'executePersonalOutreachAction',
    actionId: action.id,
    campaignId: campaign.id,
  });

  try {
    const actionData = action.actionData as unknown as PersonalOutreachActionConfig;
    const { taskDescription, assignedTo, priority = 'HIGH', dueInDays = 2 } = actionData;

    // Calculate due date
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueInDays);

    // Build task subject
    const subject = `[Retention] Follow up with ${campaign.customer.name || campaign.customer.email || 'Customer'} - ${campaign.triggerType}`;

    // Build task body with context
    const body = `
${taskDescription}

**Customer Details:**
- Name: ${campaign.customer.name || 'N/A'}
- Email: ${campaign.customer.email || 'N/A'}
- Customer ID: ${campaign.customer.externalId}

**Campaign Context:**
- Trigger: ${campaign.triggerType}
- Priority: ${campaign.priority}
- Triggered at: ${campaign.startedAt.toISOString()}

**Risk Signals:**
${JSON.stringify(campaign.triggerContext, null, 2)}

**Next Steps:**
1. Review customer account and usage history
2. Reach out via email or phone
3. Understand pain points and objections
4. Offer personalized solution or discount if needed
5. Schedule follow-up call if necessary

Campaign ID: ${campaign.id}
    `.trim();

    // Create task in HubSpot
    const result = await createTask({
      subject,
      body,
      priority,
      dueDate,
      assignedTo,
      contactEmail: campaign.customer.email || undefined,
    });

    if (!result.success) {
      operationLog.error({ error: result.error }, 'Failed to create HubSpot task');

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
          hubspotTaskId: result.id,
          assignedTo: assignedTo || 'unassigned',
          taskDescription,
          dueDate: dueDate.toISOString(),
          createdAt: new Date().toISOString(),
        },
      },
    });

    operationLog.info({ taskId: result.id }, 'HubSpot task created successfully');

    return {
      success: true,
      result: {
        hubspotTaskId: result.id,
        assignedTo: assignedTo || 'unassigned',
        taskDescription,
        createdAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute outreach action');

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
