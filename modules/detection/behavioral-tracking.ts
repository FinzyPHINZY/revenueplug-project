/**
 * Behavioral Event Tracking Service (ClickHouse)
 *
 * Tracks customer behavioral events for pattern analysis:
 * - Login/logout events
 * - Feature usage
 * - API calls
 * - Settings changes
 * - Support interactions
 * - Integration activity
 *
 * Data stored in ClickHouse for scalable analytics
 */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  getEventCount as clickhouseGetEventCount,
  getEventTimeline as clickhouseGetEventTimeline,
  getRecentEvents as clickhouseGetRecentEvents,
  getLoginFrequency,
} from '../../infrastructure/clickhouse-analytics.js';
import { AnalyticsTopics, publishAnalyticsEvent } from '../../infrastructure/kafka/index.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

// BehavioralEventType enum is kept in Prisma for type safety
type BehavioralEventType =
  | 'LOGIN'
  | 'LOGOUT'
  | 'FEATURE_USED'
  | 'API_CALL'
  | 'PAYMENT_METHOD_UPDATED'
  | 'SETTINGS_CHANGED'
  | 'SUPPORT_TICKET_CREATED'
  | 'EXPORT_DATA'
  | 'INTEGRATION_ADDED'
  | 'TEAM_MEMBER_ADDED';

interface TrackEventInput {
  customerId: string;
  eventType: BehavioralEventType;
  eventName: string;
  properties?: Record<string, any>;
  source?: string;
  sessionId?: string;
  userId?: string;
  occurredAt?: Date;
}

/**
 * Track a behavioral event (writes to ClickHouse via Kafka)
 */
export async function trackEvent(input: TrackEventInput): Promise<void> {
  try {
    // Get customer details for organization_id and connection_id
    const customer = await prisma.customer.findUnique({
      where: { id: input.customerId },
      select: {
        id: true,
        connectionId: true,
        connection: {
          select: { organizationId: true },
        },
      },
    });

    if (!customer) {
      logger.warn({ customerId: input.customerId }, 'Customer not found for event tracking');
      return;
    }

    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      customerId: input.customerId,
      connectionId: customer.connectionId,
      organizationId: customer.connection.organizationId,
      eventType: input.eventType,
      eventName: input.eventName,
      properties: input.properties || {},
      source: input.source,
      sessionId: input.sessionId,
      userId: input.userId,
      occurredAt: input.occurredAt || new Date(),
    };

    // Publish to Kafka (async processing to ClickHouse)
    await publishAnalyticsEvent(AnalyticsTopics.BEHAVIORAL_EVENTS, event);

    logger.debug(
      {
        customerId: input.customerId,
        eventType: input.eventType,
        eventName: input.eventName,
      },
      'Behavioral event tracked'
    );
  } catch (error) {
    logger.error(
      { customerId: input.customerId, eventType: input.eventType, error },
      'Failed to track behavioral event'
    );
    // Don't throw - event tracking shouldn't block main flow
  }
}

/**
 * Track user login
 */
export async function trackLogin(
  customerId: string,
  userId: string,
  sessionId: string,
  source?: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'LOGIN',
    eventName: 'user_login',
    userId,
    sessionId,
    source,
  });
}

/**
 * Track user logout
 */
export async function trackLogout(
  customerId: string,
  userId: string,
  sessionId: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'LOGOUT',
    eventName: 'user_logout',
    userId,
    sessionId,
  });
}

/**
 * Track feature usage
 */
export async function trackFeatureUsage(
  customerId: string,
  featureName: string,
  userId?: string,
  properties?: Record<string, any>
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'FEATURE_USED',
    eventName: featureName,
    userId,
    properties,
  });
}

/**
 * Track API call
 */
export async function trackApiCall(
  customerId: string,
  endpoint: string,
  method: string,
  statusCode: number,
  responseTime?: number
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'API_CALL',
    eventName: `${method} ${endpoint}`,
    properties: {
      endpoint,
      method,
      statusCode,
      responseTime,
    },
    source: 'api',
  });
}

/**
 * Track payment method update
 */
export async function trackPaymentMethodUpdate(customerId: string, userId?: string): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'PAYMENT_METHOD_UPDATED',
    eventName: 'payment_method_updated',
    userId,
  });
}

/**
 * Track settings change
 */
export async function trackSettingsChange(
  customerId: string,
  settingName: string,
  oldValue: any,
  newValue: any,
  userId?: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'SETTINGS_CHANGED',
    eventName: `settings_changed_${settingName}`,
    userId,
    properties: {
      settingName,
      oldValue,
      newValue,
    },
  });
}

/**
 * Track support ticket creation
 */
export async function trackSupportTicket(
  customerId: string,
  ticketId: string,
  subject: string,
  priority?: string,
  userId?: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'SUPPORT_TICKET_CREATED',
    eventName: 'support_ticket_created',
    userId,
    properties: {
      ticketId,
      subject,
      priority,
    },
  });
}

/**
 * Track data export
 */
export async function trackDataExport(
  customerId: string,
  exportType: string,
  recordCount?: number,
  userId?: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'EXPORT_DATA',
    eventName: `data_export_${exportType}`,
    userId,
    properties: {
      exportType,
      recordCount,
    },
  });
}

/**
 * Track integration addition
 */
export async function trackIntegrationAdded(
  customerId: string,
  integrationName: string,
  userId?: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'INTEGRATION_ADDED',
    eventName: `integration_added_${integrationName}`,
    userId,
    properties: {
      integrationName,
    },
  });
}

