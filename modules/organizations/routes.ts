import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OrganizationRole } from '@prisma/client';
import { logger } from '../../shared/logger/index.js';
import { getAuthUser, requireAuth } from '../auth/middleware.js';
import { getOrganizationContext, requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import { requirePermission } from '../../shared/middleware/permissions.js';
import * as orgService from './service.js';

// ==========================================================================
// REQUEST SCHEMAS (using Zod)
// ==========================================================================

const CreateOrganizationBodySchema = z.object({
  name: z.string().min(1, 'Organization name is required'),
  slug: z.string().min(1, 'Organization slug is required').regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  email: z.string().email('Invalid email address').optional(),
});

const UpdateOrganizationBodySchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens').optional(),
  email: z.string().email('Invalid email address').optional(),
  settings: z.record(z.any()).optional(),
});

const AddMemberBodySchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.nativeEnum(OrganizationRole),
});

const UpdateMemberRoleBodySchema = z.object({
  role: z.nativeEnum(OrganizationRole),
});

const OrganizationIdParamSchema = z.object({
  id: z.string().min(1, 'Organization ID is required'),
});

const MemberParamsSchema = z.object({
  id: z.string().min(1, 'Organization ID is required'),
  userId: z.string().min(1, 'User ID is required'),
});

// ==========================================================================
// TYPE DEFINITIONS FOR ROUTES
// ==========================================================================

interface CreateOrganizationRoute {
  Body: z.infer<typeof CreateOrganizationBodySchema>;
}

interface UpdateOrganizationRoute {
  Params: z.infer<typeof OrganizationIdParamSchema>;
  Body: z.infer<typeof UpdateOrganizationBodySchema>;
}

interface OrganizationIdRoute {
  Params: z.infer<typeof OrganizationIdParamSchema>;
}

interface AddMemberRoute {
  Params: z.infer<typeof OrganizationIdParamSchema>;
  Body: z.infer<typeof AddMemberBodySchema>;
}

interface UpdateMemberRoleRoute {
  Params: z.infer<typeof MemberParamsSchema>;
  Body: z.infer<typeof UpdateMemberRoleBodySchema>;
}

interface MemberParamsRoute {
  Params: z.infer<typeof MemberParamsSchema>;
}

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * POST /api/organizations
 * Create a new organization (any authenticated user)
 */
async function handleCreateOrganization(
  request: FastifyRequest<CreateOrganizationRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreateOrganization' });

  try {
    // Get authenticated user
    const { userId } = getAuthUser(request);

    // Validate request body
    const body = CreateOrganizationBodySchema.parse(request.body);

    // Create organization
    const organization = await orgService.createOrganization({
      name: body.name,
      slug: body.slug,
      email: body.email,
      creatorUserId: userId,
    });

    log.info({ organizationId: organization.id, slug: organization.slug }, 'Organization created');

    return reply.code(201).send({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      email: organization.email,
      role: 'OWNER',
      created_at: organization.createdAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to create organization');

    if (error instanceof Error && error.message === 'Organization slug already exists') {
      return reply.code(409).send({
        error: 'Slug already exists',
        message: 'An organization with this slug already exists',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to create organization',
    });
  }
}

/**
 * GET /api/organizations
 * List all organizations for the authenticated user
 */
async function handleListOrganizations(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleListOrganizations' });

  try {
    // Get authenticated user
    const { userId } = getAuthUser(request);

    // Get user's organizations
    const organizations = await orgService.getUserOrganizations(userId);

    log.info({ userId, count: organizations.length }, 'Listed organizations');

    return reply.code(200).send({
      organizations: organizations.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        email: org.email,
        role: org.role,
        member_since: org.memberSince,
        created_at: org.createdAt,
      })),
    });
  } catch (error) {
    log.error({ error }, 'Failed to list organizations');

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to list organizations',
    });
  }
}

/**
 * GET /api/organizations/:id
 * Get organization details (member+ only)
 */
