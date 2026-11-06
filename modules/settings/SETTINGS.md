# Settings & Configuration

Comprehensive settings management system for organizations, users, webhooks, and feature flags.

## Overview

The settings system provides four main areas of configuration:

1. **Organization Settings** - Regional preferences, email defaults, campaign settings, privacy & compliance
2. **User Notification Preferences** - Individual notification preferences for email, in-app, and Slack
3. **Outgoing Webhooks** - Send RevenuePlug events to external systems via HTTP webhooks
4. **Feature Flags** - Control feature availability per organization or globally

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Settings API Routes                         │
│  GET/PATCH /settings, /settings/notifications, etc.          │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                  Settings Service                            │
│  - Organization settings                                     │
│  - User notification preferences                             │
│  - Outgoing webhook management                               │
│  - Feature flag evaluation                                   │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│        PostgreSQL (Settings Tables)                          │
│  - organization_settings                                     │
│  - user_notification_preferences                             │
│  - outgoing_webhooks                                         │
│  - outgoing_webhook_deliveries                               │
│  - feature_flags                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Organization Settings

### Overview

Organization settings control regional preferences, email configuration, retention campaign defaults, and privacy settings.

### Database Schema

```prisma
model OrganizationSettings {
  id             String   @id
  organizationId String   @unique

  // Regional settings
  timezone    String @default("UTC")
  currency    String @default("USD")
  dateFormat  String @default("MM/DD/YYYY")
  timeFormat  String @default("12h")

  // Email settings
  fromName    String?
  fromEmail   String?
  replyTo     String?
  emailFooter String? @db.Text

  // Retention campaign defaults
  defaultCampaignCooldown Int @default(30)
  maxEmailsPerDay        Int @default(10)
  minDaysBetweenEmails   Int @default(1)

  // Notification settings
  notifyHighRiskChurn      Boolean @default(true)
  notifyPaymentFailures    Boolean @default(true)
  notifyCampaignConversions Boolean @default(true)
  notifyLowHealthScore     Boolean @default(false)

  // Feature preferences
  enableABTesting           Boolean @default(true)
  enablePredictiveAnalytics Boolean @default(true)
  enableBehavioralTracking  Boolean @default(true)

  // Privacy & compliance
  gdprMode          Boolean @default(false)
  dataRetentionDays Int     @default(730)
}
```

### API Endpoints

#### Get Organization Settings

```http
GET /api/settings
```

**Response:**
```json
{
  "id": "setting_123",
  "organizationId": "org_123",
  "timezone": "America/New_York",
  "currency": "USD",
  "dateFormat": "MM/DD/YYYY",
  "timeFormat": "12h",
  "fromName": "RevenuePlug",
  "fromEmail": "noreply@company.com",
  "replyTo": "support@company.com",
  "emailFooter": "© 2024 Company Inc. All rights reserved.",
  "defaultCampaignCooldown": 30,
  "maxEmailsPerDay": 10,
  "minDaysBetweenEmails": 1,
  "notifyHighRiskChurn": true,
  "notifyPaymentFailures": true,
  "notifyCampaignConversions": true,
  "notifyLowHealthScore": false,
  "enableABTesting": true,
  "enablePredictiveAnalytics": true,
  "enableBehavioralTracking": true,
  "gdprMode": false,
  "dataRetentionDays": 730,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-12-30T00:00:00Z"
}
```

#### Update Organization Settings

```http
PATCH /api/settings
```

**Request Body:**
```json
{
  "timezone": "Europe/London",
  "currency": "GBP",
  "fromEmail": "notifications@company.co.uk",
  "maxEmailsPerDay": 15,
  "gdprMode": true
}
```

**Response:**
```json
{
  // Updated settings object
}
```

### Settings Reference

#### Regional Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `timezone` | String | `"UTC"` | IANA timezone (e.g., "America/New_York") |
| `currency` | String | `"USD"` | ISO 4217 currency code |
| `dateFormat` | String | `"MM/DD/YYYY"` | Date format for UI displays |
| `timeFormat` | String | `"12h"` | 12-hour or 24-hour time format |

#### Email Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `fromName` | String | `null` | Default sender name for emails |
| `fromEmail` | String | `null` | Default sender email (must be verified) |
| `replyTo` | String | `null` | Reply-to email address |
| `emailFooter` | String | `null` | Custom footer for all emails (supports HTML) |

