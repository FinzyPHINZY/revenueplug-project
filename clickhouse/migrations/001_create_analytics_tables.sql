-- this are my clickHouse analytics tables for this project. and the purpose for this migration is time-series analytics and event storage

-- ============================================================================
-- BEHAVIORAL EVENTS TABLE
-- ============================================================================
-- the table stores all customer behavioral events (logins, feature usage, API calls, etc.) and it is optimized for time-series queries and event correlation

CREATE TABLE IF NOT EXISTS behavioral_events (
    -- event identification
    id String,
    customer_id String,
    connection_id String,
    organization_id String,

    -- event details
    event_type LowCardinality(String), -- LOGIN, FEATURE_USED, API_CALL, etc.
    event_name String,

    -- event metadata
    properties String, -- JSON string
    source LowCardinality(String), -- web, mobile, api

    -- context
    session_id String,
    user_id String,

    -- timestamps (they are critical for time-series)
    occurred_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at) -- partition by month for efficient pruning
ORDER BY (organization_id, customer_id, occurred_at, event_type)
TTL occurred_at + INTERVAL 2 YEAR -- keep 2 years of data
SETTINGS index_granularity = 8192;

-- indexes for common queries
CREATE INDEX IF NOT EXISTS idx_event_type ON behavioral_events (event_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_session ON behavioral_events (session_id) TYPE bloom_filter GRANULARITY 1;

-- ============================================================================
-- USAGE METRICS TABLE
-- ============================================================================
--  for aggregated usage metrics over time periods and pre-aggregated for fast querying

CREATE TABLE IF NOT EXISTS usage_metrics (
    -- identification
    id String,
    customer_id String,
    connection_id String,
    organization_id String,

    -- metric details
    metric_type LowCardinality(String), -- API_CALLS, LOGINS, ACTIVE_USERS, etc.
    metric_name String,

    -- values
    value Float64,
    change Float64,
    change_percent Float64,

    -- period
    period LowCardinality(String), -- HOURLY, DAILY, WEEKLY, MONTHLY
    period_start DateTime64(3, 'UTC'),
    period_end DateTime64(3, 'UTC'),

    -- trend
    trend LowCardinality(String), -- INCREASING, STABLE, DECREASING

    -- metadata
    calculated_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(period_start)
ORDER BY (organization_id, customer_id, metric_type, period, period_start)
TTL period_start + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_metric_type ON usage_metrics (metric_type) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_period ON usage_metrics (period) TYPE bloom_filter GRANULARITY 1;

-- ============================================================================
-- HEALTH SCORE HISTORY TABLE
-- ============================================================================
-- for historical health scores for trend analysis. i kept this lean. focusing on only snapshots, not full breakdowns

CREATE TABLE IF NOT EXISTS health_score_history (
    id String,
    customer_id String,
    organization_id String,

    -- scores
    overall_score UInt8, -- 0-100
    payment_health_score UInt8,
    engagement_score UInt8,
    usage_score UInt8,
    subscription_health_score UInt8,
    support_score UInt8,

    -- risk
    risk_level LowCardinality(String), -- CRITICAL, HIGH, MEDIUM, LOW
    trend LowCardinality(String), -- IMPROVING, STABLE, DECLINING

    -- timestamp
    calculated_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(calculated_at)
ORDER BY (organization_id, customer_id, calculated_at)
TTL calculated_at + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- ============================================================================
-- CHURN RISK HISTORY TABLE
-- ============================================================================
-- historical churn risk scores for trend analysis

CREATE TABLE IF NOT EXISTS churn_risk_history (
    id String,
    customer_id String,
    organization_id String,

    -- risk scores
    churn_score UInt8, -- 0-100
    churn_probability Float32, -- 0.0-1.0
    risk_level LowCardinality(String), -- CRITICAL, HIGH, MEDIUM, LOW

    -- risk factors
    payment_failure_risk UInt8,
    engagement_decline_risk UInt8,
    usage_decline_risk UInt8,
    support_issue_risk UInt8,

    -- predictions
    predicted_churn_date DateTime64(3, 'UTC'),
    days_until_predicted_churn Int32,

    -- priority
    priority LowCardinality(String), -- IMMEDIATE, HIGH, MEDIUM, LOW
    trend LowCardinality(String), -- IMPROVING, STABLE, DECLINING

    -- timestamp
    calculated_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(calculated_at)
ORDER BY (organization_id, customer_id, calculated_at)
TTL calculated_at + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- ============================================================================
-- PAYMENT EVENTS TABLE
-- ============================================================================
-- to track all payment-related events for pattern analysis

CREATE TABLE IF NOT EXISTS payment_events (
    id String,
    customer_id String,
    organization_id String,

    -- Payment details
    invoice_id String,
    amount_cents Int64,
    currency LowCardinality(String),

    -- status
    status LowCardinality(String), -- paid, failed, pending, etc.
    payment_method LowCardinality(String), -- card, bank, etc.

    -- failure details
    failure_code String,
    failure_message String,

    -- metadata
    attempt_count UInt8,
    is_retry Boolean,

    -- timestamps
    occurred_at DateTime64(3, 'UTC'),
    created_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (organization_id, customer_id, occurred_at)
TTL occurred_at + INTERVAL 3 YEAR -- keep payment data longer for compliance
SETTINGS index_granularity = 8192;

-- indexes
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment_events (status) TYPE bloom_filter GRANULARITY 1;
CREATE INDEX IF NOT EXISTS idx_invoice ON payment_events (invoice_id) TYPE bloom_filter GRANULARITY 1;

-- ============================================================================
-- MATERIALIZED VIEWS FOR COMMON QUERIES
-- ============================================================================

-- view: daily event counts per customer
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_event_counts
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (organization_id, customer_id, event_type, event_date)
AS SELECT
    organization_id,
    customer_id,
    event_type,
    toDate(occurred_at) AS event_date,
    count() AS event_count
FROM behavioral_events
GROUP BY organization_id, customer_id, event_type, event_date;

-- view: hourly API call counts
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hourly_api_calls
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_hour)
ORDER BY (organization_id, customer_id, event_hour)
AS SELECT
    organization_id,
    customer_id,
    toStartOfHour(occurred_at) AS event_hour,
    count() AS api_call_count
FROM behavioral_events
WHERE event_type = 'API_CALL'
GROUP BY organization_id, customer_id, event_hour;

-- view: payment success rate by customer
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_payment_success_rate
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(month)
ORDER BY (organization_id, customer_id, month)
AS SELECT
    organization_id,
    customer_id,
    toStartOfMonth(occurred_at) AS month,
    countIf(status = 'paid') AS successful_payments,
    countIf(status = 'failed') AS failed_payments,
    count() AS total_payments
FROM payment_events
GROUP BY organization_id, customer_id, month;
