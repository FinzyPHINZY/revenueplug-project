/**
 * Default Email Template Library
 *
 * Pre-built, professionally written templates for common retention scenarios
 * Ready to use out-of-the-box with merge tags for personalization
 */

export interface DefaultTemplate {
  name: string;
  description: string;
  category: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  availableTags: string[];
}

// ============================================================================
// CHURN PREVENTION TEMPLATES
// ============================================================================

export const churnPreventionHighRisk: DefaultTemplate = {
  name: 'Churn Prevention - High Risk',
  description: 'Sent when customer shows high churn risk signals. Empathetic tone with value reminder.',
  category: 'CHURN_PREVENTION',
  subject: 'We noticed you haven\'t been around, {{customerName}}',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>We'd love to have you back</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0;">We'd love to have you back</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>I noticed you haven't been active with your {{planName}} recently, and I wanted to personally reach out.</p>

        <p>We know life gets busy, but I wanted to make sure everything is okay with your account. Is there anything we can help with?</p>

        <div style="background: #f3f4f6; border-left: 4px solid #2563eb; padding: 20px; margin: 30px 0;">
          <p style="margin: 0; font-weight: 600;">Quick reminder of what you get:</p>
          <ul style="margin: 10px 0;">
            <li>Automated revenue recovery from failed payments</li>
            <li>Churn prediction and prevention</li>
            <li>Real-time analytics and insights</li>
            <li>Priority support from our team</li>
          </ul>
        </div>

        <p>If you're thinking about canceling, I'd love to chat first to see if there's a way we can make this work for you. You can:</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{dashboardUrl}}" style="background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Return to Dashboard</a>
        </div>

        <p>Or simply reply to this email - I read every response.</p>

        <p>Thanks for being a valued customer,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong><br>
          <span style="color: #6b7280; font-size: 14px;">We're here to help you recover revenue</span>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

I noticed you haven't been active with your {{planName}} recently, and I wanted to personally reach out.

We know life gets busy, but I wanted to make sure everything is okay with your account. Is there anything we can help with?

QUICK REMINDER OF WHAT YOU GET:
• Automated revenue recovery from failed payments
• Churn prediction and prevention
• Real-time analytics and insights
• Priority support from our team

If you're thinking about canceling, I'd love to chat first to see if there's a way we can make this work for you.

Return to Dashboard: {{dashboardUrl}}

Or simply reply to this email - I read every response.

Thanks for being a valued customer,
The RevenuePlug Team
We're here to help you recover revenue`,
  availableTags: ['customerName', 'planName', 'dashboardUrl'],
};

export const churnPreventionCritical: DefaultTemplate = {
  name: 'Churn Prevention - Critical Risk',
  description: 'Sent when customer shows critical churn signals. Offers immediate assistance and discount.',
  category: 'CHURN_PREVENTION',
  subject: 'Can we help? Special offer inside for {{customerName}}',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #dc2626; margin: 0;">Before you go...</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>I noticed we haven't seen you in a while, and your {{planName}} subscription is coming up for renewal soon.</p>

        <p>Before you decide to cancel, I wanted to reach out personally. We've helped thousands of SaaS companies recover millions in lost revenue - and I'd hate to see you miss out on those results.</p>

        <div style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px; padding: 20px; margin: 30px 0; text-align: center;">
          <p style="font-size: 18px; font-weight: 600; color: #dc2626; margin: 0 0 10px 0;">🎁 Special Offer Just for You</p>
          <p style="font-size: 32px; font-weight: 700; color: #dc2626; margin: 0;">{{discountPercent}}% OFF</p>
          <p style="color: #991b1b; margin: 10px 0 0 0;">for the next {{durationMonths}} months</p>
        </div>

        <p>This is our way of saying thank you for being an early supporter. No strings attached - just a genuine offer to help make RevenuePlug work for you.</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{acceptOfferUrl}}" style="background: #dc2626; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Accept This Offer</a>
        </div>

        <p><strong>Or, if there's something else we can do:</strong></p>
        <ul>
          <li>Schedule a 1-on-1 session with our team</li>
          <li>Get help setting up your first campaign</li>
          <li>Discuss custom features for your needs</li>
        </ul>

        <p>Just reply to this email and let me know what would help.</p>

        <p>Best regards,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

I noticed we haven't seen you in a while, and your {{planName}} subscription is coming up for renewal soon.

Before you decide to cancel, I wanted to reach out personally. We've helped thousands of SaaS companies recover millions in lost revenue - and I'd hate to see you miss out on those results.

