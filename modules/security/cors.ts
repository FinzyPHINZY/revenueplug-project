/**
 * CORS Configuration
 * Cross-Origin Resource Sharing policies for API security
 */

import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { logger } from '../../shared/logger/index.js';

/**
 * Register CORS middleware
 */
export async function registerCORS(app: FastifyInstance): Promise<void> {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173', // Vite dev server
    'https://revenueplug.com',
    'https://app.revenueplug.com',
    'https://dashboard.revenueplug.com',
  ];

  // Add environment-specific origins
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Check if origin is allowed
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin }, 'CORS request blocked from unauthorized origin');
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true, // Allow cookies and authorization headers
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Request-ID',
      'X-Organization-ID',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 86400, // 24 hours - cache preflight requests
  });

  logger.info({ allowedOrigins }, 'CORS configured');
}

/**
 * CORS configuration for development mode
 * Allows all origins for easier testing
 */
export async function registerCORSDevelopment(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: true, // Allow all origins in development
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  });

  logger.info('CORS configured for development (all origins allowed)');
}
