import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import {
  batchInsertCampaignEvents,
  batchInsertActionEvents,
  batchInsertEmailEvents,
  type CampaignEventInput,
  type ActionEventInput,
  type EmailEventInput,
} from '../clickhouse-analytics.js';
import { KafkaTopics } from './topics.js';

let retentionConsumer: Consumer | null = null;

class CampaignEventBuffer {
  private events: CampaignEventInput[] = [];
  private maxSize: number;
  private maxWaitMs: number;
  private lastFlush: number;
  private flushPromise: Promise<void> | null = null;

  constructor(maxSize = 500, maxWaitMs = 5000) {
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.lastFlush = Date.now();
  }

  async add(event: CampaignEventInput): Promise<void> {
    this.events.push(event);

    if (this.events.length >= this.maxSize || Date.now() - this.lastFlush >= this.maxWaitMs) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    if (this.events.length === 0) {
      return;
    }

    const eventsToFlush = [...this.events];
    this.events = [];
    this.lastFlush = Date.now();

    this.flushPromise = (async () => {
      try {
        await batchInsertCampaignEvents(eventsToFlush);
        logger.info({ count: eventsToFlush.length }, 'Flushed campaign events to ClickHouse');
      } catch (error) {
        logger.error({ count: eventsToFlush.length, error }, 'Failed to flush campaign events');
        this.events.unshift(...eventsToFlush);
      } finally {
        this.flushPromise = null;
      }
    })();

    return this.flushPromise;
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

class ActionEventBuffer {
  private events: ActionEventInput[] = [];
  private maxSize: number;
  private maxWaitMs: number;
  private lastFlush: number;
  private flushPromise: Promise<void> | null = null;

  constructor(maxSize = 500, maxWaitMs = 5000) {
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.lastFlush = Date.now();
  }

  async add(event: ActionEventInput): Promise<void> {
    this.events.push(event);

    if (this.events.length >= this.maxSize || Date.now() - this.lastFlush >= this.maxWaitMs) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    if (this.events.length === 0) {
      return;
    }

    const eventsToFlush = [...this.events];
    this.events = [];
    this.lastFlush = Date.now();

    this.flushPromise = (async () => {
      try {
        await batchInsertActionEvents(eventsToFlush);
        logger.info({ count: eventsToFlush.length }, 'Flushed action events to ClickHouse');
      } catch (error) {
        logger.error({ count: eventsToFlush.length, error }, 'Failed to flush action events');
        this.events.unshift(...eventsToFlush);
      } finally {
        this.flushPromise = null;
      }
    })();

    return this.flushPromise;
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

class EmailEventBuffer {
  private events: EmailEventInput[] = [];
  private maxSize: number;
  private maxWaitMs: number;
  private lastFlush: number;
  private flushPromise: Promise<void> | null = null;

  constructor(maxSize = 500, maxWaitMs = 5000) {
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.lastFlush = Date.now();
  }

  async add(event: EmailEventInput): Promise<void> {
    this.events.push(event);

    if (this.events.length >= this.maxSize || Date.now() - this.lastFlush >= this.maxWaitMs) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }

    if (this.events.length === 0) {
      return;
    }

    const eventsToFlush = [...this.events];
    this.events = [];
    this.lastFlush = Date.now();

    this.flushPromise = (async () => {
      try {
        await batchInsertEmailEvents(eventsToFlush);
        logger.info({ count: eventsToFlush.length }, 'Flushed email events to ClickHouse');
      } catch (error) {
        logger.error({ count: eventsToFlush.length, error }, 'Failed to flush email events');
        this.events.unshift(...eventsToFlush);
      } finally {
        this.flushPromise = null;
      }
    })();

    return this.flushPromise;
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

const campaignBuffer = new CampaignEventBuffer();
const actionBuffer = new ActionEventBuffer();
const emailBuffer = new EmailEventBuffer();

async function processCampaignEvent(message: EachMessagePayload, eventType: string): Promise<void> {
  try {
    const event = JSON.parse(message.message.value?.toString() || '{}');

    const campaignEvent: CampaignEventInput = {
      id: event.id,
      campaignId: event.campaignId,
      strategyId: event.strategyId,
      customerId: event.customerId,
      organizationId: event.organizationId,
      eventType,
      triggerType: event.triggerType,
      campaignStatus: event.campaignStatus,
      campaignPriority: event.campaignPriority,
      triggerContext: event.triggerContext,
      revenueRecovered: event.revenueRecovered,
      timeToConversionSeconds: event.timeToConversionSeconds,
      occurredAt: new Date(event.occurredAt || Date.now()),
    };

    await campaignBuffer.add(campaignEvent);
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process campaign event'
    );
  }
}

async function processActionEvent(message: EachMessagePayload, eventType: string): Promise<void> {
  try {
    const event = JSON.parse(message.message.value?.toString() || '{}');

    const actionEvent: ActionEventInput = {
      id: event.id,
      actionId: event.actionId,
      campaignId: event.campaignId,
      strategyId: event.strategyId,
      customerId: event.customerId,
      organizationId: event.organizationId,
      actionType: event.actionType,
      eventType,
      actionStatus: event.actionStatus,
      actionData: event.actionData,
      executionResult: event.executionResult,
      errorMessage: event.errorMessage,
      retryCount: event.retryCount,
      delayMinutes: event.delayMinutes,
      scheduledFor: event.scheduledFor ? new Date(event.scheduledFor) : undefined,
      executedAt: event.executedAt ? new Date(event.executedAt) : undefined,
      occurredAt: new Date(event.occurredAt || Date.now()),
    };

    await actionBuffer.add(actionEvent);
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process action event'
    );
  }
}

async function _processEmailEvent(message: EachMessagePayload, eventType: string): Promise<void> {
  try {
    const event = JSON.parse(message.message.value?.toString() || '{}');

    const emailEvent: EmailEventInput = {
      id: event.id,
      actionId: event.actionId,
      campaignId: event.campaignId,
      templateId: event.templateId,
      customerId: event.customerId,
      organizationId: event.organizationId,
      emailTo: event.emailTo,
      emailSubject: event.emailSubject,
      messageId: event.messageId,
      eventType,
      clickedUrl: event.clickedUrl,
      bounceType: event.bounceType,
      bounceReason: event.bounceReason,
      templateVariant: event.templateVariant,
      occurredAt: new Date(event.occurredAt || Date.now()),
    };

    await emailBuffer.add(emailEvent);
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process email event'
    );
  }
}

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const { topic } = payload;

  try {
    switch (topic) {
      case KafkaTopics.RETENTION_CAMPAIGN_TRIGGERED:
        await processCampaignEvent(payload, 'triggered');
        break;
      case KafkaTopics.RETENTION_CAMPAIGN_CONVERTED:
        await processCampaignEvent(payload, 'converted');
        break;
      case KafkaTopics.RETENTION_CAMPAIGN_FAILED:
        await processCampaignEvent(payload, 'failed');
        break;
      case KafkaTopics.RETENTION_CAMPAIGN_CANCELLED:
        await processCampaignEvent(payload, 'cancelled');
        break;

      case KafkaTopics.RETENTION_ACTION_SCHEDULED:
        await processActionEvent(payload, 'scheduled');
        break;
      case KafkaTopics.RETENTION_ACTION_SENT:
        await processActionEvent(payload, 'sent');
        break;
      case KafkaTopics.RETENTION_ACTION_DELIVERED:
        await processActionEvent(payload, 'delivered');
        break;
      case KafkaTopics.RETENTION_ACTION_OPENED:
        await processActionEvent(payload, 'opened');
        break;
      case KafkaTopics.RETENTION_ACTION_CLICKED:
        await processActionEvent(payload, 'clicked');
        break;
      case KafkaTopics.RETENTION_ACTION_FAILED:
        await processActionEvent(payload, 'failed');
        break;

      default:
        logger.warn({ topic }, 'Unknown retention topic');
    }
  } catch (error) {
    logger.error(
      { topic, partition: payload.partition, offset: payload.message.offset, error },
      'Error handling retention message'
    );
  }
}

const RETENTION_TOPICS = [
  KafkaTopics.RETENTION_CAMPAIGN_TRIGGERED,
  KafkaTopics.RETENTION_CAMPAIGN_CONVERTED,
  KafkaTopics.RETENTION_CAMPAIGN_FAILED,
  KafkaTopics.RETENTION_CAMPAIGN_CANCELLED,
  KafkaTopics.RETENTION_ACTION_SCHEDULED,
  KafkaTopics.RETENTION_ACTION_SENT,
  KafkaTopics.RETENTION_ACTION_DELIVERED,
  KafkaTopics.RETENTION_ACTION_OPENED,
  KafkaTopics.RETENTION_ACTION_CLICKED,
  KafkaTopics.RETENTION_ACTION_FAILED,
];

export async function startRetentionConsumer(): Promise<void> {
  try {
    const kafka = new Kafka({
      clientId: `${config.KAFKA_CLIENT_ID}-retention-consumer`,
      brokers: config.KAFKA_BROKERS,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    retentionConsumer = kafka.consumer({
      groupId: 'retention-clickhouse-consumer',
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      maxWaitTimeInMs: 5000,
    });

    await retentionConsumer.connect();
    logger.info('Retention consumer connected to Kafka');

    await retentionConsumer.subscribe({
      topics: RETENTION_TOPICS,
      fromBeginning: false,
    });

    logger.info({ topics: RETENTION_TOPICS }, 'Subscribed to retention topics');

    await retentionConsumer.run({
      autoCommit: true,
      autoCommitInterval: 5000,
      eachMessage: handleMessage,
    });

    logger.info('Retention consumer started');

    setInterval(() => {
      Promise.all([campaignBuffer.flush(), actionBuffer.flush(), emailBuffer.flush()]).catch(
        (error) => {
          logger.error({ error }, 'Error during periodic buffer flush');
        }
      );
    }, 5000);
  } catch (error) {
    logger.error({ error }, 'Failed to start retention consumer');
    throw error;
  }
}

export async function stopRetentionConsumer(): Promise<void> {
  try {
    await Promise.all([campaignBuffer.shutdown(), actionBuffer.shutdown(), emailBuffer.shutdown()]);

    if (retentionConsumer) {
      await retentionConsumer.disconnect();
      retentionConsumer = null;
      logger.info('Retention consumer disconnected');
    }
  } catch (error) {
    logger.error({ error }, 'Error stopping retention consumer');
    throw error;
  }
}

export function getRetentionConsumerStats() {
  return {
    isRunning: retentionConsumer !== null,
    topics: RETENTION_TOPICS,
  };
}
