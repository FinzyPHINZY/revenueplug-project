import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import type { LeadQualificationTier, LeadSource } from '@prisma/client';
import * as notifications from './notifications.js';

const log = logger.child({ module: 'enterprise-leads' });

export interface CreateLeadInput {
  // Contact info
  name: string;
  email: string;
  company: string;
  jobTitle?: string;
  phone?: string;
  website?: string;
  linkedinUrl?: string;

  // Business metrics
  monthlyRevenue?: number; // In USD
  customerCount?: number;
  platformsUsed?: string[];
  currentFailureRate?: number; // 0-100
  estimatedAtRisk?: number; // In USD

  // Context
  message?: string;
  interestedFeatures?: string[];
  timeline?: string;
  hasExistingAccount?: boolean;
  organizationId?: string;

  // Attribution
  source?: LeadSource;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrer?: string;
}

export interface LeadQualification {
  tier: LeadQualificationTier;
  score: number; // 0-100
  isQualified: boolean;
  estimatedDealValue: number; // Annual contract value in cents
  reasoning: string[];
  recommendedAction: string;
}

/**
 * Create new enterprise sales lead with automatic qualification
 */
export async function createEnterpriseLead(input: CreateLeadInput): Promise<{
  leadId: string;
  qualification: LeadQualification;
}> {
  try {
    // Qualify the lead based on business metrics
    const qualification = qualifyLead(input);

    log.info(
      {
        email: input.email,
        company: input.company,
        tier: qualification.tier,
        score: qualification.score,
      },
      'Qualifying enterprise lead'
    );

    // Create lead in database
    const lead = await prisma.enterpriseLead.create({
      data: {
        // Contact
        name: input.name,
        email: input.email,
        company: input.company,
        jobTitle: input.jobTitle,
        phone: input.phone,
        website: input.website,
        linkedinUrl: input.linkedinUrl,

        // Business metrics
        monthlyRevenue: input.monthlyRevenue,
        customerCount: input.customerCount,
        platformsUsed: input.platformsUsed || [],
        currentFailureRate: input.currentFailureRate,
        estimatedAtRisk: input.estimatedAtRisk,

        // Qualification
        qualificationScore: qualification.score,
        qualificationTier: qualification.tier,
        isQualified: qualification.isQualified,
        estimatedDealValue: qualification.estimatedDealValue,

        // Context
        message: input.message,
        interestedFeatures: input.interestedFeatures || [],
        timeline: input.timeline,
        hasExistingAccount: input.hasExistingAccount || false,
        organizationId: input.organizationId,

        // Attribution
        source: input.source || 'CONTACT_FORM',
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
        referrer: input.referrer,

        // Status
        status: 'NEW',
      },
    });

    log.info(
      {
        leadId: lead.id,
        email: input.email,
        qualification: qualification.tier,
      },
      'Created enterprise lead'
    );

    // Send notifications to sales team (async, don't wait)
    notifications
      .notifySalesTeam({
        lead: {
          id: lead.id,
          name: input.name,
          email: input.email,
          company: input.company,
          jobTitle: input.jobTitle,
          phone: input.phone,
        },
        qualification: {
          tier: qualification.tier,
          score: qualification.score,
          estimatedDealValue: qualification.estimatedDealValue,
        },
        metrics: {
          monthlyRevenue: input.monthlyRevenue,
          customerCount: input.customerCount,
          estimatedAtRisk: input.estimatedAtRisk,
        },
        context: {
          message: input.message,
          timeline: input.timeline,
          source: input.source || 'CONTACT_FORM',
        },
      })
      .catch((err) => log.error({ err, leadId: lead.id }, 'Failed to send sales notification'));

    return {
      leadId: lead.id,
      qualification,
    };
  } catch (error) {
    log.error({ error, email: input.email }, 'Failed to create enterprise lead');
    throw error;
  }
}

/**
 * Qualify lead based on business metrics
 * Returns qualification tier, score, and reasoning
 */
