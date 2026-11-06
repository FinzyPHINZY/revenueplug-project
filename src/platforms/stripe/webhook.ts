import { createHmac } from 'node:crypto';
import { EventType } from '../../shared/types/index.js';
import type { NormalizedEvent, WebhookVerificationResult } from '../types.js';
import type { StripeWebhookEvent } from './types.js';


export function verifyStripeWebhook(
  payload: string,
  signature: string,
  secret: string
): WebhookVerificationResult {
  try {

    const signatureParts = signature.split(',').reduce(
      (acc, part) => {
        const [key, value] = part.split('=');
        if (key && value) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>
    );

    const timestamp = signatureParts['t'];
    const receivedSignature = signatureParts['v1'];

    if (!timestamp || !receivedSignature) {
      return { valid: false, error: 'Invalid signature format' };
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const timeDiff = currentTime - parseInt(timestamp, 10);

    if (timeDiff > 300) {
      return { valid: false, error: 'Timestamp too old' };
    }

    const signedPayload = `${timestamp}.${payload}`;
    const expectedSignature = createHmac('sha256', secret).update(signedPayload).digest('hex');

    if (expectedSignature !== receivedSignature) {
      return { valid: false, error: 'Signature mismatch' };
    }

    const event = JSON.parse(payload) as StripeWebhookEvent;
    const normalizedEvent = parseStripeWebhook(event);

    return { valid: true, event: normalizedEvent };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export function parseStripeWebhook(event: StripeWebhookEvent): NormalizedEvent {
  return {
    event: mapStripeEventType(event.type),
    platformEvent: event.type,
    occurredAt: new Date(event.created * 1000),
    data: event.data.object,
    rawData: event,
  };
}


function mapStripeEventType(stripeEvent: string): string {
  const eventMap: Record<string, string> = {
    'customer.subscription.created': EventType.SUBSCRIPTION_CREATED,
    'customer.subscription.updated': EventType.SUBSCRIPTION_UPDATED,
    'customer.subscription.deleted': EventType.SUBSCRIPTION_CANCELLED,
    'customer.subscription.trial_will_end': EventType.SUBSCRIPTION_TRIAL_WILL_END,
    'customer.created': EventType.CUSTOMER_CREATED,
    'customer.updated': EventType.CUSTOMER_UPDATED,
    'customer.deleted': EventType.CUSTOMER_DELETED,
    'charge.succeeded': EventType.PAYMENT_SUCCEEDED,
    'charge.failed': EventType.PAYMENT_FAILED,
    'charge.refunded': EventType.PAYMENT_REFUNDED,
  };

  return eventMap[stripeEvent] || stripeEvent;
}
