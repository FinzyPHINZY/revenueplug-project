/**
 * A/B Testing Service for Email Templates
 *
 * Test email template variants to optimize conversion rates
 * Features:
 * - Split testing (50/50, 60/40, etc.)
 * - Performance tracking per variant
 * - Statistical significance calculation
 * - Automatic winner selection
 */

import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import type { EmailTemplate } from '@prisma/client';

const log = logger.child({ module: 'ab-testing' });

/**
 * A/B test configuration
 */
export interface ABTestConfig {
  name: string;
  description?: string;
  controlTemplateId: string; // Original template (variant A)
  variantTemplateIds: string[]; // Test variants (variant B, C, etc.)
  splitRatio?: number[]; // Traffic split [50, 50] or [33, 33, 34], defaults to even split
  duration?: number; // Test duration in days (optional)
  minSampleSize?: number; // Minimum sends before declaring winner (default: 100)
  confidenceLevel?: number; // Confidence level for significance (default: 95)
}

/**
 * Variant performance metrics
 */
export interface VariantMetrics {
  templateId: string;
  templateName: string;
  variantName: string | null;
  sentCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  convertedCount: number;
  deliveryRate: number;
  openRate: number;
  clickRate: number;
  conversionRate: number;
  revenueRecovered: number;
}

/**
 * A/B test results with statistical analysis
 */
export interface ABTestResults {
  testName: string;
  startedAt: Date;
  endedAt?: Date;
  totalSent: number;
  control: VariantMetrics;
  variants: VariantMetrics[];
  winner: {
    templateId: string;
    variantName: string;
    improvementPercent: number;
    isStatisticallySignificant: boolean;
    confidenceLevel: number;
  } | null;
  recommendation: string;
}

/**
 * Create a new A/B test
 */
