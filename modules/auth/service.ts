import { randomBytes } from 'node:crypto';
import type { User, VerificationTokenType } from '@prisma/client';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { sendVerificationEmail } from './email.js';
import { comparePassword, hashPassword } from './password.js';
import { hashRefreshToken } from './tokens.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateUserParams {
  email: string;
  password: string;
  name?: string;
}

export interface UpdateUserParams {
  name?: string;
  email?: string;
}

export interface CreateSessionParams {
  userId: string;
  refreshToken: string; // unhashed
  ipAddress?: string;
  userAgent?: string;
}

// ============================================================================
// USER MANAGEMENT
// ============================================================================

/**
 * Create new user with hashed password
 * Also creates associated Account (1:1 relationship)
 * Sends verification email
 *
 * @param params - User creation parameters
 * @returns Created user and verification token (unhashed)
 *
 * @throws Error if email already exists
 */
export async function createUser(params: CreateUserParams): Promise<{
  user: User;
  verificationToken: string;
}> {
  const log = logger.child({ operation: 'createUser', email: params.email });

  try {
    log.info('Creating new user');

    // Check if email already exists
    const existing = await prisma.user.findUnique({
      where: { email: params.email },
    });

    if (existing) {
      throw new Error('Email already registered');
    }

    // Hash password
    const hashedPassword = await hashPassword(params.password);

    // Create user
    const user = await prisma.user.create({
      data: {
        email: params.email,
        password: hashedPassword,
        name: params.name || null,
      },
    });

    // Generate verification token
    const token = await createVerificationToken(user.id, 'EMAIL_VERIFICATION');

    // Send verification email
    await sendVerificationEmail(user.email, user.name, token);

    log.info({ userId: user.id }, 'User created successfully');

    return { user, verificationToken: token };
  } catch (error) {
    log.error({ error, params }, 'Failed to create user');
    throw error;
  }
}

/**
 * Get user by ID (without password for security)
 *
 * @param userId - User ID
 * @returns User or null if not found
 */
export async function getUserById(userId: string): Promise<User | null> {
  return await prisma.user.findUnique({
    where: { id: userId },
  });
}

/**
 * Get user by email (includes password for login)
 *
 * @param email - User email
 * @returns User or null if not found
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  return await prisma.user.findUnique({
    where: { email },
  });
}

/**
 * Update user profile (name, email)
 * If email changes, creates new verification token
 *
 * @param userId - User ID
 * @param updates - Fields to update
 * @returns Updated user
 */
export async function updateUser(userId: string, updates: UpdateUserParams): Promise<User> {
  const log = logger.child({ operation: 'updateUser', userId });

  try {
    log.info({ updates }, 'Updating user');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new Error('User not found');
    }

    // If email is changing, create verification token
    let verificationToken: string | null = null;
    if (updates.email && updates.email !== user.email) {
      // Check if new email already exists
      const existing = await prisma.user.findUnique({
        where: { email: updates.email },
      });

      if (existing) {
        throw new Error('Email already in use');
      }

      // Create verification token
      verificationToken = await createVerificationToken(userId, 'EMAIL_VERIFICATION');
    }

    // Update user
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        name: updates.name !== undefined ? updates.name : undefined,
        email: updates.email !== undefined ? updates.email : undefined,
        // Reset email verification if email changed
        emailVerified: updates.email ? false : undefined,
        emailVerifiedAt: updates.email ? null : undefined,
      },
    });

    // Send verification email if email changed
    if (updates.email && verificationToken) {
      await sendVerificationEmail(updated.email, updated.name, verificationToken);
      log.info({ newEmail: updates.email }, 'Email changed, verification sent');
    }

    log.info('User updated successfully');
    return updated;
  } catch (error) {
    log.error({ error, updates }, 'Failed to update user');
    throw error;
  }
}

/**
 * Update user password
 * Invalidates all existing sessions for security
 *
 * @param userId - User ID
 * @param newPassword - New plaintext password
 */
export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  const log = logger.child({ operation: 'updatePassword', userId });

  try {
    log.info('Updating password');

    const hashedPassword = await hashPassword(newPassword);

    await prisma.$transaction(async (tx) => {
      // Update password
      await tx.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // Invalidate all sessions
      await tx.session.deleteMany({
        where: { userId },
      });
    });

    log.info('Password updated and sessions invalidated');
  } catch (error) {
    log.error({ error }, 'Failed to update password');
    throw error;
  }
}

