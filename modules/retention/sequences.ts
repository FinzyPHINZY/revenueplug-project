/**
 * Email Sequence Management Service
 *
 * Handles multi-step email sequences with conditional branching
 * Supports:
 * - Sequential email campaigns with delays
 * - Conditional branching based on customer behavior
 * - Automatic sequence progression
 * - Sequence cancellation on conversion
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import type { Campaign, CampaignAction } from '@prisma/client';

const log = logger.child({ module: 'retention-sequences' });

/**
 * Email sequence step definition
 */
export interface SequenceStep {
  stepNumber: number;
  templateId: string;
  delayMinutes: number; // Delay from previous step (0 for first step)
  branches?: SequenceBranch[];
}

/**
 * Conditional branch definition
 */
export interface SequenceBranch {
  condition: BranchCondition;
  onMatch: SequenceStep; // Step to execute if condition matches
  onNoMatch?: SequenceStep; // Step to execute if condition doesn't match (optional)
}

/**
 * Branch condition types
 */
export type BranchCondition =
  | 'EMAIL_OPENED'
  | 'EMAIL_CLICKED'
  | 'EMAIL_NOT_OPENED'
  | 'EMAIL_NOT_CLICKED'
  | 'PAYMENT_SUCCEEDED'
  | 'SUBSCRIPTION_REACTIVATED'
  | 'CONVERTED'
  | 'DISCOUNT_ACCEPTED'
  | 'TRIAL_CONVERTED';

/**
 * Sequence definition
 */
export interface EmailSequence {
  name: string;
  description?: string;
  steps: SequenceStep[];
  stopOnConversion?: boolean; // Stop sequence if customer converts (default: true)
}

/**
 * Create a multi-step email sequence for a campaign
 * Schedules all sequence steps with delays and branching logic
 */
