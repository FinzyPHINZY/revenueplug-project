

import { getClickHouse } from './clickhouse.js';
import { logger } from '../shared/logger/index.js';

export interface BehavioralEventInput {
  id: string;
  customerId: string;
  connectionId: string;
  organizationId: string;
  eventType: string;
  eventName: string;
  properties?: Record<string, any>;
  source?: string;
  sessionId?: string;
  userId?: string;
  occurredAt: Date;
}

export async function insertBehavioralEvent(
  event: BehavioralEventInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'behavioral_events',
    values: [
      {
        id: event.id,
        customer_id: event.customerId,
        connection_id: event.connectionId,
        organization_id: event.organizationId,
        event_type: event.eventType,
        event_name: event.eventName,
        properties: event.properties ? JSON.stringify(event.properties) : '',
        source: event.source || '',
        session_id: event.sessionId || '',
        user_id: event.userId || '',
        occurred_at: event.occurredAt,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function batchInsertBehavioralEvents(
  events: BehavioralEventInput[]
): Promise<void> {
  if (events.length === 0) return;

  const client = getClickHouse();

  const values = events.map((event) => ({
    id: event.id,
    customer_id: event.customerId,
    connection_id: event.connectionId,
    organization_id: event.organizationId,
    event_type: event.eventType,
    event_name: event.eventName,
    properties: event.properties ? JSON.stringify(event.properties) : '',
    source: event.source || '',
    session_id: event.sessionId || '',
    user_id: event.userId || '',
    occurred_at: event.occurredAt,
  }));

  await client.insert({
    table: 'behavioral_events',
    values,
    format: 'JSONEachRow',
  });

  logger.info({ count: events.length }, 'Batch inserted behavioral events');
}


export async function getEventCount(
  customerId: string,
  eventType: string,
  startDate: Date,
  endDate?: Date
): Promise<number> {
  const client = getClickHouse();

  const query = `
    SELECT count() as count
    FROM behavioral_events
    WHERE customer_id = {customerId:String}
      AND event_type = {eventType:String}
      AND occurred_at >= {startDate:DateTime64(3)}
      ${endDate ? 'AND occurred_at <= {endDate:DateTime64(3)}' : ''}
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      eventType,
      startDate: startDate.toISOString(),
      ...(endDate && { endDate: endDate.toISOString() }),
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<{ count: string }>();
  return data.length > 0 && data[0] ? parseInt(data[0].count, 10) : 0;
}


export async function getRecentEvents(
  customerId: string,
  limit: number = 50
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM behavioral_events
    WHERE customer_id = {customerId:String}
    ORDER BY occurred_at DESC
    LIMIT {limit:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      limit,
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}

export async function getEventTimeline(
  customerId: string,
  startDate: Date,
  endDate?: Date
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM behavioral_events
    WHERE customer_id = {customerId:String}
      AND occurred_at >= {startDate:DateTime64(3)}
      ${endDate ? 'AND occurred_at <= {endDate:DateTime64(3)}' : ''}
    ORDER BY occurred_at ASC
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      startDate: startDate.toISOString(),
      ...(endDate && { endDate: endDate.toISOString() }),
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}


export async function getLoginFrequency(
  customerId: string,
  days: number = 30
): Promise<{
  totalLogins: number;
  uniqueDays: number;
  averagePerDay: number;
}> {
  const client = getClickHouse();

  const query = `
    SELECT
      count() as total_logins,
      uniq(toDate(occurred_at)) as unique_days
    FROM behavioral_events
    WHERE customer_id = {customerId:String}
      AND event_type = 'LOGIN'
      AND occurred_at >= now() - INTERVAL {days:UInt32} DAY
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      days,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<{
    total_logins: string;
    unique_days: string;
  }>();

  const totalLogins = data.length > 0 && data[0] ? parseInt(data[0].total_logins, 10) : 0;
  const uniqueDays = data.length > 0 && data[0] ? parseInt(data[0].unique_days, 10) : 0;
  const averagePerDay = uniqueDays > 0 ? totalLogins / uniqueDays : 0;

  return {
    totalLogins,
    uniqueDays,
    averagePerDay,
  };
}


export interface UsageMetricInput {
  id: string;
  customerId: string;
  connectionId: string;
  organizationId: string;
  metricType: string;
  metricName: string;
  value: number;
  change?: number | null;
  changePercent?: number | null;
  period: string;
  periodStart: Date;
  periodEnd: Date;
  trend?: string | null;
}


export async function insertUsageMetric(
  metric: UsageMetricInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'usage_metrics',
    values: [
      {
        id: metric.id,
        customer_id: metric.customerId,
        connection_id: metric.connectionId,
        organization_id: metric.organizationId,
        metric_type: metric.metricType,
        metric_name: metric.metricName,
        value: metric.value,
        change: metric.change ?? 0,
        change_percent: metric.changePercent ?? 0,
        period: metric.period,
        period_start: metric.periodStart,
        period_end: metric.periodEnd,
        trend: metric.trend || 'STABLE',
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function getUsageHistory(
  customerId: string,
  metricType: string,
  period: string,
  limit: number = 30
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM usage_metrics
    WHERE customer_id = {customerId:String}
      AND metric_type = {metricType:String}
      AND period = {period:String}
    ORDER BY period_start DESC
    LIMIT {limit:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      metricType,
      period,
      limit,
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}

export async function getUsageTrend(
  customerId: string,
  metricType: string,
  periods: number = 4
): Promise<{
  current: number;
  previous: number | null;
  change: number;
  changePercent: number;
  trend: string;
}> {
  const client = getClickHouse();

  const query = `
    SELECT value, change, change_percent, trend
    FROM usage_metrics
    WHERE customer_id = {customerId:String}
      AND metric_type = {metricType:String}
    ORDER BY period_start DESC
    LIMIT {periods:UInt32}
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      metricType,
      periods,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<{
    value: number;
    change: number;
    change_percent: number;
    trend: string;
  }>();

  if (data.length === 0) {
    return {
      current: 0,
      previous: null,
      change: 0,
      changePercent: 0,
      trend: 'STABLE',
    };
  }

  const current = data[0]?.value ?? 0;
  const previous = data[1]?.value ?? null;

  return {
    current,
    previous,
    change: data[0]?.change ?? 0,
    changePercent: data[0]?.change_percent ?? 0,
    trend: data[0]?.trend ?? 'STABLE',
  };
}

export interface HealthScoreHistoryInput {
  id: string;
  customerId: string;
  organizationId: string;
  overallScore: number;
  paymentHealthScore: number;
  engagementScore: number;
  usageScore: number;
  subscriptionHealthScore: number;
  supportScore: number;
  riskLevel: string;
  trend: string;
  calculatedAt: Date;
}


export async function insertHealthScoreHistory(
  score: HealthScoreHistoryInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'health_score_history',
    values: [
      {
        id: score.id,
        customer_id: score.customerId,
        organization_id: score.organizationId,
        overall_score: score.overallScore,
        payment_health_score: score.paymentHealthScore,
        engagement_score: score.engagementScore,
        usage_score: score.usageScore,
        subscription_health_score: score.subscriptionHealthScore,
        support_score: score.supportScore,
        risk_level: score.riskLevel,
        trend: score.trend,
        calculated_at: score.calculatedAt,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function getHealthScoreHistory(
  customerId: string,
  days: number = 30
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM health_score_history
    WHERE customer_id = {customerId:String}
      AND calculated_at >= now() - INTERVAL {days:UInt32} DAY
    ORDER BY calculated_at DESC
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      days,
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}

export interface ChurnRiskHistoryInput {
  id: string;
  customerId: string;
  organizationId: string;
  churnScore: number;
  churnProbability: number;
  riskLevel: string;
  paymentFailureRisk: number;
  engagementDeclineRisk: number;
  usageDeclineRisk: number;
  supportIssueRisk: number;
  predictedChurnDate: Date | null;
  daysUntilPredictedChurn: number | null;
  priority: string;
  trend: string;
  calculatedAt: Date;
}


export async function insertChurnRiskHistory(
  risk: ChurnRiskHistoryInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'churn_risk_history',
    values: [
      {
        id: risk.id,
        customer_id: risk.customerId,
        organization_id: risk.organizationId,
        churn_score: risk.churnScore,
        churn_probability: risk.churnProbability,
        risk_level: risk.riskLevel,
        payment_failure_risk: risk.paymentFailureRisk,
        engagement_decline_risk: risk.engagementDeclineRisk,
        usage_decline_risk: risk.usageDeclineRisk,
        support_issue_risk: risk.supportIssueRisk,
        predicted_churn_date: risk.predictedChurnDate || new Date(0),
        days_until_predicted_churn: risk.daysUntilPredictedChurn ?? 0,
        priority: risk.priority,
        trend: risk.trend,
        calculated_at: risk.calculatedAt,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function getChurnRiskHistory(
  customerId: string,
  days: number = 30
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM churn_risk_history
    WHERE customer_id = {customerId:String}
      AND calculated_at >= now() - INTERVAL {days:UInt32} DAY
    ORDER BY calculated_at DESC
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      days,
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}


export interface PaymentEventInput {
  id: string;
  customerId: string;
  organizationId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  status: string;
  paymentMethod: string;
  failureCode?: string;
  failureMessage?: string;
  attemptCount: number;
  isRetry: boolean;
  occurredAt: Date;
}

export async function insertPaymentEvent(
  event: PaymentEventInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'payment_events',
    values: [
      {
        id: event.id,
        customer_id: event.customerId,
        organization_id: event.organizationId,
        invoice_id: event.invoiceId,
        amount_cents: event.amountCents,
        currency: event.currency,
        status: event.status,
        payment_method: event.paymentMethod,
        failure_code: event.failureCode || '',
        failure_message: event.failureMessage || '',
        attempt_count: event.attemptCount,
        is_retry: event.isRetry,
        occurred_at: event.occurredAt,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function getPaymentSuccessRate(
  customerId: string,
  days: number = 90
): Promise<{
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  successRate: number;
}> {
  const client = getClickHouse();

  const query = `
    SELECT
      count() as total_payments,
      countIf(status = 'paid') as successful_payments,
      countIf(status = 'failed') as failed_payments
    FROM payment_events
    WHERE customer_id = {customerId:String}
      AND occurred_at >= now() - INTERVAL {days:UInt32} DAY
  `;

  const result = await client.query({
    query,
    query_params: {
      customerId,
      days,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<{
    total_payments: string;
    successful_payments: string;
    failed_payments: string;
  }>();

  const totalPayments =
    data.length > 0 && data[0] ? parseInt(data[0].total_payments, 10) : 0;
  const successfulPayments =
    data.length > 0 && data[0] ? parseInt(data[0].successful_payments, 10) : 0;
  const failedPayments =
    data.length > 0 && data[0] ? parseInt(data[0].failed_payments, 10) : 0;
  const successRate =
    totalPayments > 0 ? successfulPayments / totalPayments : 0;

  return {
    totalPayments,
    successfulPayments,
    failedPayments,
    successRate,
  };
}


export interface PaymentPredictionInput {
  id: string;
  invoiceId: string;
  invoiceExternalId: string;
  customerId: string;
  connectionId: string;
  organizationId: string;
  failureProbability: number;
  predictionScore: number;
  riskLevel: string;
  model: string;
  paymentHistoryScore: number;
  cardHealthScore: number;
  subscriptionScore: number;
  behavioralScore: number;
  criticalFlags: string[];
  confidence: number;
  predictedAt: Date;
  dueDate: Date;
  amountDue: number;
  currency: string;
}


export async function insertPaymentPrediction(
  prediction: PaymentPredictionInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'payment_predictions',
    values: [
      {
        id: prediction.id,
        invoice_id: prediction.invoiceId,
        invoice_external_id: prediction.invoiceExternalId,
        customer_id: prediction.customerId,
        connection_id: prediction.connectionId,
        organization_id: prediction.organizationId,
        failure_probability: prediction.failureProbability,
        prediction_score: prediction.predictionScore,
        risk_level: prediction.riskLevel,
        model: prediction.model,
        payment_history_score: prediction.paymentHistoryScore,
        card_health_score: prediction.cardHealthScore,
        subscription_score: prediction.subscriptionScore,
        behavioral_score: prediction.behavioralScore,
        critical_flags: prediction.criticalFlags,
        confidence: prediction.confidence,
        predicted_at: prediction.predictedAt,
        due_date: prediction.dueDate,
        amount_due: prediction.amountDue,
        currency: prediction.currency,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function getPredictionHistory(
  invoiceId: string
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM payment_predictions
    WHERE invoice_id = {invoiceId:String}
    ORDER BY predicted_at DESC
  `;

  const result = await client.query({
    query,
    query_params: {
      invoiceId,
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}


export async function getHighRiskPredictions(
  organizationId: string,
  minRiskScore: number = 60
): Promise<any[]> {
  const client = getClickHouse();

  const query = `
    SELECT *
    FROM payment_predictions
    WHERE organization_id = {organizationId:String}
      AND prediction_score >= {minRiskScore:UInt8}
      AND predicted_at >= now() - INTERVAL 7 DAY
    ORDER BY prediction_score DESC
    LIMIT 100
  `;

  const result = await client.query({
    query,
    query_params: {
      organizationId,
      minRiskScore,
    },
    format: 'JSONEachRow',
  });

  return await result.json();
}


export async function getPredictionAccuracy(
  organizationId: string,
  days: number = 30
): Promise<{
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
}> {
  const client = getClickHouse();

  const query = `
    SELECT
      count() as total_predictions,
      countIf(
        (failure_probability >= 0.5 AND actual_failed = 1) OR
        (failure_probability < 0.5 AND actual_failed = 0)
      ) as correct_predictions,
      countIf(failure_probability >= 0.5 AND actual_failed = 1) as true_positives,
      countIf(failure_probability >= 0.5 AND actual_failed = 0) as false_positives,
      countIf(failure_probability < 0.5 AND actual_failed = 0) as true_negatives,
      countIf(failure_probability < 0.5 AND actual_failed = 1) as false_negatives
    FROM payment_predictions
    WHERE organization_id = {organizationId:String}
      AND predicted_at >= now() - INTERVAL {days:UInt32} DAY
      AND actual_failed IS NOT NULL
  `;

  const result = await client.query({
    query,
    query_params: {
      organizationId,
      days,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<{
    total_predictions: string;
    correct_predictions: string;
    true_positives: string;
    false_positives: string;
    true_negatives: string;
    false_negatives: string;
  }>();

  if (data.length === 0 || !data[0]) {
    return {
      totalPredictions: 0,
      correctPredictions: 0,
      accuracy: 0,
      truePositives: 0,
      falsePositives: 0,
      trueNegatives: 0,
      falseNegatives: 0,
      precision: 0,
      recall: 0,
      f1Score: 0,
    };
  }

  const row = data[0];
  const totalPredictions = parseInt(row.total_predictions, 10);
  const correctPredictions = parseInt(row.correct_predictions, 10);
  const truePositives = parseInt(row.true_positives, 10);
  const falsePositives = parseInt(row.false_positives, 10);
  const trueNegatives = parseInt(row.true_negatives, 10);
  const falseNegatives = parseInt(row.false_negatives, 10);

  const accuracy = totalPredictions > 0 ? correctPredictions / totalPredictions : 0;
  const precision = (truePositives + falsePositives) > 0 ? truePositives / (truePositives + falsePositives) : 0;
  const recall = (truePositives + falseNegatives) > 0 ? truePositives / (truePositives + falseNegatives) : 0;
  const f1Score = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  return {
    totalPredictions,
    correctPredictions,
    accuracy,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision,
    recall,
    f1Score,
  };
}


export interface CampaignEventInput {
  id: string;
  campaignId: string;
  strategyId: string;
  customerId: string;
  organizationId: string;
  eventType: string;
  triggerType: string;
  campaignStatus: string;
  campaignPriority: string;
  triggerContext?: Record<string, any>;
  revenueRecovered?: number;
  timeToConversionSeconds?: number;
  occurredAt: Date;
}

export async function insertCampaignEvent(
  event: CampaignEventInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'campaign_events',
    values: [
      {
        id: event.id,
        campaign_id: event.campaignId,
        strategy_id: event.strategyId,
        customer_id: event.customerId,
        organization_id: event.organizationId,
        event_type: event.eventType,
        trigger_type: event.triggerType,
        campaign_status: event.campaignStatus,
        campaign_priority: event.campaignPriority,
        trigger_context: event.triggerContext ? JSON.stringify(event.triggerContext) : '',
        revenue_recovered: event.revenueRecovered || null,
        time_to_conversion_seconds: event.timeToConversionSeconds || null,
        occurred_at: event.occurredAt,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function batchInsertCampaignEvents(
  events: CampaignEventInput[]
): Promise<void> {
  if (events.length === 0) return;

  const client = getClickHouse();

  const values = events.map((event) => ({
    id: event.id,
    campaign_id: event.campaignId,
    strategy_id: event.strategyId,
    customer_id: event.customerId,
    organization_id: event.organizationId,
    event_type: event.eventType,
    trigger_type: event.triggerType,
    campaign_status: event.campaignStatus,
    campaign_priority: event.campaignPriority,
    trigger_context: event.triggerContext ? JSON.stringify(event.triggerContext) : '',
    revenue_recovered: event.revenueRecovered || null,
    time_to_conversion_seconds: event.timeToConversionSeconds || null,
    occurred_at: event.occurredAt,
  }));

  await client.insert({
    table: 'campaign_events',
    values,
    format: 'JSONEachRow',
  });

  logger.info({ count: events.length }, 'Batch inserted campaign events');
}


export interface ActionEventInput {
  id: string;
  actionId: string;
  campaignId: string;
  strategyId: string;
  customerId: string;
  organizationId: string;
  actionType: string;
  eventType: string;
  actionStatus: string;
  actionData?: Record<string, any>;
  executionResult?: Record<string, any>;
  errorMessage?: string;
  retryCount?: number;
  delayMinutes?: number;
  scheduledFor?: Date;
  executedAt?: Date;
  occurredAt: Date;
}


export async function insertActionEvent(
  event: ActionEventInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'action_events',
    values: [
      {
        id: event.id,
        action_id: event.actionId,
        campaign_id: event.campaignId,
        strategy_id: event.strategyId,
        customer_id: event.customerId,
        organization_id: event.organizationId,
        action_type: event.actionType,
        event_type: event.eventType,
        action_status: event.actionStatus,
        action_data: event.actionData ? JSON.stringify(event.actionData) : '',
        execution_result: event.executionResult ? JSON.stringify(event.executionResult) : '',
        error_message: event.errorMessage || '',
        retry_count: event.retryCount || 0,
        delay_minutes: event.delayMinutes || 0,
        scheduled_for: event.scheduledFor || new Date(0),
        executed_at: event.executedAt || new Date(0),
        occurred_at: event.occurredAt,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function batchInsertActionEvents(
  events: ActionEventInput[]
): Promise<void> {
  if (events.length === 0) return;

  const client = getClickHouse();

  const values = events.map((event) => ({
    id: event.id,
    action_id: event.actionId,
    campaign_id: event.campaignId,
    strategy_id: event.strategyId,
    customer_id: event.customerId,
    organization_id: event.organizationId,
    action_type: event.actionType,
    event_type: event.eventType,
    action_status: event.actionStatus,
    action_data: event.actionData ? JSON.stringify(event.actionData) : '',
    execution_result: event.executionResult ? JSON.stringify(event.executionResult) : '',
    error_message: event.errorMessage || '',
    retry_count: event.retryCount || 0,
    delay_minutes: event.delayMinutes || 0,
    scheduled_for: event.scheduledFor || new Date(0),
    executed_at: event.executedAt || new Date(0),
    occurred_at: event.occurredAt,
  }));

  await client.insert({
    table: 'action_events',
    values,
    format: 'JSONEachRow',
  });

  logger.info({ count: events.length }, 'Batch inserted action events');
}

export interface EmailEventInput {
  id: string;
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
  occurredAt: Date;
}


export async function insertEmailEvent(
  event: EmailEventInput
): Promise<void> {
  const client = getClickHouse();

  await client.insert({
    table: 'email_events',
    values: [
      {
        id: event.id,
        action_id: event.actionId,
        campaign_id: event.campaignId,
        template_id: event.templateId,
        customer_id: event.customerId,
        organization_id: event.organizationId,
        email_to: event.emailTo,
        email_subject: event.emailSubject,
        message_id: event.messageId,
        event_type: event.eventType,
        clicked_url: event.clickedUrl || '',
        bounce_type: event.bounceType || '',
        bounce_reason: event.bounceReason || '',
        template_variant: event.templateVariant || '',
        occurred_at: event.occurredAt,
      },
    ],
    format: 'JSONEachRow',
  });
}


export async function batchInsertEmailEvents(
  events: EmailEventInput[]
): Promise<void> {
  if (events.length === 0) return;

  const client = getClickHouse();

  const values = events.map((event) => ({
    id: event.id,
    action_id: event.actionId,
    campaign_id: event.campaignId,
    template_id: event.templateId,
    customer_id: event.customerId,
    organization_id: event.organizationId,
    email_to: event.emailTo,
    email_subject: event.emailSubject,
    message_id: event.messageId,
    event_type: event.eventType,
    clicked_url: event.clickedUrl || '',
    bounce_type: event.bounceType || '',
    bounce_reason: event.bounceReason || '',
    template_variant: event.templateVariant || '',
    occurred_at: event.occurredAt,
  }));

  await client.insert({
    table: 'email_events',
    values,
    format: 'JSONEachRow',
  });

  logger.info({ count: events.length }, 'Batch inserted email events');
}

export interface PaymentTrendDataPoint {
  date: string;
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  totalAmount: number;
  successfulAmount: number;
  failedAmount: number;
  successRate: number;
}

export async function getPaymentTrends(
  organizationId: string,
  days: number = 30
): Promise<PaymentTrendDataPoint[]> {
  const client = getClickHouse();

  const query = `
    SELECT
      toDate(occurred_at) AS date,
      count() AS total_payments,
      countIf(status = 'paid') AS successful_payments,
      countIf(status = 'failed') AS failed_payments,
      sum(amount_cents) AS total_amount,
      sumIf(amount_cents, status = 'paid') AS successful_amount,
      sumIf(amount_cents, status = 'failed') AS failed_amount,
      (successful_payments / total_payments * 100) AS success_rate
    FROM payment_events
    WHERE organization_id = {organizationId:String}
      AND occurred_at >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY date
    ORDER BY date ASC
  `;

  const result = await client.query({
    query,
    query_params: {
      organizationId,
      days,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<any>();

  return data.map((row: any) => ({
    date: row.date,
    totalPayments: row.total_payments,
    successfulPayments: row.successful_payments,
    failedPayments: row.failed_payments,
    totalAmount: row.total_amount,
    successfulAmount: row.successful_amount,
    failedAmount: row.failed_amount,
    successRate: row.success_rate,
  }));
}

export interface RecoveredPayment {
  invoiceId: string;
  customerId: string;
  failedAt: string;
  recoveredAt: string;
  amountCents: number;
  currency: string;
  daysToRecover: number;
  attemptCount: number;
}


export async function getRecoveredRevenue(
  organizationId: string,
  days: number = 30
): Promise<{
  totalRecovered: number;
  recoveredCount: number;
  avgDaysToRecover: number;
  recoveredPayments: RecoveredPayment[];
}> {
  const client = getClickHouse();

  const query = `
    WITH failed AS (
      SELECT
        invoice_id,
        customer_id,
        amount_cents,
        currency,
        occurred_at AS failed_at,
        attempt_count
      FROM payment_events
      WHERE organization_id = {organizationId:String}
        AND status = 'failed'
        AND occurred_at >= now() - INTERVAL {days:UInt32} DAY
    ),
    recovered AS (
      SELECT
        invoice_id,
        occurred_at AS recovered_at
      FROM payment_events
      WHERE organization_id = {organizationId:String}
        AND status = 'paid'
        AND is_retry = true
        AND occurred_at >= now() - INTERVAL {days:UInt32} DAY
    )
    SELECT
      f.invoice_id,
      f.customer_id,
      f.failed_at,
      r.recovered_at,
      f.amount_cents,
      f.currency,
      dateDiff('day', f.failed_at, r.recovered_at) AS days_to_recover,
      f.attempt_count
    FROM failed f
    INNER JOIN recovered r ON f.invoice_id = r.invoice_id
    WHERE r.recovered_at > f.failed_at
    ORDER BY r.recovered_at DESC
  `;

  const result = await client.query({
    query,
    query_params: {
      organizationId,
      days,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<any>();

  const recoveredPayments: RecoveredPayment[] = data.map((row: any) => ({
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    failedAt: row.failed_at,
    recoveredAt: row.recovered_at,
    amountCents: row.amount_cents,
    currency: row.currency,
    daysToRecover: row.days_to_recover,
    attemptCount: row.attempt_count,
  }));

  const totalRecovered = recoveredPayments.reduce(
    (sum, payment) => sum + payment.amountCents,
    0
  );
  const recoveredCount = recoveredPayments.length;
  const avgDaysToRecover =
    recoveredCount > 0
      ? recoveredPayments.reduce((sum, p) => sum + p.daysToRecover, 0) / recoveredCount
      : 0;

  return {
    totalRecovered,
    recoveredCount,
    avgDaysToRecover,
    recoveredPayments,
  };
}

export interface MRRTrendDataPoint {
  date: string;
  mrr: number;
  activeSubscriptions: number;
  newMRR: number;
  churnedMRR: number;
  netMRRGrowth: number;
}


export async function getMRRTrend(
  organizationId: string,
  months: number = 6
): Promise<MRRTrendDataPoint[]> {
  const client = getClickHouse();

  const query = `
    SELECT
      toStartOfMonth(occurred_at) AS month,
      sum(amount_cents) / 100.0 AS total_revenue,
      uniq(customer_id) AS active_customers
    FROM payment_events
    WHERE organization_id = {organizationId:String}
      AND status = 'paid'
      AND occurred_at >= now() - INTERVAL {months:UInt32} MONTH
    GROUP BY month
    ORDER BY month ASC
  `;

  const result = await client.query({
    query,
    query_params: {
      organizationId,
      months,
    },
    format: 'JSONEachRow',
  });

  const data = await result.json<any>();

  return data.map((row: any, index: number) => {
    const previousRevenue = index > 0 ? data[index - 1].total_revenue : row.total_revenue;
    const netGrowth = row.total_revenue - previousRevenue;

    return {
      date: row.month,
      mrr: row.total_revenue,
      activeSubscriptions: row.active_customers,
      newMRR: index === 0 ? 0 : Math.max(netGrowth, 0),
      churnedMRR: index === 0 ? 0 : Math.max(-netGrowth, 0),
      netMRRGrowth: index === 0 ? 0 : netGrowth,
    };
  });
}