export function qualifyLead(input: CreateLeadInput): LeadQualification {
  let score = 0;
  const reasoning: string[] = [];

  // Revenue scoring (max 40 points)
  if (input.monthlyRevenue) {
    if (input.monthlyRevenue >= 500000) {
      // $500K+ MRR
      score += 40;
      reasoning.push(`$${(input.monthlyRevenue / 1000).toFixed(0)}K MRR - Enterprise tier`);
    } else if (input.monthlyRevenue >= 100000) {
      // $100K-500K MRR
      score += 30;
      reasoning.push(`$${(input.monthlyRevenue / 1000).toFixed(0)}K MRR - Mid-market`);
    } else if (input.monthlyRevenue >= 50000) {
      // $50K-100K MRR
      score += 20;
      reasoning.push(`$${(input.monthlyRevenue / 1000).toFixed(0)}K MRR - SMB`);
    } else {
      // <$50K MRR
      score += 5;
      reasoning.push(`$${(input.monthlyRevenue / 1000).toFixed(0)}K MRR - Small business`);
    }
  } else {
    reasoning.push('No revenue data provided');
  }

  // Customer count scoring (max 30 points)
  if (input.customerCount) {
    if (input.customerCount >= 10000) {
      score += 30;
      reasoning.push(`${input.customerCount.toLocaleString()} customers - Large scale`);
    } else if (input.customerCount >= 5000) {
      score += 25;
      reasoning.push(`${input.customerCount.toLocaleString()} customers - Growing scale`);
    } else if (input.customerCount >= 1000) {
      score += 15;
      reasoning.push(`${input.customerCount.toLocaleString()} customers - Medium scale`);
    } else {
      score += 5;
      reasoning.push(`${input.customerCount.toLocaleString()} customers - Small scale`);
    }
  } else {
    reasoning.push('No customer count provided');
  }

  // At-risk revenue scoring (max 20 points)
  if (input.estimatedAtRisk) {
    if (input.estimatedAtRisk >= 100000) {
      // $1,000+ at risk
      score += 20;
      reasoning.push(
        `$${(input.estimatedAtRisk / 100).toLocaleString()} at risk - High recovery potential`
      );
    } else if (input.estimatedAtRisk >= 50000) {
      // $500-1000 at risk
      score += 15;
      reasoning.push(
        `$${(input.estimatedAtRisk / 100).toLocaleString()} at risk - Medium recovery potential`
      );
    } else if (input.estimatedAtRisk >= 10000) {
      // $100-500 at risk
      score += 10;
      reasoning.push(
        `$${(input.estimatedAtRisk / 100).toLocaleString()} at risk - Some recovery potential`
      );
    } else {
      score += 5;
      reasoning.push(
        `$${(input.estimatedAtRisk / 100).toLocaleString()} at risk - Low recovery potential`
      );
    }
  } else {
    reasoning.push('No at-risk revenue data');
  }

  // Timeline urgency (max 10 points)
  if (input.timeline === 'Immediate') {
    score += 10;
    reasoning.push('Immediate timeline - High urgency');
  } else if (input.timeline === '1-3 months') {
    score += 7;
    reasoning.push('1-3 month timeline - Medium urgency');
  } else if (input.timeline === '3-6 months') {
    score += 5;
    reasoning.push('3-6 month timeline - Lower urgency');
  }

  // Bonus points
  if (input.hasExistingAccount) {
    score += 5;
    reasoning.push('Existing customer - Expansion opportunity');
  }

  if (input.platformsUsed && input.platformsUsed.length > 1) {
    score += 5;
    reasoning.push(`${input.platformsUsed.length} platforms - Multi-platform setup`);
  }

  // Determine tier based on score and key metrics
  let tier: LeadQualificationTier;
  let isQualified: boolean;
  let recommendedAction: string;

  if (
    (input.monthlyRevenue && input.monthlyRevenue >= 500000) ||
    (input.customerCount && input.customerCount >= 10000) ||
    score >= 80
  ) {
    tier = 'HOT';
    isQualified = true;
    recommendedAction =
      'Immediate follow-up. Assign to senior AE. Schedule call within 24 hours.';
  } else if (
    (input.monthlyRevenue && input.monthlyRevenue >= 50000) ||
    (input.customerCount && input.customerCount >= 1000) ||
    score >= 50
  ) {
    tier = 'WARM';
    isQualified = true;
    recommendedAction =
      'Qualified lead. Assign to AE. Send personalized email and schedule demo.';
  } else if (score >= 30) {
    tier = 'COLD';
    isQualified = false;
    recommendedAction =
      'Not qualified for enterprise. Add to nurture campaign. Suggest self-serve STARTER plan.';
  } else {
    tier = 'UNQUALIFIED';
    isQualified = false;
    recommendedAction =
      'Unqualified. Send automated response with self-serve resources. No sales follow-up.';
  }

  // Calculate estimated annual deal value
  const estimatedDealValue = calculateEstimatedDealValue(input, tier);

  return {
    tier,
    score,
    isQualified,
    estimatedDealValue,
    reasoning,
    recommendedAction,
  };
}

