/**
 * Retention Playbooks Service
 *
 * Import/export retention strategies as JSON playbooks
 * Share strategies across organizations or use community templates
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { z } from 'zod';

const log = logger.child({ module: 'retention-playbooks' });

/**
 * Playbook action schema
 */
const PlaybookActionSchema = z.object({
  type: z.enum(['EMAIL', 'DISCOUNT', 'PERSONAL_OUTREACH', 'USAGE_NUDGE']),
  delayMinutes: z.number().min(0),
  templateName: z.string().optional(),
  templateSubject: z.string().optional(),
  templateBody: z.string().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  durationMonths: z.number().min(1).optional(),
  description: z.string().optional(),
});

/**
 * Playbook schema
 */
const PlaybookSchema = z.object({
  version: z.literal('1.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum([
    'CHURN_PREVENTION',
    'PAYMENT_RECOVERY',
    'TRIAL_CONVERSION',
    'USAGE_ENGAGEMENT',
    'CUSTOM',
  ]),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),

  // Strategy configuration
  strategy: z.object({
    triggerConditions: z.record(z.any()),
    audienceFilters: z.record(z.any()).optional(),
    cooldownDays: z.number().min(0),
    maxActionsPerCustomer: z.number().min(1).optional(),
    priority: z.enum(['IMMEDIATE', 'HIGH', 'MEDIUM', 'LOW']),
  }),

  // Actions
  actions: z.array(PlaybookActionSchema),
});

export type Playbook = z.infer<typeof PlaybookSchema>;
export type PlaybookAction = z.infer<typeof PlaybookActionSchema>;

/**
 * Export a retention strategy as a playbook
 */
export async function exportStrategyAsPlaybook(strategyId: string): Promise<Playbook> {
  const operationLog = log.child({
    operation: 'exportStrategyAsPlaybook',
    strategyId,
  });

  try {
    const strategy = await prisma.retentionStrategy.findUnique({
      where: { id: strategyId },
    });

    if (!strategy) {
      throw new Error('Strategy not found');
    }

    // Extract actions configuration
    const actionsData = strategy.actions as any[];
    const playbookActions: PlaybookAction[] = [];

    for (const action of actionsData) {
      const playbookAction: PlaybookAction = {
        type: action.type,
        delayMinutes: action.delayMinutes || 0,
      };

      // Add type-specific fields
      if (action.type === 'EMAIL' && action.templateId) {
        // Get template details
        const template = await prisma.emailTemplate.findUnique({
          where: { id: action.templateId },
          select: { name: true, subject: true, htmlBody: true },
        });

        if (template) {
          playbookAction.templateName = template.name;
          playbookAction.templateSubject = template.subject;
          playbookAction.templateBody = template.htmlBody;
        }
      } else if (action.type === 'DISCOUNT') {
        playbookAction.discountPercent = action.discountPercent;
        playbookAction.durationMonths = action.durationMonths;
      } else if (action.type === 'PERSONAL_OUTREACH') {
        playbookAction.description = action.description;
      }

      playbookActions.push(playbookAction);
    }

    // Determine category from trigger conditions
    const triggerConditions = strategy.triggerConditions as any;
    let category: Playbook['category'] = 'CUSTOM';

    if (triggerConditions.churnRiskLevel) {
      category = 'CHURN_PREVENTION';
    } else if (triggerConditions.paymentFailed) {
      category = 'PAYMENT_RECOVERY';
    } else if (triggerConditions.trialEnding) {
      category = 'TRIAL_CONVERSION';
    } else if (triggerConditions.usageDecline) {
      category = 'USAGE_ENGAGEMENT';
    }

    const playbook: Playbook = {
      version: '1.0',
      name: strategy.name,
      description: strategy.description || undefined,
      category,
      tags: [],
      strategy: {
        triggerConditions: strategy.triggerConditions as any,
        audienceFilters: strategy.audienceFilters as any,
        cooldownDays: strategy.cooldownDays,
        maxActionsPerCustomer: strategy.maxActionsPerCustomer || undefined,
        priority: strategy.priority as any,
      },
      actions: playbookActions,
    };

    operationLog.info({ playbookName: playbook.name }, 'Strategy exported as playbook');

    return playbook;
  } catch (error) {
    operationLog.error({ error }, 'Failed to export strategy as playbook');
    throw error;
  }
}

/**
 * Import a playbook and create a new retention strategy
 */
