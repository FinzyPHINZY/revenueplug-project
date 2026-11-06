/**
 * Campaign Scheduler Service
 *
 * Handles scheduled and recurring campaign triggers
 * Allows campaigns to run on a schedule instead of event-driven triggers
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { z } from 'zod';
import { triggerCampaign } from './service.js';
import type {
  CampaignScheduleStatus,
  CampaignScheduleType,
  CampaignTriggerType,
} from '@prisma/client';

const log = logger.child({ module: 'retention-scheduler' });

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

const CreateScheduleSchema = z.object({
  organizationId: z.string().cuid(),
  strategyId: z.string().cuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  scheduleType: z.enum(['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
  scheduledAt: z.coerce.date().optional(), // For ONE_TIME
  cronExpression: z.string().optional(), // For CUSTOM
  dayOfWeek: z.number().int().min(0).max(6).optional(), // 0=Sunday, 6=Saturday
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(), // HH:MM format
  audienceFilters: z.record(z.any()).optional(),
  maxRuns: z.number().int().min(1).optional(), // Null = unlimited
});

const UpdateScheduleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  scheduleType: z.enum(['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']).optional(),
  scheduledAt: z.coerce.date().optional(),
  cronExpression: z.string().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  audienceFilters: z.record(z.any()).optional(),
  maxRuns: z.number().int().min(1).optional(),
});

export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;

// ============================================================================
// SCHEDULE CRUD
// ============================================================================

/**
 * Create a new campaign schedule
 */
export async function createSchedule(input: CreateScheduleInput) {
  const operationLog = log.child({ operation: 'createSchedule' });

  try {
    const validated = CreateScheduleSchema.parse(input);

    // Validate schedule type matches provided fields
    validateScheduleConfiguration({
      scheduleType: validated.scheduleType,
      scheduledAt: validated.scheduledAt,
      cronExpression: validated.cronExpression,
      dayOfWeek: validated.dayOfWeek,
      dayOfMonth: validated.dayOfMonth,
      timeOfDay: validated.timeOfDay,
    });

    // Calculate first run time
    const nextRunAt = calculateNextRunTime({
      scheduleType: validated.scheduleType as CampaignScheduleType,
      scheduledAt: validated.scheduledAt,
      cronExpression: validated.cronExpression,
      dayOfWeek: validated.dayOfWeek,
      dayOfMonth: validated.dayOfMonth,
      timeOfDay: validated.timeOfDay,
    });

    const schedule = await prisma.campaignSchedule.create({
      data: {
        organizationId: validated.organizationId,
        strategyId: validated.strategyId,
        name: validated.name,
        description: validated.description,
        scheduleType: validated.scheduleType,
        scheduledAt: validated.scheduledAt,
        cronExpression: validated.cronExpression,
        dayOfWeek: validated.dayOfWeek,
        dayOfMonth: validated.dayOfMonth,
        timeOfDay: validated.timeOfDay,
        audienceFilters: validated.audienceFilters || {},
        maxRuns: validated.maxRuns,
        nextRunAt,
        status: 'ACTIVE',
      },
      include: {
        strategy: true,
      },
    });

    operationLog.info(
      { scheduleId: schedule.id, nextRunAt },
      'Campaign schedule created'
    );

    return schedule;
  } catch (error) {
    operationLog.error({ error }, 'Failed to create campaign schedule');
    throw error;
  }
}

/**
 * Update an existing schedule
 */
export async function updateSchedule(
  scheduleId: string,
  updates: UpdateScheduleInput
) {
  const operationLog = log.child({ operation: 'updateSchedule', scheduleId });

  try {
    const validated = UpdateScheduleSchema.parse(updates);

    const existing = await prisma.campaignSchedule.findUnique({
      where: { id: scheduleId },
    });

    if (!existing) {
      throw new Error('Schedule not found');
    }

    // Merge with existing config
    const mergedConfig = {
      scheduleType: validated.scheduleType || existing.scheduleType,
      scheduledAt: validated.scheduledAt ?? existing.scheduledAt,
      cronExpression: validated.cronExpression ?? existing.cronExpression,
      dayOfWeek: validated.dayOfWeek ?? existing.dayOfWeek,
      dayOfMonth: validated.dayOfMonth ?? existing.dayOfMonth,
      timeOfDay: validated.timeOfDay ?? existing.timeOfDay,
    };

    // Validate merged config
    validateScheduleConfiguration(mergedConfig);

    // Recalculate next run time if schedule config changed
    let nextRunAt = existing.nextRunAt;
    if (
      validated.scheduleType ||
      validated.scheduledAt ||
      validated.cronExpression ||
      validated.dayOfWeek !== undefined ||
      validated.dayOfMonth !== undefined ||
      validated.timeOfDay
    ) {
      nextRunAt = calculateNextRunTime(mergedConfig);
    }

    const schedule = await prisma.campaignSchedule.update({
      where: { id: scheduleId },
      data: {
        ...validated,
        nextRunAt,
      },
      include: {
        strategy: true,
      },
    });

    operationLog.info({ scheduleId, nextRunAt }, 'Campaign schedule updated');

    return schedule;
  } catch (error) {
    operationLog.error({ error }, 'Failed to update campaign schedule');
    throw error;
  }
}

