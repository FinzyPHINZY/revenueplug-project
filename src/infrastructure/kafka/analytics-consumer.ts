

import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';
import {
  batchInsertBehavioralEvents,
  insertUsageMetric,
  insertHealthScoreHistory,
  insertChurnRiskHistory,
  insertPaymentEvent,
  insertPaymentPrediction,
  type BehavioralEventInput,
  type UsageMetricInput,
  type HealthScoreHistoryInput,
  type ChurnRiskHistoryInput,
  type PaymentEventInput,
  type PaymentPredictionInput,
} from '../clickhouse-analytics.js';
import { AnalyticsTopics } from './analytics-publisher.js';


let analyticsConsumer: Consumer | null = null;

class EventBuffer {
  private events: BehavioralEventInput[] = [];
  private maxSize: number;
  private maxWaitMs: number;
  private lastFlush: number;
  private flushPromise: Promise<void> | null = null;

  constructor(maxSize = 1000, maxWaitMs = 5000) {
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.lastFlush = Date.now();
  }

  async add(event: BehavioralEventInput): Promise<void> {
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
        await batchInsertBehavioralEvents(eventsToFlush);
        logger.info(
          { count: eventsToFlush.length },
          'Flushed behavioral events to ClickHouse'
        );
      } catch (error) {
        logger.error(
          { count: eventsToFlush.length, error },
          'Failed to flush events to ClickHouse'
        );
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


const eventBuffer = new EventBuffer();


async function processBehavioralEvent(message: EachMessagePayload): Promise<void> {
  try {
    const event = JSON.parse(message.message.value?.toString() || '{}');

    const behavioralEvent: BehavioralEventInput = {
      id: event.id,
      customerId: event.customerId,
      connectionId: event.connectionId,
      organizationId: event.organizationId,
      eventType: event.eventType,
      eventName: event.eventName,
      properties: event.properties,
      source: event.source,
      sessionId: event.sessionId,
      userId: event.userId,
      occurredAt: new Date(event.occurredAt),
    };

    await eventBuffer.add(behavioralEvent);
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process behavioral event'
    );
  }
}


async function processUsageMetric(message: EachMessagePayload): Promise<void> {
  try {
    const metric = JSON.parse(message.message.value?.toString() || '{}');

    const usageMetric: UsageMetricInput = {
      id: metric.id,
      customerId: metric.customerId,
      connectionId: metric.connectionId,
      organizationId: metric.organizationId,
      metricType: metric.metricType,
      metricName: metric.metricName,
      value: metric.value,
      change: metric.change,
      changePercent: metric.changePercent,
      period: metric.period,
      periodStart: new Date(metric.periodStart),
      periodEnd: new Date(metric.periodEnd),
      trend: metric.trend,
    };

    await insertUsageMetric(usageMetric);

    logger.debug(
      { customerId: metric.customerId, metricType: metric.metricType },
      'Usage metric inserted to ClickHouse'
    );
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process usage metric'
    );
  }
}


async function processHealthScore(message: EachMessagePayload): Promise<void> {
  try {
    const score = JSON.parse(message.message.value?.toString() || '{}');

    const healthScore: HealthScoreHistoryInput = {
      id: score.id,
      customerId: score.customerId,
      organizationId: score.organizationId,
      overallScore: score.overallScore,
      paymentHealthScore: score.paymentHealthScore,
      engagementScore: score.engagementScore,
      usageScore: score.usageScore,
      subscriptionHealthScore: score.subscriptionHealthScore,
      supportScore: score.supportScore,
      riskLevel: score.riskLevel,
      trend: score.trend,
      calculatedAt: new Date(score.calculatedAt),
    };

    await insertHealthScoreHistory(healthScore);

    logger.debug(
      { customerId: score.customerId, overallScore: score.overallScore },
      'Health score inserted to ClickHouse'
    );
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process health score'
    );
  }
}


async function processChurnRisk(message: EachMessagePayload): Promise<void> {
  try {
    const risk = JSON.parse(message.message.value?.toString() || '{}');

    const churnRisk: ChurnRiskHistoryInput = {
      id: risk.id,
      customerId: risk.customerId,
      organizationId: risk.organizationId,
      churnScore: risk.churnScore,
      churnProbability: risk.churnProbability,
      riskLevel: risk.riskLevel,
      paymentFailureRisk: risk.paymentFailureRisk,
      engagementDeclineRisk: risk.engagementDeclineRisk,
      usageDeclineRisk: risk.usageDeclineRisk,
      supportIssueRisk: risk.supportIssueRisk,
      predictedChurnDate: risk.predictedChurnDate ? new Date(risk.predictedChurnDate) : null,
      daysUntilPredictedChurn: risk.daysUntilPredictedChurn,
      priority: risk.priority,
      trend: risk.trend,
      calculatedAt: new Date(risk.calculatedAt),
    };

    await insertChurnRiskHistory(churnRisk);

    logger.debug(
      { customerId: risk.customerId, churnScore: risk.churnScore },
      'Churn risk inserted to ClickHouse'
    );
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process churn risk'
    );
  }
}


