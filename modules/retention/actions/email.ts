/**
 * Email Action Executor
 * Sends retention emails via Resend with template rendering and tracking
 */

import type { CampaignAction } from '@prisma/client';
import { sendEmail } from '../../../infrastructure/email/resend.js';
import { prisma } from '../../../infrastructure/postgres/index.js';
import { logger } from '../../../shared/logger/index.js';
import { renderEmailTemplate } from '../templates/renderer.js';
import type {
  CampaignWithRelations,
  EmailActionConfig,
  ExecuteActionResult,
  TemplateData,
} from '../types.js';

const log = logger.child({ module: 'email-action' });

/**
 * Execute an email action
 */
export async function executeEmailAction(
  action: CampaignAction,
  campaign: CampaignWithRelations
): Promise<ExecuteActionResult> {
  const operationLog = log.child({
    operation: 'executeEmailAction',
    actionId: action.id,
    campaignId: campaign.id,
  });

  try {
    const actionData = action.actionData as unknown as EmailActionConfig;
    const { templateId, personalizations, subject: subjectOverride } = actionData;

    // A/B Testing: Select variant if available
    let actualTemplateId = templateId;

    // Check if this template has active variants
    const { selectVariant } = await import('../ab-testing.js');
    try {
      actualTemplateId = await selectVariant(templateId);

      if (actualTemplateId !== templateId) {
        operationLog.info(
          { originalTemplateId: templateId, selectedTemplateId: actualTemplateId },
          'A/B test variant selected'
        );
      }
    } catch (error) {
      operationLog.warn({ error }, 'Failed to select variant, using original template');
      // Continue with original template
    }

    // Get email template (either control or selected variant)
    const template = await prisma.emailTemplate.findUnique({
      where: { id: actualTemplateId },
    });

    if (!template) {
      const error = 'Email template not found';
      operationLog.error({ templateId: actualTemplateId }, error);

      await prisma.campaignAction.update({
        where: { id: action.id },
        data: {
          status: 'FAILED',
          errorMessage: error,
        },
      });

      return { success: false, error };
    }

    // Store which variant was actually used
    await prisma.campaignAction.update({
      where: { id: action.id },
      data: {
        actionData: {
          ...actionData,
          templateId: actualTemplateId, // Update to actual template used
          originalTemplateId: templateId, // Keep track of original
          variantName: template.variantName, // Store which variant
        },
      },
    });

    // Get customer subscription data
    const subscription = await prisma.subscription.findFirst({
      where: {
        customerId: campaign.customer.id,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get or create email preferences and generate unsubscribe links
    const { getOrCreateEmailPreferences, generateUnsubscribeUrl, getPreferenceCenterUrl } =
      await import('../email-preferences.js');

    const preferences = await getOrCreateEmailPreferences(
      campaign.customer.id,
      campaign.organizationId
    );

    const unsubscribeUrl = generateUnsubscribeUrl(preferences.unsubscribeToken!);
    const preferenceCenterUrl = getPreferenceCenterUrl(preferences.unsubscribeToken!);

    // Build template data
    const templateData: TemplateData = {
      customerName: campaign.customer.name || undefined,
      customerEmail: campaign.customer.email || undefined,
      planName: subscription?.productName || undefined,
      amount: subscription ? Number(subscription.amount) : undefined,
      currency: subscription?.currency || undefined,
      trialEndDate: subscription?.trialEnd || undefined,
      currentPeriodEnd: subscription?.currentPeriodEnd || undefined,
      unsubscribeUrl,
      preferenceCenterUrl,
      ...personalizations, // Merge custom personalizations
    };

    // Render template (will automatically inject unsubscribe links)
    const rendered = renderEmailTemplate(template, templateData);

    // Use subject override if provided
    const finalSubject = subjectOverride || rendered.subject;

    // Check if customer has email
    if (!campaign.customer.email) {
      const error = 'Customer email not available';
      operationLog.warn(error);

      await prisma.campaignAction.update({
        where: { id: action.id },
        data: {
          status: 'FAILED',
          errorMessage: error,
        },
      });

      return { success: false, error };
    }

    // Send email via Resend
    const result = await sendEmail({
      to: campaign.customer.email,
      subject: finalSubject,
      html: rendered.html,
      text: rendered.text,
      tags: [
        { name: 'campaign_id', value: campaign.id },
        { name: 'action_id', value: action.id },
        { name: 'organization_id', value: campaign.organizationId },
        { name: 'template_id', value: templateId },
      ],
    });

    if (!result.success) {
      operationLog.error({ error: result.error }, 'Failed to send email');

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
          messageId: result.id,
          provider: 'resend',
          sentAt: new Date().toISOString(),
        },
      },
    });

    // Increment usage tracking for emails sent
    const currentMonth = new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);

    await prisma.usageTracking.upsert({
      where: {
        organizationId_period: {
          organizationId: campaign.organizationId,
          period: currentMonth,
        },
      },
      create: {
        organizationId: campaign.organizationId,
        period: currentMonth,
        emailsSent: 1,
      },
      update: {
        emailsSent: { increment: 1 },
      },
    });

    // Update template stats
    await prisma.emailTemplate.update({
      where: { id: templateId },
      data: {
        sentCount: { increment: 1 },
      },
    });

    operationLog.info({ messageId: result.id }, 'Email sent successfully');

    return {
      success: true,
      result: {
        messageId: result.id,
        provider: 'resend',
      },
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to execute email action');

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
