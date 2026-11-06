# Revenue Forecasting

AI-powered revenue forecasting with churn prediction and recovery campaign impact projections.

## Overview

The Revenue Forecasting system provides data-driven projections of Monthly Recurring Revenue (MRR) over different time horizons. It combines:
- **Current subscription data** - Active MRR from all subscriptions
- **Churn predictions** - Uses AI risk scores to project customer losses
- **Recovery campaigns** - Factors in expected wins from retention efforts
- **Growth projections** - Optional organic growth modeling

## Features

### 1. Multi-Horizon Forecasting
Generate revenue projections for:
- **30 days** - Short-term tactical planning
- **90 days** - Quarterly business planning
- **365 days** - Annual strategic planning

### 2. Comprehensive Breakdown
Every forecast includes:
- **Current MRR** - Baseline recurring revenue
- **Forecasted MRR** - Projected future recurring revenue
- **Retained Revenue** - Expected revenue from staying customers
- **Churned Revenue** - Expected losses from at-risk customers
- **Recovered Revenue** - Projected wins from retention campaigns
- **New Revenue** - Optional organic growth component

### 3. Confidence Scoring
Each forecast includes a confidence level (HIGH/MEDIUM/LOW) based on:
- Availability of historical campaign data
- Number of customers with risk predictions
- Data freshness and quality

### 4. Recovery Impact Analysis
Separate endpoint provides detailed recovery campaign impact:
- Customers currently at risk
- Total revenue at risk
- Expected recovery revenue
- Time-based impact projections (30/90/365 days)

## API Endpoints

### GET /api/dashboard/forecast

Generate revenue forecast for an organization.

**Authentication:** Required (Bearer token)
**Middleware:** `requireAuth`, `requireOrganizationContext`, `enforceApiUsageLimit`

**Query Parameters:**
```typescript
{
  horizon?: 'THIRTY_DAYS' | 'NINETY_DAYS' | 'ONE_YEAR',  // Default: 'THIRTY_DAYS'
  include_growth?: boolean,                               // Default: false
  growth_rate?: number                                    // 0-1 (e.g., 0.05 = 5% growth)
}
```

**Response:**
```typescript
{
  organizationId: string;
  horizon: 'THIRTY_DAYS' | 'NINETY_DAYS' | 'ONE_YEAR';
  generatedAt: Date;
  currentMRR: number;              // Current monthly recurring revenue
  forecastedMRR: number;           // Projected MRR at horizon
  projectedChange: number;         // Change from current (positive or negative)
  projectedChangePercent: number;  // Percentage change
  breakdown: {
    retainedRevenue: number;       // Revenue from customers staying
    churnedRevenue: number;        // Lost revenue from churn
    recoveredRevenue: number;      // Won back from campaigns
    newRevenue: number;            // Organic growth (if enabled)
  };
  metrics: {
    expectedChurnRate: number;     // Projected churn rate (0-1)
    expectedRecoveryRate: number;  // Historical recovery rate
    customersAtRisk: number;       // Count of at-risk customers
  };
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}
```

**Example Request:**
```bash
curl -X GET 'https://api.example.com/api/dashboard/forecast?horizon=NINETY_DAYS&include_growth=true&growth_rate=0.05' \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

**Example Response:**
```json
{
  "organizationId": "org_123",
  "horizon": "NINETY_DAYS",
  "generatedAt": "2025-12-30T10:00:00Z",
  "currentMRR": 50000,
  "forecastedMRR": 52500,
  "projectedChange": 2500,
  "projectedChangePercent": 5.0,
  "breakdown": {
    "retainedRevenue": 45000,
    "churnedRevenue": 5000,
    "recoveredRevenue": 10000,
    "newRevenue": 2500
  },
  "metrics": {
    "expectedChurnRate": 0.10,
    "expectedRecoveryRate": 0.15,
    "customersAtRisk": 25
  },
  "confidence": "HIGH"
}
```

### GET /api/dashboard/forecast/recovery-impact

Get detailed recovery campaign impact projections.

**Authentication:** Required (Bearer token)
**Middleware:** `requireAuth`, `requireOrganizationContext`, `enforceApiUsageLimit`

**Response:**
```typescript
{
  customersAtRisk: number;            // Count of at-risk customers
  revenueAtRisk: number;              // Total MRR at risk
  expectedRecoveredRevenue: number;   // Projected recovery based on historical rate
  projectedImpact30Days: number;      // Expected wins in 30 days
  projectedImpact90Days: number;      // Expected wins in 90 days
  projectedImpact365Days: number;     // Expected wins in 365 days
}
```

**Example Request:**
```bash
curl -X GET 'https://api.example.com/api/dashboard/forecast/recovery-impact' \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