/**
 * Delete a schedule
 */
export async function deleteSchedule(scheduleId: string) {
  const operationLog = log.child({ operation: 'deleteSchedule', scheduleId });

  try {
    await prisma.campaignSchedule.delete({
      where: { id: scheduleId },
    });

    operationLog.info('Campaign schedule deleted');
  } catch (error) {
    operationLog.error({ error }, 'Failed to delete campaign schedule');
    throw error;
  }
}

/**
 * Pause a schedule
 */
export async function pauseSchedule(scheduleId: string) {
  const operationLog = log.child({ operation: 'pauseSchedule', scheduleId });

  try {
    const schedule = await prisma.campaignSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'PAUSED',
        pausedAt: new Date(),
      },
    });

    operationLog.info('Campaign schedule paused');

    return schedule;
  } catch (error) {
    operationLog.error({ error }, 'Failed to pause campaign schedule');
    throw error;
  }
}

/**
 * Resume a paused schedule
 */
export async function resumeSchedule(scheduleId: string) {
  const operationLog = log.child({ operation: 'resumeSchedule', scheduleId });

  try {
    const existing = await prisma.campaignSchedule.findUnique({
      where: { id: scheduleId },
    });

    if (!existing) {
      throw new Error('Schedule not found');
    }

    // Recalculate next run time from now
    const nextRunAt = calculateNextRunTime({
      scheduleType: existing.scheduleType,
      scheduledAt: existing.scheduledAt,
      cronExpression: existing.cronExpression,
      dayOfWeek: existing.dayOfWeek,
      dayOfMonth: existing.dayOfMonth,
      timeOfDay: existing.timeOfDay,
    });

    const schedule = await prisma.campaignSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'ACTIVE',
        pausedAt: null,
        nextRunAt,
      },
    });

    operationLog.info({ nextRunAt }, 'Campaign schedule resumed');

    return schedule;
  } catch (error) {
    operationLog.error({ error }, 'Failed to resume campaign schedule');
    throw error;
  }
}

/**
 * List schedules for an organization
 */
export async function listSchedules(
  organizationId: string,
  options: {
    strategyId?: string;
    status?: CampaignScheduleStatus;
    scheduleType?: CampaignScheduleType;
  } = {}
) {
  const schedules = await prisma.campaignSchedule.findMany({
    where: {
      organizationId,
      ...(options.strategyId && { strategyId: options.strategyId }),
      ...(options.status && { status: options.status }),
      ...(options.scheduleType && { scheduleType: options.scheduleType }),
    },
    include: {
      strategy: {
        select: {
          id: true,
          name: true,
          status: true,
        },
      },
    },
    orderBy: {
      nextRunAt: 'asc',
    },
  });

  return schedules;
}

/**
 * Get a specific schedule
 */
export async function getSchedule(scheduleId: string) {
  const schedule = await prisma.campaignSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      strategy: true,
    },
  });

  return schedule;
}

// ============================================================================
// SCHEDULE EXECUTION
// ============================================================================

/**
 * Process all due scheduled campaigns
 * This should be called by a cron job every minute
 */