export async function importPlaybook(
  organizationId: string,
  playbook: Playbook,
  options: {
    namePrefix?: string; // Add prefix to avoid conflicts
    createTemplates?: boolean; // Create email templates if they don't exist
  } = {}
): Promise<{ strategyId: string; templatesCreated: number }> {
  const operationLog = log.child({
    operation: 'importPlaybook',
    organizationId,
    playbookName: playbook.name,
  });

  try {
    // Validate playbook
    const validatedPlaybook = PlaybookSchema.parse(playbook);

    // Check if strategy with same name exists
    const namePrefix = options.namePrefix || '';
    const strategyName = namePrefix ? `${namePrefix}${validatedPlaybook.name}` : validatedPlaybook.name;

    const existing = await prisma.retentionStrategy.findFirst({
      where: {
        organizationId,
        name: strategyName,
      },
    });

    if (existing) {
      throw new Error(`Strategy with name "${strategyName}" already exists. Use namePrefix option to avoid conflicts.`);
    }

    let templatesCreated = 0;
    const actions: any[] = [];

    // Process actions
    for (const action of validatedPlaybook.actions) {
      const actionData: any = {
        type: action.type,
        delayMinutes: action.delayMinutes,
      };

      if (action.type === 'EMAIL' && action.templateName) {
        // Check if template exists
        let template = await prisma.emailTemplate.findFirst({
          where: {
            organizationId,
            name: action.templateName,
          },
        });

        // Create template if it doesn't exist and createTemplates is true
        if (!template && options.createTemplates && action.templateSubject && action.templateBody) {
          template = await prisma.emailTemplate.create({
            data: {
              organizationId,
              name: action.templateName,
              description: `Imported from playbook: ${validatedPlaybook.name}`,
              category: validatedPlaybook.category === 'CUSTOM' ? 'CHURN_PREVENTION' : validatedPlaybook.category as any,
              status: 'ACTIVE',
              subject: action.templateSubject,
              htmlBody: action.templateBody,
              textBody: '', // Could extract from HTML or leave empty
              availableTags: [],
              sentCount: 0,
              openRate: 0,
              clickRate: 0,
              conversionRate: 0,
            },
          });

          templatesCreated++;
          operationLog.info({ templateName: template.name }, 'Created template from playbook');
        }

        if (template) {
          actionData.templateId = template.id;
        } else {
          operationLog.warn({ templateName: action.templateName }, 'Template not found and createTemplates=false');
        }
      } else if (action.type === 'DISCOUNT') {
        actionData.discountPercent = action.discountPercent;
        actionData.durationMonths = action.durationMonths;
      } else if (action.type === 'PERSONAL_OUTREACH') {
        actionData.description = action.description;
      }

      actions.push(actionData);
    }

    // Create strategy
    const strategy = await prisma.retentionStrategy.create({
      data: {
        organizationId,
        name: strategyName,
        description: validatedPlaybook.description || `Imported from playbook: ${validatedPlaybook.name}`,
        status: 'ACTIVE',
        triggerConditions: validatedPlaybook.strategy.triggerConditions,
        audienceFilters: validatedPlaybook.strategy.audienceFilters || {},
        actions,
        cooldownDays: validatedPlaybook.strategy.cooldownDays,
        maxActionsPerCustomer: validatedPlaybook.strategy.maxActionsPerCustomer || 10,
        priority: validatedPlaybook.strategy.priority,
      },
    });

    operationLog.info(
      { strategyId: strategy.id, templatesCreated },
      'Playbook imported successfully'
    );

    return {
      strategyId: strategy.id,
      templatesCreated,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to import playbook');
    throw error;
  }
}

/**
 * Validate a playbook without importing
 */
export function validatePlaybook(playbook: unknown): {
  valid: boolean;
  errors?: string[];
} {
  try {
    PlaybookSchema.parse(playbook);
    return { valid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
      };
    }
    return {
      valid: false,
      errors: ['Invalid playbook format'],
    };
  }
}

/**
 * Built-in playbook library
 */
