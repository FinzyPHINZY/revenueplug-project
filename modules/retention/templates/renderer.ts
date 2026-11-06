/**
 * Email Template Renderer
 * Uses Handlebars to render email templates with customer data
 */

import Handlebars from 'handlebars';
import { logger } from '../../../shared/logger/index.js';
import type { EmailTemplate } from '@prisma/client';
import type { TemplateData, RenderedTemplate } from '../types.js';

const log = logger.child({ module: 'template-renderer' });

// ============================================================================
// HANDLEBARS HELPERS
// ============================================================================

/**
 * Register custom Handlebars helpers
 */
function registerHelpers(): void {
  // Format currency (cents to dollars)
  Handlebars.registerHelper('currency', function (amount: number | undefined, currency: string = 'USD') {
    if (amount === undefined || amount === null) {
      return '$0.00';
    }

    const dollars = amount / 100;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(dollars);
  });

  // Format date
  Handlebars.registerHelper('date', function (date: Date | string | undefined, format: string = 'long') {
    if (!date) {
      return '';
    }

    const dateObj = typeof date === 'string' ? new Date(date) : date;

    const formatOptions: Intl.DateTimeFormatOptions = {
      long: { dateStyle: 'long' },
      short: { dateStyle: 'short' },
      medium: { dateStyle: 'medium' },
      full: { dateStyle: 'full', timeStyle: 'short' },
    }[format] || { dateStyle: 'long' };

    return new Intl.DateTimeFormat('en-US', formatOptions).format(dateObj);
  });

  // Format percentage
  Handlebars.registerHelper('percent', function (value: number | undefined) {
    if (value === undefined || value === null) {
      return '0%';
    }
    return `${Math.round(value)}%`;
  });

  // Format number with commas
  Handlebars.registerHelper('number', function (value: number | undefined) {
    if (value === undefined || value === null) {
      return '0';
    }
    return new Intl.NumberFormat('en-US').format(value);
  });

  // Conditional helper - if equals
  Handlebars.registerHelper('ifEquals', function (arg1: any, arg2: any, options: any) {
    return arg1 === arg2 ? options.fn(this) : options.inverse(this);
  });

  // Conditional helper - if greater than
  Handlebars.registerHelper('ifGt', function (arg1: number, arg2: number, options: any) {
    return arg1 > arg2 ? options.fn(this) : options.inverse(this);
  });

  // Capitalize first letter
  Handlebars.registerHelper('capitalize', function (str: string | undefined) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  });

  // Days until date
  Handlebars.registerHelper('daysUntil', function (date: Date | string | undefined) {
    if (!date) return 0;

    const dateObj = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const diffTime = dateObj.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
  });

  log.info('Handlebars helpers registered');
}

// Register helpers on module load
registerHelpers();

// ============================================================================
// TEMPLATE RENDERING
// ============================================================================

/**
 * Render an email template with data
 * Automatically injects unsubscribe links if unsubscribeUrl is provided
 */
export function renderEmailTemplate(
  template: EmailTemplate,
  data: TemplateData
): RenderedTemplate {
  const operationLog = log.child({
    operation: 'renderEmailTemplate',
    templateId: template.id,
    templateName: template.name,
  });

  try {
    // Compile templates
    const subjectTemplate = Handlebars.compile(template.subject);
    const htmlTemplate = Handlebars.compile(template.htmlBody);
    const textTemplate = template.textBody
      ? Handlebars.compile(template.textBody)
      : null;

    // Render with data
    let html = htmlTemplate(data);
    let text = textTemplate ? textTemplate(data) : undefined;

    // Inject unsubscribe links if provided
    if (data.unsubscribeUrl) {
      html = injectUnsubscribeLink(html, data.unsubscribeUrl, data.preferenceCenterUrl);
      if (text) {
        text = injectUnsubscribeLinkText(text, data.unsubscribeUrl);
      }
    }

    const rendered: RenderedTemplate = {
      subject: subjectTemplate(data),
      html,
      text,
    };

    operationLog.info('Template rendered successfully');
    return rendered;
  } catch (error) {
    operationLog.error({ error }, 'Failed to render template');
    throw new Error(
      `Template rendering failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Inject unsubscribe link into HTML email
 * Appends footer with unsubscribe and preference center links
 */
function injectUnsubscribeLink(
  html: string,
  unsubscribeUrl: string,
  preferenceCenterUrl?: string
): string {
  const footer = `
    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px;">
      <p>
        ${preferenceCenterUrl ? `<a href="${preferenceCenterUrl}" style="color: #2563eb; text-decoration: none;">Manage email preferences</a> | ` : ''}
        <a href="${unsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe</a>
      </p>
      <p style="margin-top: 8px;">RevenuePlug - Revenue Recovery & Retention Platform</p>
    </div>
  `;

  // Try to inject before closing body tag, otherwise append
  if (html.includes('</body>')) {
    return html.replace('</body>', `${footer}</body>`);
  }
  return html + footer;
}

/**
 * Inject unsubscribe link into plain text email
 */
function injectUnsubscribeLinkText(
  text: string,
  unsubscribeUrl: string
): string {
  return `${text}\n\n---\n\nUnsubscribe: ${unsubscribeUrl}\n\nRevenuePlug - Revenue Recovery & Retention Platform`;
}

/**
 * Validate that all required tags are present in template data
 */
export function validateTemplateData(
  template: EmailTemplate,
  data: TemplateData
): { valid: boolean; missingTags: string[] } {
  const missingTags: string[] = [];

  for (const tag of template.availableTags) {
    if (!(tag in data) || data[tag] === undefined) {
      missingTags.push(tag);
    }
  }

  return {
    valid: missingTags.length === 0,
    missingTags,
  };
}

/**
 * Preview a template with sample data
 */
export function previewTemplate(
  template: EmailTemplate
): RenderedTemplate {
  // Create sample data based on available tags
  const sampleData: TemplateData = {};

  for (const tag of template.availableTags) {
    switch (tag) {
      case 'customerName':
        sampleData[tag] = 'John Doe';
        break;
      case 'customerEmail':
        sampleData[tag] = 'john@example.com';
        break;
      case 'planName':
        sampleData[tag] = 'Professional Plan';
        break;
      case 'amount':
        sampleData[tag] = 9900; // $99.00
        break;
      case 'currency':
        sampleData[tag] = 'USD';
        break;
      case 'trialEndDate':
        sampleData[tag] = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days from now
        break;
      case 'currentPeriodEnd':
        sampleData[tag] = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
        break;
      case 'discountCode':
        sampleData[tag] = 'SAVE25';
        break;
      case 'discountPercent':
        sampleData[tag] = 25;
        break;
      default:
        sampleData[tag] = `[${tag}]`;
    }
  }

  return renderEmailTemplate(template, sampleData);
}

/**
 * Escape HTML in template data to prevent XSS
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return text.replace(/[&<>"']/g, (m) => map[m]);
}
