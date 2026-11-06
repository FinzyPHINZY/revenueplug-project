import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../shared/config/index.js';

/**
 * Credential encryption/decryption
 * Uses AES-256-GCM for authenticated encryption
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Derive encryption key from config
 * // TODO: In production, use AWS KMS, Google Cloud KMS, or HashiCorp Vault
 */
function getEncryptionKey(): Buffer {
  const key = Buffer.from(config.ENCRYPTION_KEY, 'base64');

  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes`);
  }

  return key;
}

/**
 * Encrypt credentials
 * Returns base64-encoded string: iv:authTag:ciphertext
 */
export function encryptCredentials(credentials: Record<string, unknown>): string {
  try {
    const key = getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);

    const plaintext = JSON.stringify(credentials);
    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext (all base64)
    const encrypted = [iv.toString('base64'), authTag.toString('base64'), ciphertext].join(':');

    return encrypted;
  } catch (error) {
    throw new Error(`Failed to encrypt credentials: ${error}`);
  }
}

/**
 * Decrypt credentials
 * Accepts base64-encoded string: iv:authTag:ciphertext
 */
export function decryptCredentials(encrypted: string): Record<string, unknown> {
  try {
    const key = getEncryptionKey();

    // Parse encrypted string
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted credentials format');
    }

    const [ivBase64, authTagBase64, ciphertext] = parts;

    if (!ivBase64 || !authTagBase64 || !ciphertext) {
      throw new Error('Invalid encrypted credentials format');
    }

    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(ciphertext, 'base64', 'utf8');
    plaintext += decipher.final('utf8');

    return JSON.parse(plaintext) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to decrypt credentials: ${error}`);
  }
}

/**
 * Validate that credentials can be decrypted
 * Used for testing encryption key validity
 */
export function validateEncryptionKey(): boolean {
  try {
    const testData = { test: 'data' };
    const encrypted = encryptCredentials(testData);
    const decrypted = decryptCredentials(encrypted);

    return JSON.stringify(testData) === JSON.stringify(decrypted);
  } catch {
    return false;
  }
}
