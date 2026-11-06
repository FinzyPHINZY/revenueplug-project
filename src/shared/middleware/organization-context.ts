import type { FastifyRequest, FastifyReply } from 'fastify';
import type { OrganizationRole, OrganizationMember } from '@prisma/client';
import { prisma } from '../../infrastructure/postgres/index.js';
import { getAuthUser } from '../../modules/auth/middleware.js';
import { logger } from '../logger/index.js';

export async function requireOrganizationContext(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'requireOrganizationContext', url: request.url });

  try {
    const { userId } = getAuthUser(request);

    const orgId =
      (request.headers['x-organization-id'] as string) || (request.query as any).organization_id;

    let membership:
      (OrganizationMember & { organization: { id: string; slug: string; name: string } }) | null;

    if (orgId) {
      membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: orgId, userId },
        },
        include: {
          organization: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
      });

      if (!membership) {
        log.warn({ userId, orgId }, 'User not member of organization');
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'You are not a member of this organization',
        });
      }
    } else {
      membership = await prisma.organizationMember.findFirst({
        where: { userId },
        include: {
          organization: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!membership) {
        log.warn({ userId }, 'User has no organization memberships');
        return reply.code(400).send({
          error: 'No organization',
          message: 'You must belong to an organization. Create one first.',
        });
      }
    }

    (request as any).organization = {
      id: membership.organizationId,
      role: membership.role,
      slug: membership.organization.slug,
      name: membership.organization.name,
    };

    log.debug(
      { organizationId: membership.organizationId, role: membership.role },
      'Organization context set'
    );
  } catch (error) {
    log.error({ error }, 'Failed to set organization context');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to validate organization context',
    });
  }
}

export function getOrganizationContext(request: FastifyRequest): {
  id: string;
  role: OrganizationRole;
  slug: string;
  name: string;
} {
  const org = (request as any).organization;
  if (!org) {
    throw new Error(
      'Organization context not set. Did you forget requireOrganizationContext middleware?'
    );
  }
  return org;
}
