# Billing Module Tests

Comprehensive test suite for the RevenuePlug billing system integration with Stripe.

## Overview

This test suite covers:
- ✅ Checkout session creation
- ✅ Plan eligibility validation
- ✅ Usage tracking and limits
- ✅ Customer portal sessions
- ✅ Subscription management
- ✅ Webhook event processing
- ✅ ROI calculations
- ✅ End-to-end billing flows

## Test Files

### `billing.test.ts`
**Unit and integration tests for core billing service**

Tests:
- Checkout session creation for all plans
- Stripe customer creation and reuse
- Plan eligibility validation logic
- Usage tracking (API calls, emails, connections)
- Usage limit enforcement
- Customer portal session creation
- Subscription status retrieval
- Webhook event handlers
- ROI calculation accuracy

### `webhook.test.ts`
**Webhook endpoint tests**

Tests:
- Webhook signature validation
- Event processing for all webhook types:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
- Webhook event logging
- Idempotency (duplicate event handling)
- Error handling for malformed payloads

### `e2e.test.ts`
**End-to-end user journey tests**

Tests complete flows:
1. Free → STARTER upgrade
2. STARTER → PRO upgrade
3. Customer portal access and cancellation
4. Usage tracking and limit enforcement
5. Annual billing
6. Failed payment recovery
7. ROI calculator

### `setup.ts`
**Test utilities and helpers**

Provides:
- Test organization creation
- Test user creation
- Cleanup functions
- Stripe helper functions
- Webhook signature generation
- Test data generators
- Environment validation

## Prerequisites

### 1. Environment Variables

Create a `.env.test` file or ensure your `.env` has:

```bash
# Stripe Test Mode Keys
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_PUBLISHABLE_KEY="pk_test_..."
STRIPE_WEBHOOK_SECRET_BILLING="whsec_test_..."

# Stripe Price IDs (from running npm run stripe:setup)
PRICE_ID_STARTER_MONTHLY="price_..."
PRICE_ID_PRO_MONTHLY="price_..."
PRICE_ID_ENTERPRISE_MONTHLY="price_..."
PRICE_ID_STARTER_ANNUAL="price_..."
PRICE_ID_PRO_ANNUAL="price_..."
PRICE_ID_ENTERPRISE_ANNUAL="price_..."

# Database
DATABASE_URL="postgresql://revenueplug:revenueplug@localhost:5432/revenueplug_test?schema=public"
```

**IMPORTANT:** Always use **test mode** Stripe keys (`sk_test_`, `pk_test_`). The test suite will fail if it detects live mode keys.

### 2. Set Up Stripe Test Products

Run the Stripe setup script to create test products and prices:

```bash
npm run stripe:setup
```

This will:
- Create products in Stripe test mode
- Create monthly and annual prices
- Output price IDs to add to `.env`

### 3. Database Setup

Ensure PostgreSQL is running and migrations are applied:

```bash
# Start database
npm run docker:up

# Run migrations
npm run prisma:migrate:dev
```

### 4. Stripe CLI (for webhook testing)

Install Stripe CLI for local webhook testing:

**Mac:**
```bash
brew install stripe/stripe-cli/stripe
```

**Linux:**
```bash
curl -s https://packages.stripe.com/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.com/stripe-cli-debian-local stable main" | sudo tee -a /etc/apt/sources.list.d/stripe.list
sudo apt update
sudo apt install stripe
```

Authenticate:
```bash
stripe login
```

## Running Tests

### Run All Tests

```bash
npm test
```

### Run Specific Test File

```bash
# Run only billing service tests
npm test -- billing.test.ts

# Run only webhook tests
npm test -- webhook.test.ts

# Run only E2E tests
npm test -- e2e.test.ts
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

Coverage report will be generated in `coverage/` directory.

## Test Strategy

### Unit Tests
**Fast, isolated tests of individual functions**

- No external API calls (mock Stripe)
- Test business logic only
- Run frequently during development

### Integration Tests
**Test integration with Stripe API**

- Make real Stripe API calls (test mode)
- Verify database updates
- Test complete workflows
- Run before committing

### E2E Tests
**Test complete user journeys**

- Simulate real user flows
- Test entire stack (API → Service → Database → Stripe)
- Run before deploying

## Writing New Tests

### 1. Import Test Utilities

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestOrganization,
  cleanupTestOrganization,
  getPriceIdForPlan,
} from './setup.js';
```

### 2. Set Up Test Data

```typescript
let testOrg: Organization;

beforeEach(async () => {
  testOrg = await createTestOrganization({
    withStripeCustomer: true,
    withSubscription: true,
    plan: 'starter',
  });
});

afterEach(async () => {
  await cleanupTestOrganization(testOrg.id);
});
```

### 3. Write Test Cases

```typescript
it('should upgrade from STARTER to PRO', async () => {
  const priceId = getPriceIdForPlan('pro');

  const session = await billingService.createCheckoutSession({
    organizationId: testOrg.id,
    priceId,
    successUrl: 'http://localhost:3000/success',
    cancelUrl: 'http://localhost:3000/cancel',
  });

  expect(session.sessionId).toBeDefined();
  expect(session.url).toContain('checkout.stripe.com');
});
```

