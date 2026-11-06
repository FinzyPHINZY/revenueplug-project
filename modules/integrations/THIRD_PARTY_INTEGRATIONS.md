# Third-Party Integrations

RevenuePlug integrates with external platforms to enhance churn prediction, streamline workflows, and enable custom automations.

## Overview

**Supported Integrations:**
1. **Mixpanel** - Behavioral event tracking for churn prediction
2. **HubSpot** - CRM sync for personal outreach and task management
3. **Zapier** - Connect with 5000+ apps for custom workflows

---

## 1. Mixpanel Integration

### Purpose
Receive behavioral events from Mixpanel to enhance churn prediction accuracy. When users perform actions in your application (logins, feature usage, etc.), Mixpanel sends these events to RevenuePlug for analysis.

### How It Works
1. Configure Mixpanel webhook to point to RevenuePlug
2. Mixpanel sends user activity events in real-time
3. RevenuePlug matches events to customers and publishes to Kafka
4. Behavioral data feeds into churn prediction models

### Setup

#### 1. Configure Webhook in Mixpanel

In your Mixpanel project:
- Go to **Settings** → **Webhooks**
- Click **Add Webhook**
- Enter webhook URL: `https://your-domain.com/api/webhooks/mixpanel`
- Select events to forward (recommended: all user activity events)
- Save the webhook secret for signature verification

#### 2. Add Webhook Secret to Environment

```bash
# .env
MIXPANEL_WEBHOOK_SECRET=your_webhook_secret_here
```

#### 3. Webhook Payload Format

Mixpanel sends events in this format:

```json
{
  "event": "Feature Used",
  "properties": {
    "distinct_id": "user_12345",
    "email": "user@example.com",
    "$email": "user@example.com",
    "time": 1609459200000,
    "feature_name": "analytics_dashboard",
    "session_duration": 180,
    "action_count": 15
  }
}
```

### Security

- **Signature Verification**: RevenuePlug validates all webhooks using HMAC-SHA256
- **TLS/HTTPS**: All webhook traffic encrypted in transit
- **Timing-Safe Comparison**: Prevents timing attacks on signature verification

### Event Processing

1. **Signature Validation**: Verify X-Mixpanel-Signature header
2. **Customer Matching**: Find customer by email or distinct_id
3. **Kafka Publishing**: Stream to `behavioral.user_activity` topic
4. **Analytics**: Feed into churn prediction models

### Customer Matching Logic

```typescript
// Matches customer by:
1. Email from properties.email or properties.$email
2. External ID from properties.distinct_id

// If no match found:
- Event is logged but not processed
- Check customer exists in RevenuePlug database
```

### Key Metrics Extracted

| Property | Description | Usage |
|----------|-------------|-------|
| `session_duration` | Time spent in session | Engagement metric |
| `feature_name` | Feature used | Feature adoption tracking |
| `action_count` | Actions per session | Activity level |
| `event` | Event name | Behavior categorization |

### Use Cases

1. **Engagement Tracking**: Monitor feature usage decline
2. **Churn Signals**: Detect reduced login frequency
3. **Health Scoring**: Factor behavioral data into health scores
4. **Trigger Campaigns**: Launch retention campaigns based on usage patterns

### Troubleshooting

**Webhook not receiving events:**
- Verify URL is publicly accessible
- Check Mixpanel webhook configuration is active
- Confirm webhook secret matches environment variable

**Events not matching customers:**
- Ensure `distinct_id` or `email` is included in properties
- Verify customer exists in RevenuePlug database
- Check customer email matches exactly

**Signature verification failing:**
- Confirm `MIXPANEL_WEBHOOK_SECRET` is correct
- Check X-Mixpanel-Signature header is present
- Ensure webhook secret hasn't been rotated in Mixpanel

---

## 2. HubSpot Integration

### Purpose
Sync CRM data between HubSpot and RevenuePlug for:
- Creating tasks for personal outreach campaigns
- Tracking task completion and outreach effectiveness
- Monitoring customer lifecycle changes
- Connecting retention efforts to deal outcomes

### How It Works

