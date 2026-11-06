import { logger } from '../../shared/logger/index.js';
import type { EnterpriseLead, LeadQualificationTier } from '@prisma/client';

const log = logger.child({ module: 'sales-notifications' });

// Sales team configuration
const SALES_TEAM = {
  hotLeads: {
    emails: ['sales-hot@revenueplug.com', 'ceo@revenueplug.com'],
    slackWebhook: process.env.SLACK_WEBHOOK_HOT_LEADS,
  },
  warmLeads: {
    emails: ['sales@revenueplug.com'],
    slackWebhook: process.env.SLACK_WEBHOOK_WARM_LEADS,
  },
};

export interface LeadNotification {
  lead: {
    id: string;
    name: string;
    email: string;
    company: string;
    jobTitle?: string;
    phone?: string;
  };
  qualification: {
    tier: LeadQualificationTier;
    score: number;
    estimatedDealValue: number;
  };
  metrics: {
    monthlyRevenue?: number;
    customerCount?: number;
    estimatedAtRisk?: number;
  };
  context: {
    message?: string;
    timeline?: string;
    source: string;
  };
}

/**
 * Send notifications to sales team when new lead is created
 */
export async function notifySalesTeam(notification: LeadNotification): Promise<void> {
  const { tier } = notification.qualification;

  try {
    // Only notify for HOT and WARM leads
    if (tier !== 'HOT' && tier !== 'WARM') {
      log.debug({ tier, leadId: notification.lead.id }, 'Skipping notification for COLD/UNQUALIFIED lead');
      return;
    }

    log.info(
      {
        leadId: notification.lead.id,
        tier,
        company: notification.lead.company,
      },
      'Sending sales team notification'
    );

    // Send email notification
    await sendEmailNotification(notification);

    // Send Slack notification
    await sendSlackNotification(notification);

    log.info({ leadId: notification.lead.id, tier }, 'Sales team notified');
  } catch (error) {
    log.error({ error, leadId: notification.lead.id }, 'Failed to notify sales team');
    // Don't throw - notification failure shouldn't block lead creation
  }
}

/**
 * Send email notification to sales team
 */
async function sendEmailNotification(notification: LeadNotification): Promise<void> {
  const { tier } = notification.qualification;
  const config = tier === 'HOT' ? SALES_TEAM.hotLeads : SALES_TEAM.warmLeads;

  // TODO: Replace with actual email service (Resend, SendGrid, etc.)
  // For now, just log
  const emailContent = formatEmailNotification(notification);

  log.info(
    {
      to: config.emails,
      subject: `[${tier}] New Enterprise Lead: ${notification.lead.company}`,
    },
    'Email notification prepared (email service not configured)'
  );

  // Example using Resend (when configured):
  /*
  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from: 'RevenuePlug Sales <sales@revenueplug.com>',
    to: config.emails,
    subject: `[${tier}] New Enterprise Lead: ${notification.lead.company}`,
    html: emailContent,
  });
  */

  log.debug({ emailContent }, 'Email content generated');
}

/**
 * Format email notification
 */