#### Retention Campaign Defaults

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultCampaignCooldown` | Number | `30` | Default days between campaigns to same customer |
| `maxEmailsPerDay` | Number | `10` | Maximum emails organization can send per day |
| `minDaysBetweenEmails` | Number | `1` | Minimum days between emails to same customer |

#### Notification Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `notifyHighRiskChurn` | Boolean | `true` | Alert on high churn risk customers |
| `notifyPaymentFailures` | Boolean | `true` | Alert on payment failures |
| `notifyCampaignConversions` | Boolean | `true` | Alert on campaign conversions |
| `notifyLowHealthScore` | Boolean | `false` | Alert on low health scores |

#### Feature Preferences

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enableABTesting` | Boolean | `true` | Enable A/B testing features |
| `enablePredictiveAnalytics` | Boolean | `true` | Enable payment failure predictions |
| `enableBehavioralTracking` | Boolean | `true` | Enable Mixpanel behavioral tracking |

#### Privacy & Compliance

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `gdprMode` | Boolean | `false` | GDPR-compliant mode (stricter consent) |
| `dataRetentionDays` | Number | `730` | Days to retain customer data (2 years) |

---

## 2. User Notification Preferences

### Overview

User notification preferences allow individual users to customize which alerts they receive via email, in-app, and Slack.

### Database Schema

```prisma
model UserNotificationPreference {
  id     String @id
  userId String @unique

  // Email notifications
  emailDigest              EmailDigestFrequency @default(DAILY)
  emailOnHighRisk          Boolean @default(true)
  emailOnPaymentFailed     Boolean @default(true)
  emailOnCampaignConverted Boolean @default(true)
  emailOnTrialEnding       Boolean @default(true)
  emailOnMilestones        Boolean @default(true)

  // In-app notifications
  inAppOnHighRisk          Boolean @default(true)
  inAppOnPaymentFailed     Boolean @default(true)
  inAppOnCampaignConverted Boolean @default(true)

  // Slack notifications
  slackWebhookUrl           String?
  slackOnHighRisk           Boolean @default(false)
  slackOnCampaignConverted  Boolean @default(false)
}

enum EmailDigestFrequency {
  REALTIME  // Immediate notifications
  HOURLY    // Hourly digest
  DAILY     // Daily digest
  WEEKLY    // Weekly digest
  NEVER     // No digest emails
}
```

### API Endpoints

#### Get Notification Preferences

```http
GET /api/settings/notifications
```

**Response:**
```json
{
  "id": "pref_123",
  "userId": "user_456",
  "emailDigest": "DAILY",
  "emailOnHighRisk": true,
  "emailOnPaymentFailed": true,
  "emailOnCampaignConverted": true,
  "emailOnTrialEnding": true,
  "emailOnMilestones": true,
  "inAppOnHighRisk": true,
  "inAppOnPaymentFailed": true,
  "inAppOnCampaignConverted": true,
  "slackWebhookUrl": null,
  "slackOnHighRisk": false,
  "slackOnCampaignConverted": false,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-12-30T00:00:00Z"
}
```

#### Update Notification Preferences

```http
PATCH /api/settings/notifications
```

**Request Body:**
```json
{
  "emailDigest": "HOURLY",
  "emailOnHighRisk": false,
  "slackWebhookUrl": "https://hooks.slack.com/services/T00/B00/XXX",
  "slackOnHighRisk": true,
  "slackOnCampaignConverted": true
}
```

### Notification Types

#### Email Digest Frequencies

- `REALTIME` - Immediate email for each event
- `HOURLY` - Hourly digest of events
- `DAILY` - Daily digest (default)
- `WEEKLY` - Weekly digest
- `NEVER` - Disable all digest emails

#### Event Types

| Event | Email | In-App | Slack | Description |
|-------|-------|--------|-------|-------------|
| High Risk Churn | ✓ | ✓ | ✓ | Customer churn risk is HIGH/CRITICAL |
| Payment Failed | ✓ | ✓ | - | Payment attempt failed |
| Campaign Converted | ✓ | ✓ | ✓ | Retention campaign converted |
| Trial Ending | ✓ | - | - | Customer trial ending soon |
| Milestones | ✓ | - | - | Revenue milestones reached |

---

## 3. Outgoing Webhooks

### Overview

Outgoing webhooks allow organizations to receive RevenuePlug events in their own systems via HTTP POST requests.

### Database Schema