export const BUILTIN_PLAYBOOKS: Record<string, Playbook> = {
  'payment-recovery-sequence': {
    version: '1.0',
    name: 'Payment Recovery Sequence',
    description: 'Escalating 3-email sequence for failed payments',
    category: 'PAYMENT_RECOVERY',
    author: 'RevenuePlug',
    tags: ['payment', 'recovery', 'sequence'],
    strategy: {
      triggerConditions: {
        paymentFailed: true,
      },
      audienceFilters: {},
      cooldownDays: 30,
      maxActionsPerCustomer: 3,
      priority: 'HIGH',
    },
    actions: [
      {
        type: 'EMAIL',
        delayMinutes: 0,
        templateName: 'Payment Failed - Gentle Reminder',
        templateSubject: 'Your payment failed',
        templateBody: '<h1>Hi {{customerName}},</h1><p>We noticed your recent payment of {{amount}} {{currency}} didn\'t go through.</p><p>This is usually just a temporary issue with your payment method.</p><a href="{{updatePaymentUrl}}">Update Payment Method</a>',
      },
      {
        type: 'EMAIL',
        delayMinutes: 1440, // 24 hours
        templateName: 'Payment Failed - Urgent',
        templateSubject: '⚠️ Urgent: Payment issue',
        templateBody: '<h1>Action Required</h1><p>Hi {{customerName}},</p><p>Your payment is still outstanding. Please update your payment method to avoid service interruption.</p><p><strong>Amount due: {{amount}} {{currency}}</strong></p><a href="{{updatePaymentUrl}}">Update Payment Now</a>',
      },
      {
        type: 'DISCOUNT',
        delayMinutes: 2880, // 48 hours
        discountPercent: 15,
        durationMonths: 1,
      },
    ],
  },

  'high-risk-churn-prevention': {
    version: '1.0',
    name: 'High-Risk Churn Prevention',
    description: 'Proactive outreach for customers at high churn risk',
    category: 'CHURN_PREVENTION',
    author: 'RevenuePlug',
    tags: ['churn', 'high-risk', 'outreach'],
    strategy: {
      triggerConditions: {
        churnRiskLevel: ['HIGH', 'CRITICAL'],
      },
      audienceFilters: {},
      cooldownDays: 60,
      maxActionsPerCustomer: 5,
      priority: 'HIGH',
    },
    actions: [
      {
        type: 'EMAIL',
        delayMinutes: 0,
        templateName: 'Churn Prevention - High Risk',
        templateSubject: 'Can we help?',
        templateBody: '<h1>Hi {{customerName}},</h1><p>We noticed you haven\'t been as active lately. Is everything okay?</p><p>We\'d love to help ensure you\'re getting the most value from {{planName}}.</p><a href="{{scheduleCallUrl}}">Schedule a Quick Call</a>',
      },
      {
        type: 'PERSONAL_OUTREACH',
        delayMinutes: 4320, // 3 days
        description: 'Personal outreach from CSM team for high-value customer',
      },
      {
        type: 'DISCOUNT',
        delayMinutes: 10080, // 7 days
        discountPercent: 25,
        durationMonths: 2,
      },
    ],
  },

  'trial-conversion-sequence': {
    version: '1.0',
    name: 'Trial Conversion Sequence',
    description: '3-email sequence to convert trial users',
    category: 'TRIAL_CONVERSION',
    author: 'RevenuePlug',
    tags: ['trial', 'conversion', 'onboarding'],
    strategy: {
      triggerConditions: {
        trialEnding: true,
        daysBeforeTrialEnd: 7,
      },
      audienceFilters: {},
      cooldownDays: 90,
      maxActionsPerCustomer: 3,
      priority: 'MEDIUM',
    },
    actions: [
      {
        type: 'EMAIL',
        delayMinutes: 0,
        templateName: 'Trial Ending - 7 Days',
        templateSubject: 'Your trial ends in 7 days',
        templateBody: '<h1>Hi {{customerName}},</h1><p>Your trial of {{planName}} ends in 7 days.</p><p>Here\'s what you\'ll get when you subscribe:</p><ul><li>Feature 1</li><li>Feature 2</li><li>Feature 3</li></ul><a href="{{manageBillingUrl}}">Continue with {{planName}}</a>',
      },
      {
        type: 'EMAIL',
        delayMinutes: 5760, // 4 days (7d → 3d)
        templateName: 'Trial Ending - 3 Days',
        templateSubject: 'Only 3 days left in your trial',
        templateBody: '<h1>Hi {{customerName}},</h1><p>You have 3 days left to explore {{planName}}.</p><p><strong>You\'ll be charged {{amount}} {{currency}} on {{trialEndDate}}</strong></p><a href="{{manageBillingUrl}}">Manage Subscription</a>',
      },
      {
        type: 'EMAIL',
        delayMinutes: 2880, // 2 days (3d → 1d)
        templateName: 'Trial Ending - 1 Day',
        templateSubject: '⏰ Last day of your trial!',
        templateBody: '<h1>Final reminder</h1><p>Hi {{customerName}},</p><p>Your trial ends tomorrow. If you want to continue using {{planName}}, no action is needed.</p><p><strong>Billing: {{amount}} {{currency}} tomorrow</strong></p><a href="{{manageBillingUrl}}">Cancel or Change Plan</a>',
      },
    ],
  },
};

/**
 * Get list of built-in playbooks
 */
export function listBuiltinPlaybooks(): Array<{
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
}> {
  return Object.entries(BUILTIN_PLAYBOOKS).map(([id, playbook]) => ({
    id,
    name: playbook.name,
    description: playbook.description || '',
    category: playbook.category,
    tags: playbook.tags || [],
  }));
}

/**
 * Get a specific built-in playbook
 */
export function getBuiltinPlaybook(id: string): Playbook | null {
  return BUILTIN_PLAYBOOKS[id] || null;
}
