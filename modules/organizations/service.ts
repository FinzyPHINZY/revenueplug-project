import type { Organization, OrganizationMember, OrganizationRole, User } from '@prisma/client';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateOrganizationParams {
  name: string;
  slug: string;
  email?: string;
  creatorUserId: string;
}

export interface UpdateOrganizationParams {
  name?: string;
  slug?: string;
  email?: string;
  settings?: Record<string, any>;
}

export interface AddMemberParams {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

// ============================================================================
// ORGANIZATION MANAGEMENT
// ============================================================================

/**
 * Create organization and add creator as owner
 * Uses transaction to ensure atomic creation
 *
 * @param params - Organization creation parameters
 * @returns Created organization with membership
 */
export async function createOrganization(params: CreateOrganizationParams): Promise<Organization> {
  const log = logger.child({ operation: 'createOrganization', slug: params.slug });

  try {
    log.info('Creating organization');

    // Check if slug already exists
    const existing = await prisma.organization.findUnique({
      where: { slug: params.slug }
    });

    if (existing) {
      throw new Error('Organization slug already exists');
    }

    // Create organization and add creator as owner in transaction
    const organization = await prisma.$transaction(async (tx) => {
      // Create organization
      const org = await tx.organization.create({
        data: {
          name: params.name,
          slug: params.slug,
          email: params.email || null
        }
      });

      // Add creator as owner
      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: params.creatorUserId,
          role: 'OWNER'
        }
      });

      return org;
    });

    log.info({ organizationId: organization.id }, 'Organization created successfully');
    return organization;
  } catch (error) {
    log.error({ error, params }, 'Failed to create organization');
    throw error;
  }
}

/**
 * Get organization by ID
 *
 * @param organizationId - Organization ID
 * @returns Organization or null if not found
 */
export async function getOrganizationById(organizationId: string): Promise<Organization | null> {
  return await prisma.organization.findUnique({
    where: { id: organizationId }
  });
}

/**
 * Get organization by slug
 *
 * @param slug - Organization slug
 * @returns Organization or null if not found
 */
export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  return await prisma.organization.findUnique({
    where: { slug }
  });
}

/**
 * Get user's organizations with role information
 *
 * @param userId - User ID
 * @returns Array of organizations with membership details
 */
export async function getUserOrganizations(userId: string): Promise<
  Array<Organization & { role: OrganizationRole; memberSince: Date }>
> {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: { createdAt: 'asc' }
  });

  return memberships.map((m) => ({
    ...m.organization,
    role: m.role,
    memberSince: m.createdAt
  }));
}

/**
 * Update organization details
 * Only updates fields that are provided
 *
 * @param organizationId - Organization ID
 * @param updates - Fields to update
 * @returns Updated organization
 */
export async function updateOrganization(
  organizationId: string,
  updates: UpdateOrganizationParams
): Promise<Organization> {
  const log = logger.child({ operation: 'updateOrganization', organizationId });

  try {
    log.info({ updates }, 'Updating organization');

    // If slug is changing, check if new slug already exists
    if (updates.slug) {
      const existing = await prisma.organization.findFirst({
        where: {
          slug: updates.slug,
          id: { not: organizationId }
        }
      });

      if (existing) {
        throw new Error('Organization slug already exists');
      }
    }

    const organization = await prisma.organization.update({
      where: { id: organizationId },
      data: {
        name: updates.name !== undefined ? updates.name : undefined,
        slug: updates.slug !== undefined ? updates.slug : undefined,
        email: updates.email !== undefined ? updates.email : undefined,
        settings: updates.settings !== undefined ? updates.settings : undefined
      }
    });

    log.info('Organization updated successfully');
    return organization;
  } catch (error) {
    log.error({ error, updates }, 'Failed to update organization');
    throw error;
  }
}

/**
 * Delete organization and all associated data
 * Cascade deletes handle connections, members, etc.
 *
 * @param organizationId - Organization ID
 */
export async function deleteOrganization(organizationId: string): Promise<void> {
  const log = logger.child({ operation: 'deleteOrganization', organizationId });

  try {
    log.info('Deleting organization');

    await prisma.organization.delete({
      where: { id: organizationId }
    });

    log.info('Organization deleted successfully');
  } catch (error) {
    log.error({ error }, 'Failed to delete organization');
    throw error;
  }
}

// ============================================================================
// TEAM MEMBER MANAGEMENT
// ============================================================================

