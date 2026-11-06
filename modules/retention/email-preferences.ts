/**
 * Email Preference Management Service
 *
 * Handles unsubscribe management and email preference center
 * - Global unsubscribe (all emails)
 * - Category-specific preferences (churn, payment, trial, usage, etc.)
 * - One-click unsubscribe tokens
 * - Compliance with CAN-SPAM and GDPR
 */

import { randomBytes } from 'node:crypto';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

const log = logger.child({ module: 'email-preferences' });

export type EmailCategory =
  | 'CHURN_PREVENTION'
  | 'PAYMENT_RECOVERY'
  | 'TRIAL_CONVERSION'
  | 'USAGE_NUDGES'
  | 'PRODUCT_UPDATES'
  | 'NEWS_MARKETING';

export interface UnsubscribeParams {
  customerId: string;
  organizationId: string;
  category?: EmailCategory; // If omitted, unsubscribe from all
  reason?: string;
  source?: string; // Campaign ID or email template ID
  userAgent?: string;
  ipAddress?: string;
}

export interface EmailPreferenceUpdate {
  churnPreventionEnabled?: boolean;
  paymentRecoveryEnabled?: boolean;
  trialConversionEnabled?: boolean;
  usageNudgesEnabled?: boolean;
  productUpdatesEnabled?: boolean;
  newsMarketingEnabled?: boolean;
}

/**
 * Get or create email preferences for a customer
 */
export async function getOrCreateEmailPreferences(
  customerId: string,
  organizationId: string
) {
  const operationLog = log.child({
    operation: 'getOrCreateEmailPreferences',
    customerId,
    organizationId,
  });

  try {
    // Try to find existing preferences
    let preferences = await prisma.emailPreference.findUnique({
      where: {
        customerId_organizationId: {
          customerId,
          organizationId,
        },
      },
    });

    // Create if doesn't exist (all categories enabled by default)
    if (!preferences) {
      const unsubscribeToken = generateUnsubscribeToken();

      preferences = await prisma.emailPreference.create({
        data: {
          customerId,
          organizationId,
          unsubscribeToken,
          unsubscribedAll: false,
          churnPreventionEnabled: true,
          paymentRecoveryEnabled: true,
          trialConversionEnabled: true,
          usageNudgesEnabled: true,
          productUpdatesEnabled: true,
          newsMarketingEnabled: true,
        },
      });

      operationLog.info('Created email preferences with all categories enabled');
    }

    return preferences;
  } catch (error) {
    operationLog.error({ error }, 'Failed to get or create email preferences');
    throw error;
  }
}

/**
 * Generate a secure unsubscribe token
 */
function generateUnsubscribeToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Unsubscribe customer from emails
 */
export async function unsubscribeCustomer(
  params: UnsubscribeParams
): Promise<void> {
  const operationLog = log.child({
    operation: 'unsubscribeCustomer',
    customerId: params.customerId,
    organizationId: params.organizationId,
    category: params.category,
  });

  try {
    // Get or create preferences
    let preferences = await getOrCreateEmailPreferences(
      params.customerId,
      params.organizationId
    );

    // Build update data
    const updateData: any = {
      unsubscribeReason: params.reason,
      unsubscribeSource: params.source,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    };

    if (params.category) {
      // Unsubscribe from specific category
      switch (params.category) {
        case 'CHURN_PREVENTION':
          updateData.churnPreventionEnabled = false;
          break;
        case 'PAYMENT_RECOVERY':
          updateData.paymentRecoveryEnabled = false;
          break;
        case 'TRIAL_CONVERSION':
          updateData.trialConversionEnabled = false;
          break;
        case 'USAGE_NUDGES':
          updateData.usageNudgesEnabled = false;
          break;
        case 'PRODUCT_UPDATES':
          updateData.productUpdatesEnabled = false;
          break;
        case 'NEWS_MARKETING':
          updateData.newsMarketingEnabled = false;
          break;
      }

      operationLog.info({ category: params.category }, 'Unsubscribed from category');
    } else {
      // Unsubscribe from ALL emails
      updateData.unsubscribedAll = true;
      updateData.unsubscribedAt = new Date();
      updateData.churnPreventionEnabled = false;
      updateData.paymentRecoveryEnabled = false;
      updateData.trialConversionEnabled = false;
      updateData.usageNudgesEnabled = false;
      updateData.productUpdatesEnabled = false;
      updateData.newsMarketingEnabled = false;

      operationLog.info('Unsubscribed from all emails');
    }

    // Update preferences
    await prisma.emailPreference.update({
      where: { id: preferences.id },
      data: updateData,
    });
  } catch (error) {
    operationLog.error({ error }, 'Failed to unsubscribe customer');
    throw error;
  }
}

/**
 * Unsubscribe using token (one-click unsubscribe)
 */
