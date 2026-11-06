

export interface StripeCustomer {
  id: string;
  email?: string;
  name?: string;
  created: number;
  [key: string]: unknown;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  items: {
    data: Array<{
      price: {
        unit_amount: number;
        currency: string;
        recurring?: {
          interval: string;
          interval_count: number;
        };
        product?: string | { name?: string };
      };
    }>;
  };
  trial_end?: number;
  canceled_at?: number;
  cancel_at_period_end: boolean;
  [key: string]: unknown;
}

export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  customer?: string;
  invoice?: string;
  failure_message?: string;
  created: number;
  refunded: boolean;
  amount_refunded?: number;
  [key: string]: unknown;
}

export interface StripeInvoice {
  id: string;
  customer?: string;
  subscription?: string;
  status: string;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  due_date?: number;
  status_transitions?: {
    paid_at?: number;
  };
  next_payment_attempt?: number;
  attempt_count: number;
  last_finalization_error?: {
    message?: string;
  };
  hosted_invoice_url?: string;
  invoice_pdf?: string;
  created: number;
  [key: string]: unknown;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
  created: number;
  [key: string]: unknown;
}