function formatEmailNotification(notification: LeadNotification): string {
  const { lead, qualification, metrics, context } = notification;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: ${qualification.tier === 'HOT' ? '#dc2626' : '#f59e0b'}; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
    .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-radius: 0 0 5px 5px; }
    .metric { background: white; padding: 15px; margin: 10px 0; border-left: 4px solid ${qualification.tier === 'HOT' ? '#dc2626' : '#f59e0b'}; }
    .metric-label { font-size: 12px; color: #6b7280; text-transform: uppercase; }
    .metric-value { font-size: 24px; font-weight: bold; color: #111827; }
    .action-button { background: ${qualification.tier === 'HOT' ? '#dc2626' : '#f59e0b'}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔥 ${qualification.tier} Lead Alert!</h1>
      <p style="margin: 5px 0;">New enterprise inquiry from ${lead.company}</p>
    </div>

    <div class="content">
      <h2>Lead Details</h2>
      <div class="info-row">
        <strong>Name:</strong>
        <span>${lead.name}${lead.jobTitle ? ` (${lead.jobTitle})` : ''}</span>
      </div>
      <div class="info-row">
        <strong>Company:</strong>
        <span>${lead.company}</span>
      </div>
      <div class="info-row">
        <strong>Email:</strong>
        <span><a href="mailto:${lead.email}">${lead.email}</a></span>
      </div>
      ${lead.phone ? `
      <div class="info-row">
        <strong>Phone:</strong>
        <span><a href="tel:${lead.phone}">${lead.phone}</a></span>
      </div>
      ` : ''}
      <div class="info-row">
        <strong>Source:</strong>
        <span>${context.source}</span>
      </div>

      <h2 style="margin-top: 30px;">Business Metrics</h2>
      <div class="metric">
        <div class="metric-label">Qualification Score</div>
        <div class="metric-value">${qualification.score}/100</div>
      </div>

      ${metrics.monthlyRevenue ? `
      <div class="metric">
        <div class="metric-label">Monthly Revenue (MRR)</div>
        <div class="metric-value">$${(metrics.monthlyRevenue / 1000).toFixed(0)}K</div>
      </div>
      ` : ''}

      ${metrics.customerCount ? `
      <div class="metric">
        <div class="metric-label">Customer Count</div>
        <div class="metric-value">${metrics.customerCount.toLocaleString()}</div>
      </div>
      ` : ''}

      ${metrics.estimatedAtRisk ? `
      <div class="metric">
        <div class="metric-label">Estimated At-Risk Revenue</div>
        <div class="metric-value">$${(metrics.estimatedAtRisk / 100).toLocaleString()}</div>
      </div>
      ` : ''}

      <div class="metric">
        <div class="metric-label">Estimated Deal Value (Annual)</div>
        <div class="metric-value">$${(qualification.estimatedDealValue / 100).toLocaleString()}</div>
      </div>

      ${context.timeline ? `
      <div class="info-row" style="margin-top: 20px;">
        <strong>Timeline:</strong>
        <span>${context.timeline}</span>
      </div>
      ` : ''}

      ${context.message ? `
      <h2 style="margin-top: 30px;">Message</h2>
      <p style="background: white; padding: 15px; border-radius: 5px;">${context.message}</p>
      ` : ''}

      <h2 style="margin-top: 30px;">Next Steps</h2>
      <p>
        ${qualification.tier === 'HOT'
          ? '⚡ <strong>URGENT:</strong> Respond within 24 hours. Schedule a call immediately.'
          : '📞 Respond within 2-3 business days. Send personalized demo invite.'}
      </p>

      <a href="https://app.revenueplug.com/admin/leads/${lead.id}" class="action-button">
        View Lead in CRM →
      </a>
    </div>
  </div>
</body>
</html>
  `;

  return html;
}

/**
 * Send Slack notification
 */
async function sendSlackNotification(notification: LeadNotification): Promise<void> {
  const { tier } = notification.qualification;
  const config = tier === 'HOT' ? SALES_TEAM.hotLeads : SALES_TEAM.warmLeads;

  if (!config.slackWebhook) {
    log.debug({ tier }, 'Slack webhook not configured, skipping');
    return;
  }

  const slackMessage = formatSlackMessage(notification);

  try {
    const response = await fetch(config.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackMessage),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
    }

    log.info({ tier, leadId: notification.lead.id }, 'Slack notification sent');
  } catch (error) {
    log.error({ error, tier }, 'Failed to send Slack notification');
  }
}

/**
 * Format Slack message
 */
function formatSlackMessage(notification: LeadNotification) {
  const { lead, qualification, metrics, context } = notification;

  const color = qualification.tier === 'HOT' ? '#dc2626' : '#f59e0b';
  const emoji = qualification.tier === 'HOT' ? '🔥' : '⚡';

  const fields = [
    {
      type: 'mrkdwn',
      text: `*Contact:*\n${lead.name}${lead.jobTitle ? ` (${lead.jobTitle})` : ''}\n${lead.email}${lead.phone ? `\n${lead.phone}` : ''}`,
    },
    {
      type: 'mrkdwn',
      text: `*Score:*\n${qualification.score}/100\n\n*Deal Value:*\n$${(qualification.estimatedDealValue / 100).toLocaleString()}/yr`,
    },
  ];

  if (metrics.monthlyRevenue || metrics.customerCount) {
    fields.push({
      type: 'mrkdwn',
      text: `*Business:*\n${metrics.monthlyRevenue ? `$${(metrics.monthlyRevenue / 1000).toFixed(0)}K MRR` : ''}${metrics.monthlyRevenue && metrics.customerCount ? '\n' : ''}${metrics.customerCount ? `${metrics.customerCount.toLocaleString()} customers` : ''}`,
    });
  }

  if (metrics.estimatedAtRisk) {
    fields.push({
      type: 'mrkdwn',
      text: `*At Risk:*\n$${(metrics.estimatedAtRisk / 100).toLocaleString()}`,
    });
  }

  return {
    text: `${emoji} New ${qualification.tier} Lead: ${lead.company}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} New ${qualification.tier} Lead: ${lead.company}`,
        },
      },
      {
        type: 'section',
        fields,
      },
      ...(context.message
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Message:*\n>${context.message}`,
              },
            },
          ]
        : []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            qualification.tier === 'HOT'
              ? '*⚡ URGENT:* Respond within 24 hours. Schedule a call immediately.'
              : '*📞 Action:* Respond within 2-3 business days. Send personalized demo invite.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Lead in CRM',
            },
            url: `https://app.revenueplug.com/admin/leads/${lead.id}`,
            style: qualification.tier === 'HOT' ? 'danger' : 'primary',
          },
        ],
      },
    ],
  };
}

/**
 * Send test notification (for testing/development)
 */
export async function sendTestNotification(tier: 'HOT' | 'WARM' = 'HOT'): Promise<void> {
  const testNotification: LeadNotification = {
    lead: {
      id: 'test_lead_123',
      name: 'John Smith',
      email: 'john.smith@acmecorp.com',
      company: 'Acme Corporation',
      jobTitle: 'VP of Finance',
      phone: '+1 (555) 123-4567',
    },
    qualification: {
      tier,
      score: tier === 'HOT' ? 85 : 65,
      estimatedDealValue: tier === 'HOT' ? 12000000 : 149000, // cents
    },
    metrics: {
      monthlyRevenue: tier === 'HOT' ? 1000000 : 100000,
      customerCount: tier === 'HOT' ? 15000 : 2000,
      estimatedAtRisk: tier === 'HOT' ? 50000 : 5000,
    },
    context: {
      message: 'We\'re experiencing high payment failure rates and need a solution ASAP.',
      timeline: tier === 'HOT' ? 'Immediate' : '1-3 months',
      source: 'CONTACT_FORM',
    },
  };

  await notifySalesTeam(testNotification);
}
