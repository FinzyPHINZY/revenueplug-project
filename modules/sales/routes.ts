import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger/index.js';
import { requireAuth } from '../auth/middleware.js';
import {
  getOrganizationContext,
  requireOrganizationContext,
} from '../../shared/middleware/organization-context.js';
import * as enterpriseLeads from './enterprise-leads.js';
import * as pricingCalculator from './pricing-calculator.js';

// ==========================================================================
// REQUEST SCHEMAS
// ==========================================================================

const ContactSalesSchema = z.object({
  // Contact info
  name: z.string().min(1),
  email: z.string().email(),
  company: z.string().min(1),
  job_title: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  linkedin_url: z.string().url().optional(),

  // Business metrics
  monthly_revenue: z.number().int().min(0).optional(),
  customer_count: z.number().int().min(0).optional(),
  platforms_used: z.array(z.string()).optional(),
  current_failure_rate: z.number().min(0).max(100).optional(),
  estimated_at_risk: z.number().int().min(0).optional(),

  // Context
  message: z.string().optional(),
  interested_features: z.array(z.string()).optional(),
  timeline: z.enum(['Immediate', '1-3 months', '3-6 months', '6+ months']).optional(),

  // Attribution
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  referrer: z.string().optional(),
});

const GetLeadsQuerySchema = z.object({
  tier: z.enum(['HOT', 'WARM', 'COLD', 'UNQUALIFIED']).optional(),
  status: z.string().optional(),
  is_qualified: z.coerce.boolean().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

const UpdateLeadStatusSchema = z.object({
  status: z.enum([
    'NEW',
    'CONTACTED',
    'QUALIFIED',
    'DEMO_SCHEDULED',
    'DEMO_COMPLETED',
    'PROPOSAL_SENT',
    'NEGOTIATION',
    'CONTRACT_SENT',
    'CLOSED_WON',
    'CLOSED_LOST',
    'NURTURE',
  ]),
  note: z.string().optional(),
});

const PricingCalculatorSchema = z.object({
  // Business metrics
  monthly_revenue: z.number().int().min(0),
  customer_count: z.number().int().min(0),
  platform_count: z.number().int().min(1).max(20),
  estimated_failure_rate: z.number().min(0).max(100).optional(),
  estimated_at_risk: z.number().int().min(0).optional(),

  // Contract terms
  contract_length: z.enum([12, 24, 36]).default(12),
  billing_cycle: z.enum(['monthly', 'annual']).default('annual'),

  // Add-ons
  dedicated_infrastructure: z.boolean().optional().default(false),
  white_label: z.boolean().optional().default(false),
  additional_engineering_hours: z.number().int().min(0).max(500).optional(),
  sms_recovery: z.boolean().optional().default(false),

  // Discounts
  referral_discount: z.boolean().optional().default(false),
  nonprofit_discount: z.boolean().optional().default(false),
  custom_discount: z.number().min(0).max(50).optional(),
});

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * POST /api/sales/contact
 * Submit contact sales form (public endpoint)
 */
async function handleContactSales(
  request: FastifyRequest<{
    Body: z.infer<typeof ContactSalesSchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleContactSales' });

  try {
    const body = ContactSalesSchema.parse(request.body);

    // Check if user is authenticated and has existing organization
    let organizationId: string | undefined;
    let hasExistingAccount = false;

    try {
      const orgContext = getOrganizationContext(request);
      organizationId = orgContext.id;
      hasExistingAccount = true;
    } catch {
      // Not authenticated, that's fine for contact form
    }

    // Create lead with automatic qualification
    const result = await enterpriseLeads.createEnterpriseLead({
      name: body.name,
      email: body.email,
      company: body.company,
      jobTitle: body.job_title,
      phone: body.phone,
      website: body.website,
      linkedinUrl: body.linkedin_url,

      monthlyRevenue: body.monthly_revenue,
      customerCount: body.customer_count,
      platformsUsed: body.platforms_used,
      currentFailureRate: body.current_failure_rate,
      estimatedAtRisk: body.estimated_at_risk,

      message: body.message,
      interestedFeatures: body.interested_features,
      timeline: body.timeline,

      hasExistingAccount,
      organizationId,

      source: 'CONTACT_FORM',
      utmSource: body.utm_source,
      utmMedium: body.utm_medium,
      utmCampaign: body.utm_campaign,
      referrer: body.referrer,
    });

    log.info(
      {
        leadId: result.leadId,
        email: body.email,
        tier: result.qualification.tier,
        score: result.qualification.score,
      },
      'Contact sales form submitted'
    );

    // Return qualification results (helps with testing)
    return reply.code(200).send({
      success: true,
      lead_id: result.leadId,
      qualification: {
        tier: result.qualification.tier,
        is_qualified: result.qualification.isQualified,
        estimated_deal_value: result.qualification.estimatedDealValue,
        next_steps:
          result.qualification.tier === 'HOT'
            ? "We'll reach out within 24 hours to schedule a call."
            : result.qualification.tier === 'WARM'
              ? "We'll be in touch within 2-3 business days to schedule a demo."
              : result.qualification.tier === 'COLD'
                ? "We've received your inquiry. Check your email for self-serve options."
                : 'Thank you for your interest. We recommend starting with our self-serve plans.',
      },
    });
  } catch (error) {
    log.error({ error }, 'Failed to process contact sales form');

    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: error.errors,
      });
    }

    return reply.code(500).send({
      error: 'Failed to submit contact form',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/sales/leads
 * Get all leads (internal - requires auth)
 */
async function handleGetLeads(
  request: FastifyRequest<{
    Querystring: z.infer<typeof GetLeadsQuerySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetLeads' });

  try {
    const query = GetLeadsQuerySchema.parse(request.query);

    const result = await enterpriseLeads.getLeads({
      tier: query.tier,
      status: query.status,
      isQualified: query.is_qualified,
      limit: query.limit,
      offset: query.offset,
    });

    log.info({ count: result.leads.length, total: result.total }, 'Retrieved leads');

    return reply.code(200).send({
      leads: result.leads,
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get leads');
    return reply.code(500).send({
      error: 'Failed to retrieve leads',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/sales/leads/:id
 * Get lead by ID (internal - requires auth)
 */
async function handleGetLead(
  request: FastifyRequest<{
    Params: { id: string };
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetLead' });

  try {
    const lead = await enterpriseLeads.getLeadById(request.params.id);

    if (!lead) {
      return reply.code(404).send({
        error: 'Lead not found',
      });
    }

    log.info({ leadId: lead.id }, 'Retrieved lead');

    return reply.code(200).send({ lead });
  } catch (error) {
    log.error({ error }, 'Failed to get lead');
    return reply.code(500).send({
      error: 'Failed to retrieve lead',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * PATCH /api/sales/leads/:id/status
 * Update lead status (internal - requires auth)
 */
async function handleUpdateLeadStatus(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof UpdateLeadStatusSchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateLeadStatus' });

  try {
    const body = UpdateLeadStatusSchema.parse(request.body);

    await enterpriseLeads.updateLeadStatus(request.params.id, body.status, body.note);

    log.info({ leadId: request.params.id, status: body.status }, 'Updated lead status');

    return reply.code(200).send({
      success: true,
    });
  } catch (error) {
    log.error({ error }, 'Failed to update lead status');
    return reply.code(500).send({
      error: 'Failed to update lead status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/sales/pricing-calculator
 * Calculate custom pricing for enterprise prospects (internal - requires auth)
 */
async function handlePricingCalculator(
  request: FastifyRequest<{
    Body: z.infer<typeof PricingCalculatorSchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handlePricingCalculator' });

  try {
    const body = PricingCalculatorSchema.parse(request.body);

    const pricing = pricingCalculator.calculatePricing({
      monthlyRevenue: body.monthly_revenue,
      customerCount: body.customer_count,
      platformCount: body.platform_count,
      estimatedFailureRate: body.estimated_failure_rate,
      estimatedAtRisk: body.estimated_at_risk,
      contractLength: body.contract_length,
      billingCycle: body.billing_cycle,
      dedicatedInfrastructure: body.dedicated_infrastructure,
      whiteLabel: body.white_label,
      additionalEngineeringHours: body.additional_engineering_hours,
      smsRecovery: body.sms_recovery,
      referralDiscount: body.referral_discount,
      nonprofitDiscount: body.nonprofit_discount,
      customDiscount: body.custom_discount,
    });

    log.info(
      {
        basePlan: pricing.basePlan,
        finalAnnualPrice: pricing.finalAnnualPrice,
        roi: pricing.roi.roiMultiplier,
      },
      'Calculated custom pricing'
    );

    // Also return formatted version for copy-paste into emails/proposals
    const formattedPricing = pricingCalculator.formatPricingForProposal(pricing);

    return reply.code(200).send({
      pricing,
      formatted: formattedPricing,
    });
  } catch (error) {
    log.error({ error }, 'Failed to calculate pricing');

    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: error.errors,
      });
    }

    return reply.code(500).send({
      error: 'Failed to calculate pricing',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

/**
 * Register sales routes
 */
export async function registerSalesRoutes(app: FastifyInstance): Promise<void> {
  // Public routes
  app.post('/api/sales/contact', handleContactSales);

  // Internal routes (require auth - for sales team dashboard)
  app.get('/api/sales/leads', { preHandler: [requireAuth] }, handleGetLeads);

  app.get(
    '/api/sales/leads/:id',
    { preHandler: [requireAuth] },
    handleGetLead
  );

  app.patch(
    '/api/sales/leads/:id/status',
    { preHandler: [requireAuth] },
    handleUpdateLeadStatus
  );

  app.post(
    '/api/sales/pricing-calculator',
    { preHandler: [requireAuth] },
    handlePricingCalculator
  );

  logger.info('Registered sales routes');
}