/**
 * Validate user credentials (for login)
 *
 * @param email - User email
 * @param password - Plaintext password
 * @returns User if credentials are valid
 * @throws Error if credentials are invalid
 */
export async function validateCredentials(email: string, password: string): Promise<User> {
  const log = logger.child({ operation: 'validateCredentials', email });

  try {
    const user = await getUserByEmail(email);

    if (!user) {
      throw new Error('Invalid credentials');
    }

    const isValid = await comparePassword(password, user.password);

    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    log.info({ userId: user.id }, 'Credentials validated');
    return user;
  } catch (error) {
    log.warn({ error }, 'Credential validation failed');
    throw error;
  }
}

// ============================================================================
// EMAIL VERIFICATION
// ============================================================================

/**
 * Create email verification or password reset token
 * Returns unhashed token for sending in email
 *
 * @param userId - User ID
 * @param type - Token type (EMAIL_VERIFICATION or PASSWORD_RESET)
 * @returns Unhashed token (send this in email)
 */
export async function createVerificationToken(
  userId: string,
  type: VerificationTokenType
): Promise<string> {
  const log = logger.child({
    operation: 'createVerificationToken',
    userId,
    type,
  });

  try {
    // Generate cryptographically secure random token
    const token = randomBytes(32).toString('hex');

    // Hash token for database storage
    const hashedToken = hashRefreshToken(token); // Reuse SHA-256 hash function

    // Set expiry to 24 hours from now
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Store hashed token
    await prisma.verificationToken.create({
      data: {
        userId,
        token: hashedToken,
        type,
        expiresAt,
      },
    });

    log.info({ expiresAt }, 'Verification token created');

    // Return unhashed token to send in email
    return token;
  } catch (error) {
    log.error({ error }, 'Failed to create verification token');
    throw error;
  }
}

/**
 * Verify email using token
 * Marks token as used and updates user.emailVerified
 *
 * @param token - Verification token from email
 * @returns Verified user
 * @throws Error if token is invalid, expired, or already used
 */