export async function unsubscribeByToken(
  token: string,
  category?: EmailCategory,
  metadata?: {
    reason?: string;
    source?: string;
    userAgent?: string;
    ipAddress?: string;
  }
): Promise<void> {
  const operationLog = log.child({
    operation: 'unsubscribeByToken',
    category,
  });

  try {
    // Find preferences by token
    const preferences = await prisma.emailPreference.findUnique({
      where: { unsubscribeToken: token },
    });

    if (!preferences) {
      operationLog.warn({ token }, 'Unsubscribe token not found');
      throw new Error('Invalid unsubscribe token');
    }

    // Unsubscribe
    await unsubscribeCustomer({
      customerId: preferences.customerId,
      organizationId: preferences.organizationId,
      category,
      ...metadata,
    });

    operationLog.info(
      { customerId: preferences.customerId },
      'Customer unsubscribed via token'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to unsubscribe by token');
    throw error;
  }
}

/**
 * Resubscribe customer to all emails
 */
export async function resubscribeCustomer(
  customerId: string,
  organizationId: string
): Promise<void> {
  const operationLog = log.child({
    operation: 'resubscribeCustomer',
    customerId,
    organizationId,
  });

  try {
    const preferences = await getOrCreateEmailPreferences(
      customerId,
      organizationId
    );

    await prisma.emailPreference.update({
      where: { id: preferences.id },
      data: {
        unsubscribedAll: false,
        unsubscribedAt: null,
        churnPreventionEnabled: true,
        paymentRecoveryEnabled: true,
        trialConversionEnabled: true,
        usageNudgesEnabled: true,
        productUpdatesEnabled: true,
        newsMarketingEnabled: true,
      },
    });

    operationLog.info('Customer resubscribed to all emails');
  } catch (error) {
    operationLog.error({ error }, 'Failed to resubscribe customer');
    throw error;
  }
}

/**
 * Update email preferences
 */
export async function updateEmailPreferences(
  customerId: string,
  organizationId: string,
  updates: EmailPreferenceUpdate
): Promise<void> {
  const operationLog = log.child({
    operation: 'updateEmailPreferences',
    customerId,
    organizationId,
  });

  try {
    const preferences = await getOrCreateEmailPreferences(
      customerId,
      organizationId
    );

    await prisma.emailPreference.update({
      where: { id: preferences.id },
      data: updates,
    });

    operationLog.info({ updates }, 'Email preferences updated');
  } catch (error) {
    operationLog.error({ error }, 'Failed to update email preferences');
    throw error;
  }
}

/**
 * Check if customer can receive emails for a specific category
 */
export async function canSendEmail(
  customerId: string,
  organizationId: string,
  category: EmailCategory
): Promise<boolean> {
  const operationLog = log.child({
    operation: 'canSendEmail',
    customerId,
    organizationId,
    category,
  });

  try {
    const preferences = await getOrCreateEmailPreferences(
      customerId,
      organizationId
    );

    // If unsubscribed from all, can't send any emails
    if (preferences.unsubscribedAll) {
      operationLog.debug('Customer unsubscribed from all emails');
      return false;
    }

    // Check category-specific preference
    switch (category) {
      case 'CHURN_PREVENTION':
        return preferences.churnPreventionEnabled;
      case 'PAYMENT_RECOVERY':
        return preferences.paymentRecoveryEnabled;
      case 'TRIAL_CONVERSION':
        return preferences.trialConversionEnabled;
      case 'USAGE_NUDGES':
        return preferences.usageNudgesEnabled;
      case 'PRODUCT_UPDATES':
        return preferences.productUpdatesEnabled;
      case 'NEWS_MARKETING':
        return preferences.newsMarketingEnabled;
      default:
        operationLog.warn({ category }, 'Unknown email category');
        return false;
    }
  } catch (error) {
    operationLog.error({ error }, 'Failed to check if can send email');
    // Default to false to prevent sending emails on error
    return false;
  }
}

/**
 * Get email category from campaign trigger type
 */
export function getCategoryFromTriggerType(
  triggerType: string
): EmailCategory {
  if (triggerType.includes('CHURN')) {
    return 'CHURN_PREVENTION';
  }
  if (triggerType.includes('PAYMENT')) {
    return 'PAYMENT_RECOVERY';
  }
  if (triggerType.includes('TRIAL')) {
    return 'TRIAL_CONVERSION';
  }
  if (triggerType.includes('USAGE')) {
    return 'USAGE_NUDGES';
  }
  return 'PRODUCT_UPDATES'; // Default
}

/**
 * Generate unsubscribe URL for email
 */
export function generateUnsubscribeUrl(
  token: string,
  category?: EmailCategory,
  baseUrl: string = process.env.APP_URL || 'https://app.revenueplug.com'
): string {
  const url = new URL(`${baseUrl}/unsubscribe`);
  url.searchParams.set('token', token);
  if (category) {
    url.searchParams.set('category', category);
  }
  return url.toString();
}

/**
 * Get preference center URL
 */
export function getPreferenceCenterUrl(
  token: string,
  baseUrl: string = process.env.APP_URL || 'https://app.revenueplug.com'
): string {
  return `${baseUrl}/email-preferences?token=${token}`;
}
