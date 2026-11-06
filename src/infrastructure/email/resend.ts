
import { Resend } from 'resend';
import { logger } from '../../shared/logger/index.js';
import { config } from '../../shared/config/index.js';

const log = logger.child({ module: 'resend' });

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    const apiKey = config['RESEND_API_KEY'] || process.env.RESEND_API_KEY;

    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured');
    }

    resendClient = new Resend(apiKey);
    log.info('Resend client initialized');
  }

  return resendClient;
}

export interface SendEmailParams {
  to: string | string[];
  from?: string;
  subject: string;
  html: string;
  text?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  id: string;
  success: boolean;
  error?: string;
}


export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const operationLog = log.child({
    operation: 'sendEmail',
    to: params.to,
    subject: params.subject,
  });

  try {
    const client = getResendClient();

    const { data, error } = await client.emails.send({
      from: params.from || 'RevenuePlug <campaigns@revenueplug.com>',
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      tags: params.tags,
      headers: params.headers,
    });

    if (error) {
      operationLog.error({ error }, 'Failed to send email via Resend');
      return {
        id: '',
        success: false,
        error: error.message,
      };
    }

    if (!data || !data.id) {
      operationLog.error('No data returned from Resend');
      return {
        id: '',
        success: false,
        error: 'No data returned from Resend',
      };
    }

    operationLog.info({ emailId: data.id }, 'Email sent successfully');
    return {
      id: data.id,
      success: true,
    };
  } catch (error) {
    operationLog.error({ error }, 'Exception while sending email');
    return {
      id: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


export async function sendBulkEmails(
  emails: SendEmailParams[]
): Promise<SendEmailResult[]> {
  const operationLog = log.child({
    operation: 'sendBulkEmails',
    count: emails.length,
  });

  try {
    const results = await Promise.all(emails.map((email) => sendEmail(email)));

    const successCount = results.filter((r) => r.success).length;
    operationLog.info({ successCount, totalCount: emails.length }, 'Bulk email send completed');

    return results;
  } catch (error) {
    operationLog.error({ error }, 'Failed to send bulk emails');
    throw error;
  }
}

export function isResendConfigured(): boolean {
  const apiKey = config['RESEND_API_KEY'] || process.env.RESEND_API_KEY;
  return Boolean(apiKey);
}