export async function createSequence(
  campaignId: string,
  sequence: EmailSequence
): Promise<{ scheduledActions: number }> {
  const operationLog = log.child({
    operation: 'createSequence',
    campaignId,
    sequenceName: sequence.name,
  });

  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { customer: true },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    if (campaign.status === 'CANCELLED' || campaign.status === 'COMPLETED') {
      operationLog.warn('Campaign already cancelled or completed, skipping sequence');
      return { scheduledActions: 0 };
    }

    const sequenceId = `seq_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    let scheduledActions = 0;

    // Schedule first step immediately (or with configured delay)
    for (const step of sequence.steps) {
      const actionsCreated = await scheduleSequenceStep(
        campaignId,
        sequenceId,
        step,
        null, // No parent for first-level steps
        0 // No additional delay for first-level steps
      );
      scheduledActions += actionsCreated;
    }

    operationLog.info(
      { scheduledActions, sequenceId },
      'Email sequence created and scheduled'
    );

    return { scheduledActions };
  } catch (error) {
    operationLog.error({ error }, 'Failed to create email sequence');
    throw error;
  }
}

/**
 * Schedule a single sequence step (with optional branching)
 * Returns number of actions scheduled
 */
async function scheduleSequenceStep(
  campaignId: string,
  sequenceId: string,
  step: SequenceStep,
  parentActionId: string | null,
  accumulatedDelay: number
): Promise<number> {
  const operationLog = log.child({
    operation: 'scheduleSequenceStep',
    campaignId,
    sequenceId,
    stepNumber: step.stepNumber,
  });

  try {
    const totalDelay = accumulatedDelay + step.delayMinutes;
    const scheduledFor = new Date(Date.now() + totalDelay * 60 * 1000);

    // Create the action for this step
    const action = await prisma.campaignAction.create({
      data: {
        campaignId,
        actionType: 'EMAIL',
        status: 'PENDING',
        delayMinutes: totalDelay,
        scheduledFor,
        sequenceId,
        sequenceStep: step.stepNumber,
        parentActionId,
        actionData: {
          templateId: step.templateId,
        },
      },
    });

    operationLog.info(
      { actionId: action.id, scheduledFor, totalDelay },
      'Sequence step scheduled'
    );

    let actionsScheduled = 1;

    // Schedule branches if defined
    if (step.branches && step.branches.length > 0) {
      for (const branch of step.branches) {
        const branchActions = await scheduleBranch(
          campaignId,
          sequenceId,
          action.id,
          branch,
          totalDelay
        );
        actionsScheduled += branchActions;
      }
    }

    return actionsScheduled;
  } catch (error) {
    operationLog.error({ error }, 'Failed to schedule sequence step');
    throw error;
  }
}

/**
 * Schedule a conditional branch
 * Creates actions for both match and no-match scenarios
 */
async function scheduleBranch(
  campaignId: string,
  sequenceId: string,
  branchFromActionId: string,
  branch: SequenceBranch,
  currentDelay: number
): Promise<number> {
  const operationLog = log.child({
    operation: 'scheduleBranch',
    branchFromActionId,
    condition: branch.condition,
  });

  try {
    let actionsScheduled = 0;

    // Schedule "match" branch
    if (branch.onMatch) {
      const matchAction = await prisma.campaignAction.create({
        data: {
          campaignId,
          actionType: 'EMAIL',
          status: 'WAITING_FOR_CONDITION',
          delayMinutes: currentDelay + branch.onMatch.delayMinutes,
          scheduledFor: new Date(
            Date.now() + (currentDelay + branch.onMatch.delayMinutes) * 60 * 1000
          ),
          sequenceId,
          sequenceStep: branch.onMatch.stepNumber,
          branchFromActionId,
          branchCondition: branch.condition,
          actionData: {
            templateId: branch.onMatch.templateId,
            branchType: 'MATCH',
          },
        },
      });

      operationLog.debug({ actionId: matchAction.id }, 'Branch match action created');
      actionsScheduled++;
    }

    // Schedule "no match" branch (optional)
    if (branch.onNoMatch) {
      const noMatchAction = await prisma.campaignAction.create({
        data: {
          campaignId,
          actionType: 'EMAIL',
          status: 'WAITING_FOR_CONDITION',
          delayMinutes: currentDelay + branch.onNoMatch.delayMinutes,
          scheduledFor: new Date(
            Date.now() + (currentDelay + branch.onNoMatch.delayMinutes) * 60 * 1000
          ),
          sequenceId,
          sequenceStep: branch.onNoMatch.stepNumber,
          branchFromActionId,
          branchCondition: `NOT_${branch.condition}` as any,
          actionData: {
            templateId: branch.onNoMatch.templateId,
            branchType: 'NO_MATCH',
          },
        },
      });

      operationLog.debug({ actionId: noMatchAction.id }, 'Branch no-match action created');
      actionsScheduled++;
    }

    return actionsScheduled;
  } catch (error) {
    operationLog.error({ error }, 'Failed to schedule branch');
    throw error;
  }
}

/**
 * Evaluate branch condition based on action result
 * Called when an action completes to trigger conditional branches
 */
export async function evaluateBranchConditions(actionId: string): Promise<void> {
  const operationLog = log.child({
    operation: 'evaluateBranchConditions',
    actionId,
  });

  try {
    const action = await prisma.campaignAction.findUnique({
      where: { id: actionId },
      include: {
        campaign: true,
      },
    });

    if (!action) {
      operationLog.warn('Action not found');
      return;
    }

    // Find all branch actions waiting on this action
    const branchActions = await prisma.campaignAction.findMany({
      where: {
        branchFromActionId: actionId,
        status: 'WAITING_FOR_CONDITION',
      },
    });

    if (branchActions.length === 0) {
      operationLog.debug('No branch actions waiting on this action');
      return;
    }

    operationLog.info(
      { branchCount: branchActions.length },
      'Evaluating branch conditions'
    );

    for (const branchAction of branchActions) {
      const conditionMet = await checkBranchCondition(
        action,
        branchAction.branchCondition!
      );

      if (conditionMet) {
        // Activate this branch - change status to PENDING so it gets picked up by worker
        await prisma.campaignAction.update({
          where: { id: branchAction.id },
          data: {
            status: 'PENDING',
          },
        });

        operationLog.info(
          { branchActionId: branchAction.id, condition: branchAction.branchCondition },
          'Branch condition met, activated branch action'
        );

        // Cancel the opposite branch if it exists
        const oppositeCondition = getOppositeCondition(branchAction.branchCondition!);
        if (oppositeCondition) {
          await prisma.campaignAction.updateMany({
            where: {
              branchFromActionId: actionId,
              branchCondition: oppositeCondition,
              status: 'WAITING_FOR_CONDITION',
            },
            data: {
              status: 'CANCELLED',
            },
          });
        }
      }
    }
  } catch (error) {
    operationLog.error({ error }, 'Failed to evaluate branch conditions');
    // Don't throw - this is called asynchronously
  }
}

/**
 * Check if a branch condition is met based on action result
 */
async function checkBranchCondition(
  action: CampaignAction,
  condition: string
): Promise<boolean> {
  const executionResult = action.executionResult as any;

  switch (condition) {
    case 'EMAIL_OPENED':
      return action.status === 'OPENED' || executionResult?.opened === true;

    case 'EMAIL_CLICKED':
      return action.status === 'CLICKED' || executionResult?.clicked === true;

    case 'EMAIL_NOT_OPENED':
      // Check if enough time has passed (e.g., 24 hours)
      if (!action.executedAt) return false;
      const hoursSinceExecution =
        (Date.now() - action.executedAt.getTime()) / (1000 * 60 * 60);
      return hoursSinceExecution >= 24 && action.status !== 'OPENED';

    case 'EMAIL_NOT_CLICKED':
      if (!action.executedAt) return false;
      const hoursSinceExecution2 =
        (Date.now() - action.executedAt.getTime()) / (1000 * 60 * 60);
      return hoursSinceExecution2 >= 24 && action.status !== 'CLICKED';

    case 'PAYMENT_SUCCEEDED':
    case 'SUBSCRIPTION_REACTIVATED':
    case 'CONVERTED':
    case 'DISCOUNT_ACCEPTED':
    case 'TRIAL_CONVERTED':
      // These would be checked via campaign status or custom events
      return false; // TODO: Implement when we have conversion tracking

    default:
      return false;
  }
}

/**
 * Get the opposite branch condition
 */
function getOppositeCondition(condition: string): string | null {
  const opposites: Record<string, string> = {
    EMAIL_OPENED: 'EMAIL_NOT_OPENED',
    EMAIL_NOT_OPENED: 'EMAIL_OPENED',
    EMAIL_CLICKED: 'EMAIL_NOT_CLICKED',
    EMAIL_NOT_CLICKED: 'EMAIL_CLICKED',
  };

  return opposites[condition] || null;
}

/**
 * Cancel all pending actions in a sequence
 * Called when a campaign converts or is manually cancelled
 */
export async function cancelSequence(
  campaignId: string,
  sequenceId: string
): Promise<{ cancelledActions: number }> {
  const operationLog = log.child({
    operation: 'cancelSequence',
    campaignId,
    sequenceId,
  });

  try {
    const result = await prisma.campaignAction.updateMany({
      where: {
        campaignId,
        sequenceId,
        status: {
          in: ['PENDING', 'WAITING_FOR_CONDITION'],
        },
      },
      data: {
        status: 'CANCELLED',
      },
    });

    operationLog.info(
      { cancelledActions: result.count },
      'Sequence cancelled'
    );

    return { cancelledActions: result.count };
  } catch (error) {
    operationLog.error({ error }, 'Failed to cancel sequence');
    throw error;
  }
}

/**
 * Get sequence progress for a campaign
 */
export async function getSequenceProgress(campaignId: string): Promise<{
  sequenceId: string | null;
  totalSteps: number;
  completedSteps: number;
  pendingSteps: number;
  waitingSteps: number;
  cancelledSteps: number;
  currentStep: number | null;
}> {
  const actions = await prisma.campaignAction.findMany({
    where: {
      campaignId,
      sequenceId: { not: null },
    },
    orderBy: {
      sequenceStep: 'asc',
    },
  });

  if (actions.length === 0) {
    return {
      sequenceId: null,
      totalSteps: 0,
      completedSteps: 0,
      pendingSteps: 0,
      waitingSteps: 0,
      cancelledSteps: 0,
      currentStep: null,
    };
  }

  const completedSteps = actions.filter((a) =>
    ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'].includes(a.status)
  ).length;

  const pendingSteps = actions.filter((a) => a.status === 'PENDING').length;
  const waitingSteps = actions.filter((a) => a.status === 'WAITING_FOR_CONDITION').length;
  const cancelledSteps = actions.filter((a) => a.status === 'CANCELLED').length;

  const lastCompletedAction = actions
    .filter((a) => ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'].includes(a.status))
    .sort((a, b) => (b.sequenceStep || 0) - (a.sequenceStep || 0))[0];

  return {
    sequenceId: actions[0].sequenceId,
    totalSteps: actions.length,
    completedSteps,
    pendingSteps,
    waitingSteps,
    cancelledSteps,
    currentStep: lastCompletedAction?.sequenceStep || null,
  };
}

/**
 * Example sequence templates
 */
export const SequenceTemplates = {
  /**
   * Trial ending sequence with follow-ups
   */
  trialEndingSequence: (
    template7DayId: string,
    template3DayId: string,
    template1DayId: string
  ): EmailSequence => ({
    name: 'Trial Ending Sequence',
    description: '3-email trial reminder sequence',
    stopOnConversion: true,
    steps: [
      {
        stepNumber: 1,
        templateId: template7DayId,
        delayMinutes: 0, // Send immediately
        branches: [
          {
            condition: 'TRIAL_CONVERTED',
            onMatch: {
              // If they convert, stop the sequence
              stepNumber: 99,
              templateId: '', // No email needed
              delayMinutes: 0,
            },
          },
        ],
      },
      {
        stepNumber: 2,
        templateId: template3DayId,
        delayMinutes: 4 * 24 * 60, // 4 days later (7-day → 3-day)
        branches: [
          {
            condition: 'TRIAL_CONVERTED',
            onMatch: {
              stepNumber: 99,
              templateId: '',
              delayMinutes: 0,
            },
          },
        ],
      },
      {
        stepNumber: 3,
        templateId: template1DayId,
        delayMinutes: 2 * 24 * 60, // 2 days later (3-day → 1-day)
      },
    ],
  }),

  /**
   * Payment recovery sequence with escalating urgency
   */
  paymentRecoverySequence: (
    gentleReminderId: string,
    urgentReminderId: string,
    finalNoticeId: string
  ): EmailSequence => ({
    name: 'Payment Recovery Sequence',
    description: 'Escalating payment reminder sequence',
    stopOnConversion: true,
    steps: [
      {
        stepNumber: 1,
        templateId: gentleReminderId,
        delayMinutes: 0, // Send immediately after payment failure
        branches: [
          {
            condition: 'PAYMENT_SUCCEEDED',
            onMatch: {
              stepNumber: 99,
              templateId: '',
              delayMinutes: 0,
            },
          },
        ],
      },
      {
        stepNumber: 2,
        templateId: urgentReminderId,
        delayMinutes: 24 * 60, // 24 hours later
        branches: [
          {
            condition: 'PAYMENT_SUCCEEDED',
            onMatch: {
              stepNumber: 99,
              templateId: '',
              delayMinutes: 0,
            },
          },
        ],
      },
      {
        stepNumber: 3,
        templateId: finalNoticeId,
        delayMinutes: 48 * 60, // 48 hours later
      },
    ],
  }),

  /**
   * Churn prevention sequence with branching based on engagement
   */
  churnPreventionSequence: (
    highRiskId: string,
    criticalRiskWithDiscountId: string,
    finalWinbackId: string
  ): EmailSequence => ({
    name: 'Churn Prevention Sequence',
    description: 'Multi-touch churn prevention with engagement-based branching',
    stopOnConversion: true,
    steps: [
      {
        stepNumber: 1,
        templateId: highRiskId,
        delayMinutes: 0,
        branches: [
          {
            condition: 'EMAIL_OPENED',
            onMatch: {
              // If they opened, send less aggressive follow-up
              stepNumber: 2,
              templateId: finalWinbackId,
              delayMinutes: 3 * 24 * 60, // 3 days
            },
            onNoMatch: {
              // If they didn't open, escalate with discount
              stepNumber: 3,
              templateId: criticalRiskWithDiscountId,
              delayMinutes: 2 * 24 * 60, // 2 days
            },
          },
        ],
      },
    ],
  }),
};