```prisma
model OutgoingWebhook {
  id             String @id
  organizationId String

  name        String
  url         String
  secret      String? // For HMAC signature verification
  enabled     Boolean @default(true)
  events      Json    // Array of event types
  headers     Json?   // Custom headers
  maxRetries  Int     @default(3)
  retryDelay  Int     @default(60)

  lastDeliveryAt DateTime?
  lastFailureAt  DateTime?
  failureCount   Int @default(0)
  disabledAt     DateTime? // Auto-disabled after 10 failures

  deliveries OutgoingWebhookDelivery[]
}

model OutgoingWebhookDelivery {
  id        String @id
  webhookId String

  eventType    String
  payload      Json
  status       OutgoingWebhookStatus
  statusCode   Int?
  responseBody String? @db.Text
  errorMessage String? @db.Text
  attemptNumber Int @default(1)
  deliveredAt  DateTime?
}

enum OutgoingWebhookStatus {
  PENDING
  DELIVERED
  FAILED
  DISABLED
}
```

### API Endpoints

#### Create Webhook

```http
POST /api/settings/webhooks
```

**Request Body:**
```json
{
  "name": "Slack Alerts",
  "url": "https://hooks.slack.com/services/T00/B00/XXX",
  "secret": "your_hmac_secret",
  "events": [
    "churn.risk_high",
    "payment.failed",
    "campaign.converted"
  ],
  "headers": {
    "X-Custom-Header": "value"
  },
  "maxRetries": 3,
  "retryDelay": 60
}
```

**Response:**
```json
{
  "id": "webhook_123",
  "organizationId": "org_123",
  "name": "Slack Alerts",
  "url": "https://hooks.slack.com/services/T00/B00/XXX",
  "secret": "your_hmac_secret",
  "enabled": true,
  "events": ["churn.risk_high", "payment.failed", "campaign.converted"],
  "headers": {"X-Custom-Header": "value"},
  "maxRetries": 3,
  "retryDelay": 60,
  "lastDeliveryAt": null,
  "lastFailureAt": null,
  "failureCount": 0,
  "disabledAt": null,
  "createdAt": "2024-12-30T00:00:00Z",
  "updatedAt": "2024-12-30T00:00:00Z"
}
```

#### List Webhooks

```http
GET /api/settings/webhooks
```

**Response:**
```json
{
  "webhooks": [
    {
      "id": "webhook_123",
      "name": "Slack Alerts",
      "url": "https://hooks.slack.com/...",
      "enabled": true,
      "events": ["churn.risk_high", "payment.failed"],
      "lastDeliveryAt": "2024-12-30T10:00:00Z",
      "failureCount": 0
    }
  ]
}
```

#### Get Webhook (with delivery history)

```http
GET /api/settings/webhooks/:webhook_id
```

**Response:**
```json
{
  "id": "webhook_123",
  "name": "Slack Alerts",
  "url": "https://hooks.slack.com/...",
  "enabled": true,
  "events": ["churn.risk_high"],
  "deliveries": [
    {
      "id": "delivery_1",
      "eventType": "churn.risk_high",
      "status": "DELIVERED",
      "statusCode": 200,
      "attemptNumber": 1,
      "deliveredAt": "2024-12-30T10:00:00Z",
      "createdAt": "2024-12-30T10:00:00Z"
    }
  ]
}
```

#### Update Webhook

```http
PATCH /api/settings/webhooks/:webhook_id
```

**Request Body:**
```json
{
  "enabled": false,
  "events": ["churn.risk_critical", "payment.failed"]
}
```

#### Delete Webhook

```http
DELETE /api/settings/webhooks/:webhook_id
```

#### List Available Event Types

```http
GET /api/settings/webhooks/events
```

**Response:**
```json
{
  "events": [
    {
      "type": "churn.risk_high",
      "description": "Customer churn risk is HIGH",
      "payload_example": {
        "customer_id": "cus_123",
        "email": "user@example.com",
        "risk_level": "HIGH",
        "probability": 0.75
      }
    },
    {
      "type": "payment.failed",
      "description": "Payment attempt failed",
      "payload_example": {
        "customer_id": "cus_123",
        "invoice_id": "inv_123",
        "amount": 4900,
        "currency": "usd"
      }
    }
  ]
}
```

### Webhook Event Types

