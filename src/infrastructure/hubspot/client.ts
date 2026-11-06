

import { Client } from '@hubspot/api-client';
import { logger } from '../../shared/logger/index.js';
import { config } from '../../shared/config/index.js';

const log = logger.child({ module: 'hubspot' });

let hubspotClient: Client | null = null;

function getHubSpotClient(): Client {
  if (!hubspotClient) {
    const apiKey = config['HUBSPOT_API_KEY'] || process.env.HUBSPOT_API_KEY;

    if (!apiKey) {
      throw new Error('HUBSPOT_API_KEY is not configured');
    }

    hubspotClient = new Client({ accessToken: apiKey });
    log.info('HubSpot client initialized');
  }

  return hubspotClient;
}

export interface CreateTaskParams {
  subject: string;
  body: string;
  priority?: 'HIGH' | 'MEDIUM' | 'LOW';
  dueDate?: Date;
  assignedTo?: string;
  contactEmail?: string;
}

export interface CreateTaskResult {
  id: string;
  success: boolean;
  error?: string;
}


export async function createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
  const operationLog = log.child({
    operation: 'createTask',
    subject: params.subject,
  });

  try {
    const client = getHubSpotClient();

    const priorityMap = {
      HIGH: 'HIGH',
      MEDIUM: 'MEDIUM',
      LOW: 'LOW',
    };

    const properties: any = {
      hs_task_subject: params.subject,
      hs_task_body: params.body,
      hs_task_priority: priorityMap[params.priority || 'MEDIUM'],
      hs_task_status: 'NOT_STARTED',
      hs_task_type: 'TODO',
    };

    if (params.dueDate) {
      properties.hs_timestamp = params.dueDate.getTime().toString();
    }
    const response = await client.crm.objects.tasks.basicApi.create({
      properties,
      associations: [],
    });

    operationLog.info({ taskId: response.id }, 'HubSpot task created');

    if (params.contactEmail) {
      try {
        await associateTaskWithContact(response.id, params.contactEmail);
      } catch (error) {
        operationLog.warn({ error }, 'Failed to associate task with contact');
      }
    }

    return {
      id: response.id,
      success: true,
    };
  } catch (error) {
    operationLog.error({ error }, 'Failed to create HubSpot task');
    return {
      id: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


async function associateTaskWithContact(
  taskId: string,
  contactEmail: string
): Promise<void> {
  const client = getHubSpotClient();

  const searchResponse = await client.crm.contacts.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'email',
            operator: 'EQ' as any,
            value: contactEmail,
          },
        ],
      },
    ],
  });

  if (searchResponse.results && searchResponse.results.length > 0) {
    const contact = searchResponse.results[0];
    if (contact?.id) {
      const contactId = contact.id;

      try {
        await client.crm.associations.batchApi.create({
          inputs: [
            {
              from: { id: taskId },
              to: { id: contactId },
              type: 'task_to_contact',
            },
          ],
        });
        log.info({ taskId, contactId }, 'Task associated with contact');
      } catch (error) {
        log.warn({ error, taskId, contactId }, 'Failed to associate task with contact');
      }
    }
  } else {
    log.warn({ contactEmail }, 'Contact not found in HubSpot');
  }
}


export async function updateTask(
  taskId: string,
  updates: Partial<CreateTaskParams>
): Promise<boolean> {
  const operationLog = log.child({ operation: 'updateTask', taskId });

  try {
    const client = getHubSpotClient();

    const properties: any = {};

    if (updates.subject) properties.hs_task_subject = updates.subject;
    if (updates.body) properties.hs_task_body = updates.body;
    if (updates.priority) properties.hs_task_priority = updates.priority;
    if (updates.dueDate) {
      properties.hs_timestamp = updates.dueDate.getTime().toString();
    }

    await client.crm.objects.tasks.basicApi.update(taskId, { properties });

    operationLog.info('HubSpot task updated');
    return true;
  } catch (error) {
    operationLog.error({ error }, 'Failed to update HubSpot task');
    return false;
  }
}

export async function completeTask(taskId: string): Promise<boolean> {
  const operationLog = log.child({ operation: 'completeTask', taskId });

  try {
    const client = getHubSpotClient();

    await client.crm.objects.tasks.basicApi.update(taskId, {
      properties: {
        hs_task_status: 'COMPLETED',
      },
    });

    operationLog.info('HubSpot task marked as completed');
    return true;
  } catch (error) {
    operationLog.error({ error }, 'Failed to complete HubSpot task');
    return false;
  }
}

export function isHubSpotConfigured(): boolean {
  const apiKey = config['HUBSPOT_API_KEY'] || process.env.HUBSPOT_API_KEY;
  return Boolean(apiKey);
}
