import type { FastifyRequest, FastifyReply } from 'fastify';
import { getOrganizationContext } from './organization-context.js';
import * as billingService from '../../modules/billing/service.js';
import { getOrganizationPlan } from '../../modules/billing/plans.js';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../logger/index.js';

const log = logger.child({ middleware: 'usage-limits' });


export async function enforceApiUsageLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { allowed, reason } = await billingService.checkUsageLimit(organizationId, 'apiCalls');

    if (!allowed) {
      log.warn({ organizationId, reason }, 'API usage limit exceeded');

      return reply.code(429).send({
        error: 'Usage Limit Exceeded',
        message: reason,
        code: 'USAGE_LIMIT_EXCEEDED',
      });
    }

    reply.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode < 400) {
        await billingService
          .incrementUsage(organizationId, 'apiCalls', 1)
          .catch((err) => log.error({ err }, 'Failed to track API usage'));
      }
      return payload;
    });
  } catch (error) {
    log.error({ error }, 'Usage limit check failed, allowing request');
  }
}


export async function enforceEmailLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      log.error({ organizationId }, 'Organization not found');
      return;
    }

    const plan = getOrganizationPlan(org);
    const period = org.currentPeriodStart || new Date();
    const usage = await billingService.getUsageForPeriod(organizationId, period);

    const limit = plan.limits.emailsPerMonth;
    const warningThreshold = limit === 1000 ? 900 : limit === 10000 ? 9000 : limit * 0.9;

    if (usage.emailsSent >= limit && limit !== -1) {
      log.warn({ organizationId, usage: usage.emailsSent, limit }, 'Email limit exceeded');

      return reply.code(429).send({
        error: 'Email Limit Reached',
        message: `You've sent ${usage.emailsSent}/${limit} emails this billing period. Limit reached.`,
        code: 'EMAIL_LIMIT_EXCEEDED',
        current_usage: usage.emailsSent,
        limit,
        reset_date: org.currentPeriodEnd,
        upgrade_url: plan.id === 'starter' ? '/billing?upgrade=pro' : '/billing?upgrade=enterprise',
        current_plan: plan.name,
      });
    }

    if (usage.emailsSent >= warningThreshold && usage.emailsSent < limit && limit !== -1) {
      const remaining = limit - usage.emailsSent;

      log.info(
        { organizationId, usage: usage.emailsSent, limit, remaining },
        'Email usage approaching limit'
      );

      reply.header(
        'X-Usage-Warning',
        `Approaching email limit: ${usage.emailsSent}/${limit} used. ${remaining} remaining.`
      );
      reply.header('X-Usage-Current', usage.emailsSent.toString());
      reply.header('X-Usage-Limit', limit.toString());
      reply.header('X-Usage-Remaining', remaining.toString());
    }
  } catch (error) {
    log.error({ error }, 'Email limit check failed, allowing request');
  }
}


export async function enforceConnectionLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const { allowed, reason } = await billingService.checkUsageLimit(
      organizationId,
      'connections'
    );

    if (!allowed) {
      log.warn({ organizationId, reason }, 'Connection limit exceeded');

      return reply.code(429).send({
        error: 'Usage Limit Exceeded',
        message: reason,
        code: 'CONNECTION_LIMIT_EXCEEDED',
      });
    }
  } catch (error) {
    log.error({ error }, 'Connection limit check failed, allowing request');
  }
}


export async function enforceRecoveryActionsLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const { id: organizationId } = getOrganizationContext(request);

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      log.error({ organizationId }, 'Organization not found');
      return reply.code(404).send({
        error: 'Organization Not Found',
        message: 'Organization not found',
        code: 'ORGANIZATION_NOT_FOUND',
      });
    }

    const plan = getOrganizationPlan(org);


    if (plan.id === 'viewer') {
      log.warn({ organizationId, plan: plan.id }, 'Recovery action blocked for Viewer tier');

      return reply.code(403).send({
        error: 'Feature Not Available',
        message: 'Recovery actions require STARTER plan or higher. Upgrade to start recovering revenue.',
        code: 'UPGRADE_REQUIRED',
        upgrade_url: '/billing?upgrade=starter',
        current_plan: plan.name,
        required_plan: 'STARTER',
      });
    }

    log.info({ organizationId, plan: plan.id }, 'Recovery action allowed');
  } catch (error) {
    log.error({ error }, 'Recovery action limit check failed, allowing request');
  }
}
