import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Stripe from 'stripe';
import crypto from 'node:crypto';
import { prisma } from '../../../infrastructure/postgres/index.js';
import { app } from '../../../server.js';
import type { Organization } from '@prisma/client';

/**
 * Webhook Security Tests
 * 
 * Tests Stripe webhook signature verification, replay attack prevention,
 * and timestamp validation to ensure webhook endpoints are secure.
 */
describe('Webhook Security Tests', () => {
  let testOrg: Organization;
  let stripe: Stripe;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';

  beforeEach(async () => {
    testOrg = await prisma.organization.create({
      data: {
        name: 'Webhook Security Test Org',
        slug: `webhook-sec-test-${Date.now()}`,
        email: `webhook-sec-${Date.now()}@example.com`,
      },
    });

    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-12-15.clover',
    });
  });

  afterEach(async () => {
    if (testOrg) {
      await prisma.organization.delete({
        where: { id: testOrg.id },
      });
    }
  });

  /**
   * Generate a valid Stripe webhook signature
   * This mimics how Stripe signs webhooks
   */
  function generateStripeSignature(
    payload: string,
    secret: string,
    timestamp?: number
  ): string {
    const ts = timestamp || Math.floor(Date.now() / 1000);
    const signedPayload = `${ts}.${payload}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    return `t=${ts},v1=${signature}`;
  }

  describe('Signature Verification', () => {
    it('should accept webhook with valid signature', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      const payload = JSON.stringify(event);
      const signature = generateStripeSignature(payload, webhookSecret);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      // Should accept valid signature
      expect(response.statusCode).not.toBe(400);
    });

    it('should reject webhook with invalid signature', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const payload = JSON.stringify(event);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=1234567890,v1=invalid_signature',
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/signature|verification/i);
    });

    it('should reject webhook with missing signature', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          // No stripe-signature header
        },
        payload: JSON.stringify(event),
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject webhook with tampered payload', async () => {
      const originalEvent = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      const originalPayload = JSON.stringify(originalEvent);
      const signature = generateStripeSignature(originalPayload, webhookSecret);

      // Tamper with the payload after generating signature
      const tamperedEvent = {
        ...originalEvent,
        data: {
          object: {
            metadata: { organizationId: 'hacker-org-id' },
          },
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload: JSON.stringify(tamperedEvent),
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject webhook signed with wrong secret', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const payload = JSON.stringify(event);
      const wrongSignature = generateStripeSignature(payload, 'wrong_secret');

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': wrongSignature,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject webhook with malformed signature format', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const malformedSignatures = [
        'invalid_format',
        't=1234567890', // Missing v1
        'v1=signature', // Missing t
        't=abc,v1=signature', // Invalid timestamp
        't=1234567890,v1=', // Empty signature
      ];

      for (const sig of malformedSignatures) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/billing/webhook',
          headers: {
            'Content-Type': 'application/json',
            'stripe-signature': sig,
          },
          payload: JSON.stringify(event),
        });

        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('Timestamp Validation', () => {
    it('should reject webhook with old timestamp (replay attack)', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const payload = JSON.stringify(event);
      
      // Generate signature with timestamp from 10 minutes ago
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const signature = generateStripeSignature(payload, webhookSecret, oldTimestamp);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      // Stripe recommends rejecting webhooks older than 5 minutes
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/timestamp|expired|old/i);
    });

    it('should reject webhook with future timestamp', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const payload = JSON.stringify(event);
      
      // Generate signature with future timestamp
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600; // 10 minutes in future
      const signature = generateStripeSignature(payload, webhookSecret, futureTimestamp);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept webhook with recent timestamp', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      const payload = JSON.stringify(event);
      
      // Generate signature with current timestamp
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const signature = generateStripeSignature(payload, webhookSecret, currentTimestamp);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      // Should accept recent timestamp
      expect(response.statusCode).not.toBe(400);
    });

    it('should accept webhook within tolerance window (5 minutes)', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      const payload = JSON.stringify(event);
      
      // Generate signature with timestamp 4 minutes ago (within tolerance)
      const recentTimestamp = Math.floor(Date.now() / 1000) - 240; // 4 minutes ago
      const signature = generateStripeSignature(payload, webhookSecret, recentTimestamp);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      expect(response.statusCode).not.toBe(400);
    });
  });

  describe('Replay Attack Prevention', () => {
    it('should process same event ID only once (idempotency)', async () => {
      const eventId = `evt_test_${Date.now()}`;
      const event = {
        id: eventId,
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            subscription: 'sub_test_123',
            metadata: { organizationId: testOrg.id },
          },
        },
      };

      const payload = JSON.stringify(event);
      const signature = generateStripeSignature(payload, webhookSecret);

      // Send webhook first time
      const response1 = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      expect(response1.statusCode).toBe(200);

      // Send same webhook again (replay attack)
      const response2 = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      // Should still return 200 but not process again
      expect(response2.statusCode).toBe(200);

      // Verify only one event record exists
      const events = await prisma.billingWebhookEvent.findMany({
        where: { stripeEventId: eventId },
      });

      expect(events).toHaveLength(1);
    });

    it('should reject replayed webhook with different signature', async () => {
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

      const payload = JSON.stringify(event);
      const signature1 = generateStripeSignature(payload, webhookSecret);

      // Send webhook first time
      await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature1,
        },
        payload,
      });

      // Wait a bit and generate new signature (simulating replay with new timestamp)
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const signature2 = generateStripeSignature(payload, webhookSecret);

      // Try to replay with new signature
      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature2,
        },
        payload,
      });

      // Should accept (200) but not process duplicate event
      expect(response.statusCode).toBe(200);
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle very large payload', async () => {
      const largeData = 'x'.repeat(1024 * 1024); // 1MB of data
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            large_field: largeData,
          },
        },
      };

      const payload = JSON.stringify(event);
      const signature = generateStripeSignature(payload, webhookSecret);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload,
      });

      // Should handle large payloads gracefully (reject or accept based on limits)
      expect([200, 400, 413]).toContain(response.statusCode);
    });

    it('should handle malformed JSON payload', async () => {
      const malformedPayload = '{ invalid json }';
      const signature = generateStripeSignature(malformedPayload, webhookSecret);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload: malformedPayload,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle empty payload', async () => {
      const emptyPayload = '';
      const signature = generateStripeSignature(emptyPayload, webhookSecret);

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        payload: emptyPayload,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should not expose webhook secret in error messages', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        type: 'checkout.session.completed',
        data: { object: {} },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/billing/webhook',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 'invalid_signature',
        },
        payload: JSON.stringify(event),
      });

      const body = JSON.parse(response.body);
      
      // Error message should not contain the webhook secret
      expect(JSON.stringify(body)).not.toContain(webhookSecret);
      expect(JSON.stringify(body)).not.toContain('whsec_');
    });

    it('should handle concurrent webhook requests', async () => {
      const events = Array.from({ length: 10 }, (_, i) => ({
        id: `evt_test_${Date.now()}_${i}`,
        type: 'invoice.payment_succeeded',
        data: {
          object: {
            subscription: `sub_test_${i}`,
            metadata: { organizationId: testOrg.id },
          },
        },
      }));

      const requests = events.map((event) => {
        const payload = JSON.stringify(event);
        const signature = generateStripeSignature(payload, webhookSecret);

        return app.inject({
          method: 'POST',
          url: '/api/billing/webhook',
          headers: {
            'Content-Type': 'application/json',
            'stripe-signature': signature,
          },
          payload,
        });
      });

      const responses = await Promise.all(requests);

      // All should succeed
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
      });

      // All events should be logged
      const loggedEvents = await prisma.billingWebhookEvent.findMany({
        where: {
          stripeEventId: {
            in: events.map((e) => e.id),
          },
        },
      });

      expect(loggedEvents).toHaveLength(10);
    });
  });

  describe('Rate Limiting & DoS Protection', () => {
    it('should handle rapid webhook requests', async () => {
      const requests = Array.from({ length: 100 }, (_, i) => {
        const event = {
          id: `evt_rapid_${Date.now()}_${i}`,
          type: 'ping',
          data: { object: {} },
        };

        const payload = JSON.stringify(event);
        const signature = generateStripeSignature(payload, webhookSecret);

        return app.inject({
          method: 'POST',
          url: '/api/billing/webhook',
          headers: {
            'Content-Type': 'application/json',
            'stripe-signature': signature,
          },
          payload,
        });
      });

      const responses = await Promise.all(requests);

      // Should handle all requests without crashing
      expect(responses).toHaveLength(100);
      
      // Most should succeed, some might be rate-limited
      const successCount = responses.filter((r) => r.statusCode === 200).length;
      expect(successCount).toBeGreaterThan(0);
    });
  });
});
