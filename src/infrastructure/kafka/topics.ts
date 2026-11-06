export const KafkaTopics = {
  BILLING_SUBSCRIPTION_CREATED: 'billing.subscription.created',
  BILLING_SUBSCRIPTION_UPDATED: 'billing.subscription.updated',
  BILLING_SUBSCRIPTION_CANCELLED: 'billing.subscription.cancelled',
  BILLING_SUBSCRIPTION_RENEWED: 'billing.subscription.renewed',
  BILLING_SUBSCRIPTION_PAUSED: 'billing.subscription.paused',
  BILLING_SUBSCRIPTION_RESUMED: 'billing.subscription.resumed',

  BILLING_CUSTOMER_CREATED: 'billing.customer.created',
  BILLING_CUSTOMER_UPDATED: 'billing.customer.updated',
  BILLING_CUSTOMER_DELETED: 'billing.customer.deleted',

  BILLING_PAYMENT_SUCCEEDED: 'billing.payment.succeeded',
  BILLING_PAYMENT_FAILED: 'billing.payment.failed',
  BILLING_PAYMENT_REFUNDED: 'billing.payment.refunded',

  PLATFORM_CONNECTION_CREATED: 'platform.connection.created',
  PLATFORM_CONNECTION_FAILED: 'platform.connection.failed',
  PLATFORM_CONNECTION_REFRESHED: 'platform.connection.refreshed',

  RETENTION_CAMPAIGN_TRIGGERED: 'retention.campaign.triggered',
  RETENTION_CAMPAIGN_CONVERTED: 'retention.campaign.converted',
  RETENTION_CAMPAIGN_FAILED: 'retention.campaign.failed',
  RETENTION_CAMPAIGN_CANCELLED: 'retention.campaign.cancelled',
  RETENTION_ACTION_SCHEDULED: 'retention.action.scheduled',
  RETENTION_ACTION_SENT: 'retention.action.sent',
  RETENTION_ACTION_DELIVERED: 'retention.action.delivered',
  RETENTION_ACTION_OPENED: 'retention.action.opened',
  RETENTION_ACTION_CLICKED: 'retention.action.clicked',
  RETENTION_ACTION_FAILED: 'retention.action.failed',

  DETECTION_CHURN_RISK_CALCULATED: 'detection.churn_risk.calculated',
  DETECTION_PAYMENT_FAILURE_PREDICTED: 'detection.payment_failure.predicted',

  DLQ_EVENTS: 'dlq.events',
} as const;

export type KafkaTopic = (typeof KafkaTopics)[keyof typeof KafkaTopics];


export function getTopicForEvent(eventType: string): KafkaTopic {
  const topicMap: Record<string, KafkaTopic> = {
    'subscription.created': KafkaTopics.BILLING_SUBSCRIPTION_CREATED,
    'subscription.updated': KafkaTopics.BILLING_SUBSCRIPTION_UPDATED,
    'subscription.cancelled': KafkaTopics.BILLING_SUBSCRIPTION_CANCELLED,
    'subscription.renewed': KafkaTopics.BILLING_SUBSCRIPTION_RENEWED,
    'subscription.paused': KafkaTopics.BILLING_SUBSCRIPTION_PAUSED,
    'subscription.resumed': KafkaTopics.BILLING_SUBSCRIPTION_RESUMED,
    'customer.created': KafkaTopics.BILLING_CUSTOMER_CREATED,
    'customer.updated': KafkaTopics.BILLING_CUSTOMER_UPDATED,
    'customer.deleted': KafkaTopics.BILLING_CUSTOMER_DELETED,
    'payment.succeeded': KafkaTopics.BILLING_PAYMENT_SUCCEEDED,
    'payment.failed': KafkaTopics.BILLING_PAYMENT_FAILED,
    'payment.refunded': KafkaTopics.BILLING_PAYMENT_REFUNDED,
    'connection.created': KafkaTopics.PLATFORM_CONNECTION_CREATED,
    'connection.failed': KafkaTopics.PLATFORM_CONNECTION_FAILED,
    'connection.refreshed': KafkaTopics.PLATFORM_CONNECTION_REFRESHED,
  };

  return topicMap[eventType] || KafkaTopics.DLQ_EVENTS;
}