export async function processScheduledCampaigns(): Promise<{
  processed: number;
  triggered: number;
  errors: number;
}> {
  const operationLog = log.child({ operation: 'processScheduledCampaigns' });

  try {
    const now = new Date();

    // Find all active schedules that are due to run
    const dueSchedules = await prisma.campaignSchedule.findMany({
      where: {
        status: 'ACTIVE',
        nextRunAt: {
          lte: now,
        },
      },
      include: {
        strategy: true,
      },
    });

    operationLog.info(
      { dueSchedulesCount: dueSchedules.length },
      'Processing due schedules'
    );

    let triggered = 0;
    let errors = 0;

    for (const schedule of dueSchedules) {
      try {
        const campaignCount = await executeSchedule(schedule.id);
        triggered += campaignCount;
      } catch (error) {
        errors++;
        operationLog.error(
          { error, scheduleId: schedule.id },
          'Failed to execute schedule'
        );
      }
    }

    operationLog.info(
      { processed: dueSchedules.length, triggered, errors },
      'Scheduled campaigns processed'
    );

    return {
      processed: dueSchedules.length,
      triggered,
      errors,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to process scheduled campaigns');
    throw error;
  }
}

/**
 * Execute a specific schedule
 * Finds matching customers and triggers campaigns for each
 */
export async function executeSchedule(scheduleId: string): Promise<number> {
  const operationLog = log.child({ operation: 'executeSchedule', scheduleId });

  try {
    const schedule = await prisma.campaignSchedule.findUnique({
      where: { id: scheduleId },
      include: {
        strategy: true,
      },
    });

    if (!schedule) {
      throw new Error('Schedule not found');
    }

    if (schedule.status !== 'ACTIVE') {
      operationLog.warn({ status: schedule.status }, 'Schedule is not active');
      return 0;
    }

    // Check if max runs reached
    if (schedule.maxRuns && schedule.runCount >= schedule.maxRuns) {
      await prisma.campaignSchedule.update({
        where: { id: scheduleId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
      operationLog.info('Schedule completed (max runs reached)');
      return 0;
    }

    // Find customers matching audience filters
    const customers = await findMatchingCustomers(
      schedule.organizationId,
      schedule.audienceFilters as Record<string, any>
    );

    operationLog.info(
      { customersCount: customers.length },
      'Found matching customers'
    );

    // Trigger campaign for each customer
    let triggeredCount = 0;

    for (const customer of customers) {
      try {
        const campaign = await triggerCampaign({
          strategyId: schedule.strategyId,
          customerId: customer.id,
          triggerType: 'MANUAL' as CampaignTriggerType, // Scheduled campaigns are manual triggers
          triggerContext: {
            scheduledCampaign: true,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            executedAt: new Date().toISOString(),
          },
        });

        if (campaign) {
          triggeredCount++;
        }
      } catch (error) {
        operationLog.error(
          { error, customerId: customer.id },
          'Failed to trigger campaign for customer'
        );
      }
    }

    // Calculate next run time
    const nextRunAt =
      schedule.scheduleType === 'ONE_TIME'
        ? null
        : calculateNextRunTime({
            scheduleType: schedule.scheduleType,
            scheduledAt: schedule.scheduledAt,
            cronExpression: schedule.cronExpression,
            dayOfWeek: schedule.dayOfWeek,
            dayOfMonth: schedule.dayOfMonth,
            timeOfDay: schedule.timeOfDay,
          });

    // Update schedule
    await prisma.campaignSchedule.update({
      where: { id: scheduleId },
      data: {
        runCount: schedule.runCount + 1,
        lastRunAt: new Date(),
        lastRunCampaignCount: triggeredCount,
        nextRunAt,
        ...(schedule.scheduleType === 'ONE_TIME' && {
          status: 'COMPLETED',
          completedAt: new Date(),
        }),
      },
    });

    operationLog.info(
      { triggeredCount, nextRunAt },
      'Schedule executed successfully'
    );

    return triggeredCount;
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute schedule');
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate schedule configuration based on type
 */
function validateScheduleConfiguration(config: {
  scheduleType: string;
  scheduledAt?: Date | null;
  cronExpression?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timeOfDay?: string | null;
}): void {
  const { scheduleType } = config;

  if (scheduleType === 'ONE_TIME') {
    if (!config.scheduledAt) {
      throw new Error('scheduledAt is required for ONE_TIME schedules');
    }
  } else if (scheduleType === 'DAILY') {
    if (!config.timeOfDay) {
      throw new Error('timeOfDay is required for DAILY schedules');
    }
  } else if (scheduleType === 'WEEKLY') {
    if (config.dayOfWeek === undefined || config.dayOfWeek === null) {
      throw new Error('dayOfWeek is required for WEEKLY schedules');
    }
    if (!config.timeOfDay) {
      throw new Error('timeOfDay is required for WEEKLY schedules');
    }
  } else if (scheduleType === 'MONTHLY') {
    if (config.dayOfMonth === undefined || config.dayOfMonth === null) {
      throw new Error('dayOfMonth is required for MONTHLY schedules');
    }
    if (!config.timeOfDay) {
      throw new Error('timeOfDay is required for MONTHLY schedules');
    }
  } else if (scheduleType === 'CUSTOM') {
    if (!config.cronExpression) {
      throw new Error('cronExpression is required for CUSTOM schedules');
    }
  }
}

/**
 * Calculate the next run time based on schedule configuration
 */
export function calculateNextRunTime(config: {
  scheduleType: CampaignScheduleType;
  scheduledAt?: Date | null;
  cronExpression?: string | null;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  timeOfDay?: string | null;
}): Date | null {
  const now = new Date();

  switch (config.scheduleType) {
    case 'ONE_TIME':
      return config.scheduledAt || null;

    case 'DAILY': {
      if (!config.timeOfDay) return null;

      const [hours, minutes] = config.timeOfDay.split(':').map(Number);
      const nextRun = new Date();
      nextRun.setHours(hours, minutes, 0, 0);

      // If time already passed today, schedule for tomorrow
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }

      return nextRun;
    }

    case 'WEEKLY': {
      if (config.dayOfWeek === undefined || config.dayOfWeek === null || !config.timeOfDay) {
        return null;
      }

      const [hours, minutes] = config.timeOfDay.split(':').map(Number);
      const nextRun = new Date();
      nextRun.setHours(hours, minutes, 0, 0);

      // Calculate days until target day of week
      const currentDay = nextRun.getDay();
      let daysUntilTarget = config.dayOfWeek - currentDay;

      if (daysUntilTarget < 0) {
        daysUntilTarget += 7;
      } else if (daysUntilTarget === 0 && nextRun <= now) {
        // If it's the same day but time passed, schedule for next week
        daysUntilTarget = 7;
      }

      nextRun.setDate(nextRun.getDate() + daysUntilTarget);

      return nextRun;
    }

    case 'MONTHLY': {
      if (config.dayOfMonth === undefined || config.dayOfMonth === null || !config.timeOfDay) {
        return null;
      }

      const [hours, minutes] = config.timeOfDay.split(':').map(Number);
      const nextRun = new Date();
      nextRun.setHours(hours, minutes, 0, 0);
      nextRun.setDate(config.dayOfMonth);

      // If this month's date already passed, schedule for next month
      if (nextRun <= now) {
        nextRun.setMonth(nextRun.getMonth() + 1);
      }

      // Handle months with fewer days (e.g., Feb 30 -> Feb 28)
      if (nextRun.getDate() !== config.dayOfMonth) {
        nextRun.setDate(0); // Last day of previous month
      }

      return nextRun;
    }

    case 'CUSTOM': {
      if (!config.cronExpression) return null;

      // For now, we'll just return null for custom schedules
      // Full cron parsing would require a library like node-cron or cron-parser
      log.warn(
        { cronExpression: config.cronExpression },
        'CUSTOM schedules with cron expressions are not yet fully implemented'
      );

      return null;
    }

    default:
      return null;
  }
}

/**
 * Find customers matching audience filters
 */
async function findMatchingCustomers(
  organizationId: string,
  audienceFilters: Record<string, any>
): Promise<Array<{ id: string; email: string }>> {
  const operationLog = log.child({ operation: 'findMatchingCustomers' });

  try {
    // Build where clause from audience filters
    const where: any = {
      organizationId,
    };

    // Subscription status filter
    if (audienceFilters.subscriptionStatus) {
      where.subscriptionStatus = {
        in: Array.isArray(audienceFilters.subscriptionStatus)
          ? audienceFilters.subscriptionStatus
          : [audienceFilters.subscriptionStatus],
      };
    }

    // MRR filters
    if (audienceFilters.minMRR !== undefined) {
      where.mrr = { ...where.mrr, gte: audienceFilters.minMRR };
    }
    if (audienceFilters.maxMRR !== undefined) {
      where.mrr = { ...where.mrr, lte: audienceFilters.maxMRR };
    }

    // Churn risk filter
    if (audienceFilters.hasHighChurnRisk) {
      where.churnRiskLevel = { in: ['HIGH', 'CRITICAL'] };
    }

    // Payment health filter
    if (audienceFilters.hasPaymentIssues) {
      where.paymentHealthScore = { lt: 50 };
    }

    // Customer segment filter
    if (audienceFilters.segment) {
      where.segment = audienceFilters.segment;
    }

    // Trial status filter
    if (audienceFilters.isTrialing !== undefined) {
      if (audienceFilters.isTrialing) {
        where.subscriptionStatus = 'trialing';
      }
    }

    // Days until trial end
    if (audienceFilters.maxDaysUntilTrialEnd !== undefined) {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + audienceFilters.maxDaysUntilTrialEnd);
      where.trialEndsAt = { lte: futureDate };
    }

    const customers = await prisma.customer.findMany({
      where,
      select: {
        id: true,
        email: true,
      },
      take: 1000, // Limit to prevent huge campaigns
    });

    operationLog.info(
      { count: customers.length, audienceFilters },
      'Found matching customers'
    );

    return customers;
  } catch (error) {
    operationLog.error({ error }, 'Failed to find matching customers');
    throw error;
  }
}