**Example Response:**
```json
{
  "customersAtRisk": 42,
  "revenueAtRisk": 25000,
  "expectedRecoveredRevenue": 3750,
  "projectedImpact30Days": 1250,
  "projectedImpact90Days": 2813,
  "projectedImpact365Days": 3750
}
```

## Forecasting Algorithm

### 1. Current MRR Calculation
```typescript
// Sum all active subscription amounts, normalized to monthly
MRR = Σ(subscription.amount / interval_months)
```

### 2. Churn Projection
Uses AI-generated churn risk scores:

**Risk Level Probabilities:**
- MINIMAL: 5% churn probability
- LOW: 15% churn probability
- MEDIUM: 30% churn probability
- HIGH: 50% churn probability
- CRITICAL: 75% churn probability

**Time Adjustment:**
```typescript
adjustedProbability = min(baseProbability × (horizonDays / 30), 1.0)
```

**Revenue Impact:**
```typescript
churnedRevenue = Σ(subscription.MRR × adjustedChurnProbability)
retainedRevenue = currentMRR - churnedRevenue
```

### 3. Recovery Projection
Based on historical campaign performance:

**Recovery Rate Calculation:**
```typescript
recoveryRate = totalConversions / totalCampaigns
// Default: 15% if no historical data
```

**Revenue Recovery:**
```typescript
recoveredRevenue = revenueAtRisk × recoveryRate × timeProgressionFactor
```

**Time Progression:**
```typescript
timeProgressionFactor = {
  30 days: 0.5,    // 50% of full impact
  90 days: 0.75,   // 75% of full impact
  365 days: 1.0    // 100% of full impact
}
```

### 4. Growth Projection (Optional)
Simple compound growth model:

```typescript
monthsInHorizon = horizonDays / 30
newRevenue = currentMRR × ((1 + growthRate)^monthsInHorizon - 1)
```

### 5. Confidence Scoring
Based on data availability:

```typescript
dataPoints = [
  hasChurnPredictions ? 1 : 0,
  hasCampaignHistory ? 1 : 0,
  hasActiveSubscriptions ? 1 : 0
]

confidence = {
  3 points: 'HIGH',
  2 points: 'MEDIUM',
  1 point: 'LOW'
}
```

## Use Cases

### Strategic Planning
```typescript
// Get annual forecast with growth projections
const forecast = await fetch('/api/dashboard/forecast?horizon=ONE_YEAR&include_growth=true&growth_rate=0.10');
// Plan hiring, infrastructure, funding based on projected ARR
```

### Retention Campaign ROI
```typescript
// Compare with and without retention efforts
const withoutCampaigns = await fetch('/api/dashboard/forecast?horizon=NINETY_DAYS');
const impact = await fetch('/api/dashboard/forecast/recovery-impact');

const roi = impact.projectedImpact90Days / campaignCosts;
```

### Cash Flow Planning
```typescript
// Monthly forecast for operational planning
const forecast = await fetch('/api/dashboard/forecast?horizon=THIRTY_DAYS');
// Use breakdown.churnedRevenue for worst-case planning
// Use forecastedMRR for expected scenario
```

### Investor Reporting
```typescript
// Quarterly projections with high confidence
const q1 = await fetch('/api/dashboard/forecast?horizon=NINETY_DAYS');
// Show current MRR, forecasted MRR, and confidence level
// Demonstrate retention strategy impact via recoveredRevenue
```

## Implementation Details

### Database Queries

**Churn Risk Data:**
```sql
SELECT * FROM churn_predictions
WHERE organization_id = ?
  AND risk_level IN ('HIGH', 'CRITICAL')
  AND is_active = true
```

**Campaign Performance:**
```sql
SELECT COUNT(*) as total,
       SUM(CASE WHEN result = 'CONVERTED' THEN 1 ELSE 0 END) as conversions
FROM retention_campaigns
WHERE organization_id = ?
  AND status = 'COMPLETED'
```

**Active Subscriptions:**
```sql
SELECT * FROM subscriptions
WHERE organization_id = ?
  AND status = 'active'
  AND customer_id IS NOT NULL
```

### Performance Optimization

