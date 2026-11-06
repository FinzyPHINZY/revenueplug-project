import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { type Env, envSchema } from './env.schema.js';

export function loadConfig(): Env {
  dotenv.config();

  try {
    const config = envSchema.parse(process.env);
    return config;
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.errors.map((err) => {
        const path = err.path.join('.');
        return `  - ${path}: ${err.message}`;
      });

      console.error(`Environment validation failed:\n${errorMessages.join('\n')}`);
      process.exit(1);
    }

    console.error('Unexpected error loading configuration:', error);
    process.exit(1);
  }
}

export const config = loadConfig();

export type { Env } from './env.schema.js';