export async function createABTest(
  organizationId: string,
  config: ABTestConfig
): Promise<{ testId: string; variants: EmailTemplate[] }> {
  const operationLog = log.child({
    operation: 'createABTest',
    organizationId,
    testName: config.name,
  });

  try {
    // Validate control template exists
    const controlTemplate = await prisma.emailTemplate.findFirst({
      where: {
        id: config.controlTemplateId,
        organizationId,
      },
    });

    if (!controlTemplate) {
      throw new Error('Control template not found');
    }

    // Validate all variant templates exist
    const variantTemplates = await prisma.emailTemplate.findMany({
      where: {
        id: { in: config.variantTemplateIds },
        organizationId,
      },
    });

    if (variantTemplates.length !== config.variantTemplateIds.length) {
      throw new Error('One or more variant templates not found');
    }

    // Generate test ID
    const testId = `test_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Link variants to control template
    for (let i = 0; i < variantTemplates.length; i++) {
      await prisma.emailTemplate.update({
        where: { id: variantTemplates[i].id },
        data: {
          variantOf: controlTemplate.id,
          variantName: variantTemplates[i].variantName || `Variant ${String.fromCharCode(66 + i)}`, // B, C, D...
        },
      });
    }

    // Mark control as having variants
    if (!controlTemplate.variantName) {
      await prisma.emailTemplate.update({
        where: { id: controlTemplate.id },
        data: {
          variantName: 'Control (A)',
        },
      });
    }

    operationLog.info(
      {
        testId,
        controlTemplate: controlTemplate.name,
        variantCount: variantTemplates.length,
      },
      'A/B test created'
    );

    return {
      testId,
      variants: [controlTemplate, ...variantTemplates],
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to create A/B test');
    throw error;
  }
}

/**
 * Select a template variant for a campaign (weighted random selection)
 */
export async function selectVariant(
  controlTemplateId: string,
  splitRatio?: number[]
): Promise<string> {
  const operationLog = log.child({
    operation: 'selectVariant',
    controlTemplateId,
  });

  try {
    // Get control template and its variants
    const controlTemplate = await prisma.emailTemplate.findUnique({
      where: { id: controlTemplateId },
    });

    if (!controlTemplate) {
      throw new Error('Control template not found');
    }

    // Find all variants
    const variants = await prisma.emailTemplate.findMany({
      where: {
        variantOf: controlTemplateId,
        status: 'ACTIVE',
      },
    });

    // If no variants, return control
    if (variants.length === 0) {
      return controlTemplateId;
    }

    const allTemplates = [controlTemplate, ...variants];

    // Calculate split ratio (default to even split)
    const ratio = splitRatio || allTemplates.map(() => 100 / allTemplates.length);

    if (ratio.length !== allTemplates.length) {
      throw new Error('Split ratio length must match number of templates');
    }

    // Normalize ratio to sum to 100
    const total = ratio.reduce((sum, r) => sum + r, 0);
    const normalizedRatio = ratio.map((r) => (r / total) * 100);

    // Weighted random selection
    const random = Math.random() * 100;
    let cumulative = 0;

    for (let i = 0; i < allTemplates.length; i++) {
      cumulative += normalizedRatio[i];
      if (random <= cumulative) {
        operationLog.debug(
          {
            selectedTemplate: allTemplates[i].id,
            variantName: allTemplates[i].variantName,
          },
          'Variant selected'
        );
        return allTemplates[i].id;
      }
    }

    // Fallback to control (should never happen)
    return controlTemplateId;
  } catch (error) {
    operationLog.error({ error }, 'Failed to select variant');
    throw error;
  }
}

/**
 * Get variant performance metrics
 */
async function getVariantMetrics(templateId: string): Promise<VariantMetrics> {
  const template = await prisma.emailTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new Error('Template not found');
  }

  // Get action counts
  const [sentCount, deliveredCount, openedCount, clickedCount, convertedData] =
    await Promise.all([
      // Total sent
      prisma.campaignAction.count({
        where: {
          actionType: 'EMAIL',
          actionData: {
            path: ['templateId'],
            equals: templateId,
          },
          status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'] },
        },
      }),

      // Delivered
      prisma.campaignAction.count({
        where: {
          actionType: 'EMAIL',
          actionData: {
            path: ['templateId'],
            equals: templateId,
          },
          status: { in: ['DELIVERED', 'OPENED', 'CLICKED'] },
        },
      }),

      // Opened
      prisma.campaignAction.count({
        where: {
          actionType: 'EMAIL',
          actionData: {
            path: ['templateId'],
            equals: templateId,
          },
          status: { in: ['OPENED', 'CLICKED'] },
        },
      }),

      // Clicked
      prisma.campaignAction.count({
        where: {
          actionType: 'EMAIL',
          actionData: {
            path: ['templateId'],
            equals: templateId,
          },
          status: 'CLICKED',
        },
      }),

      // Converted campaigns (revenue)
      prisma.campaignAction.findMany({
        where: {
          actionType: 'EMAIL',
          actionData: {
            path: ['templateId'],
            equals: templateId,
          },
          campaign: {
            status: 'CONVERTED',
          },
        },
        include: {
          campaign: {
            select: {
              id: true,
              revenueRecovered: true,
            },
          },
        },
      }),
    ]);

  // Calculate metrics
  const convertedCount = new Set(convertedData.map((a) => a.campaign.id)).size;
  const revenueRecovered = convertedData.reduce(
    (sum, a) => sum + (a.campaign.revenueRecovered || 0),
    0
  );

  return {
    templateId,
    templateName: template.name,
    variantName: template.variantName,
    sentCount,
    deliveredCount,
    openedCount,
    clickedCount,
    convertedCount,
    deliveryRate: sentCount > 0 ? (deliveredCount / sentCount) * 100 : 0,
    openRate: deliveredCount > 0 ? (openedCount / deliveredCount) * 100 : 0,
    clickRate: deliveredCount > 0 ? (clickedCount / deliveredCount) * 100 : 0,
    conversionRate: sentCount > 0 ? (convertedCount / sentCount) * 100 : 0,
    revenueRecovered,
  };
}

/**
 * Get A/B test results with statistical analysis
 */
export async function getABTestResults(
  controlTemplateId: string,
  config: { minSampleSize?: number; confidenceLevel?: number } = {}
): Promise<ABTestResults> {
  const operationLog = log.child({
    operation: 'getABTestResults',
    controlTemplateId,
  });

  try {
    const minSampleSize = config.minSampleSize || 100;
    const confidenceLevel = config.confidenceLevel || 95;

    // Get control template
    const controlTemplate = await prisma.emailTemplate.findUnique({
      where: { id: controlTemplateId },
    });

    if (!controlTemplate) {
      throw new Error('Control template not found');
    }

    // Get variants
    const variantTemplates = await prisma.emailTemplate.findMany({
      where: {
        variantOf: controlTemplateId,
        status: 'ACTIVE',
      },
    });

    // Get metrics for control
    const controlMetrics = await getVariantMetrics(controlTemplateId);

    // Get metrics for all variants
    const variantMetrics = await Promise.all(
      variantTemplates.map((v) => getVariantMetrics(v.id))
    );

    const totalSent = controlMetrics.sentCount + variantMetrics.reduce((sum, v) => sum + v.sentCount, 0);

    // Find winner (based on conversion rate)
    let winner: ABTestResults['winner'] = null;

    if (totalSent >= minSampleSize) {
      // Find best performing variant
      const allMetrics = [controlMetrics, ...variantMetrics];
      const bestVariant = allMetrics.reduce((best, current) =>
        current.conversionRate > best.conversionRate ? current : best
      );

      // Calculate improvement over control
      const improvement = bestVariant.conversionRate - controlMetrics.conversionRate;
      const improvementPercent = controlMetrics.conversionRate > 0
        ? (improvement / controlMetrics.conversionRate) * 100
        : 0;

      // Calculate statistical significance (Z-test for proportions)
      const isSignificant = calculateStatisticalSignificance(
        controlMetrics,
        bestVariant,
        confidenceLevel
      );

      winner = {
        templateId: bestVariant.templateId,
        variantName: bestVariant.variantName || 'Unknown',
        improvementPercent,
        isStatisticallySignificant: isSignificant,
        confidenceLevel,
      };
    }

    // Generate recommendation
    let recommendation = '';
    if (!winner) {
      recommendation = `Need at least ${minSampleSize} total sends to determine a winner. Currently at ${totalSent} sends.`;
    } else if (winner.isStatisticallySignificant && winner.improvementPercent > 5) {
      recommendation = `${winner.variantName} is the clear winner with ${winner.improvementPercent.toFixed(1)}% improvement. Consider rolling it out to all campaigns.`;
    } else if (winner.isStatisticallySignificant && winner.improvementPercent > 0) {
      recommendation = `${winner.variantName} shows modest improvement (${winner.improvementPercent.toFixed(1)}%). Consider running test longer or testing more variants.`;
    } else if (!winner.isStatisticallySignificant) {
      recommendation = `No statistically significant difference found. Consider running test longer or trying more distinct variants.`;
    } else {
      recommendation = `Control template performs best. No need to change.`;
    }

    const results: ABTestResults = {
      testName: `${controlTemplate.name} A/B Test`,
      startedAt: controlTemplate.createdAt,
      totalSent,
      control: controlMetrics,
      variants: variantMetrics,
      winner,
      recommendation,
    };

    operationLog.info(
      {
        totalSent,
        winnerVariant: winner?.variantName,
        isSignificant: winner?.isStatisticallySignificant,
      },
      'A/B test results calculated'
    );

    return results;
  } catch (error) {
    operationLog.error({ error }, 'Failed to get A/B test results');
    throw error;
  }
}

/**
 * Calculate statistical significance using Z-test for proportions
 * Returns true if difference is statistically significant at given confidence level
 */
function calculateStatisticalSignificance(
  control: VariantMetrics,
  variant: VariantMetrics,
  confidenceLevel: number
): boolean {
  // Need at least 30 samples for each variant for Z-test validity
  if (control.sentCount < 30 || variant.sentCount < 30) {
    return false;
  }

  // Calculate proportions
  const p1 = control.convertedCount / control.sentCount;
  const p2 = variant.convertedCount / variant.sentCount;

  // Calculate pooled proportion
  const pooledP =
    (control.convertedCount + variant.convertedCount) /
    (control.sentCount + variant.sentCount);

  // Calculate standard error
  const standardError = Math.sqrt(
    pooledP * (1 - pooledP) * (1 / control.sentCount + 1 / variant.sentCount)
  );

  // Calculate Z-score
  const zScore = Math.abs((p2 - p1) / standardError);

  // Z-score thresholds for confidence levels
  const zThresholds: Record<number, number> = {
    90: 1.645,
    95: 1.96,
    99: 2.576,
  };

  const threshold = zThresholds[confidenceLevel] || 1.96;

  return zScore >= threshold;
}

/**
 * Promote a winning variant to be the new control
 */
export async function promoteVariant(
  variantTemplateId: string
): Promise<void> {
  const operationLog = log.child({
    operation: 'promoteVariant',
    variantTemplateId,
  });

  try {
    const variant = await prisma.emailTemplate.findUnique({
      where: { id: variantTemplateId },
    });

    if (!variant || !variant.variantOf) {
      throw new Error('Variant template not found or not linked to control');
    }

    // Update variant to be standalone (remove variantOf link)
    await prisma.emailTemplate.update({
      where: { id: variantTemplateId },
      data: {
        variantOf: null,
        variantName: 'Control (Promoted)',
      },
    });

    // Archive old control
    await prisma.emailTemplate.update({
      where: { id: variant.variantOf },
      data: {
        status: 'ARCHIVED',
        variantName: 'Control (Replaced)',
      },
    });

    // Unlink other variants
    await prisma.emailTemplate.updateMany({
      where: {
        variantOf: variant.variantOf,
        id: { not: variantTemplateId },
      },
      data: {
        variantOf: null,
      },
    });

    operationLog.info('Variant promoted to control');
  } catch (error) {
    operationLog.error({ error }, 'Failed to promote variant');
    throw error;
  }
}

/**
 * List all active A/B tests for an organization
 */
export async function listABTests(organizationId: string): Promise<
  Array<{
    controlTemplate: EmailTemplate;
    variants: EmailTemplate[];
    totalSent: number;
    status: 'running' | 'needs_more_data' | 'has_winner';
  }>
> {
  const operationLog = log.child({
    operation: 'listABTests',
    organizationId,
  });

  try {
    // Find all templates that have variants
    const controlTemplates = await prisma.emailTemplate.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        variantName: { not: null },
        variants: {
          some: {
            status: 'ACTIVE',
          },
        },
      },
      include: {
        variants: {
          where: {
            status: 'ACTIVE',
          },
        },
      },
    });

    const tests = await Promise.all(
      controlTemplates.map(async (control) => {
        // Get metrics for quick status
        const controlMetrics = await getVariantMetrics(control.id);
        const variantMetrics = await Promise.all(
          control.variants.map((v) => getVariantMetrics(v.id))
        );

        const totalSent = controlMetrics.sentCount + variantMetrics.reduce((sum, v) => sum + v.sentCount, 0);

        let status: 'running' | 'needs_more_data' | 'has_winner' = 'running';

        if (totalSent < 100) {
          status = 'needs_more_data';
        } else {
          // Check if we have a clear winner
          const allMetrics = [controlMetrics, ...variantMetrics];
          const bestVariant = allMetrics.reduce((best, current) =>
            current.conversionRate > best.conversionRate ? current : best
          );

          const isSignificant = calculateStatisticalSignificance(
            controlMetrics,
            bestVariant,
            95
          );

          const improvement = bestVariant.conversionRate - controlMetrics.conversionRate;
          const improvementPercent = controlMetrics.conversionRate > 0
            ? (improvement / controlMetrics.conversionRate) * 100
            : 0;

          if (isSignificant && improvementPercent > 5) {
            status = 'has_winner';
          }
        }

        return {
          controlTemplate: control,
          variants: control.variants,
          totalSent,
          status,
        };
      })
    );

    operationLog.info({ testCount: tests.length }, 'A/B tests listed');

    return tests;
  } catch (error) {
    operationLog.error({ error }, 'Failed to list A/B tests');
    throw error;
  }
}
