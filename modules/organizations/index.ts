/**
 * Organizations Module
 *
 * Handles organization (multi-tenancy) and team management.
 *
 * Features:
 * - Organization CRUD operations
 * - Team member management
 * - Role-based access control (RBAC)
 * - Organization context for data isolation
 *
 * Roles:
 * - OWNER: Full access, can delete org, manage all settings
 * - ADMIN: Can manage members, connections, settings
 * - MEMBER: Can view and use connections, trigger syncs
 * - VIEWER: Read-only access to analytics and data
 */

export * from './service.js';
export * from './routes.js';