🎁 SPECIAL OFFER JUST FOR YOU:
{{discountPercent}}% OFF for the next {{durationMonths}} months

This is our way of saying thank you for being an early supporter. No strings attached - just a genuine offer to help make RevenuePlug work for you.

Accept this offer: {{acceptOfferUrl}}

OR, IF THERE'S SOMETHING ELSE WE CAN DO:
• Schedule a 1-on-1 session with our team
• Get help setting up your first campaign
• Discuss custom features for your needs

Just reply to this email and let me know what would help.

Best regards,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'discountPercent', 'durationMonths', 'acceptOfferUrl', 'dashboardUrl'],
};

// ============================================================================
// PAYMENT RECOVERY TEMPLATES
// ============================================================================

export const paymentFailedGentle: DefaultTemplate = {
  name: 'Payment Failed - Gentle Reminder',
  description: 'First email after payment failure. Friendly tone, assumes innocent mistake.',
  category: 'PAYMENT_RECOVERY',
  subject: 'Heads up: Payment issue with your {{planName}}',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #f59e0b; margin: 0;">⚠️ Payment Update Needed</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>We tried to process your {{planName}} payment of <strong>{{currency amount}}</strong>, but it didn't go through.</p>

        <p>This happens! Common reasons include:</p>
        <ul>
          <li>Expired credit card</li>
          <li>Insufficient funds</li>
          <li>Changed billing address</li>
        </ul>

        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 20px; margin: 30px 0;">
          <p style="margin: 0; font-weight: 600;">Don't worry - your account is still active.</p>
          <p style="margin: 10px 0 0 0;">You have until <strong>{{date dueDate "long"}}</strong> to update your payment method.</p>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{updatePaymentUrl}}" style="background: #f59e0b; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Update Payment Method</a>
        </div>

        <p>If you have any questions or need help, just reply to this email.</p>

        <p>Thanks,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

We tried to process your {{planName}} payment of {{currency amount}}, but it didn't go through.

This happens! Common reasons include:
• Expired credit card
• Insufficient funds
• Changed billing address

DON'T WORRY - YOUR ACCOUNT IS STILL ACTIVE
You have until {{date dueDate "long"}} to update your payment method.

Update your payment method: {{updatePaymentUrl}}

If you have any questions or need help, just reply to this email.

Thanks,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'amount', 'currency', 'dueDate', 'updatePaymentUrl'],
};

export const paymentFailedUrgent: DefaultTemplate = {
  name: 'Payment Failed - Urgent',
  description: 'Final reminder before account suspension. Clear deadline and consequences.',
  category: 'PAYMENT_RECOVERY',
  subject: 'Final notice: Update payment by {{date dueDate "short"}}',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #dc2626; margin: 0;">🚨 Immediate Action Required</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>This is our final reminder about your failed payment for {{planName}}.</p>

        <div style="background: #fef2f2; border: 2px solid #dc2626; border-radius: 8px; padding: 20px; margin: 30px 0;">
          <p style="font-weight: 600; color: #dc2626; margin: 0 0 10px 0;">Your account will be suspended on:</p>
          <p style="font-size: 24px; font-weight: 700; color: #dc2626; margin: 0;">{{date dueDate "full"}}</p>
          <p style="color: #991b1b; margin: 10px 0 0 0; font-size: 14px;">That's {{daysUntil dueDate}} days from now</p>
        </div>

        <p><strong>What happens if payment isn't updated:</strong></p>
        <ul>
          <li>❌ Your campaigns will be paused</li>
          <li>❌ Analytics access will be limited</li>
          <li>❌ You'll lose revenue recovery opportunities</li>
          <li>❌ Data may be deleted after 30 days</li>
        </ul>

        <p><strong>Amount due:</strong> {{currency amount}}</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{updatePaymentUrl}}" style="background: #dc2626; color: white; padding: 16px 40px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; font-size: 16px;">Update Payment Now</a>
        </div>

        <p>Need help? Reply to this email or call us at <strong>{{supportPhone}}</strong></p>

        <p>We're here to help,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

This is our final reminder about your failed payment for {{planName}}.

🚨 YOUR ACCOUNT WILL BE SUSPENDED ON:
{{date dueDate "full"}}
That's {{daysUntil dueDate}} days from now

WHAT HAPPENS IF PAYMENT ISN'T UPDATED:
❌ Your campaigns will be paused
❌ Analytics access will be limited
❌ You'll lose revenue recovery opportunities
❌ Data may be deleted after 30 days

Amount due: {{currency amount}}