1. **Caching Strategy**
   - Cache forecasts for 1 hour (data doesn't change frequently)
   - Invalidate on new subscription/churn event
   - Use Redis for distributed caching

2. **Query Optimization**
   - Index on `organization_id`, `status`, `is_active`
   - Use database views for complex aggregations
   - Batch process multiple horizons in single query

3. **Rate Limiting**
   - Applied via `enforceApiUsageLimit` middleware
   - Prevents excessive computation for large datasets

## Error Handling

**No Active Subscriptions:**
```typescript
{
  currentMRR: 0,
  forecastedMRR: 0,
  confidence: 'LOW',
  // ... zero values
}
```

**Missing Churn Predictions:**
- Uses conservative 5% default churn rate
- Confidence marked as MEDIUM or LOW
- Logs warning for investigation

**No Campaign History:**
- Uses industry standard 15% recovery rate
- Confidence reduced to MEDIUM
- Suggests running campaigns to improve accuracy

## Testing

### Unit Tests
```typescript
describe('generateRevenueForecast', () => {
  it('should calculate 30-day forecast correctly', async () => {
    const forecast = await generateRevenueForecast({
      organizationId: 'org_123',
      horizon: 'THIRTY_DAYS',
    });
    expect(forecast.horizon).toBe('THIRTY_DAYS');
    expect(forecast.currentMRR).toBeGreaterThan(0);
  });

  it('should apply churn probabilities correctly', async () => {
    // Test with HIGH risk customers
    // Verify churnedRevenue calculation
  });

  it('should include growth when requested', async () => {
    const forecast = await generateRevenueForecast({
      organizationId: 'org_123',
      horizon: 'ONE_YEAR',
      includeGrowth: true,
      growthRate: 0.10,
    });
    expect(forecast.breakdown.newRevenue).toBeGreaterThan(0);
  });
});
```

### Integration Tests
```typescript
describe('Forecast API', () => {
  it('should require authentication', async () => {
    const response = await request(app)
      .get('/api/dashboard/forecast')
      .expect(401);
  });

  it('should validate query parameters', async () => {
    const response = await request(app)
      .get('/api/dashboard/forecast?horizon=INVALID')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('should return forecast with correct structure', async () => {
    const response = await request(app)
      .get('/api/dashboard/forecast?horizon=THIRTY_DAYS')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toHaveProperty('currentMRR');
    expect(response.body).toHaveProperty('forecastedMRR');
    expect(response.body).toHaveProperty('confidence');
  });
});
```

## Security Considerations

1. **Organization Isolation**
   - All queries filtered by `organization_id`
   - Enforced via `requireOrganizationContext` middleware
   - Prevents cross-organization data leakage

2. **Rate Limiting**
   - Computationally expensive queries limited
   - Prevents abuse and ensures fair usage
   - Applied per organization

3. **Data Validation**
   - Zod schema validation on all inputs
   - Growth rate capped at 100% (1.0)
   - Horizon limited to defined values

4. **Sensitive Data**
   - Revenue amounts logged only at INFO level
   - Customer-specific details not exposed
   - Aggregated metrics only in responses

## Monitoring & Observability

**Key Metrics to Track:**
- Forecast generation latency (p50, p95, p99)
- Forecast accuracy over time (compare predictions vs actuals)
- Confidence distribution (HIGH/MEDIUM/LOW ratio)
- API error rates by endpoint
- Cache hit rates

**Logging:**
```typescript
logger.info({
  organizationId,
  horizon,
  currentMRR,
  forecastedMRR,
  confidence,
  executionTimeMs,
}, 'Generated revenue forecast');
```

**Alerts:**
- Forecast generation > 5 seconds
- Confidence consistently LOW (data quality issue)
- Error rate > 1%
- Large forecast deviations (> 50% change)

## Future Enhancements

1. **Machine Learning Integration**
   - Train ML models on historical forecast accuracy
   - Improve churn probability estimates
   - Seasonal trend detection

2. **Scenario Planning**
   - Best case / worst case / expected scenarios
   - What-if analysis (e.g., "What if we reduce churn by 10%?")

3. **Cohort-Based Forecasting**
   - Separate forecasts by customer segments
   - Industry-specific projections
   - Plan-tier specific churn rates

4. **Real-Time Updates**
   - WebSocket integration for live forecast updates
   - Push notifications on significant changes

5. **Historical Tracking**
   - Store forecast snapshots
   - Compare forecasts to actuals
   - Accuracy reporting and refinement

## Related Features

- **Churn Prediction** (`src/modules/ml/churn-prediction.ts`) - Provides risk scores
- **Retention Campaigns** (`src/modules/retention/`) - Drives recovery projections
- **ROI Calculator** (`src/modules/analytics/roi-calculator.ts`) - Campaign effectiveness
- **Cohort Analysis** (future) - Segment-based insights

## Support

For questions or issues:
1. Check logs for detailed error messages
2. Verify organization context is properly set
3. Ensure subscription data is up to date
4. Review confidence levels for data quality indicators

**Common Issues:**
- **Zero MRR:** No active subscriptions found
- **Low Confidence:** Missing churn predictions or campaign history
- **High Variance:** Check for data anomalies or recent business changes