/**
 * Calculate estimated annual contract value
 */
function calculateEstimatedDealValue(
  input: CreateLeadInput,
  tier: LeadQualificationTier
): number {
  // Base pricing by tier
  let baseAnnual = 0;

  if (tier === 'HOT') {
    // Enterprise: $499/mo base + custom pricing
    // Estimate: $1,000-5,000/month based on size
    if (input.monthlyRevenue && input.monthlyRevenue >= 1000000) {
      baseAnnual = 500000; // $5,000/month = $60,000/year
    } else {
      baseAnnual = 120000; // $1,000/month = $12,000/year
    }
  } else if (tier === 'WARM') {
    // PRO: $149/mo
    baseAnnual = 178800; // $1,788/year (with 17% annual discount)
  } else {
    // STARTER: $49/mo
    baseAnnual = 58800; // $588/year (with 17% annual discount)
  }

  // Adjust based on number of connections needed
  if (input.platformsUsed && input.platformsUsed.length > 3) {
    baseAnnual = Math.round(baseAnnual * 1.5); // 50% premium for multi-platform
  }

  return baseAnnual;
}

/**
 * Get lead by ID
 */
export async function getLeadById(leadId: string) {
  return prisma.enterpriseLead.findUnique({
    where: { id: leadId },
  });
}

/**
 * Get all leads with filtering
 */
export async function getLeads(filters?: {
  tier?: LeadQualificationTier;
  status?: string;
  isQualified?: boolean;
  limit?: number;
  offset?: number;
}) {
  const where: any = {};

  if (filters?.tier) {
    where.qualificationTier = filters.tier;
  }

  if (filters?.status) {
    where.status = filters.status;
  }

  if (filters?.isQualified !== undefined) {
    where.isQualified = filters.isQualified;
  }

  const [leads, total] = await Promise.all([
    prisma.enterpriseLead.findMany({
      where,
      take: filters?.limit || 50,
      skip: filters?.offset || 0,
      orderBy: {
        createdAt: 'desc',
      },
    }),
    prisma.enterpriseLead.count({ where }),
  ]);

  return { leads, total };
}

/**
 * Update lead status
 */
export async function updateLeadStatus(
  leadId: string,
  status: string,
  note?: string
): Promise<void> {
  const updates: any = { status };

  // Add note to communication log
  if (note) {
    const lead = await getLeadById(leadId);
    if (lead) {
      const communicationLog = [
        ...(lead.communicationLog as any[]),
        {
          timestamp: new Date().toISOString(),
          type: 'status_change',
          status,
          note,
        },
      ];
      updates.communicationLog = communicationLog;
    }
  }

  await prisma.enterpriseLead.update({
    where: { id: leadId },
    data: updates,
  });

  log.info({ leadId, status }, 'Updated lead status');
}
