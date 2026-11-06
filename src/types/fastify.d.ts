import type { OrganizationRole } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      email: string;
    };
    organization?: {
      id: string;
      role: OrganizationRole;
      slug: string;
      name: string;
    };
  }
}