| Event Type | Description | Payload Fields |
|------------|-------------|----------------|
| `churn.risk_high` | Customer churn risk is HIGH | customer_id, email, risk_level, probability |
| `churn.risk_critical` | Customer churn risk is CRITICAL | customer_id, email, risk_level, probability |
| `payment.failed` | Payment attempt failed | customer_id, invoice_id, amount, currency, attempt_count |
| `payment.recovered` | Failed payment recovered | customer_id, invoice_id, amount, currency |
| `campaign.triggered` | Retention campaign triggered | campaign_id, customer_id, trigger_type |
| `campaign.converted` | Campaign converted | campaign_id, customer_id, recovered_revenue |
| `trial.ending` | Customer trial ending soon | customer_id, subscription_id, trial_end_date, days_remaining |
| `trial.converted` | Trial converted to paid | customer_id, subscription_id, amount, currency |

### Webhook Security

#### HMAC Signature Verification

When a `secret` is configured, RevenuePlug sends an HMAC-SHA256 signature in the `X-Webhook-Signature` header:

```javascript
const crypto = require('crypto');

// Verify signature
const receivedSignature = request.headers['x-webhook-signature'];
const payload = JSON.stringify(request.body);
const expectedSignature = crypto
  .createHmac('sha256', webhookSecret)
  .update(payload)
  .digest('hex');

if (receivedSignature !== expectedSignature) {
  throw new Error('Invalid webhook signature');
}
```

### Webhook Delivery

- **Timeout**: 10 seconds
- **Retries**: Configurable (default 3 attempts)
- **Retry Delay**: Configurable (default 60 seconds)
- **Auto-Disable**: After 10 consecutive failures
- **Event Filtering**: Only subscribed events are sent
- **Custom Headers**: Optional headers included in every request

### Example Webhook Handler (Node.js)

```javascript
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

app.post('/webhooks/revenueplug', (req, res) => {
  // 1. Verify signature
  const signature = req.headers['x-webhook-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (signature !== expected) {
    return res.status(401).send('Invalid signature');
  }

  // 2. Handle event
  const eventType = req.headers['x-event-type'];

  switch (eventType) {
    case 'churn.risk_high':
      console.log('High risk customer:', req.body.customer_id);
      // Alert sales team
      break;

    case 'payment.failed':
      console.log('Payment failed:', req.body.invoice_id);
      // Update internal dashboard
      break;

    case 'campaign.converted':
      console.log('Campaign converted:', req.body.campaign_id);
      // Track revenue
      break;
  }

  // 3. Respond quickly (< 5 seconds)
  res.status(200).send({ received: true });
});

app.listen(3000);
```

---

## 4. Feature Flags

### Overview

Feature flags control feature availability per organization or globally, enabling gradual rollouts, A/B testing, and beta features.

### Database Schema

```prisma
model FeatureFlag {
  id          String @id
  key         String @unique
  name        String
  description String? @db.Text

  enabled Boolean @default(false)

  rolloutPercentage  Int @default(0)
  rolloutStrategy    FeatureFlagStrategy @default(DISABLED)

  enabledOrganizations  String[] @default([])
  disabledOrganizations String[] @default([])
}

enum FeatureFlagStrategy {
  DISABLED           // Disabled for all
  ENABLED            // Enabled for all
  PERCENTAGE_ROLLOUT // Enable for X% of organizations
  WHITELIST          // Only enabled for specific orgs
  BLACKLIST          // Enabled for all except specific orgs
}
```

### API Endpoints

#### Create Feature Flag (Admin Only)

```http
POST /api/settings/feature-flags
```

**Request Body:**
```json
{
  "key": "advanced_analytics",
  "name": "Advanced Analytics Dashboard",
  "description": "New analytics features with cohort analysis",
  "enabled": false,
  "rolloutPercentage": 25,
  "rolloutStrategy": "PERCENTAGE_ROLLOUT"
}
```

#### List Feature Flags

```http
GET /api/settings/feature-flags
```

**Response:**
```json
{
  "flags": [
    {
      "id": "flag_123",
      "key": "advanced_analytics",
      "name": "Advanced Analytics Dashboard",
      "description": "New analytics features",
      "enabled": false,
      "rolloutPercentage": 25,
      "rolloutStrategy": "PERCENTAGE_ROLLOUT",
      "enabledOrganizations": [],
      "disabledOrganizations": []
    }
  ]
}
```

#### Update Feature Flag (Admin Only)

```http
PATCH /api/settings/feature-flags/:key
```

**Request Body:**
```json
{
  "rolloutPercentage": 50,
  "enabledOrganizations": ["org_123", "org_456"]
}
```

#### Delete Feature Flag (Admin Only)

```http
DELETE /api/settings/feature-flags/:key
```

#### Get Enabled Features for Organization

```http
GET /api/settings/features
```

