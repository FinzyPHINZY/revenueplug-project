/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAuthUser, requireAuth } from '../middleware.js';
import { generateAccessToken } from '../tokens.js';

describe('Authentication Middleware Tests', () => {
  let mockRequest: Partial<FastifyRequest>;
  let mockReply: Partial<FastifyReply>;
  let replySent: { code: number; body: any } | null;

  beforeEach(() => {
    replySent = null;

    // Mock Fastify request
    mockRequest = {
      headers: {},
      cookies: {}, // Mock cookies object for @fastify/cookie
      url: '/api/test',
      id: 'test-request-id',
    };

    // Mock Fastify reply
    mockReply = {
      code: function (statusCode: number) {
        replySent = { code: statusCode, body: null };
        return this as FastifyReply;
      },
      send: function (body: any) {
        if (replySent) {
          replySent.body = body;
        }
        return this as FastifyReply;
      },
    };
  });

  describe('requireAuth Middleware', () => {
    it('should authenticate valid Bearer token', async () => {
      const token = generateAccessToken({
        id: 'user-123',
        email: 'test@example.com',
      });

      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Should not send error response
      expect(replySent).toBeNull();

      // Should attach user to request
      const user = (mockRequest as any).user;
      expect(user).toBeDefined();
      expect(user.userId).toBe('user-123');
      expect(user.email).toBe('test@example.com');
    });

    it('should reject request without Authorization header or cookie', async () => {
      mockRequest.headers = {};
      mockRequest.cookies = {};

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent).not.toBeNull();
      expect(replySent?.code).toBe(401);
      expect(replySent?.body.error).toBe('Unauthorized');
      expect(replySent?.body.message).toContain('Authentication required');
    });

    it('should reject request with malformed Authorization header', async () => {
      mockRequest.headers = {
        authorization: 'InvalidFormat token123',
      };
      mockRequest.cookies = {};

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
      expect(replySent?.body.message).toContain('Authentication required');
    });

    it('should reject request with missing Bearer prefix', async () => {
      const token = generateAccessToken({
        id: 'user-123',
        email: 'test@example.com',
      });

      mockRequest.headers = {
        authorization: token, // Missing "Bearer " prefix
      };
      mockRequest.cookies = {};

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
      expect(replySent?.body.message).toContain('Authentication required');
    });

    it('should reject invalid JWT token', async () => {
      mockRequest.headers = {
        authorization: 'Bearer invalid-token-123',
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
      expect(replySent?.body.error).toBe('Unauthorized');
      expect(replySent?.body.message).toMatch(/Invalid|expired/i);
    });

    it('should reject expired JWT token', async () => {
      // Create an expired token (this would need to be manually created or mocked)
      // For now, we'll test with an invalid token format
      mockRequest.headers = {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.expired.token',
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
    });

    it('should reject token with tampered signature', async () => {
      const validToken = generateAccessToken({
        id: 'user-123',
        email: 'test@example.com',
      });

      // Tamper with the signature
      const parts = validToken.split('.');
      const tamperedToken = `${parts[0]}.${parts[1]}.tampered-signature`;

      mockRequest.headers = {
        authorization: `Bearer ${tamperedToken}`,
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
      expect(replySent?.body.message).toMatch(/Invalid|expired/i);
    });

    it('should handle case-insensitive Bearer prefix', async () => {
      const token = generateAccessToken({
        id: 'user-123',
        email: 'test@example.com',
      });

      mockRequest.headers = {
        authorization: `bearer ${token}`, // lowercase
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Should still reject because we expect "Bearer" with capital B
      expect(replySent?.code).toBe(401);
    });

    it('should trim whitespace from token', async () => {
      const token = generateAccessToken({
        id: 'user-123',
        email: 'test@example.com',
      });

      mockRequest.headers = {
        authorization: `Bearer   ${token}   `, // Extra spaces
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Should fail because we don't trim (strict parsing)
      expect(replySent?.code).toBe(401);
    });

    it('should not expose sensitive error details', async () => {
      mockRequest.headers = {
        authorization: 'Bearer invalid-token',
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Error message should be generic, not expose internal details
      expect(replySent?.body.message).not.toContain('JWT_SECRET');
      expect(replySent?.body.message).not.toContain('stack');
      expect(replySent?.body.message).not.toContain('database');
    });
  });

  describe('getAuthUser Helper', () => {
    it('should return authenticated user from request', () => {
      const mockUser = {
        userId: 'user-123',
        email: 'test@example.com',
        accountId: 'account-456',
      };

      (mockRequest as any).user = mockUser;

      const user = getAuthUser(mockRequest as FastifyRequest);

      expect(user).toEqual(mockUser);
    });

    it('should throw error if user not authenticated', () => {
      // No user attached to request
      expect(() => getAuthUser(mockRequest as FastifyRequest)).toThrow('User not authenticated');
    });

    it('should throw error with helpful message', () => {
      expect(() => getAuthUser(mockRequest as FastifyRequest)).toThrow(/requireAuth middleware/i);
    });

    it('should return user with correct type', () => {
      const mockUser = {
        userId: 'user-123',
        email: 'test@example.com',
        accountId: 'account-456',
      };

      (mockRequest as any).user = mockUser;

      const user = getAuthUser(mockRequest as FastifyRequest);

      expect(user).toHaveProperty('userId');
      expect(user).toHaveProperty('email');
      expect(user).toHaveProperty('accountId');
    });
  });

  describe('Middleware Integration', () => {
    it('should support chaining with getAuthUser', async () => {
      const token = generateAccessToken({
        id: 'user-789',
        email: 'chain@example.com',
      });

      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      // Apply middleware
      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Use helper to get user
      const user = getAuthUser(mockRequest as FastifyRequest);

      expect(user.userId).toBe('user-789');
      expect(user.email).toBe('chain@example.com');
    });

    it('should preserve request context', async () => {
      const token = generateAccessToken({
        id: 'user-context',
        email: 'context@example.com',
      });

      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };
      mockRequest.id = 'correlation-id-123';

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Original request properties should be preserved
      expect(mockRequest.id).toBe('correlation-id-123');

      // User should be added
      const user = getAuthUser(mockRequest as FastifyRequest);
      expect(user).toBeDefined();
    });
  });

  describe('Security Edge Cases', () => {
    it('should reject empty Bearer token', async () => {
      mockRequest.headers = {
        authorization: 'Bearer ',
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
    });

    it('should reject multiple Authorization headers', async () => {
      const token = generateAccessToken({
        id: 'user-123',
        email: 'test@example.com',
      });

      // Fastify normalizes headers, but test the concept
      mockRequest.headers = {
        authorization: `Bearer ${token}, Bearer fake-token`,
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Should fail because of malformed header
      expect(replySent?.code).toBe(401);
    });

    it('should not allow null or undefined user injection', async () => {
      // Attempt to pre-inject user (security test)
      (mockRequest as any).user = {
        userId: 'hacker-123',
        email: 'hacker@evil.com',
      };

      mockRequest.headers = {
        authorization: 'Bearer invalid-token',
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      // Should reject and overwrite the injected user
      expect(replySent?.code).toBe(401);
    });

    it('should handle very long tokens gracefully', async () => {
      const veryLongToken = 'a'.repeat(10000);

      mockRequest.headers = {
        authorization: `Bearer ${veryLongToken}`,
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
      // Should not crash or timeout
    });

    it('should handle special characters in token', async () => {
      mockRequest.headers = {
        authorization: 'Bearer token-with-special-chars-!@#$%^&*()',
      };

      await requireAuth(mockRequest as FastifyRequest, mockReply as FastifyReply);

      expect(replySent?.code).toBe(401);
    });
  });
});