#### Outbound (RevenuePlug → HubSpot)
- Personal outreach actions create tasks in HubSpot
- Tasks include context: customer info, churn signals, campaign details
- Assigned to sales team for human touch

#### Inbound (HubSpot → RevenuePlug)
- Task completion updates campaign action status
- Contact property changes tracked for engagement signals
- Deal stage changes measure retention campaign effectiveness

### Setup

#### 1. Get HubSpot API Key

In HubSpot:
- Go to **Settings** → **Integrations** → **API Key**
- Generate private app or use API key
- Copy API key and webhook secret

#### 2. Configure Environment Variables

```bash
# .env
HUBSPOT_API_KEY=your_api_key_here
HUBSPOT_WEBHOOK_SECRET=your_webhook_secret_here
```

#### 3. Configure HubSpot Webhook

In HubSpot:
- Go to **Settings** → **Webhooks**
- Create webhook subscription
- Target URL: `https://your-domain.com/api/webhooks/hubspot`
- Subscribe to events:
  - `task.completion`
  - `contact.propertyChange`
  - `deal.propertyChange`

### Outbound: Creating Tasks

When personal outreach action is triggered:

```typescript
// Task created in HubSpot
{
  "subject": "High Churn Risk: Reach out to John Doe",
  "body": "Customer at risk of churning...",
  "priority": "HIGH",
  "due_date": "2025-01-15",
  "assigned_to": "sales_team",
  "properties": {
    "customer_id": "cust_123",
    "churn_probability": 0.75,
    "campaign_id": "camp_456"
  }
}
```

### Inbound: Webhook Events

#### Task Completion

Payload:
```json
{
  "subscriptionType": "task.completion",
  "objectId": "task_12345",
  "properties": {
    "hs_task_status": "COMPLETED",
    "hs_timestamp": "2025-01-10T15:30:00Z"
  }
}
```

Processing:
- Finds associated campaign action by HubSpot task ID
- Updates action status to SENT/COMPLETED
- Marks completion timestamp

#### Contact Property Change

Tracks customer engagement through CRM:

```json
{
  "subscriptionType": "contact.propertyChange",
  "objectId": "contact_123",
  "propertyName": "lifecyclestage",
  "propertyValue": "customer"
}
```

Tracked properties:
- `lifecyclestage`: subscriber → lead → customer
- `email`: Email address changes
- Custom properties for engagement signals

#### Deal Stage Change

Measures retention campaign ROI:

```json
{
  "subscriptionType": "deal.propertyChange",
  "objectId": "deal_456",
  "propertyName": "dealstage",
  "propertyValue": "closedwon"
}
```

### Security

- **Signature Verification**: Validates X-HubSpot-Signature header
- **HMAC-SHA256**: Uses app secret + method + URL + payload
- **TLS/HTTPS**: Encrypted webhook traffic

### Task Creation Details

**Task Structure:**
```typescript
{
  subject: "High Churn Risk: Reach out to {customerName}",
  body: `
Customer: {customerName} ({customerEmail})
Status: At risk of churning
Churn Probability: {probability}%

Signals:
- {churnSignals}

Campaign: {campaignName}
Suggested Action: {suggestedAction}

RevenuePlug Campaign: {campaignUrl}
  `,
  priority: "HIGH",
  due_date: +7 days,
  assigned_to: owner_email
}
```

**Associations:**
- Task → Contact (by email)
- Task → Deal (if associated)
- Custom properties store campaign metadata

### Use Cases

1. **Personal Outreach**: High-value at-risk customers get human touch
2. **Task Tracking**: Monitor outreach completion rates
3. **Campaign Effectiveness**: Measure personal vs automated retention
4. **Deal Attribution**: Track retention campaign impact on deals

### Troubleshooting

**Tasks not appearing in HubSpot:**
- Verify API key has task creation permissions
- Check contact exists in HubSpot (matched by email)
- Confirm API rate limits not exceeded

**Webhooks not processing:**
- Verify webhook secret matches environment variable
- Check subscription types are correct
- Ensure webhook URL is publicly accessible

