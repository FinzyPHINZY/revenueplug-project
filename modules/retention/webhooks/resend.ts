/**
 * Resend Webhook Handler
 * Processes email delivery, open, click, and bounce events from Resend
 */

import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import type { ResendEmailEvent } from '../types.js';

const log = logger.child({ module: 'resend-webhook' });

/**
 * Handle Resend webhook event
 */
export async function handleResendWebhook(event: ResendEmailEvent): Promise<void> {
  const operationLog = log.child({
    operation: 'handleResendWebhook',
    eventType: event.type,
    emailId: event.data.email_id,
  });

  operationLog.info('Processing Resend email event');

  try {
    // Extract actionId from tags
    const actionTag = event.data.tags?.find((tag) => tag.name === 'action_id');

    if (!actionTag) {
      operationLog.warn('No action_id tag found in email, skipping');
      return;
    }

    const actionId = actionTag.value;

    // Find the campaign action
    const action = await prisma.campaignAction.findUnique({
      where: { id: actionId },
      include: {
        campaign: {
          select: {
            id: true,
            customerId: true,
            organizationId: true,
          },
        },
      },
    });

    if (!action) {
      operationLog.error({ actionId }, 'Campaign action not found');
      return;
    }

    // Process event based on type
    switch (event.type) {
      case 'email.delivered':
        await handleEmailDelivered(action, event);
        break;

      case 'email.opened':
        await handleEmailOpened(action, event);
        break;

      case 'email.clicked':
        await handleEmailClicked(action, event);
        break;

      case 'email.bounced':
        await handleEmailBounced(action, event);
        break;

      default:
        operationLog.warn({ eventType: event.type }, 'Unknown event type');
    }
  } catch (error) {
    operationLog.error({ error }, 'Failed to process Resend webhook');
    throw error;
  }
}

/**
 * Handle email delivered event
 */
async function handleEmailDelivered(
  action: any,
  event: ResendEmailEvent
): Promise<void> {
  const operationLog = log.child({
    operation: 'handleEmailDelivered',
    actionId: action.id,
  });

  try {
    // Update action status to DELIVERED
    const updatedAction = await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'DELIVERED',
        executionResult: {
          ...(action.executionResult as any),
          deliveredAt: event.data.created_at,
        },
      },
    });

    // Update email template delivery rate if templateId exists
    const actionData = action.actionData as any;
    if (actionData?.templateId) {
      await prisma.emailTemplate.update({
        where: { id: actionData.templateId },
        data: {
          sentCount: { increment: 1 },
        },
      });
    }

    operationLog.info('Email marked as delivered');
  } catch (error) {
    operationLog.error({ error }, 'Failed to update action on delivery');
  }
}

/**
 * Handle email opened event
 */
async function handleEmailOpened(action: any, event: ResendEmailEvent): Promise<void> {
  const operationLog = log.child({
    operation: 'handleEmailOpened',
    actionId: action.id,
  });

  try {
    // Only update if not already opened
    const currentResult = action.executionResult as any;
    if (currentResult?.openedAt) {
      operationLog.debug('Email already marked as opened, skipping');
      return;
    }

    // Update action status to OPENED
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'OPENED',
        executionResult: {
          ...currentResult,
          openedAt: event.data.created_at,
          opened: true,
        },
      },
    });

    // Update template open rate
    const actionData = action.actionData as any;
    if (actionData?.templateId) {
      const template = await prisma.emailTemplate.findUnique({
        where: { id: actionData.templateId },
      });

      if (template && template.sentCount > 0) {
        // Recalculate open rate
        const openedCount = await prisma.campaignAction.count({
          where: {
            actionData: {
              path: ['templateId'],
              equals: actionData.templateId,
            },
            status: { in: ['OPENED', 'CLICKED'] },
          },
        });

        const openRate = (openedCount / template.sentCount) * 100;

        await prisma.emailTemplate.update({
          where: { id: actionData.templateId },
          data: { openRate },
        });
      }
    }

    // Trigger sequence branch evaluation (for conditional branching)
    const { evaluateBranchConditions } = await import('../sequences.js');
    await evaluateBranchConditions(action.id).catch((error) => {
      operationLog.error({ error }, 'Failed to evaluate branch conditions');
      // Don't fail the webhook if branch evaluation fails
    });

    operationLog.info('Email marked as opened');
  } catch (error) {
    operationLog.error({ error }, 'Failed to update action on open');
  }
}

/**
 * Handle email clicked event
 */
async function handleEmailClicked(
  action: any,
  event: ResendEmailEvent
): Promise<void> {
  const operationLog = log.child({
    operation: 'handleEmailClicked',
    actionId: action.id,
  });

  try {
    // Update action status to CLICKED
    const currentResult = action.executionResult as any;
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'CLICKED',
        executionResult: {
          ...currentResult,
          clickedAt: event.data.created_at,
          clicked: true,
          opened: true, // Clicking implies opening
        },
      },
    });

    // Update template click rate
    const actionData = action.actionData as any;
    if (actionData?.templateId) {
      const template = await prisma.emailTemplate.findUnique({
        where: { id: actionData.templateId },
      });

      if (template && template.sentCount > 0) {
        // Recalculate click rate
        const clickedCount = await prisma.campaignAction.count({
          where: {
            actionData: {
              path: ['templateId'],
              equals: actionData.templateId,
            },
            status: 'CLICKED',
          },
        });

        const clickRate = (clickedCount / template.sentCount) * 100;

        await prisma.emailTemplate.update({
          where: { id: actionData.templateId },
          data: { clickRate },
        });
      }
    }

    // Trigger sequence branch evaluation (for conditional branching)
    const { evaluateBranchConditions } = await import('../sequences.js');
    await evaluateBranchConditions(action.id).catch((error) => {
      operationLog.error({ error }, 'Failed to evaluate branch conditions');
      // Don't fail the webhook if branch evaluation fails
    });

    operationLog.info('Email marked as clicked');
  } catch (error) {
    operationLog.error({ error }, 'Failed to update action on click');
  }
}

/**
 * Handle email bounced event
 */
async function handleEmailBounced(
  action: any,
  event: ResendEmailEvent
): Promise<void> {
  const operationLog = log.child({
    operation: 'handleEmailBounced',
    actionId: action.id,
  });

  try {
    // Update action status to FAILED
    const currentResult = action.executionResult as any;
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        status: 'FAILED',
        errorMessage: 'Email bounced',
        executionResult: {
          ...currentResult,
          bouncedAt: event.data.created_at,
        },
      },
    });

    operationLog.warn('Email bounced');
  } catch (error) {
    operationLog.error({ error }, 'Failed to update action on bounce');
  }
}

/**
 * Verify Resend webhook signature
 * (Resend doesn't currently support webhook signatures, but this is a placeholder)
 */
export function verifyResendSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  // TODO: Implement when Resend adds webhook signature support
  // For now, rely on HTTPS and keeping webhook URL secret
  return true;
}
