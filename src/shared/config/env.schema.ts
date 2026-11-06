import { z } from 'zod';
import { Environment, LogLevel } from '../types/index.js';

export const envSchema = z.object({
  NODE_ENV: z.nativeEnum(Environment).default(Environment.DEVELOPMENT),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.nativeEnum(LogLevel).default(LogLevel.INFO),

  DATABASE_URL: z.string().url().min(1, 'DATABASE_URL is required'),

  REDIS_URL: z.string().url().min(1, 'REDIS_URL is required'),

  KAFKA_BROKERS: z
    .string()
    .min(1, 'KAFKA_BROKERS is required')
    .transform((val) => val.split(',')),
  KAFKA_CLIENT_ID: z.string().default('revenueplug'),

  CLICKHOUSE_URL: z.string().url().min(1, 'CLICKHOUSE_URL is required'),
  CLICKHOUSE_DATABASE: z.string().default('revenueplug'),
  CLICKHOUSE_USERNAME: z.string().optional().default('default'),
  CLICKHOUSE_PASSWORD: z.string().optional().default(''),

  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY must be at least 32 characters')
    .regex(/^[A-Za-z0-9+/=]+$/, 'ENCRYPTION_KEY must be base64 encoded'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .regex(/^[A-Za-z0-9+/=]+$/, 'JWT_SECRET must be base64 encoded'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  OAUTH_REDIRECT_BASE: z.string().url().default('http://localhost:3000'),

  APP_URL: z.string().url().default('http://localhost:3000'),

  RESEND_API_KEY: z.string().optional(),

  STRIPE_CLIENT_ID: z.string().optional(),
  STRIPE_CLIENT_SECRET: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  POLAR_CLIENT_ID: z.string().optional(),
  POLAR_CLIENT_SECRET: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