### 4. Clean Up Resources

Always clean up Stripe resources to avoid accumulating test data:

```typescript
afterEach(async () => {
  // Delete Stripe subscription
  if (subscription) {
    await stripe.subscriptions.cancel(subscription.id);
  }

  // Delete Stripe customer
  if (customer) {
    await stripe.customers.del(customer.id);
  }

  // Delete database records
  await cleanupTestOrganization(testOrg.id);
});
```

## Common Test Patterns

### Testing Checkout Flow

```typescript
it('should create checkout session', async () => {
  const session = await billingService.createCheckoutSession({
    organizationId: testOrg.id,
    priceId: process.env.PRICE_ID_STARTER_MONTHLY!,
    successUrl: 'http://localhost:3000/success',
    cancelUrl: 'http://localhost:3000/cancel',
  });

  expect(session.sessionId).toMatch(/^cs_test_/);
  expect(session.url).toContain('checkout.stripe.com');
});
```

### Testing Usage Limits

```typescript
it('should enforce usage limits', async () => {
  // Add usage
  await billingService.incrementUsage(testOrg.id, 'apiCalls', 1001);

  // Check limit
  const check = await billingService.checkUsageLimit(
    testOrg.id,
    'apiCalls'
  );

  expect(check.allowed).toBe(false);
  expect(check.upgradeRequired).toBe(true);
});
```

### Testing Webhooks

```typescript
it('should process webhook event', async () => {
  const { event, signature } = createTestWebhookEvent(
    'invoice.payment_succeeded',
    {
      subscription: 'sub_test_123',
      metadata: { organizationId: testOrg.id },
    }
  );

  const response = await app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature,
    },
    payload: JSON.stringify(event),
  });

  expect(response.statusCode).toBe(200);
});
```

## Debugging Tests

### Enable Debug Logging

```bash
LOG_LEVEL=debug npm test
```

### Run Single Test

```typescript
it.only('should test specific scenario', async () => {
  // Your test here
});
```

### Skip Flaky Tests

```typescript
it.skip('flaky test', async () => {
  // This test will be skipped
});
```

### Inspect Stripe Dashboard

During tests, you can view test data in Stripe Dashboard:
- https://dashboard.stripe.com/test/customers
- https://dashboard.stripe.com/test/subscriptions
- https://dashboard.stripe.com/test/webhooks

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: revenueplug
          POSTGRES_DB: revenueplug_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run migrations
        run: npm run prisma:migrate:deploy
        env:
          DATABASE_URL: postgresql://postgres:revenueplug@localhost:5432/revenueplug_test

      - name: Run tests
        run: npm test
        env:
          STRIPE_SECRET_KEY: ${{ secrets.STRIPE_TEST_SECRET_KEY }}
          # ... other env vars

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

## Test Coverage Goals

| Module | Target Coverage |
|--------|----------------|
| Service | 90%+ |
| Routes | 80%+ |
| Utils | 95%+ |
| Overall | 85%+ |

Check current coverage:
```bash
npm run test:coverage
```

## Troubleshooting

### "STRIPE_SECRET_KEY not set"

**Solution:** Add Stripe test keys to `.env`:
```bash
STRIPE_SECRET_KEY="sk_test_..."
```

### "Price ID not found"

**Solution:** Run Stripe setup:
```bash
npm run stripe:setup
```

### "Webhook signature verification failed"

**Solution:**
1. Use Stripe CLI for local testing:
   ```bash
   stripe listen --forward-to localhost:3000/api/billing/webhook
   ```
2. Update `STRIPE_WEBHOOK_SECRET_BILLING` in `.env`

### Database Connection Errors

**Solution:** Ensure PostgreSQL is running:
```bash
npm run docker:up
```

### Tests Timing Out

**Solution:**
1. Check network connection
2. Verify Stripe API is reachable
3. Increase timeout in `vitest.config.ts`:
   ```typescript
   test: {
     testTimeout: 30000, // 30 seconds
   }
   ```

## Best Practices

1. **Always use test mode** - Never use live Stripe keys in tests
2. **Clean up resources** - Delete Stripe customers/subscriptions after tests
3. **Use descriptive test names** - Clearly describe what is being tested
4. **Test edge cases** - Don't just test happy paths
5. **Mock external dependencies** - When not testing Stripe integration
6. **Keep tests fast** - Use unit tests for quick feedback
7. **Document complex tests** - Add comments explaining test logic

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Stripe Testing Guide](https://stripe.com/docs/testing)
- [Stripe Test Cards](https://stripe.com/docs/testing#cards)
- [Stripe CLI Docs](https://stripe.com/docs/stripe-cli)

## Support

For questions or issues:
1. Check this README
2. Review test examples
3. Check Stripe documentation
4. Open an issue on GitHub
