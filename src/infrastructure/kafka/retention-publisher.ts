

import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/logger/index.js';
import { getKafkaProducer } from './client.js';
import { KafkaTopics } from './topics.js';

export async function publishCampaignEvent(
  topic: string,
  event: {
    id?: string;
    campaignId: string;
    strategyId: string;
    customerId: string;
    organizationId: string;
    triggerType: string;
    campaignStatus: string;
    campaignPriority: string;
    triggerContext?: Record<string, any>;
    revenueRecovered?: number;
    timeToConversionSeconds?: number;
    occurredAt?: Date;
  }
): Promise<void> {
  try {
    const producer = getKafkaProducer();

    const eventData = {
      id: event.id || randomUUID(),
      campaignId: event.campaignId,
      strategyId: event.strategyId,
      customerId: event.customerId,
      organizationId: event.organizationId,
      triggerType: event.triggerType,
      campaignStatus: event.campaignStatus,
      campaignPriority: event.campaignPriority,
      triggerContext: event.triggerContext,
      revenueRecovered: event.revenueRecovered,
      timeToConversionSeconds: event.timeToConversionSeconds,
      occurredAt: (event.occurredAt || new Date()).toISOString(),
    };

    await producer.send({
      topic,
      messages: [
        {
          key: event.organizationId,
          value: JSON.stringify(eventData),
          headers: {
            event_type: topic.split('.').pop() || 'unknown',
            campaign_id: event.campaignId,
            customer_id: event.customerId,
            occurred_at: eventData.occurredAt,
          },
        },
      ],
      acks: -1,
    });

    logger.debug(
      {
        topic,
        campaignId: event.campaignId,
        organizationId: event.organizationId,
      },
      'Campaign event published to Kafka'
    );
  } catch (error) {
    logger.error(
      { topic, campaignId: event.campaignId, error },
      'Failed to publish campaign event to Kafka'
    );
    // Don't throw - event tracking shouldn't block main flow
  }
}


export async function publishActionEvent(
  topic: string,
  event: {
    id?: string;
    actionId: string;
    campaignId: string;
    strategyId: string;
    customerId: string;
    organizationId: string;
    actionType: string;
    actionStatus: string;
    actionData?: Record<string, any>;
    executionResult?: Record<string, any>;
    errorMessage?: string;
    retryCount?: number;
    delayMinutes?: number;
    scheduledFor?: Date;
    executedAt?: Date;
    occurredAt?: Date;
  }
): Promise<void> {
  try {
    const producer = getKafkaProducer();

    const eventData = {
      id: event.id || randomUUID(),
      actionId: event.actionId,
      campaignId: event.campaignId,
      strategyId: event.strategyId,
      customerId: event.customerId,
      organizationId: event.organizationId,
      actionType: event.actionType,
      actionStatus: event.actionStatus,
      actionData: event.actionData,
      executionResult: event.executionResult,
      errorMessage: event.errorMessage,
      retryCount: event.retryCount,
      delayMinutes: event.delayMinutes,
      scheduledFor: event.scheduledFor?.toISOString(),
      executedAt: event.executedAt?.toISOString(),
      occurredAt: (event.occurredAt || new Date()).toISOString(),
    };

    await producer.send({
      topic,
      messages: [
        {
          key: event.organizationId,
          value: JSON.stringify(eventData),
          headers: {
            event_type: topic.split('.').pop() || 'unknown',
            action_id: event.actionId,
            campaign_id: event.campaignId,
            occurred_at: eventData.occurredAt,
          },
        },
      ],
      acks: -1,
    });

    logger.debug(
      {
        topic,
        actionId: event.actionId,
        actionType: event.actionType,
      },
      'Action event published to Kafka'
    );
  } catch (error) {
    logger.error(
      { topic, actionId: event.actionId, error },
      'Failed to publish action event to Kafka'
    );
  }
}


export async function publishEmailEvent(
  event: {
    id?: string;
    actionId: string;
    campaignId: string;
    templateId: string;
    customerId: string;
    organizationId: string;
    emailTo: string;
    emailSubject: string;
    messageId: string;
    eventType: string;
    clickedUrl?: string;
    bounceType?: string;
    bounceReason?: string;
    templateVariant?: string;
    occurredAt?: Date;
  }
): Promise<void> {
  try {
    const producer = getKafkaProducer();

    const eventData = {
      id: event.id || randomUUID(),
      actionId: event.actionId,
      campaignId: event.campaignId,
      templateId: event.templateId,
      customerId: event.customerId,
      organizationId: event.organizationId,
      emailTo: event.emailTo,
      emailSubject: event.emailSubject,
      messageId: event.messageId,
      eventType: event.eventType,
      clickedUrl: event.clickedUrl,
      bounceType: event.bounceType,
      bounceReason: event.bounceReason,
      templateVariant: event.templateVariant,
      occurredAt: (event.occurredAt || new Date()).toISOString(),
    };

    const topicMap: Record<string, string> = {
      delivered: KafkaTopics.RETENTION_ACTION_DELIVERED,
      opened: KafkaTopics.RETENTION_ACTION_OPENED,
      clicked: KafkaTopics.RETENTION_ACTION_CLICKED,
    };

    const topic = topicMap[event.eventType] || KafkaTopics.RETENTION_ACTION_DELIVERED;

    await producer.send({
      topic,
      messages: [
        {
          key: event.organizationId,
          value: JSON.stringify(eventData),
          headers: {
            event_type: event.eventType,
            action_id: event.actionId,
            template_id: event.templateId,
            occurred_at: eventData.occurredAt,
          },
        },
      ],
      acks: -1,
    });

    logger.debug(
      {
        topic,
        actionId: event.actionId,
        eventType: event.eventType,
      },
      'Email event published to Kafka'
    );
  } catch (error) {
    logger.error(
      { actionId: event.actionId, eventType: event.eventType, error },
      'Failed to publish email event to Kafka'
    );
  }
}
