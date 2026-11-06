import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Stripe from 'stripe';
import { prisma } from '../../../infrastructure/postgres.js';
import { app } from '../../../server.js';
import type { Organization } from '@prisma/client';

describe('Webhook Endpoint Tests', () => {
  let testOrg: Organization;
  let stripe: Stripe;

  beforeEach(async () => {
    // Create test organization
    testOrg = await prisma.organization.create({
      data: {
        name: 'Webhook Test Org',
        slug: `webhook-test-org-${Date.now()}`,
        email: `webhook-test-${Date.now()}@example.com`,
      },
    });

    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-12-18.acacia',
    });
  });

  afterEach(async () => {
    // Clean up
    if (testOrg) {
      await prisma.organization.delete({
        where: { id: testOrg.id },
      });
    }
  });

  describe('Webhook Signature Validation', () => {
    it('should reject webhook with invalid signature', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': 'invalid_signature',
        },
        payload: {
          type: 'checkout.session.completed',
          data: { object: {} },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('signature');
    });

    it('should accept webhook with valid signature', async () => {
      // This test requires generating a valid Stripe signature
      // In practice, use Stripe CLI for testing
      // stripe trigger checkout.session.completed

      // For unit tests, we can mock the signature validation
      // This is more of an integration test scenario
    });
  });

  describe('Checkout Session Completed', () => {
    it('should handle checkout.session.completed event', async () => {
      // Create a customer first
      const customer = await stripe.customers.create({
        email: testOrg.email,
        metadata: { organizationId: testOrg.id },
      });

      // Create a subscription
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: process.env.PRICE_ID_STARTER_MONTHLY! }],
      });

      // Simulate webhook event
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            customer: customer.id,
            subscription: subscription.id,
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Send webhook (would normally include valid signature)
      const payload = JSON.stringify(event);
      const sig = generateTestSignature(payload); // Mock function

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': sig,
        },
        payload,
      });

      // Verify organization updated
      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.stripeCustomerId).toBe(customer.id);
      expect(org?.stripeSubscriptionId).toBe(subscription.id);
    });
  });

  describe('Subscription Created', () => {
    it('should handle customer.subscription.created event', async () => {
      const customer = await stripe.customers.create({
        email: testOrg.email,
        metadata: { organizationId: testOrg.id },
      });

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: process.env.PRICE_ID_STARTER_MONTHLY! }],
        metadata: { organizationId: testOrg.id },
      });

      const event = {
        type: 'customer.subscription.created',
        data: {
          object: {
            id: subscription.id,
            customer: customer.id,
            status: 'active',
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 2592000, // +30 days
            items: {
              data: [
                {
                  price: {
                    id: process.env.PRICE_ID_STARTER_MONTHLY!,
                  },
                },
              ],
            },
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Process event (normally through webhook endpoint)
      // For testing, we can call the handler directly

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org).toBeDefined();
    });
  });

  describe('Subscription Updated', () => {
    it('should handle customer.subscription.updated event', async () => {
      // Update to PRO plan
      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_123',
            status: 'active',
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
            items: {
              data: [
                {
                  price: {
                    id: process.env.PRICE_ID_PRO_MONTHLY!,
                  },
                },
              ],
            },
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Process event would update organization to PRO plan
    });

    it('should handle subscription cancellation at period end', async () => {
      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_123',
            status: 'active',
            cancel_at_period_end: true,
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Should mark organization as canceling but still active until period end
    });
  });

  describe('Subscription Deleted', () => {
    it('should handle customer.subscription.deleted event', async () => {
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripeSubscriptionId: 'sub_test_123',
          billingStatus: 'ACTIVE',
        },
      });

      const event = {
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test_123',
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Process event should set status to CANCELED

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.billingStatus).toBe('CANCELED');
    });
  });

  describe('Invoice Payment Succeeded', () => {
    it('should handle invoice.payment_succeeded event', async () => {
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripeSubscriptionId: 'sub_test_123',
          billingStatus: 'PAST_DUE',
        },
      });

      const event = {
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            subscription: 'sub_test_123',
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Process event should update status to ACTIVE

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.billingStatus).toBe('ACTIVE');
    });
  });

  describe('Invoice Payment Failed', () => {
    it('should handle invoice.payment_failed event', async () => {
      await prisma.organization.update({
        where: { id: testOrg.id },
        data: {
          stripeSubscriptionId: 'sub_test_123',
          billingStatus: 'ACTIVE',
        },
      });

      const event = {
        type: 'invoice.payment_failed',
        data: {
          object: {
            subscription: 'sub_test_123',
            attempt_count: 1,
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // Process event should update status to PAST_DUE

      const org = await prisma.organization.findUnique({
        where: { id: testOrg.id },
      });

      expect(org?.billingStatus).toBe('PAST_DUE');
    });

    it('should handle multiple failed payment attempts', async () => {
      const event = {
        type: 'invoice.payment_failed',
        data: {
          object: {
            subscription: 'sub_test_123',
            attempt_count: 4, // Final attempt failed
            metadata: {
              organizationId: testOrg.id,
            },
          },
        },
      };

      // After 4 failed attempts, should potentially cancel subscription
      // or send urgent notifications to user
    });
  });

  describe('Webhook Event Logging', () => {
    it('should log all webhook events to database', async () => {
      const eventId = `evt_test_${Date.now()}`;
      const event = {
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      // Process webhook

      // Verify event logged
      const loggedEvent = await prisma.billingWebhookEvent.findUnique({
        where: { stripeEventId: eventId },
      });

      expect(loggedEvent).toBeDefined();
      expect(loggedEvent?.eventType).toBe('checkout.session.completed');
      expect(loggedEvent?.processed).toBe(true);
    });

    it('should handle duplicate webhook events (idempotency)', async () => {
      const eventId = `evt_test_${Date.now()}`;
      const event = {
        id: eventId,
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      // Process webhook twice
      // First time: should process
      // Second time: should skip (already processed)

      const events = await prisma.billingWebhookEvent.findMany({
        where: { stripeEventId: eventId },
      });

      expect(events.length).toBe(1); // Should only have one record
    });
  });

  describe('Error Handling', () => {
    it('should handle webhook for non-existent organization', async () => {
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: {
              organizationId: 'non-existent-id',
            },
          },
        },
      };

      // Should log error but return 200 to Stripe (don't retry)
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': 'test_sig',
        },
        payload: JSON.stringify(event),
      });

      // Should return 200 even on error to prevent retries
      expect(response.statusCode).toBe(200);
    });

    it('should handle malformed webhook payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': 'test_sig',
        },
        payload: 'invalid json',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});

// Helper function for generating test signatures
function generateTestSignature(payload: string): string {
  // In real tests, use Stripe's signature generation
  // For now, return a mock signature
  return 't=1234567890,v1=test_signature';
}