Update payment now: {{updatePaymentUrl}}

Need help? Reply to this email or call us at {{supportPhone}}

We're here to help,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'amount', 'currency', 'dueDate', 'updatePaymentUrl', 'supportPhone'],
};

export const cardExpiringTemplate: DefaultTemplate = {
  name: 'Card Expiring Soon',
  description: 'Proactive reminder sent 7 days before card expiration. Prevents payment failures.',
  category: 'PAYMENT_RECOVERY',
  subject: 'Your payment card expires soon - Update now',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0;">💳 Card Update Needed</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>A quick heads up: the credit card we have on file for your {{planName}} is set to expire soon.</p>

        <div style="background: #dbeafe; border-left: 4px solid #2563eb; padding: 20px; margin: 30px 0;">
          <p style="margin: 0; font-weight: 600;">Card ending in {{cardLast4}}</p>
          <p style="margin: 5px 0 0 0;">Expires: {{cardExpiry}}</p>
        </div>

        <p>To avoid any interruption to your service, please update your payment method before your next billing date on <strong>{{date nextBillingDate "long"}}</strong>.</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{updatePaymentUrl}}" style="background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Update Card Now</a>
        </div>

        <p>This only takes a minute, and you'll be all set!</p>

        <p>Thanks for staying on top of this,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

A quick heads up: the credit card we have on file for your {{planName}} is set to expire soon.

CARD DETAILS:
• Ending in {{cardLast4}}
• Expires: {{cardExpiry}}

To avoid any interruption to your service, please update your payment method before your next billing date on {{date nextBillingDate "long"}}.

Update card now: {{updatePaymentUrl}}

This only takes a minute, and you'll be all set!

Thanks for staying on top of this,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'cardLast4', 'cardExpiry', 'nextBillingDate', 'updatePaymentUrl'],
};

// ============================================================================
// TRIAL CONVERSION TEMPLATES
// ============================================================================

export const trialEnding3Days: DefaultTemplate = {
  name: 'Trial Ending - 3 Days',
  description: 'Sent 3 days before trial ends. Highlights value and makes conversion easy.',
  category: 'TRIAL_CONVERSION',
  subject: '3 days left in your trial - Ready to continue?',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0;">Your trial ends in 3 days</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>Just a friendly reminder that your {{planName}} trial ends on <strong>{{date trialEndDate "long"}}</strong>.</p>

        <p>We hope you've enjoyed exploring RevenuePlug! Here's what happens next:</p>

        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 30px 0;">
          <p style="margin: 0 0 15px 0; font-weight: 600;">On {{date trialEndDate "medium"}}:</p>
          <ul style="margin: 0;">
            <li>Your card will be charged <strong>{{currency amount}}</strong></li>
            <li>You'll keep all your campaigns and data</li>
            <li>No interruption to your service</li>
          </ul>
        </div>

        <p><strong>Want to cancel?</strong> No problem - you can do that anytime before {{date trialEndDate "long"}} with zero charges.</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{dashboardUrl}}" style="background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; margin-right: 10px;">Continue to Dashboard</a>
          <a href="{{manageBillingUrl}}" style="background: white; color: #2563eb; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; border: 2px solid #2563eb;">Manage Billing</a>
        </div>

        <p>Questions? Just reply to this email - we're here to help!</p>

        <p>Best,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

Just a friendly reminder that your {{planName}} trial ends on {{date trialEndDate "long"}}.

We hope you've enjoyed exploring RevenuePlug! Here's what happens next:

ON {{date trialEndDate "medium"}}:
• Your card will be charged {{currency amount}}
• You'll keep all your campaigns and data
• No interruption to your service

WANT TO CANCEL? No problem - you can do that anytime before {{date trialEndDate "long"}} with zero charges.

Continue to dashboard: {{dashboardUrl}}
Manage billing: {{manageBillingUrl}}

Questions? Just reply to this email - we're here to help!

Best,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'trialEndDate', 'amount', 'currency', 'dashboardUrl', 'manageBillingUrl'],
};

