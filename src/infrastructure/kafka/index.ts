export { checkKafkaHealth, connectKafka, disconnectKafka, getKafkaProducer } from './client.js';
export { createKafkaEvent, type KafkaEvent, publishEvent, publishEventBatch } from './publisher.js';
export { getTopicForEvent, type KafkaTopic, KafkaTopics } from './topics.js';

export {
  publishAnalyticsEvent,
  publishAnalyticsEventBatch,
  AnalyticsTopics,
  type AnalyticsTopic,
} from './analytics-publisher.js';
export {
  startAnalyticsConsumer,
  stopAnalyticsConsumer,
  getConsumerStats,
} from './analytics-consumer.js';