async function handleGetOrganization(
  request: FastifyRequest<OrganizationIdRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetOrganization' });

  try {
    // Validate params
    const params = OrganizationIdParamSchema.parse(request.params);

    // Get organization context (middleware validates membership)
    const { id, role } = getOrganizationContext(request);

    // Get organization details
    const organization = await orgService.getOrganizationById(id);

    if (!organization) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Organization not found',
      });
    }

    // Get member count
    const memberCount = await orgService.getMemberCount(id);

    log.info({ organizationId: id }, 'Organization retrieved');

    return reply.code(200).send({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      email: organization.email,
      settings: organization.settings,
      member_count: memberCount,
      your_role: role,
      created_at: organization.createdAt,
      updated_at: organization.updatedAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get organization');

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to get organization',
    });
  }
}

/**
 * PATCH /api/organizations/:id
 * Update organization details (admin+ only)
 */
async function handleUpdateOrganization(
  request: FastifyRequest<UpdateOrganizationRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateOrganization' });

  try {
    // Validate params and body
    const params = OrganizationIdParamSchema.parse(request.params);
    const body = UpdateOrganizationBodySchema.parse(request.body);

    // Get organization context (middleware validates admin+ permission)
    const { id } = getOrganizationContext(request);

    // Update organization
    const organization = await orgService.updateOrganization(id, body);

    log.info({ organizationId: id }, 'Organization updated');

    return reply.code(200).send({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      email: organization.email,
      settings: organization.settings,
      updated_at: organization.updatedAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to update organization');

    if (error instanceof Error && error.message === 'Organization slug already exists') {
      return reply.code(409).send({
        error: 'Slug already exists',
        message: 'An organization with this slug already exists',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to update organization',
    });
  }
}

/**
 * DELETE /api/organizations/:id
 * Delete organization (owner only)
 */
async function handleDeleteOrganization(
  request: FastifyRequest<OrganizationIdRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDeleteOrganization' });

  try {
    // Validate params
    const params = OrganizationIdParamSchema.parse(request.params);

    // Get organization context (middleware validates owner permission)
    const { id } = getOrganizationContext(request);

    // Delete organization
    await orgService.deleteOrganization(id);

    log.info({ organizationId: id }, 'Organization deleted');

    return reply.code(200).send({
      message: 'Organization deleted successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to delete organization');

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to delete organization',
    });
  }
}

/**
 * GET /api/organizations/:id/members
 * List organization members (member+ only)
 */
async function handleListMembers(
  request: FastifyRequest<OrganizationIdRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleListMembers' });

  try {
    // Validate params
    const params = OrganizationIdParamSchema.parse(request.params);

    // Get organization context (middleware validates membership)
    const { id } = getOrganizationContext(request);

    // Get members
    const members = await orgService.getOrganizationMembers(id);

    log.info({ organizationId: id, count: members.length }, 'Listed members');

    return reply.code(200).send({
      members: members.map((member) => ({
        id: member.id,
        user_id: member.userId,
        email: member.user.email,
        name: member.user.name,
        role: member.role,
        joined_at: member.createdAt,
      })),
    });
  } catch (error) {
    log.error({ error }, 'Failed to list members');

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to list members',
    });
  }
}

/**
 * POST /api/organizations/:id/members
 * Add member to organization (admin+ only)
 */
