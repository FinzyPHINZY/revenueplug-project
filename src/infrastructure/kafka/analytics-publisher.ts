

import { logger } from '../../shared/logger/index.js';
import { getKafkaProducer } from './client.js';

export const AnalyticsTopics = {
  BEHAVIORAL_EVENTS: 'analytics.behavioral-events',
  USAGE_METRICS: 'analytics.usage-metrics',
  PAYMENT_EVENTS: 'analytics.payment-events',
  HEALTH_SCORES: 'analytics.health-scores',
  CHURN_RISKS: 'analytics.churn-risks',
  PAYMENT_PREDICTIONS: 'analytics.payment-predictions',
} as const;

export type AnalyticsTopic = (typeof AnalyticsTopics)[keyof typeof AnalyticsTopics];


export async function publishAnalyticsEvent(
  topic: AnalyticsTopic | string,
  event: Record<string, any>
): Promise<void> {
  try {
    const producer = getKafkaProducer();

    await producer.send({
      topic,
      messages: [
        {
          key: event['customerId'] || event['customer_id'] || event['organizationId'] || 'unknown',
          value: JSON.stringify(event),
          headers: {
            event_type: event['eventType'] || event['event_type'] || 'unknown',
            occurred_at: new Date().toISOString(),
          },
        },
      ],
      acks: -1,
    });

    logger.debug(
      {
        topic,
        customerId: event['customerId'] || event['customer_id'],
        eventType: event['eventType'] || event['event_type'],
      },
      'Analytics event published to Kafka'
    );
  } catch (error) {
    logger.error(
      { topic, error },
      'Failed to publish analytics event to Kafka'
    );
  }
}


export async function publishAnalyticsEventBatch(
  topic: AnalyticsTopic | string,
  events: Record<string, any>[]
): Promise<void> {
  try {
    const producer = getKafkaProducer();

    await producer.send({
      topic,
      messages: events.map((event) => ({
        key: event['customerId'] || event['customer_id'] || event['organizationId'] || 'unknown',
        value: JSON.stringify(event),
        headers: {
          event_type: event['eventType'] || event['event_type'] || 'unknown',
          occurred_at: new Date().toISOString(),
        },
      })),
      acks: -1,
    });

    logger.debug(
      { topic, count: events.length },
      'Analytics event batch published to Kafka'
    );
  } catch (error) {
    logger.error(
      { topic, count: events.length, error },
      'Failed to publish analytics event batch to Kafka'
    );
  }
}
