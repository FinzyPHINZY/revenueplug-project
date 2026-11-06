import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/logger/index.js';
import type { Platform } from '../../shared/types/index.js';
import { getKafkaProducer } from './client.js';
import { getTopicForEvent, type KafkaTopic } from './topics.js';

export interface KafkaEvent {
  event_id: string;
  event: string;
  event_version: string;
  occurred_at: string;
  account_id: string;
  connection_id: string;
  platform: Platform;
  platform_event: string;
  data: Record<string, unknown>;
  raw_data: Record<string, unknown>;
}

export async function publishEvent(event: KafkaEvent): Promise<void> {
  try {
    const producer = getKafkaProducer();
    const topic = getTopicForEvent(event.event);

    await producer.send({
      topic,
      messages: [
        {
          key: event.account_id,
          value: JSON.stringify(event),
          headers: {
            event_id: event.event_id,
            event_type: event.event,
            platform: event.platform,
            occurred_at: event.occurred_at,
          },
        },
      ],

      acks: -1,
    });

    logger.debug(
      {
        event_id: event.event_id,
        event: event.event,
        topic,
        account_id: event.account_id,
      },
      'Event published to Kafka'
    );
  } catch (error) {
    logger.error(
      {
        error,
        event_id: event.event_id,
        event: event.event,
      },
      'Failed to publish event to Kafka'
    );
    throw error;
  }
}

export async function publishEventBatch(events: KafkaEvent[]): Promise<void> {
  try {
    const producer = getKafkaProducer();

    const eventsByTopic = events.reduce(
      (acc, event) => {
        const topic = getTopicForEvent(event.event);
        if (!acc[topic]) {
          acc[topic] = [];
        }
        acc[topic].push(event);
        return acc;
      },
      {} as Record<KafkaTopic, KafkaEvent[]>
    );

    const sendPromises = Object.entries(eventsByTopic).map(([topic, topicEvents]) =>
      producer.send({
        topic,
        messages: topicEvents.map((event) => ({
          key: event.account_id,
          value: JSON.stringify(event),
          headers: {
            event_id: event.event_id,
            event_type: event.event,
            platform: event.platform,
            occurred_at: event.occurred_at,
          },
        })),
        acks: -1,
      })
    );

    await Promise.all(sendPromises);

    logger.debug({ count: events.length }, 'Event batch published to Kafka');
  } catch (error) {
    logger.error({ error, count: events.length }, 'Failed to publish event batch to Kafka');
    throw error;
  }
}

export function createKafkaEvent(params: {
  event: string;
  accountId: string;
  connectionId: string;
  platform: Platform;
  platformEvent: string;
  occurredAt: Date;
  data: Record<string, unknown>;
  rawData: Record<string, unknown>;
}): KafkaEvent {
  return {
    event_id: randomUUID(),
    event: params.event,
    event_version: '1',
    occurred_at: params.occurredAt.toISOString(),
    account_id: params.accountId,
    connection_id: params.connectionId,
    platform: params.platform,
    platform_event: params.platformEvent,
    data: params.data,
    raw_data: params.rawData,
  };
}