async function processPaymentEvent(message: EachMessagePayload): Promise<void> {
  try {
    const payment = JSON.parse(message.message.value?.toString() || '{}');

    const paymentEvent: PaymentEventInput = {
      id: payment.id,
      customerId: payment.customerId,
      organizationId: payment.organizationId,
      invoiceId: payment.invoiceId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      failureCode: payment.failureCode,
      failureMessage: payment.failureMessage,
      attemptCount: payment.attemptCount,
      isRetry: payment.isRetry,
      occurredAt: new Date(payment.occurredAt),
    };

    await insertPaymentEvent(paymentEvent);

    logger.debug(
      { customerId: payment.customerId, status: payment.status },
      'Payment event inserted to ClickHouse'
    );
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process payment event'
    );
  }
}


async function processPaymentPrediction(message: EachMessagePayload): Promise<void> {
  try {
    const prediction = JSON.parse(message.message.value?.toString() || '{}');

    const paymentPrediction: PaymentPredictionInput = {
      id: prediction.id,
      invoiceId: prediction.invoiceId,
      invoiceExternalId: prediction.invoiceExternalId,
      customerId: prediction.customerId,
      connectionId: prediction.connectionId,
      organizationId: prediction.organizationId,
      failureProbability: prediction.failureProbability,
      predictionScore: prediction.predictionScore,
      riskLevel: prediction.riskLevel,
      model: prediction.model,
      paymentHistoryScore: prediction.paymentHistoryScore,
      cardHealthScore: prediction.cardHealthScore,
      subscriptionScore: prediction.subscriptionScore,
      behavioralScore: prediction.behavioralScore,
      criticalFlags: prediction.criticalFlags || [],
      confidence: prediction.confidence,
      predictedAt: new Date(prediction.predictedAt),
      dueDate: new Date(prediction.dueDate),
      amountDue: prediction.amountDue,
      currency: prediction.currency,
    };

    await insertPaymentPrediction(paymentPrediction);

    logger.debug(
      { invoiceId: prediction.invoiceId, riskLevel: prediction.riskLevel },
      'Payment prediction inserted to ClickHouse'
    );
  } catch (error) {
    logger.error(
      { partition: message.partition, offset: message.message.offset, error },
      'Failed to process payment prediction'
    );
  }
}

async function handleMessage(payload: EachMessagePayload): Promise<void> {
  const { topic } = payload;

  try {
    switch (topic) {
      case AnalyticsTopics.BEHAVIORAL_EVENTS:
        await processBehavioralEvent(payload);
        break;
      case AnalyticsTopics.USAGE_METRICS:
        await processUsageMetric(payload);
        break;
      case AnalyticsTopics.HEALTH_SCORES:
        await processHealthScore(payload);
        break;
      case AnalyticsTopics.CHURN_RISKS:
        await processChurnRisk(payload);
        break;
      case AnalyticsTopics.PAYMENT_EVENTS:
        await processPaymentEvent(payload);
        break;
      case AnalyticsTopics.PAYMENT_PREDICTIONS:
        await processPaymentPrediction(payload);
        break;
      default:
        logger.warn({ topic }, 'Unknown analytics topic');
    }
  } catch (error) {
    logger.error(
      { topic, partition: payload.partition, offset: payload.message.offset, error },
      'Error handling message'
    );
  }
}


export async function startAnalyticsConsumer(): Promise<void> {
  try {
    const kafka = new Kafka({
      clientId: `${config.KAFKA_CLIENT_ID}-analytics-consumer`,
      brokers: config.KAFKA_BROKERS,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    analyticsConsumer = kafka.consumer({
      groupId: 'analytics-clickhouse-consumer',
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      maxWaitTimeInMs: 5000,
    });

    await analyticsConsumer.connect();
    logger.info('Analytics consumer connected to Kafka');

    await analyticsConsumer.subscribe({
      topics: Object.values(AnalyticsTopics),
      fromBeginning: false,
    });

    logger.info(
      { topics: Object.values(AnalyticsTopics) },
      'Subscribed to analytics topics'
    );


    await analyticsConsumer.run({
      autoCommit: true,
      autoCommitInterval: 5000,
      eachMessage: handleMessage,
    });

    logger.info('Analytics consumer started');


    setInterval(() => {
      eventBuffer.flush().catch((error) => {
        logger.error({ error }, 'Error during periodic buffer flush');
      });
    }, 5000);
  } catch (error) {
    logger.error({ error }, 'Failed to start analytics consumer');
    throw error;
  }
}


export async function stopAnalyticsConsumer(): Promise<void> {
  try {
    await eventBuffer.shutdown();

    if (analyticsConsumer) {
      await analyticsConsumer.disconnect();
      analyticsConsumer = null;
      logger.info('Analytics consumer disconnected');
    }
  } catch (error) {
    logger.error({ error }, 'Error stopping analytics consumer');
    throw error;
  }
}


export function getConsumerStats() {
  return {
    isRunning: analyticsConsumer !== null,
    topics: Object.values(AnalyticsTopics),
  };
}
