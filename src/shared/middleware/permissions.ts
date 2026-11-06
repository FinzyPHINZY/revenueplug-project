import type { FastifyRequest, FastifyReply } from 'fastify';
import { OrganizationRole } from '@prisma/client';
import { getOrganizationContext } from './organization-context.js';
import { logger } from '../logger/index.js';


export type Permission = 'read' | 'write' | 'admin' | 'owner';


const ROLE_PERMISSIONS: Record<OrganizationRole, Permission[]> = {
  [OrganizationRole.OWNER]: ['read', 'write', 'admin', 'owner'],
  [OrganizationRole.ADMIN]: ['read', 'write', 'admin'],
  [OrganizationRole.MEMBER]: ['read', 'write'],
  [OrganizationRole.VIEWER]: ['read']
};

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const log = logger.child({ operation: 'requirePermission', permission, url: request.url });

    try {
      const { role } = getOrganizationContext(request);

      const hasPermission = ROLE_PERMISSIONS[role].includes(permission);

      if (!hasPermission) {
        log.warn({ role, permission }, 'Permission denied');
        return reply.code(403).send({
          error: 'Forbidden',
          message: `This action requires ${permission} permission. You have ${role} role.`
        });
      }

      log.debug({ role, permission }, 'Permission granted');
    } catch (error) {
      log.error({ error }, 'Failed to check permission');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to validate permissions'
      });
    }
  };
}


export function hasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
