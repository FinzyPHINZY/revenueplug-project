

import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';


export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'RevenuePlug API',
        description: 'Revenue recovery and retention automation platform for SaaS businesses',
        version: '1.0.0',
        contact: {
          name: 'RevenuePlug Support',
          email: 'support@revenueplug.com',
          url: 'https://revenueplug.com',
        },
        license: {
          name: 'Proprietary',
          url: 'https://revenueplug.com/terms',
        },
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server',
        },
        {
          url: 'https://api.revenueplug.com',
          description: 'Production server',
        },
      ],
      tags: [
        { name: 'Authentication', description: 'User authentication and session management' },
        { name: 'Organizations', description: 'Organization and team management' },
        { name: 'Connections', description: 'Platform connections (Stripe, etc.)' },
        { name: 'Sync', description: 'Data synchronization' },
        { name: 'Analytics', description: 'Analytics and detection endpoints' },
        { name: 'Dashboard', description: 'Dashboard summary endpoints' },
        { name: 'Retention', description: 'Retention campaigns and actions' },
        { name: 'Settings', description: 'Organization and user settings' },
        { name: 'Webhooks', description: 'Incoming webhooks from platforms' },
        { name: 'Audit Logs', description: 'Audit logs and compliance' },
        { name: 'Billing', description: 'RevenuePlug subscription billing' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT access token obtained from /api/auth/login',
          },
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
            description: 'API key for programmatic access',
          },
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: { type: 'string', description: 'Error type' },
              message: { type: 'string', description: 'Error message' },
            },
            required: ['error', 'message'],
          },
          User: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'User ID' },
              email: { type: 'string', format: 'email', description: 'User email' },
              name: { type: 'string', nullable: true, description: 'User name' },
              emailVerified: { type: 'boolean', description: 'Email verification status' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
          Organization: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Organization ID' },
              name: { type: 'string', description: 'Organization name' },
              slug: { type: 'string', description: 'URL-friendly slug' },
              email: { type: 'string', format: 'email', nullable: true },
              billingStatus: {
                type: 'string',
                enum: ['FREE', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'TRIALING'],
              },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
          Connection: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Connection ID' },
              platform: {
                type: 'string',
                enum: ['STRIPE', 'PADDLE', 'LEMON_SQUEEZY', 'REVENUE_CAT'],
              },
              status: {
                type: 'string',
                enum: ['ACTIVE', 'DISCONNECTED', 'ERROR'],
              },
              createdAt: { type: 'string', format: 'date-time' },
              lastSyncAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          Campaign: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Campaign ID' },
              name: { type: 'string', description: 'Campaign name' },
              status: {
                type: 'string',
                enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'],
              },
              triggerType: {
                type: 'string',
                enum: [
                  'CHURN_RISK_HIGH',
                  'CHURN_RISK_CRITICAL',
                  'PAYMENT_FAILURE',
                  'TRIAL_ENDING',
                  'USAGE_DECLINING',
                ],
              },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
          AuditLog: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              userId: { type: 'string', nullable: true },
              userEmail: { type: 'string', nullable: true },
              action: { type: 'string', description: 'Audit action type' },
              resource: { type: 'string', description: 'Resource type' },
              resourceId: { type: 'string', nullable: true },
              description: { type: 'string' },
              severity: {
                type: 'string',
                enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'],
              },
              status: {
                type: 'string',
                enum: ['SUCCESS', 'FAILURE', 'PENDING'],
              },
              occurredAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await app.register(fastifySwaggerUI, {
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      tryItOutEnabled: true,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });
}

export async function generateOpenAPISpec(app: FastifyInstance): Promise<any> {
  return app.swagger();
}
