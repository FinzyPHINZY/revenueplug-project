

import Mixpanel from 'mixpanel';
import { logger } from '../../shared/logger/index.js';
import { config } from '../../shared/config/index.js';

const log = logger.child({ module: 'mixpanel' });

let mixpanelClient: Mixpanel.Mixpanel | null = null;

function getMixpanelClient(): Mixpanel.Mixpanel {
  if (!mixpanelClient) {
    const token = config['MIXPANEL_PROJECT_TOKEN'] || process.env.MIXPANEL_PROJECT_TOKEN;

    if (!token) {
      throw new Error('MIXPANEL_PROJECT_TOKEN is not configured');
    }

    mixpanelClient = Mixpanel.init(token);
    log.info('Mixpanel client initialized');
  }

  return mixpanelClient;
}

export interface TrackEventParams {
  eventName: string;
  userId: string; // Customer ID or external ID
  properties?: Record<string, any>;
}

export interface TrackEventResult {
  success: boolean;
  error?: string;
}


export async function trackEvent(params: TrackEventParams): Promise<TrackEventResult> {
  const operationLog = log.child({
    operation: 'trackEvent',
    eventName: params.eventName,
    userId: params.userId,
  });

  try {
    const client = getMixpanelClient();

    // Track event
    client.track(params.eventName, {
      distinct_id: params.userId,
      ...params.properties,
      source: 'revenueplug_retention',
      timestamp: new Date().toISOString(),
    });

    operationLog.info('Event tracked in Mixpanel');

    return { success: true };
  } catch (error) {
    operationLog.error({ error }, 'Failed to track event in Mixpanel');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export async function setUserProfile(
  userId: string,
  properties: Record<string, any>
): Promise<TrackEventResult> {
  const operationLog = log.child({
    operation: 'setUserProfile',
    userId,
  });

  try {
    const client = getMixpanelClient();

    client.people.set(userId, {
      ...properties,
      $last_updated: new Date().toISOString(),
    });

    operationLog.info('User profile updated in Mixpanel');

    return { success: true };
  } catch (error) {
    operationLog.error({ error }, 'Failed to update user profile in Mixpanel');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export async function incrementUserProperty(
  userId: string,
  property: string,
  value: number = 1
): Promise<TrackEventResult> {
  const operationLog = log.child({
    operation: 'incrementUserProperty',
    userId,
    property,
  });

  try {
    const client = getMixpanelClient();

    client.people.increment(userId, property, value);

    operationLog.info({ value }, 'User property incremented in Mixpanel');

    return { success: true };
  } catch (error) {
    operationLog.error({ error }, 'Failed to increment user property in Mixpanel');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export async function sendUsageNudge(params: {
  userId: string;
  nudgeType: string;
  message: string;
  properties?: Record<string, any>;
}): Promise<TrackEventResult> {
  const operationLog = log.child({
    operation: 'sendUsageNudge',
    userId: params.userId,
    nudgeType: params.nudgeType,
  });

  try {
    const client = getMixpanelClient();

    client.track('usage_nudge_sent', {
      distinct_id: params.userId,
      nudge_type: params.nudgeType,
      message: params.message,
      source: 'revenueplug_retention',
      timestamp: new Date().toISOString(),
      ...params.properties,
    });

    operationLog.info('Usage nudge sent to Mixpanel');

    return { success: true };
  } catch (error) {
    operationLog.error({ error }, 'Failed to send usage nudge');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export async function batchTrackEvents(
  events: TrackEventParams[]
): Promise<TrackEventResult> {
  const operationLog = log.child({
    operation: 'batchTrackEvents',
    count: events.length,
  });

  try {
    const results = await Promise.all(events.map((event) => trackEvent(event)));

    const successCount = results.filter((r) => r.success).length;
    operationLog.info(
      { successCount, totalCount: events.length },
      'Batch event tracking completed'
    );

    return { success: true };
  } catch (error) {
    operationLog.error({ error }, 'Failed to batch track events');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export function isMixpanelConfigured(): boolean {
  const token = config['MIXPANEL_PROJECT_TOKEN'] || process.env.MIXPANEL_PROJECT_TOKEN;
  return Boolean(token);
}