**Task completion not updating campaigns:**
- Verify task ID is stored in campaign action result
- Check HubSpot task status is exactly "COMPLETED"
- Confirm campaign action exists and is PERSONAL_OUTREACH type

---

## 3. Zapier Integration

### Purpose
Enable custom workflows connecting RevenuePlug with 5000+ apps. Trigger actions in external tools when RevenuePlug events occur.

### Architecture

**Trigger Model**: RevenuePlug sends webhooks to Zapier when events occur
**Action Model**: Zapier calls RevenuePlug API to perform actions (future)

### Supported Triggers

| Trigger | Event Type | Description |
|---------|------------|-------------|
| Campaign Triggered | `campaign.triggered` | Retention campaign started for customer |
| Campaign Converted | `campaign.converted` | Customer successfully retained |
| Customer At Risk | `customer.at_risk` | High churn risk detected |
| Payment Failed | `payment.failed` | Payment attempt failed |
| Payment Recovered | `payment.recovered` | Failed payment recovered |
| Trial Ending | `trial.ending` | Trial ending in 3 days |
| Trial Converted | `trial.converted` | Trial converted to paid |
| Subscription Cancelled | `subscription.cancelled` | Subscription cancelled |

### Setup

#### 1. Create Webhook in RevenuePlug

```bash
POST /api/integrations/zapier/webhooks
Authorization: Bearer YOUR_ACCESS_TOKEN

{
  "event_type": "campaign.converted",
  "target_url": "https://hooks.zapier.com/hooks/catch/123456/abc123/",
  "secret": "optional_secret_for_verification"
}
```

Response:
```json
{
  "id": "zap_webhook_123",
  "event_type": "campaign.converted",
  "target_url": "https://hooks.zapier.com/...",
  "enabled": true,
  "created_at": "2025-01-01T00:00:00Z"
}
```

#### 2. Configure Zap in Zapier

1. **Trigger**: Webhooks by Zapier → Catch Hook
2. Copy webhook URL from Zapier
3. Create webhook in RevenuePlug (step 1 above)
4. Test trigger by triggering event in RevenuePlug
5. **Action**: Choose any of 5000+ apps

### Webhook Payload Structure

All triggers send this standardized payload:

```typescript
{
  "id": "evt_abc123",              // Unique event ID
  "event": "campaign.converted",    // Event type
  "timestamp": "2025-01-01T12:00:00Z",
  "organizationId": "org_123",      // Your organization ID
  "data": {
    // Event-specific data (see below)
  }
}
```

### Event Payloads

#### campaign.triggered
```json
{
  "campaign_id": "camp_123",
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "trigger_type": "PAYMENT_FAILURE"
}
```

#### campaign.converted
```json
{
  "campaign_id": "camp_123",
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "recovered_revenue": 49.99,
  "currency": "usd"
}
```

#### customer.at_risk
```json
{
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "risk_level": "HIGH",
  "churn_probability": 0.75
}
```

#### payment.failed
```json
{
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "invoice_id": "inv_789",
  "amount": 49.99,
  "currency": "usd",
  "attempt_count": 2
}
```

#### payment.recovered
```json
{
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "invoice_id": "inv_789",
  "amount": 49.99,
  "currency": "usd"
}
```

#### trial.ending
```json
{
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "subscription_id": "sub_789",
  "trial_end_date": "2025-01-15T00:00:00Z",
  "days_remaining": 3
}
```

#### trial.converted
```json
{
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "subscription_id": "sub_789",
  "amount": 49.99,
  "currency": "usd"
}
```

#### subscription.cancelled
```json
{
  "customer_id": "cust_456",
  "customer_email": "user@example.com",
  "subscription_id": "sub_789",
  "cancelled_at": "2025-01-01T00:00:00Z",
  "monthly_value": 49.99
}
```

### API Endpoints

#### List Event Types
```bash
GET /api/integrations/zapier/events
```

Returns all available event types with descriptions and sample data.

#### Create Webhook
```bash
POST /api/integrations/zapier/webhooks
{
  "event_type": "campaign.converted",
  "target_url": "https://hooks.zapier.com/...",
  "secret": "optional_secret"
}
```

