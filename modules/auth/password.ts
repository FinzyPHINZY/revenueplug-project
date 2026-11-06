import bcrypt from 'bcrypt';

/**
 * Number of salt rounds for bcrypt hashing
 * 10 rounds ~= 150ms per hash (good security/performance balance)
 */
const SALT_ROUNDS = 10;

/**
 * Password strength requirements
 */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_REQUIREMENTS = {
  minLength: PASSWORD_MIN_LENGTH,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
};

/**
 * Hash a plaintext password using bcrypt
 *
 * @param password - Plaintext password to hash
 * @returns Hashed password
 *
 * @example
 * const hashed = await hashPassword('SecurePass123');
 * // => '$2b$10$...'
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plaintext password with a bcrypt hash
 * Uses constant-time comparison to prevent timing attacks
 *
 * @param password - Plaintext password to check
 * @param hash - Bcrypt hash to compare against
 * @returns True if password matches hash, false otherwise
 *
 * @example
 * const isValid = await comparePassword('SecurePass123', hash);
 * // => true or false
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

/**
 * Validate password strength against requirements
 *
 * Requirements:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 *
 * @param password - Password to validate
 * @returns Object with validation result and error messages
 *
 * @example
 * const result = validatePasswordStrength('weak');
 * // => { valid: false, errors: ['Password must be at least 8 characters', ...] }
 *
 * const result = validatePasswordStrength('SecurePass123');
 * // => { valid: true, errors: [] }
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check minimum length
  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push(`Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`);
  }

  // Check for uppercase letter
  if (PASSWORD_REQUIREMENTS.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  // Check for lowercase letter
  if (PASSWORD_REQUIREMENTS.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  // Check for number
  if (PASSWORD_REQUIREMENTS.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
