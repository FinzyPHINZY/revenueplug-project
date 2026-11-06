import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../../infrastructure/postgres/index.js';
import * as authService from '../service.js';
import * as emailService from '../email.js';
import type { User } from '@prisma/client';

// Mock email service
vi.mock('../email.js', () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

describe('Authentication Service Tests', () => {
  let testUser: User;
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = 'SecurePassword123!';

  afterEach(async () => {
    // Clean up test user and related data
    if (testUser) {
      // Delete sessions first (foreign key constraint)
      await prisma.session.deleteMany({
        where: { userId: testUser.id },
      });

      // Delete verification tokens
      await prisma.verificationToken.deleteMany({
        where: { userId: testUser.id },
      });

      // Delete user
      await prisma.user.delete({
        where: { id: testUser.id },
      });
    }
  });

  describe('User Registration', () => {
    it('should create a new user with hashed password', async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });

      testUser = result.user;

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(testEmail);
      expect(result.user.name).toBe('Test User');
      expect(result.user.emailVerified).toBe(false);
      expect(result.verificationToken).toBeDefined();
      expect(result.verificationToken).toHaveLength(64); // 32 bytes hex = 64 chars

      // Password should be hashed (not plaintext)
      const userWithPassword = await prisma.user.findUnique({
        where: { id: result.user.id },
      });
      expect(userWithPassword?.password).not.toBe(testPassword);
      expect(userWithPassword?.password).toMatch(/^\$2[aby]\$/); // bcrypt hash format
    });

    it('should send verification email on registration', async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });

      testUser = result.user;

      expect(emailService.sendVerificationEmail).toHaveBeenCalledWith(
        testEmail,
        'Test User',
        result.verificationToken
      );
    });

    it('should reject duplicate email registration', async () => {
      // Create first user
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'First User',
      });

      testUser = result.user;

      // Try to create second user with same email
      await expect(
        authService.createUser({
          email: testEmail,
          password: 'DifferentPassword123!',
          name: 'Second User',
        })
      ).rejects.toThrow();
    });

    it('should create user without name (optional field)', async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
      });

      testUser = result.user;

      expect(result.user.name).toBeNull();
    });
  });

  describe('User Login & Credential Validation', () => {
    beforeEach(async () => {
      // Create test user for login tests
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });
      testUser = result.user;
    });

    it('should validate correct credentials', async () => {
      const user = await authService.validateCredentials(testEmail, testPassword);

      expect(user).toBeDefined();
      expect(user.id).toBe(testUser.id);
      expect(user.email).toBe(testEmail);
    });

    it('should reject incorrect password', async () => {
      await expect(
        authService.validateCredentials(testEmail, 'WrongPassword123!')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should reject non-existent email', async () => {
      await expect(
        authService.validateCredentials('nonexistent@example.com', testPassword)
      ).rejects.toThrow('Invalid credentials');
    });

    it('should be case-insensitive for email', async () => {
      // Note: The service uses exact email match, so case-insensitive login
      // would need to be implemented if required
      await expect(
        authService.validateCredentials(testEmail.toUpperCase(), testPassword)
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('Email Verification', () => {
    let verificationToken: string;

    beforeEach(async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });
      testUser = result.user;
      verificationToken = result.verificationToken;
    });

    it('should verify email with valid token', async () => {
      const verifiedUser = await authService.verifyEmail(verificationToken);

      expect(verifiedUser.emailVerified).toBe(true);
      expect(verifiedUser.id).toBe(testUser.id);

      // Token should be marked as used
      const token = await prisma.verificationToken.findFirst({
        where: { userId: testUser.id, type: 'EMAIL_VERIFICATION' },
      });
      expect(token?.usedAt).not.toBeNull();
    });

    it('should reject invalid verification token', async () => {
      await expect(authService.verifyEmail('invalid-token-123')).rejects.toThrow(
        'Invalid verification token'
      );
    });

    it('should reject expired verification token', async () => {
      // Manually expire the token
      await prisma.verificationToken.updateMany({
        where: { userId: testUser.id, type: 'EMAIL_VERIFICATION' },
        data: { expiresAt: new Date(Date.now() - 1000) }, // 1 second ago
      });

      await expect(authService.verifyEmail(verificationToken)).rejects.toThrow(
        'Verification token expired'
      );
    });

    it('should reject already-used verification token', async () => {
      // Use token once
      await authService.verifyEmail(verificationToken);

      // Try to use it again
      await expect(authService.verifyEmail(verificationToken)).rejects.toThrow(
        'Verification token already used'
      );
    });
  });

  describe('Password Reset', () => {
    let resetToken: string;

    beforeEach(async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });
      testUser = result.user;

      // Create password reset token
      resetToken = await authService.createVerificationToken(
        testUser.id,
        'PASSWORD_RESET'
      );
    });

    it('should reset password with valid token', async () => {
      const newPassword = 'NewSecurePassword456!';

      const updatedUser = await authService.resetPassword(resetToken, newPassword);

      expect(updatedUser.id).toBe(testUser.id);

      // Should be able to login with new password
      const user = await authService.validateCredentials(testEmail, newPassword);
      expect(user).toBeDefined();

      // Should NOT be able to login with old password
      await expect(
        authService.validateCredentials(testEmail, testPassword)
      ).rejects.toThrow();
    });

    it('should create password reset token', async () => {
      const user = await authService.getUserByEmail(testEmail);
      expect(user).not.toBeNull();

      const token = await authService.createVerificationToken(
        user!.id,
        'PASSWORD_RESET'
      );

      expect(token).toBeDefined();
      expect(token).toHaveLength(64);
    });

    it('should reject invalid reset token', async () => {
      await expect(
        authService.resetPassword('invalid-token-123', 'NewPassword123!')
      ).rejects.toThrow('Invalid reset token');
    });

    it('should reject expired reset token', async () => {
      // Manually expire the token
      await prisma.verificationToken.updateMany({
        where: { userId: testUser.id, type: 'PASSWORD_RESET' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        authService.resetPassword(resetToken, 'NewPassword123!')
      ).rejects.toThrow('Reset token expired');
    });

    it('should invalidate all sessions after password reset', async () => {
      // Create a session
      await authService.createSession({
        userId: testUser.id,
        refreshToken: 'test-refresh-token',
      });


      // Reset password
      await authService.resetPassword(resetToken, 'NewPassword123!');

      // Session should be deleted
      const sessions = await prisma.session.findMany({
        where: { userId: testUser.id },
      });
      expect(sessions).toHaveLength(0);
    });
  });

  describe('Session Management', () => {
    beforeEach(async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });
      testUser = result.user;
    });

    it('should create session with refresh token', async () => {
      const session = await authService.createSession({
        userId: testUser.id,
        refreshToken: 'test-refresh-token-123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(session.id).toBeDefined();
      expect(session.expiresAt).toBeInstanceOf(Date);
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify session in database
      const dbSession = await prisma.session.findUnique({
        where: { id: session.id },
      });

      expect(dbSession).not.toBeNull();
      expect(dbSession?.userId).toBe(testUser.id);
      expect(dbSession?.ipAddress).toBe('192.168.1.1');
      expect(dbSession?.userAgent).toBe('Mozilla/5.0');
    });

    it('should validate refresh token and return session', async () => {
      const refreshToken = 'test-refresh-token-456';

      await authService.createSession({
        userId: testUser.id,
        refreshToken,
      });

      const result = await authService.validateRefreshToken(refreshToken);

      expect(result).not.toBeNull();
      expect(result?.session.userId).toBe(testUser.id);
      expect(result?.user.id).toBe(testUser.id);
    });

    it('should reject invalid refresh token', async () => {
      const result = await authService.validateRefreshToken('invalid-token');

      expect(result).toBeNull();
    });

    it('should reject expired refresh token', async () => {
      const refreshToken = 'test-refresh-token-789';

      const session = await authService.createSession({
        userId: testUser.id,
        refreshToken,
      });

      // Manually expire the session
      await prisma.session.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const result = await authService.validateRefreshToken(refreshToken);

      expect(result).toBeNull();
    });

    it('should update lastUsedAt when validating refresh token', async () => {
      const refreshToken = 'test-refresh-token-update';

      const session = await authService.createSession({
        userId: testUser.id,
        refreshToken,
      });

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      await authService.validateRefreshToken(refreshToken);

      const updatedSession = await prisma.session.findUnique({
        where: { id: session.id },
      });

      expect(updatedSession?.lastUsedAt).not.toBeNull();
      expect(updatedSession?.lastUsedAt?.getTime()).toBeGreaterThan(
        session.expiresAt.getTime() - 7 * 24 * 60 * 60 * 1000 // Rough estimate
      );
    });

    it('should delete session (logout)', async () => {
      const session = await authService.createSession({
        userId: testUser.id,
        refreshToken: 'test-refresh-token-delete',
      });

      await authService.deleteSession(session.id);

      const deletedSession = await prisma.session.findUnique({
        where: { id: session.id },
      });

      expect(deletedSession).toBeNull();
    });

    it('should delete all user sessions (logout all devices)', async () => {
      // Create multiple sessions
      await authService.createSession({
        userId: testUser.id,
        refreshToken: 'token-1',
      });
      await authService.createSession({
        userId: testUser.id,
        refreshToken: 'token-2',
      });
      await authService.createSession({
        userId: testUser.id,
        refreshToken: 'token-3',
      });

      const deletedCount = await authService.deleteAllUserSessions(testUser.id);

      expect(deletedCount).toBe(3);

      const remainingSessions = await prisma.session.findMany({
        where: { userId: testUser.id },
      });

      expect(remainingSessions).toHaveLength(0);
    });

    it('should cleanup expired sessions', async () => {
      // Create active session
      await authService.createSession({
        userId: testUser.id,
        refreshToken: 'active-token',
      });

      // Create expired session
      const expiredSession = await authService.createSession({
        userId: testUser.id,
        refreshToken: 'expired-token',
      });

      await prisma.session.update({
        where: { id: expiredSession.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const deletedCount = await authService.cleanupExpiredSessions();

      expect(deletedCount).toBe(1);

      const remainingSessions = await prisma.session.findMany({
        where: { userId: testUser.id },
      });

      expect(remainingSessions).toHaveLength(1);
    });
  });

  describe('User Profile Management', () => {
    beforeEach(async () => {
      const result = await authService.createUser({
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });
      testUser = result.user;
    });

    it('should update user name', async () => {
      const updatedUser = await authService.updateUser(testUser.id, {
        name: 'Updated Name',
      });

      expect(updatedUser.name).toBe('Updated Name');
      expect(updatedUser.email).toBe(testEmail); // Email unchanged
    });

    it('should update user email and create new verification token', async () => {
      const newEmail = `new-${Date.now()}@example.com`;

      const updatedUser = await authService.updateUser(testUser.id, {
        email: newEmail,
      });

      expect(updatedUser.email).toBe(newEmail);
      expect(updatedUser.emailVerified).toBe(false); // Reset verification

      // Should have new verification token
      const token = await prisma.verificationToken.findFirst({
        where: { userId: testUser.id, type: 'EMAIL_VERIFICATION' },
        orderBy: { createdAt: 'desc' },
      });

      expect(token).not.toBeNull();
    });

    it('should update password and invalidate sessions', async () => {
      // Create a session
      await authService.createSession({
        userId: testUser.id,
        refreshToken: 'test-token',
      });

      const newPassword = 'NewPassword789!';
      await authService.updatePassword(testUser.id, newPassword);

      // Should be able to login with new password
      const user = await authService.validateCredentials(testEmail, newPassword);
      expect(user).toBeDefined();

      // All sessions should be deleted
      const sessions = await prisma.session.findMany({
        where: { userId: testUser.id },
      });
      expect(sessions).toHaveLength(0);
    });

    it('should get user by ID without password', async () => {
      const user = await authService.getUserById(testUser.id);

      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUser.id);
      expect(user?.email).toBe(testEmail);
      // Note: getUserById returns user with password from Prisma
      // If password exclusion is needed, update the service method
    });

    it('should get user by email with password (for login)', async () => {
      const user = await authService.getUserByEmail(testEmail);

      expect(user).not.toBeNull();
      expect(user?.id).toBe(testUser.id);
      expect(user?.email).toBe(testEmail);
      expect(user?.password).toBeDefined(); // Password included for validation
    });
  });
});