**Response:**
```json
{
  "features": [
    "advanced_analytics",
    "ab_testing",
    "predictive_churn"
  ]
}
```

#### Check Specific Feature

```http
GET /api/settings/features/:key
```

**Response:**
```json
{
  "enabled": true
}
```

### Rollout Strategies

#### 1. DISABLED

Feature is disabled for all organizations.

```javascript
{
  "rolloutStrategy": "DISABLED"
}
```

#### 2. ENABLED

Feature is enabled for all organizations.

```javascript
{
  "rolloutStrategy": "ENABLED"
}
```

#### 3. PERCENTAGE_ROLLOUT

Enable for a percentage of organizations (deterministic based on org ID hash).

```javascript
{
  "rolloutStrategy": "PERCENTAGE_ROLLOUT",
  "rolloutPercentage": 25  // 25% of organizations
}
```

**How it works:**
- MD5 hash of `organizationId + featureKey`
- Convert to percentage (0-100)
- Enable if percentage <= rolloutPercentage

This ensures the same organization always gets the same result.

#### 4. WHITELIST

Only enable for specific organizations.

```javascript
{
  "rolloutStrategy": "WHITELIST",
  "enabledOrganizations": ["org_123", "org_456"]
}
```

#### 5. BLACKLIST

Enable for all except specific organizations.

```javascript
{
  "rolloutStrategy": "BLACKLIST",
  "disabledOrganizations": ["org_789"]
}
```

### Using Feature Flags in Code

```typescript
import { isFeatureEnabled } from './modules/settings/service.js';

// Check if feature is enabled
const organizationId = 'org_123';
const enabled = await isFeatureEnabled('advanced_analytics', organizationId);

if (enabled) {
  // Show advanced analytics
  return advancedAnalyticsDashboard();
} else {
  // Show standard analytics
  return standardDashboard();
}
```

### Feature Flag Best Practices

1. **Use descriptive keys** - `advanced_analytics` not `feature_1`
2. **Start with small rollout** - Begin at 5-10% and increase gradually
3. **Monitor metrics** - Track usage and errors during rollout
4. **Clean up old flags** - Remove flags after 100% rollout
5. **Document behavior** - Explain what changes when flag is enabled
6. **Test both states** - Ensure app works with flag on AND off

---

## Usage Examples

### Setting Up Organization

```typescript
// 1. Create organization (done during signup)
const org = await prisma.organization.create({
  data: { name: 'Acme Inc', slug: 'acme' }
});

// 2. Set organization settings
await updateOrganizationSettings(org.id, {
  timezone: 'America/New_York',
  currency: 'USD',
  fromEmail: 'noreply@acme.com',
  maxEmailsPerDay: 20,
  gdprMode: true
});

// 3. Create webhook for Slack alerts
await createOutgoingWebhook({
  organizationId: org.id,
  name: 'Slack Alerts',
  url: 'https://hooks.slack.com/...',
  events: ['churn.risk_high', 'payment.failed'],
  secret: 'my_secret_key'
});
```

### Customizing User Notifications

```typescript
// User wants hourly email digest and Slack alerts
await updateUserNotificationPreference(userId, {
  emailDigest: 'HOURLY',
  slackWebhookUrl: 'https://hooks.slack.com/...',
  slackOnHighRisk: true,
  slackOnCampaignConverted: true
});
```

### Broadcasting Webhook Event

```typescript
import { broadcastWebhookEvent } from './modules/settings/service.js';

// When churn risk is calculated
await broadcastWebhookEvent(organizationId, 'churn.risk_high', {
  customer_id: 'cus_123',
  email: 'user@example.com',
  risk_level: 'HIGH',
  probability: 0.85
});
```

### Rolling Out New Feature

```typescript
// 1. Create feature flag (admin)
await createFeatureFlag({
  key: 'new_dashboard',
  name: 'New Dashboard UI',
  description: 'Redesigned dashboard with better UX',
  rolloutStrategy: 'PERCENTAGE_ROLLOUT',
  rolloutPercentage: 10  // Start with 10%
});

// 2. Check in code
const hasNewDashboard = await isFeatureEnabled('new_dashboard', organizationId);

if (hasNewDashboard) {
  return <NewDashboard />;
} else {
  return <OldDashboard />;
}

// 3. Increase rollout gradually
await updateFeatureFlag('new_dashboard', {
  rolloutPercentage: 25  // Increase to 25%
});

// 4. Eventually enable for all
await updateFeatureFlag('new_dashboard', {
  rolloutStrategy: 'ENABLED'
});
```

---