/**
 * Track team member addition
 */
export async function trackTeamMemberAdded(
  customerId: string,
  newMemberEmail: string,
  role: string,
  userId?: string
): Promise<void> {
  await trackEvent({
    customerId,
    eventType: 'TEAM_MEMBER_ADDED',
    eventName: 'team_member_added',
    userId,
    properties: {
      newMemberEmail,
      role,
    },
  });
}

/**
 * Get event count for a customer in a time period (ClickHouse)
 */
export async function getEventCount(
  customerId: string,
  eventType: BehavioralEventType,
  startDate: Date,
  endDate?: Date
): Promise<number> {
  return await clickhouseGetEventCount(customerId, eventType, startDate, endDate);
}

/**
 * Get recent events for a customer (ClickHouse)
 */
export async function getRecentEvents(customerId: string, limit: number = 50) {
  return await clickhouseGetRecentEvents(customerId, limit);
}

/**
 * Get event timeline for a customer (ClickHouse)
 */
export async function getEventTimeline(customerId: string, startDate: Date, endDate?: Date) {
  return await clickhouseGetEventTimeline(customerId, startDate, endDate);
}

/**
 * Analyze behavioral patterns for a customer (ClickHouse)
 */
export async function analyzeBehavioralPatterns(customerId: string): Promise<{
  loginFrequency: {
    last7Days: number;
    last30Days: number;
    averagePerWeek: number;
  };
  featureUsage: {
    uniqueFeaturesUsed: number;
    totalUsageEvents: number;
    mostUsedFeatures: Array<{ feature: string; count: number }>;
  };
  apiActivity: {
    last7Days: number;
    last30Days: number;
    averagePerDay: number;
  };
  engagement: {
    lastActivityDate: Date | null;
    daysSinceLastActivity: number;
    isActive: boolean; // Active if activity in last 7 days
  };
  riskSignals: string[];
}> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Login frequency (use ClickHouse optimized query)
  const loginData = await getLoginFrequency(customerId, 30);
  const loginsLast7Days = await getEventCount(customerId, 'LOGIN', sevenDaysAgo);
  const averageLoginsPerWeek = loginData.averagePerDay * 7;

  // Feature usage - query ClickHouse
  const featureEvents = await getEventCount(customerId, 'FEATURE_USED', thirtyDaysAgo);

  // API activity
  const apiCallsLast7Days = await getEventCount(customerId, 'API_CALL', sevenDaysAgo);
  const apiCallsLast30Days = await getEventCount(customerId, 'API_CALL', thirtyDaysAgo);
  const averageApiCallsPerDay = apiCallsLast30Days / 30;

  // Last activity - get recent events
  const recentEvents = await getRecentEvents(customerId, 1);
  const lastActivity = recentEvents.length > 0 ? recentEvents[0] : null;

  const daysSinceLastActivity = lastActivity
    ? Math.floor(
        (now.getTime() - new Date(lastActivity.occurred_at).getTime()) / (24 * 60 * 60 * 1000)
      )
    : 999;

  const isActive = daysSinceLastActivity <= 7;

  // Detect risk signals
  const riskSignals: string[] = [];

  if (loginsLast7Days === 0) {
    riskSignals.push('no_logins_7d');
  }
  if (loginData.totalLogins < 3) {
    riskSignals.push('low_login_frequency');
  }
  if (featureEvents === 0) {
    riskSignals.push('no_feature_usage');
  }
  if (featureEvents < 3) {
    riskSignals.push('limited_feature_adoption');
  }
  if (daysSinceLastActivity > 14) {
    riskSignals.push('inactive_14d');
  }
  if (daysSinceLastActivity > 30) {
    riskSignals.push('inactive_30d');
  }
  if (apiCallsLast7Days === 0 && apiCallsLast30Days > 0) {
    riskSignals.push('api_usage_stopped');
  }

  // Check for data export (churn signal)
  const dataExports = await getEventCount(customerId, 'EXPORT_DATA', thirtyDaysAgo);
  if (dataExports > 0) {
    riskSignals.push('data_export_activity');
  }

  return {
    loginFrequency: {
      last7Days: loginsLast7Days,
      last30Days: loginData.totalLogins,
      averagePerWeek: Math.round(averageLoginsPerWeek * 10) / 10,
    },
    featureUsage: {
      uniqueFeaturesUsed: 0, // TODO: Implement unique count query
      totalUsageEvents: featureEvents,
      mostUsedFeatures: [], // TODO: Implement aggregation query
    },
    apiActivity: {
      last7Days: apiCallsLast7Days,
      last30Days: apiCallsLast30Days,
      averagePerDay: Math.round(averageApiCallsPerDay * 10) / 10,
    },
    engagement: {
      lastActivityDate: lastActivity ? new Date(lastActivity.occurred_at) : null,
      daysSinceLastActivity,
      isActive,
    },
    riskSignals,
  };
}

/**
 * Batch track events (for bulk import)
 */
export async function batchTrackEvents(
  events: TrackEventInput[]
): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await trackEvent(event);
      created++;
    } catch (error) {
      failed++;
      logger.error({ event, error }, 'Failed to track event in batch');
    }
  }

  return { created, failed };
}

/**
 * Clean up old events (retention policy) - ClickHouse TTL handles this automatically
 */
export async function cleanupOldEvents(retentionDays: number = 90): Promise<number> {
  logger.info({ retentionDays }, 'ClickHouse TTL handles event cleanup automatically');
  return 0; // No manual cleanup needed
}