export async function verifyEmail(token: string): Promise<User> {
  const log = logger.child({ operation: 'verifyEmail' });

  try {
    // Hash the token to lookup in database
    const hashedToken = hashRefreshToken(token);

    // Find verification token
    const verificationToken = await prisma.verificationToken.findUnique({
      where: { token: hashedToken },
      include: { user: true },
    });

    if (!verificationToken) {
      throw new Error('Invalid verification token');
    }

    // Check if already used
    if (verificationToken.usedAt) {
      throw new Error('Verification token already used');
    }

    // Check if expired
    if (new Date() > verificationToken.expiresAt) {
      throw new Error('Verification token expired');
    }

    // Check token type
    if (verificationToken.type !== 'EMAIL_VERIFICATION') {
      throw new Error('Invalid token type');
    }

    // Mark user as verified and token as used
    const updatedUser = await prisma.$transaction(async (tx) => {
      // Mark token as used
      await tx.verificationToken.update({
        where: { id: verificationToken.id },
        data: { usedAt: new Date() },
      });

      // Update user
      return await tx.user.update({
        where: { id: verificationToken.userId },
        data: {
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
    });

    log.info({ userId: updatedUser.id }, 'Email verified successfully');
    return updatedUser;
  } catch (error) {
    log.error({ error }, 'Email verification failed');
    throw error;
  }
}

/**
 * Verify password reset token and update password
 *
 * @param token - Password reset token from email
 * @param newPassword - New plaintext password
 * @returns Updated user
 * @throws Error if token is invalid, expired, or already used
 */
export async function resetPassword(token: string, newPassword: string): Promise<User> {
  const log = logger.child({ operation: 'resetPassword' });

  try {
    // Hash the token to lookup in database
    const hashedToken = hashRefreshToken(token);

    // Find verification token
    const verificationToken = await prisma.verificationToken.findUnique({
      where: { token: hashedToken },
      include: { user: true },
    });

    if (!verificationToken) {
      throw new Error('Invalid reset token');
    }

    // Check if already used
    if (verificationToken.usedAt) {
      throw new Error('Reset token already used');
    }

    // Check if expired
    if (new Date() > verificationToken.expiresAt) {
      throw new Error('Reset token expired');
    }

    // Check token type
    if (verificationToken.type !== 'PASSWORD_RESET') {
      throw new Error('Invalid token type');
    }

    // Hash new password
    const hashedPassword = await hashPassword(newPassword);

    // Update password, mark token as used, invalidate all sessions
    const updatedUser = await prisma.$transaction(async (tx) => {
      // Mark token as used
      await tx.verificationToken.update({
        where: { id: verificationToken.id },
        data: { usedAt: new Date() },
      });

      // Update password
      const user = await tx.user.update({
        where: { id: verificationToken.userId },
        data: { password: hashedPassword },
      });

      // Invalidate all sessions
      await tx.session.deleteMany({
        where: { userId: verificationToken.userId },
      });

      return user;
    });

    log.info({ userId: updatedUser.id }, 'Password reset successfully');
    return updatedUser;
  } catch (error) {
    log.error({ error }, 'Password reset failed');
    throw error;
  }
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Create new session (stores hashed refresh token)
 *
 * @param params - Session creation parameters
 * @returns Created session
 */
export async function createSession(params: CreateSessionParams): Promise<{
  id: string;
  expiresAt: Date;
}> {
  const log = logger.child({
    operation: 'createSession',
    userId: params.userId,
  });

  try {
    // Hash refresh token for storage
    const hashedToken = hashRefreshToken(params.refreshToken);

    // Calculate expiry (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Create session
    const session = await prisma.session.create({
      data: {
        userId: params.userId,
        refreshToken: hashedToken,
        expiresAt,
        ipAddress: params.ipAddress || null,
        userAgent: params.userAgent || null,
      },
    });

    log.info({ sessionId: session.id, expiresAt }, 'Session created');

    return {
      id: session.id,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    log.error({ error }, 'Failed to create session');
    throw error;
  }
}

/**
 * Validate refresh token and return session
 * Updates lastUsedAt timestamp
 *
 * @param token - Unhashed refresh token
 * @returns Session with user if valid
 * @throws Error if token is invalid or expired
 */
export async function validateRefreshToken(token: string): Promise<{
  session: { id: string; userId: string; expiresAt: Date };
  user: User;
} | null> {
  const log = logger.child({ operation: 'validateRefreshToken' });

  try {
    // Hash token to lookup in database
    const hashedToken = hashRefreshToken(token);

    // Find session
    const session = await prisma.session.findUnique({
      where: { refreshToken: hashedToken },
      include: { user: true },
    });

    if (!session) {
      log.warn('Session not found');
      return null;
    }

    // Check if expired
    if (new Date() > session.expiresAt) {
      log.warn({ sessionId: session.id }, 'Session expired');
      // Delete expired session
      await prisma.session.delete({ where: { id: session.id } });
      return null;
    }

    // Update lastUsedAt
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });

    log.info({ sessionId: session.id, userId: session.userId }, 'Session validated');

    return {
      session: {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
      },
      user: session.user,
    };
  } catch (error) {
    log.error({ error }, 'Session validation failed');
    throw error;
  }
}

/**
 * Delete session (logout)
 *
 * @param sessionId - Session ID
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const log = logger.child({ operation: 'deleteSession', sessionId });

  try {
    await prisma.session.delete({
      where: { id: sessionId },
    });

    log.info('Session deleted');
  } catch (error) {
    log.error({ error }, 'Failed to delete session');
    throw error;
  }
}

/**
 * Delete all sessions for user (logout all devices)
 *
 * @param userId - User ID
 * @returns Number of sessions deleted
 */
export async function deleteAllUserSessions(userId: string): Promise<number> {
  const log = logger.child({ operation: 'deleteAllUserSessions', userId });

  try {
    const result = await prisma.session.deleteMany({
      where: { userId },
    });

    log.info({ count: result.count }, 'All user sessions deleted');
    return result.count;
  } catch (error) {
    log.error({ error }, 'Failed to delete user sessions');
    throw error;
  }
}

/**
 * Clean up expired sessions (background job)
 *
 * @returns Number of sessions deleted
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const log = logger.child({ operation: 'cleanupExpiredSessions' });

  try {
    const result = await prisma.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });

    log.info({ count: result.count }, 'Expired sessions cleaned up');
    return result.count;
  } catch (error) {
    log.error({ error }, 'Failed to cleanup expired sessions');
    throw error;
  }
}
