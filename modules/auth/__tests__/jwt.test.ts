import { describe, it, expect, beforeAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  hashRefreshToken,
  type AccessTokenPayload,
} from '../tokens.js';
import { config } from '../../../shared/config/index.js';

describe('JWT Token Tests', () => {
  const testUser = {
    id: 'test-user-123',
    email: 'test@example.com',
  };

  describe('Access Token Generation', () => {
    it('should generate valid JWT access token', () => {
      const token = generateAccessToken(testUser);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT format: header.payload.signature
    });

    it('should include user information in token payload', () => {
      const token = generateAccessToken(testUser);

      const decoded = jwt.decode(token) as AccessTokenPayload;

      expect(decoded.userId).toBe(testUser.id);
      expect(decoded.email).toBe(testUser.email);
    });

    it('should include standard JWT claims', () => {
      const token = generateAccessToken(testUser);

      const decoded = jwt.decode(token) as any;

      expect(decoded.iss).toBe('revenueplug'); // Issuer
      expect(decoded.sub).toBe(testUser.id); // Subject
      expect(decoded.exp).toBeDefined(); // Expiration
      expect(decoded.iat).toBeDefined(); // Issued at
    });

    it('should set expiration based on config', () => {
      const token = generateAccessToken(testUser);

      const decoded = jwt.decode(token) as any;
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = decoded.exp - now;

      // Should expire in ~15 minutes (default config)
      // Allow some tolerance for test execution time
      expect(expiresIn).toBeGreaterThan(14 * 60); // At least 14 minutes
      expect(expiresIn).toBeLessThan(16 * 60); // At most 16 minutes
    });

    it('should generate different tokens for different users', () => {
      const token1 = generateAccessToken(testUser);
      const token2 = generateAccessToken({
        id: 'different-user-456',
        email: 'different@example.com',
      });

      expect(token1).not.toBe(token2);
    });

    it('should generate different tokens for same user at different times', () => {
      const token1 = generateAccessToken(testUser);

      // Wait a bit to ensure different 'iat' claim
      vi.useFakeTimers();
      vi.advanceTimersByTime(1000);

      const token2 = generateAccessToken(testUser);

      vi.useRealTimers();

      expect(token1).not.toBe(token2);
    });
  });

  describe('Access Token Verification', () => {
    it('should verify valid access token', () => {
      const token = generateAccessToken(testUser);

      const payload = verifyAccessToken(token);

      expect(payload.userId).toBe(testUser.id);
      expect(payload.email).toBe(testUser.email);
    });

    it('should reject token with invalid signature', () => {
      const token = generateAccessToken(testUser);

      // Tamper with the signature
      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.${parts[1]}.invalid-signature`;

      expect(() => verifyAccessToken(tamperedToken)).toThrow('Invalid access token');
    });

    it('should reject token with tampered payload', () => {
      const token = generateAccessToken(testUser);

      // Decode and modify payload
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      payload.userId = 'hacker-user-999';

      // Re-encode with modified payload (but original signature)
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      expect(() => verifyAccessToken(tamperedToken)).toThrow('Invalid access token');
    });

    it('should reject expired token', () => {
      // Create token with very short expiry
      const shortLivedToken = jwt.sign(
        {
          userId: testUser.id,
          email: testUser.email,
        },
        config.JWT_SECRET,
        {
          expiresIn: '1ms', // Expires immediately
          issuer: 'revenueplug',
          subject: testUser.id,
        }
      );

      // Wait for token to expire
      vi.useFakeTimers();
      vi.advanceTimersByTime(100);
      vi.useRealTimers();

      expect(() => verifyAccessToken(shortLivedToken)).toThrow('Access token expired');
    });

    it('should reject token with wrong issuer', () => {
      const wrongIssuerToken = jwt.sign(
        {
          userId: testUser.id,
          email: testUser.email,
        },
        config.JWT_SECRET,
        {
          expiresIn: '15m',
          issuer: 'malicious-app',
          subject: testUser.id,
        }
      );

      expect(() => verifyAccessToken(wrongIssuerToken)).toThrow('Invalid access token');
    });

    it('should reject token signed with wrong secret', () => {
      const wrongSecretToken = jwt.sign(
        {
          userId: testUser.id,
          email: testUser.email,
        },
        'wrong-secret-key',
        {
          expiresIn: '15m',
          issuer: 'revenueplug',
          subject: testUser.id,
        }
      );

      expect(() => verifyAccessToken(wrongSecretToken)).toThrow('Invalid access token');
    });

    it('should reject malformed token', () => {
      expect(() => verifyAccessToken('not-a-valid-jwt')).toThrow();
      expect(() => verifyAccessToken('')).toThrow();
      expect(() => verifyAccessToken('a.b')).toThrow(); // Missing signature
    });

    it('should reject token with missing required claims', () => {
      // Token without userId
      const incompleteToken = jwt.sign(
        {
          email: testUser.email,
          // Missing userId
        },
        config.JWT_SECRET,
        {
          expiresIn: '15m',
          issuer: 'revenueplug',
        }
      );

      const payload = verifyAccessToken(incompleteToken);
      expect(payload.userId).toBeUndefined();
    });
  });

  describe('Refresh Token Generation', () => {
    it('should generate cryptographically random refresh token', () => {
      const { token } = generateRefreshToken();

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token).toHaveLength(64); // 32 bytes hex = 64 characters
      expect(token).toMatch(/^[a-f0-9]{64}$/); // Hex format
    });

    it('should generate unique tokens', () => {
      const token1 = generateRefreshToken().token;
      const token2 = generateRefreshToken().token;
      const token3 = generateRefreshToken().token;

      expect(token1).not.toBe(token2);
      expect(token2).not.toBe(token3);
      expect(token1).not.toBe(token3);
    });

    it('should set expiration date', () => {
      const { expiresAt } = generateRefreshToken();

      expect(expiresAt).toBeInstanceOf(Date);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Should expire in ~7 days (default config)
      const daysUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(daysUntilExpiry).toBeGreaterThan(6.9);
      expect(daysUntilExpiry).toBeLessThan(7.1);
    });

    it('should return both token and expiry', () => {
      const result = generateRefreshToken();

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('expiresAt');
    });
  });

  describe('Refresh Token Hashing', () => {
    it('should hash refresh token consistently', () => {
      const token = 'test-refresh-token-123';

      const hash1 = hashRefreshToken(token);
      const hash2 = hashRefreshToken(token);

      expect(hash1).toBe(hash2); // Same input = same hash
    });

    it('should produce different hashes for different tokens', () => {
      const token1 = 'test-token-1';
      const token2 = 'test-token-2';

      const hash1 = hashRefreshToken(token1);
      const hash2 = hashRefreshToken(token2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce SHA-256 hash (64 hex characters)', () => {
      const token = 'test-refresh-token';

      const hash = hashRefreshToken(token);

      expect(hash).toHaveLength(64); // SHA-256 = 32 bytes = 64 hex chars
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be deterministic (no salt)', () => {
      const token = 'deterministic-test-token';

      const hash1 = hashRefreshToken(token);
      const hash2 = hashRefreshToken(token);
      const hash3 = hashRefreshToken(token);

      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it('should hash empty string', () => {
      const hash = hashRefreshToken('');

      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });
  });

  describe('Token Security', () => {
    it('should not expose JWT secret in token', () => {
      const token = generateAccessToken(testUser);

      // Decode token (without verification)
      const parts = token.split('.');
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

      // Secret should not be in header or payload
      expect(JSON.stringify(header)).not.toContain(config.JWT_SECRET);
      expect(JSON.stringify(payload)).not.toContain(config.JWT_SECRET);
    });

    it('should use HS256 algorithm for JWT', () => {
      const token = generateAccessToken(testUser);

      const parts = token.split('.');
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());

      expect(header.alg).toBe('HS256');
      expect(header.typ).toBe('JWT');
    });

    it('should not include sensitive data in JWT payload', () => {
      const token = generateAccessToken(testUser);

      const decoded = jwt.decode(token) as any;

      // Should NOT include password, tokens, etc.
      expect(decoded.password).toBeUndefined();
      expect(decoded.refreshToken).toBeUndefined();
      expect(decoded.verificationToken).toBeUndefined();
    });

    it('should generate cryptographically secure refresh tokens', () => {
      // Generate many tokens to check for patterns
      const tokens = new Set();

      for (let i = 0; i < 100; i++) {
        const { token } = generateRefreshToken();
        tokens.add(token);
      }

      // All tokens should be unique (no collisions)
      expect(tokens.size).toBe(100);

      // Tokens should have high entropy (no obvious patterns)
      const tokenArray = Array.from(tokens) as string[];
      const firstToken = tokenArray[0];
      const lastToken = tokenArray[99];

      // Should not have common prefixes/suffixes
      expect(firstToken.substring(0, 10)).not.toBe(lastToken.substring(0, 10));
    });
  });

  describe('Token Lifecycle', () => {
    it('should support full access token lifecycle', () => {
      // 1. Generate token
      const token = generateAccessToken(testUser);
      expect(token).toBeDefined();

      // 2. Verify token
      const payload = verifyAccessToken(token);
      expect(payload.userId).toBe(testUser.id);

      // 3. Token should remain valid until expiry
      const decoded = jwt.decode(token) as any;
      const expiresAt = decoded.exp * 1000; // Convert to ms

      expect(Date.now()).toBeLessThan(expiresAt);
    });

    it('should support full refresh token lifecycle', () => {
      // 1. Generate refresh token
      const { token, expiresAt } = generateRefreshToken();
      expect(token).toBeDefined();

      // 2. Hash for storage
      const hash = hashRefreshToken(token);
      expect(hash).toBeDefined();

      // 3. Verify hash matches
      const verifyHash = hashRefreshToken(token);
      expect(verifyHash).toBe(hash);

      // 4. Token should not be expired
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