async function handleAddMember(
  request: FastifyRequest<AddMemberRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleAddMember' });

  try {
    // Validate params and body
    const params = OrganizationIdParamSchema.parse(request.params);
    const body = AddMemberBodySchema.parse(request.body);

    // Get organization context (middleware validates admin+ permission)
    const { id } = getOrganizationContext(request);

    // Find user by email
    const { getUserByEmail } = await import('../auth/service.js');
    const user = await getUserByEmail(body.email);

    if (!user) {
      return reply.code(404).send({
        error: 'User not found',
        message: 'No user found with this email address',
      });
    }

    // Add member
    const member = await orgService.addOrganizationMember({
      organizationId: id,
      userId: user.id,
      role: body.role,
    });

    log.info({ organizationId: id, userId: user.id, role: body.role }, 'Member added');

    return reply.code(201).send({
      id: member.id,
      user_id: member.userId,
      email: user.email,
      name: user.name,
      role: member.role,
      joined_at: member.createdAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to add member');

    if (error instanceof Error && error.message === 'User is already a member of this organization') {
      return reply.code(409).send({
        error: 'Already a member',
        message: 'This user is already a member of the organization',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to add member',
    });
  }
}

/**
 * PATCH /api/organizations/:id/members/:userId
 * Update member role (admin+ only)
 */
async function handleUpdateMemberRole(
  request: FastifyRequest<UpdateMemberRoleRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateMemberRole' });

  try {
    // Validate params and body
    const params = MemberParamsSchema.parse(request.params);
    const body = UpdateMemberRoleBodySchema.parse(request.body);

    // Get organization context (middleware validates admin+ permission)
    const { id } = getOrganizationContext(request);

    // Update member role
    const member = await orgService.updateMemberRole(id, params.userId, body.role);

    log.info({ organizationId: id, userId: params.userId, newRole: body.role }, 'Member role updated');

    return reply.code(200).send({
      id: member.id,
      user_id: member.userId,
      role: member.role,
      updated_at: member.updatedAt,
    });
  } catch (error) {
    log.error({ error }, 'Failed to update member role');

    if (error instanceof Error && error.message.includes('last owner')) {
      return reply.code(400).send({
        error: 'Cannot demote last owner',
        message: error.message,
      });
    }

    if (error instanceof Error && error.message === 'Member not found') {
      return reply.code(404).send({
        error: 'Member not found',
        message: 'This user is not a member of the organization',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to update member role',
    });
  }
}

/**
 * DELETE /api/organizations/:id/members/:userId
 * Remove member from organization (admin+ only)
 */
async function handleRemoveMember(
  request: FastifyRequest<MemberParamsRoute>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleRemoveMember' });

  try {
    // Validate params
    const params = MemberParamsSchema.parse(request.params);

    // Get organization context (middleware validates admin+ permission)
    const { id } = getOrganizationContext(request);

    // Remove member
    await orgService.removeMember(id, params.userId);

    log.info({ organizationId: id, userId: params.userId }, 'Member removed');

    return reply.code(200).send({
      message: 'Member removed successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to remove member');

    if (error instanceof Error && error.message.includes('last owner')) {
      return reply.code(400).send({
        error: 'Cannot remove last owner',
        message: error.message,
      });
    }

    if (error instanceof Error && error.message === 'Member not found') {
      return reply.code(404).send({
        error: 'Member not found',
        message: 'This user is not a member of the organization',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to remove member',
    });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

/**
 * Register all organization routes
 */
export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  // Organization CRUD
  app.post<CreateOrganizationRoute>('/api/organizations', { preHandler: requireAuth }, handleCreateOrganization);

  app.get('/api/organizations', { preHandler: requireAuth }, handleListOrganizations);

  app.get<OrganizationIdRoute>(
    '/api/organizations/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetOrganization
  );

  app.patch<UpdateOrganizationRoute>(
    '/api/organizations/:id',
    { preHandler: [requireAuth, requireOrganizationContext, requirePermission('admin')] },
    handleUpdateOrganization
  );

  app.delete<OrganizationIdRoute>(
    '/api/organizations/:id',
    { preHandler: [requireAuth, requireOrganizationContext, requirePermission('owner')] },
    handleDeleteOrganization
  );

  // Team Management
  app.get<OrganizationIdRoute>(
    '/api/organizations/:id/members',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleListMembers
  );

  app.post<AddMemberRoute>(
    '/api/organizations/:id/members',
    { preHandler: [requireAuth, requireOrganizationContext, requirePermission('admin')] },
    handleAddMember
  );

  app.patch<UpdateMemberRoleRoute>(
    '/api/organizations/:id/members/:userId',
    { preHandler: [requireAuth, requireOrganizationContext, requirePermission('admin')] },
    handleUpdateMemberRole
  );

  app.delete<MemberParamsRoute>(
    '/api/organizations/:id/members/:userId',
    { preHandler: [requireAuth, requireOrganizationContext, requirePermission('admin')] },
    handleRemoveMember
  );

  logger.info('Registered organization routes');
}