/**
 * Get organization members with user details
 *
 * @param organizationId - Organization ID
 * @returns Array of members with user information
 */
export async function getOrganizationMembers(organizationId: string): Promise<
  Array<
    OrganizationMember & {
      user: Pick<User, 'id' | 'email' | 'name'>;
    }
  >
> {
  return await prisma.organizationMember.findMany({
    where: { organizationId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });
}

/**
 * Get member by user ID and organization ID
 *
 * @param organizationId - Organization ID
 * @param userId - User ID
 * @returns Member or null if not found
 */
export async function getMember(
  organizationId: string,
  userId: string
): Promise<OrganizationMember | null> {
  return await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId }
    }
  });
}

/**
 * Add member to organization
 * User must already exist in the system
 *
 * @param params - Member addition parameters
 * @returns Created membership
 */
export async function addOrganizationMember(params: AddMemberParams): Promise<OrganizationMember> {
  const log = logger.child({
    operation: 'addOrganizationMember',
    organizationId: params.organizationId,
    userId: params.userId
  });

  try {
    log.info({ role: params.role }, 'Adding organization member');

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: params.userId }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Check if already a member
    const existing = await getMember(params.organizationId, params.userId);
    if (existing) {
      throw new Error('User is already a member of this organization');
    }

    const member = await prisma.organizationMember.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId,
        role: params.role
      }
    });

    log.info({ memberId: member.id }, 'Member added successfully');
    return member;
  } catch (error) {
    log.error({ error, params }, 'Failed to add member');
    throw error;
  }
}

/**
 * Update member role
 * Cannot demote the last owner
 *
 * @param organizationId - Organization ID
 * @param userId - User ID
 * @param newRole - New role to assign
 * @returns Updated membership
 */
export async function updateMemberRole(
  organizationId: string,
  userId: string,
  newRole: OrganizationRole
): Promise<OrganizationMember> {
  const log = logger.child({ operation: 'updateMemberRole', organizationId, userId });

  try {
    log.info({ newRole }, 'Updating member role');

    // Check if member exists
    const member = await getMember(organizationId, userId);
    if (!member) {
      throw new Error('Member not found');
    }

    // If demoting an owner, ensure at least one owner remains
    if (member.role === 'OWNER' && newRole !== 'OWNER') {
      const ownerCount = await prisma.organizationMember.count({
        where: {
          organizationId,
          role: 'OWNER'
        }
      });

      if (ownerCount <= 1) {
        throw new Error('Cannot demote the last owner. Promote another member first.');
      }
    }

    const updated = await prisma.organizationMember.update({
      where: {
        organizationId_userId: { organizationId, userId }
      },
      data: { role: newRole }
    });

    log.info('Member role updated successfully');
    return updated;
  } catch (error) {
    log.error({ error, newRole }, 'Failed to update member role');
    throw error;
  }
}

/**
 * Remove member from organization
 * Cannot remove the last owner
 *
 * @param organizationId - Organization ID
 * @param userId - User ID
 */
export async function removeMember(organizationId: string, userId: string): Promise<void> {
  const log = logger.child({ operation: 'removeMember', organizationId, userId });

  try {
    log.info('Removing member');

    // Check if member exists and get their role
    const member = await getMember(organizationId, userId);
    if (!member) {
      throw new Error('Member not found');
    }

    // If removing an owner, ensure at least one owner remains
    if (member.role === 'OWNER') {
      const ownerCount = await prisma.organizationMember.count({
        where: {
          organizationId,
          role: 'OWNER'
        }
      });

      if (ownerCount <= 1) {
        throw new Error('Cannot remove the last owner. Transfer ownership first.');
      }
    }

    await prisma.organizationMember.delete({
      where: {
        organizationId_userId: { organizationId, userId }
      }
    });

    log.info('Member removed successfully');
  } catch (error) {
    log.error({ error }, 'Failed to remove member');
    throw error;
  }
}

/**
 * Check if user is member of organization
 *
 * @param organizationId - Organization ID
 * @param userId - User ID
 * @returns true if user is a member
 */
export async function isMember(organizationId: string, userId: string): Promise<boolean> {
  const member = await getMember(organizationId, userId);
  return member !== null;
}

/**
 * Get member count for organization
 *
 * @param organizationId - Organization ID
 * @returns Number of members
 */
export async function getMemberCount(organizationId: string): Promise<number> {
  return await prisma.organizationMember.count({
    where: { organizationId }
  });
}