export const trialEnding1Day: DefaultTemplate = {
  name: 'Trial Ending - 1 Day (Last Chance)',
  description: 'Final reminder 1 day before trial ends. Urgency + easy cancellation option.',
  category: 'TRIAL_CONVERSION',
  subject: 'Tomorrow: Your trial ends - Choose your next step',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #f59e0b; margin: 0;">⏰ Your trial ends tomorrow</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>This is it - your {{planName}} trial ends <strong>tomorrow at {{time trialEndDate}}</strong>.</p>

        <p>Here's what you need to know:</p>

        <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 30px 0;">
          <p style="font-weight: 600; margin: 0 0 15px 0;">Tomorrow we'll charge:</p>
          <p style="font-size: 32px; font-weight: 700; color: #f59e0b; margin: 0;">{{currency amount}}</p>
          <p style="margin: 10px 0 0 0; font-size: 14px;">for your {{planName}} subscription</p>
        </div>

        <p><strong>Happy with RevenuePlug?</strong> You're all set - no action needed!</p>

        <p><strong>Need more time or want to cancel?</strong> Click below to manage your subscription:</p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{manageBillingUrl}}" style="background: #f59e0b; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">Manage My Subscription</a>
        </div>

        <p>Or reply to this email if you have questions!</p>

        <p>Thanks,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

This is it - your {{planName}} trial ends TOMORROW at {{time trialEndDate}}.

Here's what you need to know:

TOMORROW WE'LL CHARGE:
{{currency amount}}
for your {{planName}} subscription

✓ Happy with RevenuePlug? You're all set - no action needed!

❌ Need more time or want to cancel? Manage your subscription: {{manageBillingUrl}}

Or reply to this email if you have questions!

Thanks,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'trialEndDate', 'amount', 'currency', 'manageBillingUrl'],
};

// ============================================================================
// USAGE & ENGAGEMENT TEMPLATES
// ============================================================================

export const usageDecliningTemplate: DefaultTemplate = {
  name: 'Usage Declining - Re-engagement',
  description: 'Sent when customer usage drops significantly. Offers help and tips.',
  category: 'USAGE_NUDGES',
  subject: 'Getting the most from {{planName}}?',
  htmlBody: `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #2563eb; margin: 0;">We're here to help!</h1>
        </div>

        <p>Hi {{customerName}},</p>

        <p>I noticed you haven't logged into RevenuePlug in a while. Everything okay?</p>

        <p>I wanted to reach out personally to make sure you're getting the most out of your {{planName}}.</p>

        <div style="background: #dbeafe; border-left: 4px solid #2563eb; padding: 20px; margin: 30px 0;">
          <p style="margin: 0 0 10px 0; font-weight: 600;">Quick wins to try today:</p>
          <ol style="margin: 0; padding-left: 20px;">
            <li>Set up your first retention campaign (takes 5 min)</li>
            <li>Review your churn risk dashboard</li>
            <li>Check payment failure predictions</li>
            <li>Enable automated email sequences</li>
          </ol>
        </div>

        <p><strong>Need help getting started?</strong> Our team can:</p>
        <ul>
          <li>Walk you through setup (30 min call)</li>
          <li>Create your first campaign for you</li>
          <li>Answer any questions you have</li>
        </ul>

        <div style="text-align: center; margin: 30px 0;">
          <a href="{{scheduleCallUrl}}" style="background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; margin-right: 10px;">Schedule a Call</a>
          <a href="{{dashboardUrl}}" style="background: white; color: #2563eb; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600; border: 2px solid #2563eb;">Go to Dashboard</a>
        </div>

        <p>Or just reply to this email - I read every message!</p>

        <p>Looking forward to helping,</p>
        <p style="margin-top: 20px;">
          <strong>The RevenuePlug Team</strong>
        </p>
      </body>
    </html>
  `,
  textBody: `Hi {{customerName}},

I noticed you haven't logged into RevenuePlug in a while. Everything okay?

I wanted to reach out personally to make sure you're getting the most out of your {{planName}}.

QUICK WINS TO TRY TODAY:
1. Set up your first retention campaign (takes 5 min)
2. Review your churn risk dashboard
3. Check payment failure predictions
4. Enable automated email sequences

NEED HELP GETTING STARTED? Our team can:
• Walk you through setup (30 min call)
• Create your first campaign for you
• Answer any questions you have

Schedule a call: {{scheduleCallUrl}}
Go to dashboard: {{dashboardUrl}}

Or just reply to this email - I read every message!

Looking forward to helping,
The RevenuePlug Team`,
  availableTags: ['customerName', 'planName', 'scheduleCallUrl', 'dashboardUrl'],
};

// Export all templates as an array
export const ALL_DEFAULT_TEMPLATES: DefaultTemplate[] = [
  churnPreventionHighRisk,
  churnPreventionCritical,
  paymentFailedGentle,
  paymentFailedUrgent,
  cardExpiringTemplate,
  trialEnding3Days,
  trialEnding1Day,
  usageDecliningTemplate,
];