## Database Migrations

After adding the new models, run Prisma migrations:

```bash
npx prisma migrate dev --name add_settings_and_configuration
```

This will create:
- `organization_settings` table
- `user_notification_preferences` table
- `outgoing_webhooks` table
- `outgoing_webhook_deliveries` table
- `feature_flags` table
- 3 new enums

---

## Security Considerations

### Organization Settings
- Only organization members can view/update settings
- Email addresses must be verified before use
- Sensitive settings (GDPR mode) logged in audit trail

### User Notification Preferences
- Users can only view/update their own preferences
- Slack webhook URLs should be validated
- Personal settings don't affect other users

### Outgoing Webhooks
- HMAC signature prevents webhook spoofing
- Auto-disable after 10 failures prevents abuse
- Webhook delivery tracked for debugging
- Secret keys should be rotated regularly

### Feature Flags
- Only admins can create/update/delete flags
- Percentage rollout is deterministic (same org = same result)
- Flags don't expose sensitive data

---

## Performance Considerations

### Caching

Settings are frequently accessed but rarely changed. Consider caching:

```typescript
import { LRUCache } from 'lru-cache';

const settingsCache = new LRUCache<string, any>({
  max: 500,
  ttl: 1000 * 60 * 5, // 5 minutes
});

export async function getOrganizationSettings(organizationId: string) {
  const cacheKey = `settings:${organizationId}`;

  let settings = settingsCache.get(cacheKey);
  if (settings) {
    return settings;
  }

  settings = await prisma.organizationSettings.findUnique({
    where: { organizationId }
  });

  settingsCache.set(cacheKey, settings);
  return settings;
}
```

### Webhook Delivery

- Webhooks are sent asynchronously (non-blocking)
- Failed deliveries are retried with exponential backoff
- Delivery tracking allows debugging without impacting performance

### Feature Flag Evaluation

- Feature flag checks are fast (hash-based for percentage rollout)
- Consider caching enabled features per organization
- Avoid checking flags in hot paths (cache at request level)

---

## Troubleshooting

### Webhooks Not Delivering

1. Check webhook is enabled: `GET /api/settings/webhooks/:id`
2. Check event is subscribed: Verify event type in `events` array
3. Check recent deliveries: Look at `deliveries` array for errors
4. Verify endpoint responds quickly (< 10s timeout)
5. Check firewall allows RevenuePlug IP addresses

### Feature Flag Not Working

1. Verify flag exists: `GET /api/settings/feature-flags/:key`
2. Check rollout strategy matches intent
3. For percentage rollout, verify organization is in rollout percentage
4. Check whitelist/blacklist arrays don't conflict

### Settings Not Saving

1. Verify user has permission (organization member)
2. Check validation errors in request body
3. Verify organization settings record was created (auto-created on first GET)

---

## API Reference Summary

### Organization Settings
- `GET /api/settings` - Get organization settings
- `PATCH /api/settings` - Update organization settings

### User Notification Preferences
- `GET /api/settings/notifications` - Get notification preferences
- `PATCH /api/settings/notifications` - Update notification preferences

### Outgoing Webhooks
- `POST /api/settings/webhooks` - Create webhook
- `GET /api/settings/webhooks` - List webhooks
- `GET /api/settings/webhooks/events` - List available event types
- `GET /api/settings/webhooks/:id` - Get webhook with delivery history
- `PATCH /api/settings/webhooks/:id` - Update webhook
- `DELETE /api/settings/webhooks/:id` - Delete webhook

### Feature Flags (Admin Only)
- `POST /api/settings/feature-flags` - Create feature flag
- `GET /api/settings/feature-flags` - List all feature flags
- `GET /api/settings/feature-flags/:key` - Get specific feature flag
- `PATCH /api/settings/feature-flags/:key` - Update feature flag
- `DELETE /api/settings/feature-flags/:key` - Delete feature flag

### Enabled Features (For Organization)
- `GET /api/settings/features` - Get all enabled features
- `GET /api/settings/features/:key` - Check if specific feature is enabled

---

**Total Endpoints**: 17

---

## Next Steps

1. **Test webhook delivery** - Set up test webhook and verify events are received
2. **Configure email settings** - Add verified sender email and custom footer
3. **Set up feature flags** - Create flags for new features in development
4. **Customize notifications** - Configure team notification preferences
5. **Enable GDPR mode** - If serving EU customers, enable GDPR-compliant mode

---

**Documentation Version**: 1.0
**Last Updated**: 2024-12-30