#### List Webhooks
```bash
GET /api/integrations/zapier/webhooks
```

#### Update Webhook
```bash
PATCH /api/integrations/zapier/webhooks/:webhookId
{
  "enabled": false,
  "target_url": "https://new-url.com"
}
```

#### Delete Webhook
```bash
DELETE /api/integrations/zapier/webhooks/:webhookId
```

### Use Cases

#### 1. Slack Notifications
**Trigger**: Customer At Risk
**Action**: Send Slack message to #customer-success

```
New at-risk customer: {{customer_email}}
Risk Level: {{risk_level}}
Churn Probability: {{churn_probability}}%
```

#### 2. Email Alerts
**Trigger**: Campaign Converted
**Action**: Send email via Gmail

```
Subject: 🎉 Customer Retained!
Body: We successfully retained {{customer_email}} and recovered ${{recovered_revenue}}!
```

#### 3. Google Sheets Tracking
**Trigger**: Payment Failed
**Action**: Add row to Google Sheet

Columns: Date, Customer Email, Amount, Attempt Count, Status

#### 4. Salesforce Sync
**Trigger**: Trial Ending
**Action**: Create task in Salesforce

```
Task: Follow up with trial ending
Account: {{customer_email}}
Due Date: {{trial_end_date}}
```

#### 5. Discord Alerts
**Trigger**: Payment Recovered
**Action**: Post to Discord channel

```
💰 Payment Recovered!
Customer: {{customer_email}}
Amount: ${{amount}}
```

### Security

**Webhook Verification:**
- Optional secret header: `X-Zapier-Secret`
- Configure secret when creating webhook
- Zapier validates secret matches

**Best Practices:**
- Use HTTPS URLs only
- Rotate secrets periodically
- Monitor webhook delivery failures
- Set up retry logic in Zaps

### Rate Limiting

- Webhook delivery: 10 second timeout
- Failed webhooks logged but don't block main flow
- No automatic retries (Zapier handles retries)

### Monitoring

Check webhook logs:
```bash
GET /api/integrations/zapier/webhooks/:webhookId/logs
```

Metrics tracked:
- Total events sent
- Successful deliveries
- Failed deliveries
- Average response time

### Troubleshooting

**Webhook not firing:**
- Verify webhook is enabled
- Check event type matches trigger
- Confirm target URL is correct
- Test with manual trigger

**Zap not triggering:**
- Check "Zap History" in Zapier
- Verify webhook caught sample data
- Test trigger manually in Zapier
- Ensure Zap is turned ON

**Payload parsing errors:**
- Verify JSON structure matches documentation
- Check for required fields
- Validate data types

---

## Integration Comparison

| Feature | Mixpanel | HubSpot | Zapier |
|---------|----------|---------|--------|
| Direction | Inbound | Both | Outbound |
| Purpose | Behavioral data | CRM sync | Custom workflows |
| Real-time | Yes | Yes | Yes |
| Signature Verification | HMAC-SHA256 | HMAC-SHA256 | Optional secret |
| Use Case | Churn prediction | Personal outreach | Automation |
| Complexity | Low | Medium | Low |
| Setup Time | 5 min | 15 min | 10 min |

## Best Practices

1. **Start Small**: Test with one event type before expanding
2. **Monitor Logs**: Check webhook delivery success rates
3. **Handle Failures**: Implement retry logic where needed
4. **Secure Secrets**: Use environment variables, rotate periodically
5. **Document Workflows**: Maintain list of active integrations
6. **Test Thoroughly**: Use test data before production
7. **Rate Limits**: Respect third-party API rate limits

## Support

For integration issues:
1. Check webhook logs for delivery errors
2. Verify environment variables are set
3. Test signature verification with sample payloads
4. Review third-party platform documentation
5. Contact support with webhook ID and error messages

## Future Enhancements

### Planned Features
- [ ] Zapier actions (RevenuePlug as action step)
- [ ] Segment integration for unified customer data
- [ ] Intercom integration for in-app messaging
- [ ] Salesforce native integration
- [ ] Webhook retry policies
- [ ] Webhook delivery analytics dashboard
