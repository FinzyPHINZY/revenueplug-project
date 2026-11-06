-- This is the ClickHouse Retention Analytics Tables and those tables are necessary to track retention campaigns, actions, and email engagement for historical analysis

-- ============================================================================
-- CAMPAIGN EVENTS TABLE
-- ============================================================================
-- To store all campaign lifecycle events (triggered, converted, cancelled, failed) and it's optimized for campaign performance analysis and funnel tracking

CREATE TABLE IF NOT EXISTS campaign_events (
    -- event identification
    id String,
    campaign_id String,
    strategy_id String,
    customer_id String,
    organization_id String,

    -- event details
    event_type LowCardinality(String), -- triggered, converted, cancelled, failed, completed
    trigger_type LowCardinality(String), -- CHURN_RISK_HIGH, CHURN_RISK_CRITICAL, PAYMENT_FAILURE, TRIAL_ENDING

    -- campaign context
    campaign_status LowCardinality(String), -- ACTIVE, CONVERTED, CANCELLED, FAILED, COMPLETED
    campaign_priority LowCardinality(String), -- IMMEDIATE, HIGH, MEDIUM, LOW

    -- trigger context (JSON string)
    trigger_context String,

    -- conversion tracking
    revenue_recovered Int64, -- In cents, NULL if not converted
    time_to_conversion_seconds Int32, -- NULL if not converted

    -- timestamps
    occurred_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (organization_id, strategy_id, customer_id, occurred_at, event_type)
TTL occurred_at + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- indexes for common queries
CREATE INDEX IF NOT EXISTS idx_campaign_event_type ON campaign_events (event_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_campaign_trigger_type ON campaign_events (trigger_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaign_events (campaign_status) TYPE bloom_filter GRANULARITY 1;

-- ============================================================================
-- ACTION EVENTS TABLE
-- ============================================================================
-- to store all retention action events (scheduled, sent, delivered, failed) and tracks execution of emails, discounts, outreach tasks, usage nudges

CREATE TABLE IF NOT EXISTS action_events (
    -- Event identification
    id String,
    action_id String,
    campaign_id String,
    strategy_id String,
    customer_id String,
    organization_id String,

    -- Action details
    action_type LowCardinality(String), -- EMAIL, DISCOUNT, PERSONAL_OUTREACH, USAGE_NUDGE, FEATURE_HIGHLIGHT
    event_type LowCardinality(String), -- scheduled, sent, delivered, opened, clicked, converted, failed

    -- Action status
    action_status LowCardinality(String), -- PENDING, SCHEDULED, SENT, DELIVERED, OPENED, CLICKED, CONVERTED, FAILED

    -- action configuration (JSON string)
    action_data String,

    -- execution result (JSON string)
    execution_result String,

    -- failure tracking
    error_message String,
    retry_count UInt8,

    -- delay tracking
    delay_minutes Int32,
    scheduled_for DateTime64(3, 'UTC'),
    executed_at DateTime64(3, 'UTC'),

    -- timestamps
    occurred_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (organization_id, strategy_id, action_type, customer_id, occurred_at)
TTL occurred_at + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- indexes
CREATE INDEX IF NOT EXISTS idx_action_type ON action_events (action_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_action_event_type ON action_events (event_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_action_status ON action_events (action_status) TYPE bloom_filter GRANULARITY 1;

-- ============================================================================
-- EMAIL ENGAGEMENT TABLE
-- ============================================================================
-- for detailed email tracking for template performance analysis and to Store delivery, open, click, and bounce events from Resend

CREATE TABLE IF NOT EXISTS email_events (
    -- event identification
    id String,
    action_id String,
    campaign_id String,
    template_id String,
    customer_id String,
    organization_id String,

    -- email details
    email_to String,
    email_subject String,
    message_id String, -- Resend message ID

    -- event type
    event_type LowCardinality(String), -- delivered, opened, clicked, bounced

    -- click tracking
    clicked_url String, -- URL clicked (if applicable)

    -- bounce tracking
    bounce_type LowCardinality(String), -- hard, soft, spam
    bounce_reason String,

    -- template performance
    template_variant String, -- For A/B testing

    -- timestamps
    occurred_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (organization_id, template_id, customer_id, occurred_at, event_type)
TTL occurred_at + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- indexes
CREATE INDEX IF NOT EXISTS idx_email_event_type ON email_events (event_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_email_template ON email_events (template_id) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_message_id ON email_events (message_id) TYPE bloom_filter GRANULARITY 1;

-- ============================================================================
-- STRATEGY PERFORMANCE TABLE
-- ============================================================================
-- pre-aggregated strategy metrics for fast dashboard queries and it is updated daily via background job

CREATE TABLE IF NOT EXISTS strategy_performance (
    -- identification
    strategy_id String,
    organization_id String,

    -- time period
    date Date,

    -- campaign metrics
    campaigns_triggered UInt32,
    campaigns_active UInt32,
    campaigns_converted UInt32,
    campaigns_cancelled UInt32,
    campaigns_failed UInt32,

    -- action metrics
    actions_sent UInt32,
    actions_delivered UInt32,
    actions_failed UInt32,

    -- email metrics
    emails_sent UInt32,
    emails_delivered UInt32,
    emails_opened UInt32,
    emails_clicked UInt32,
    emails_bounced UInt32,

    -- performance rates (0.0-1.0)
    conversion_rate Float32,
    email_open_rate Float32,
    email_click_rate Float32,
    email_bounce_rate Float32,

    -- revenue impact
    total_revenue_recovered Int64, -- In cents
    avg_revenue_per_conversion Int64,

    -- timing metrics
    avg_time_to_conversion_seconds Int32,

    -- metadata
    calculated_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(calculated_at)
PARTITION BY toYYYYMM(date)
ORDER BY (organization_id, strategy_id, date)
TTL date + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;

-- ============================================================================
-- MATERIALIZED VIEWS FOR REAL-TIME AGGREGATIONS
-- ============================================================================

-- view: Daily campaign counts by trigger type
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_campaign_triggers
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (organization_id, trigger_type, event_date)
AS SELECT
    organization_id,
    trigger_type,
    toDate(occurred_at) AS event_date,
    countIf(event_type = 'triggered') AS triggered_count,
    countIf(event_type = 'converted') AS converted_count,
    countIf(event_type = 'cancelled') AS cancelled_count,
    countIf(event_type = 'failed') AS failed_count
FROM campaign_events
GROUP BY organization_id, trigger_type, event_date;

-- view: Hourly action execution rates
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hourly_action_execution
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_hour)
ORDER BY (organization_id, action_type, event_hour)
AS SELECT
    organization_id,
    action_type,
    toStartOfHour(occurred_at) AS event_hour,
    countIf(event_type = 'sent') AS sent_count,
    countIf(event_type = 'delivered') AS delivered_count,
    countIf(event_type = 'failed') AS failed_count
FROM action_events
GROUP BY organization_id, action_type, event_hour;

-- view: Email engagement funnel by template
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_email_engagement_funnel
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (organization_id, template_id, event_date)
AS SELECT
    organization_id,
    template_id,
    toDate(occurred_at) AS event_date,
    countIf(event_type = 'delivered') AS delivered_count,
    countIf(event_type = 'opened') AS opened_count,
    countIf(event_type = 'clicked') AS clicked_count,
    countIf(event_type = 'bounced') AS bounced_count
FROM email_events
GROUP BY organization_id, template_id, event_date;

-- view: Revenue recovered by strategy (monthly)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_revenue_recovered
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(month)
ORDER BY (organization_id, strategy_id, month)
AS SELECT
    organization_id,
    strategy_id,
    toStartOfMonth(occurred_at) AS month,
    sumIf(revenue_recovered, event_type = 'converted') AS total_revenue_recovered,
    countIf(event_type = 'converted') AS total_conversions
FROM campaign_events
WHERE revenue_recovered IS NOT NULL
GROUP BY organization_id, strategy_id, month;
