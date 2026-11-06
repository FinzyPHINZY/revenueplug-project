import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';

/**
 * Send email verification email
 * // TODO: currently logs to console - will integrate Resend later
 *
 * @param email - Recipient email address
 * @param name - Recipient name (optional)
 * @param token - Verification token to include in URL
 *
 * @example
 * await sendVerificationEmail('user@example.com', 'John Doe', 'abc123...');
 */
export async function sendVerificationEmail(
  email: string,
  name: string | null,
  token: string
): Promise<void> {
  const verificationUrl = `${config.APP_URL}/verify-email?token=${token}`;

  // TODO: Log email to console (will use Resend later)
  logger.info(
    {
      to: email,
      subject: 'Verify your RevenuePlug account',
      verificationUrl,
    },
    '📧 EMAIL: Verification email'
  );

  console.log('\n' + '='.repeat(80));
  console.log('📧 VERIFICATION EMAIL');
  console.log('='.repeat(80));
  console.log(`To: ${email}`);
  console.log(`Subject: Verify your RevenuePlug account`);
  console.log('-'.repeat(80));
  console.log(`Hello${name ? ` ${name}` : ''},\n`);
  console.log(
    'Welcome to RevenuePlug! Please verify your email address to complete registration.\n'
  );
  console.log(`Verification link: ${verificationUrl}\n`);
  console.log('This link expires in 24 hours.');
  console.log('-'.repeat(80));
  console.log('If you did not create an account, please ignore this email.');
  console.log('='.repeat(80) + '\n');
}

/**
 * Send password reset email
 // TODO: Currently logs to console - will integrate Resend later
 *
 * @param email - Recipient email address
 * @param name - Recipient name (optional)
 * @param token - Password reset token to include in URL
 *
 * @example
 * await sendPasswordResetEmail('user@example.com', 'John Doe', 'xyz789...');
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string | null,
  token: string
): Promise<void> {
  const resetUrl = `${config.APP_URL}/reset-password?token=${token}`;

  // TODO: Log email to console (will use Resend later)
  logger.info(
    {
      to: email,
      subject: 'Reset your RevenuePlug password',
      resetUrl,
    },
    '📧 EMAIL: Password reset email'
  );

  console.log(`\n${'='.repeat(80)}`);
  console.log('📧 PASSWORD RESET EMAIL');
  console.log('='.repeat(80));
  console.log(`To: ${email}`);
  console.log(`Subject: Reset your RevenuePlug password`);
  console.log('-'.repeat(80));
  console.log(`Hello${name ? ` ${name}` : ''},\n`);
  console.log(
    'You requested to reset your password. Click the link below to set a new password.\n'
  );
  console.log(`Reset password link: ${resetUrl}\n`);
  console.log('This link expires in 24 hours.');
  console.log('-'.repeat(80));
  console.log('If you did not request a password reset, please ignore this email.');
  console.log('Your password will not be changed unless you click the link above.');
  console.log(`${'='.repeat(80)}\n`);
}
