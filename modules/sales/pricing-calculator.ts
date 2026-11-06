import { logger } from '../../shared/logger/index.js';

const log = logger.child({ module: 'pricing-calculator' });

export interface PricingInput {
  // Business metrics
  monthlyRevenue: number; // MRR in USD
  customerCount: number;
  platformCount: number;
  estimatedFailureRate?: number; // 0-100%
  estimatedAtRisk?: number; // In USD

  // Contract terms
  contractLength: 12 | 24 | 36; // months
  billingCycle: 'monthly' | 'annual';

  // Add-ons
  dedicatedInfrastructure?: boolean;
  whiteLabel?: boolean;
  additionalEngineeringHours?: number;
  smsRecovery?: boolean;

  // Discounts
  referralDiscount?: boolean; // 10% off first year
  nonprofitDiscount?: boolean; // 20% off
  customDiscount?: number; // Custom % discount
}

export interface PricingOutput {
  // Base pricing
  basePlan: 'PRO' | 'ENTERPRISE';
  baseMonthlyPrice: number; // In cents
  baseAnnualPrice: number; // In cents

  // Add-ons
  addOns: Array<{
    name: string;
    monthlyPrice: number;
    annualPrice: number;
    description: string;
  }>;

  // Total pricing
  totalMonthlyPrice: number;
  totalAnnualPrice: number;

  // Discounts
  discounts: Array<{
    name: string;
    amount: number; // In cents
    percentage: number;
  }>;

  // Final pricing
  finalMonthlyPrice: number;
  finalAnnualPrice: number;

  // ROI projection
  roi: {
    estimatedMonthlyRecovery: number; // Conservative estimate
    estimatedAnnualRecovery: number;
    roiMultiplier: number; // e.g., 15.2x
    paybackMonths: number;
    netAnnualGain: number;
  };

  // Implementation
  implementation: {
    estimatedHours: number;
    timeline: string;
    cost: number; // Included or additional
  };

  // Contract terms
  contract: {
    length: number; // months
    earlyTerminationFees: {
      months1to6: number;
      months7to12: number;
      after12: number;
    };
    autoRenewal: boolean;
    priceProtection: string;
  };

  // Recommendations
  recommendations: string[];
}

/**
 * Calculate custom enterprise pricing
 * Used by sales team to generate proposals
 */
export function calculatePricing(input: PricingInput): PricingOutput {
  log.debug({ input }, 'Calculating custom pricing');

  // Determine base plan
  const basePlan = determineBasePlan(input);
  const { baseMonthlyPrice, baseAnnualPrice } = getBasePricing(basePlan, input);

  // Calculate add-ons
  const addOns = calculateAddOns(input);
  const addOnsMonthly = addOns.reduce((sum, addon) => sum + addon.monthlyPrice, 0);
  const addOnsAnnual = addOns.reduce((sum, addon) => sum + addon.annualPrice, 0);

  // Total before discounts
  const totalMonthlyPrice = baseMonthlyPrice + addOnsMonthly;
  const totalAnnualPrice = baseAnnualPrice + addOnsAnnual;

  // Apply discounts
  const discounts = calculateDiscounts(input, totalAnnualPrice);
  const totalDiscount = discounts.reduce((sum, discount) => sum + discount.amount, 0);

  // Final pricing
  const finalMonthlyPrice = Math.round(totalMonthlyPrice * (1 - totalDiscount / totalAnnualPrice));
  const finalAnnualPrice = Math.round(totalAnnualPrice - totalDiscount);

  // Calculate ROI
  const roi = calculateROI(input, finalAnnualPrice);

  // Implementation details
  const implementation = calculateImplementation(input, basePlan);

  // Contract terms
  const contract = generateContractTerms(input, finalAnnualPrice);

  // Recommendations
  const recommendations = generateRecommendations(input, basePlan);

  const pricing: PricingOutput = {
    basePlan,
    baseMonthlyPrice,
    baseAnnualPrice,
    addOns,
    totalMonthlyPrice,
    totalAnnualPrice,
    discounts,
    finalMonthlyPrice,
    finalAnnualPrice,
    roi,
    implementation,
    contract,
    recommendations,
  };

  log.info(
    {
      basePlan,
      finalAnnualPrice,
      roi: roi.roiMultiplier,
    },
    'Calculated custom pricing'
  );

  return pricing;
}

/**
 * Determine appropriate base plan
 */
function determineBasePlan(input: PricingInput): 'PRO' | 'ENTERPRISE' {
  // Enterprise criteria:
  // - $500K+ MRR
  // - 10K+ customers
  // - 5+ platforms
  // - Needs dedicated infrastructure or white-label

  if (
    input.monthlyRevenue >= 500000 ||
    input.customerCount >= 10000 ||
    input.platformCount >= 5 ||
    input.dedicatedInfrastructure ||
    input.whiteLabel
  ) {
    return 'ENTERPRISE';
  }

  return 'PRO';
}

/**
 * Get base pricing for plan with volume adjustments
 */
function getBasePricing(
  plan: 'PRO' | 'ENTERPRISE',
  input: PricingInput
): { baseMonthlyPrice: number; baseAnnualPrice: number } {
  if (plan === 'PRO') {
    return {
      baseMonthlyPrice: 14900, // $149/month
      baseAnnualPrice: 149000, // $1,490/year (17% discount)
    };
  }

  // Enterprise: Custom pricing based on size
  let monthlyPrice = 49900; // $499/month base

  // Scale pricing based on MRR
  if (input.monthlyRevenue >= 2000000) {
    // $2M+ MRR
    monthlyPrice = 500000; // $5,000/month
  } else if (input.monthlyRevenue >= 1000000) {
    // $1M-2M MRR
    monthlyPrice = 300000; // $3,000/month
  } else if (input.monthlyRevenue >= 500000) {
    // $500K-1M MRR
    monthlyPrice = 150000; // $1,500/month
  }

  // Additional scaling for customer count
  if (input.customerCount >= 50000) {
    monthlyPrice = Math.round(monthlyPrice * 1.5);
  } else if (input.customerCount >= 25000) {
    monthlyPrice = Math.round(monthlyPrice * 1.3);
  }

  // Multi-platform premium
  if (input.platformCount > 5) {
    monthlyPrice = Math.round(monthlyPrice * 1.2);
  }

  const annualPrice = Math.round(monthlyPrice * 12 * 0.83); // 17% annual discount

  return {
    baseMonthlyPrice: monthlyPrice,
    baseAnnualPrice: annualPrice,
  };
}

/**
 * Calculate add-on pricing
 */
function calculateAddOns(input: PricingInput): PricingOutput['addOns'] {
  const addOns: PricingOutput['addOns'] = [];

  if (input.dedicatedInfrastructure) {
    addOns.push({
      name: 'Dedicated Infrastructure',
      monthlyPrice: 100000, // $1,000/month
      annualPrice: 996000, // $9,960/year (17% discount)
      description: 'Isolated VPC, dedicated resources, enhanced security',
    });
  }

  if (input.whiteLabel) {
    addOns.push({
      name: 'White-label',
      monthlyPrice: 50000, // $500/month
      annualPrice: 498000, // $4,980/year (17% discount)
      description: 'Custom branding, CNAME domain, remove RevenuePlug branding',
    });
  }

  if (input.additionalEngineeringHours && input.additionalEngineeringHours > 0) {
    const hourlyRate = 20000; // $200/hour
    const annualCost = input.additionalEngineeringHours * hourlyRate;

    addOns.push({
      name: `Additional Engineering Hours (${input.additionalEngineeringHours} hrs)`,
      monthlyPrice: 0, // Not monthly
      annualPrice: annualCost,
      description: 'Custom integrations, advanced customizations',
    });
  }

  if (input.smsRecovery) {
    addOns.push({
      name: 'SMS Recovery',
      monthlyPrice: 0, // Usage-based
      annualPrice: 0,
      description: 'SMS campaigns charged at cost (~$0.01/SMS)',
    });
  }

  return addOns;
}

/**
 * Calculate applicable discounts
 */
function calculateDiscounts(
  input: PricingInput,
  totalAnnualPrice: number
): PricingOutput['discounts'] {
  const discounts: PricingOutput['discounts'] = [];

  // Annual billing discount (already applied in base pricing)
  if (input.billingCycle === 'annual') {
    const annualDiscount = Math.round(totalAnnualPrice * 0.17);
    discounts.push({
      name: 'Annual Billing Discount',
      amount: annualDiscount,
      percentage: 17,
    });
  }

  // Multi-year discount
  if (input.contractLength === 24) {
    const multiYearDiscount = Math.round(totalAnnualPrice * 0.05);
    discounts.push({
      name: '24-Month Contract Discount',
      amount: multiYearDiscount,
      percentage: 5,
    });
  } else if (input.contractLength === 36) {
    const multiYearDiscount = Math.round(totalAnnualPrice * 0.10);
    discounts.push({
      name: '36-Month Contract Discount',
      amount: multiYearDiscount,
      percentage: 10,
    });
  }

  // Referral discount
  if (input.referralDiscount) {
    const referralDiscount = Math.round(totalAnnualPrice * 0.10);
    discounts.push({
      name: 'Referral Discount (First Year)',
      amount: referralDiscount,
      percentage: 10,
    });
  }

  // Nonprofit discount
  if (input.nonprofitDiscount) {
    const nonprofitDiscount = Math.round(totalAnnualPrice * 0.20);
    discounts.push({
      name: 'Nonprofit Discount',
      amount: nonprofitDiscount,
      percentage: 20,
    });
  }

  // Custom discount
  if (input.customDiscount && input.customDiscount > 0) {
    const customDiscount = Math.round(totalAnnualPrice * (input.customDiscount / 100));
    discounts.push({
      name: 'Custom Discount',
      amount: customDiscount,
      percentage: input.customDiscount,
    });
  }

  return discounts;
}

/**
 * Calculate ROI projection
 */
function calculateROI(input: PricingInput, finalAnnualPrice: number): PricingOutput['roi'] {
  // Estimate failed payment volume
  let monthlyFailures = 0;

  if (input.estimatedAtRisk) {
    monthlyFailures = input.estimatedAtRisk;
  } else if (input.estimatedFailureRate && input.monthlyRevenue) {
    monthlyFailures = Math.round((input.monthlyRevenue * input.estimatedFailureRate) / 100);
  } else {
    // Default assumption: 5% failure rate
    monthlyFailures = Math.round(input.monthlyRevenue * 0.05);
  }

  // Conservative recovery estimate: 40%
  const recoveryRate = 0.4;
  const estimatedMonthlyRecovery = Math.round(monthlyFailures * recoveryRate);
  const estimatedAnnualRecovery = estimatedMonthlyRecovery * 12;

  // ROI calculation
  const roiMultiplier = estimatedAnnualRecovery / (finalAnnualPrice / 100); // Convert cents to dollars
  const netAnnualGain = estimatedAnnualRecovery - finalAnnualPrice / 100;

  // Payback period
  const monthlySubscriptionCost = finalAnnualPrice / 12 / 100;
  const paybackMonths = Math.ceil(monthlySubscriptionCost / estimatedMonthlyRecovery);

  return {
    estimatedMonthlyRecovery,
    estimatedAnnualRecovery,
    roiMultiplier: Number(roiMultiplier.toFixed(1)),
    paybackMonths,
    netAnnualGain,
  };
}

/**
 * Calculate implementation details
 */
function calculateImplementation(
  input: PricingInput,
  basePlan: 'PRO' | 'ENTERPRISE'
): PricingOutput['implementation'] {
  let estimatedHours = 20; // Base implementation
  let timeline = '4 weeks';
  let cost = 0; // Included

  if (basePlan === 'ENTERPRISE') {
    // More complex implementation
    estimatedHours = 40;

    // Add hours for each platform
    estimatedHours += (input.platformCount - 1) * 8;

    // Add hours for custom features
    if (input.dedicatedInfrastructure) estimatedHours += 16;
    if (input.whiteLabel) estimatedHours += 12;

    if (estimatedHours > 60) {
      timeline = '6 weeks';
    }
  }

  return {
    estimatedHours,
    timeline,
    cost, // Included in Enterprise
  };
}

/**
 * Generate contract terms
 */
function generateContractTerms(
  input: PricingInput,
  finalAnnualPrice: number
): PricingOutput['contract'] {
  const monthlyEquivalent = finalAnnualPrice / 12;

  return {
    length: input.contractLength,
    earlyTerminationFees: {
      months1to6: Math.round(monthlyEquivalent * (12 - 6)), // Full remaining
      months7to12: Math.round(monthlyEquivalent * (12 - 6) * 0.5), // 50% of remaining
      after12: 0, // No fee, just 60-day notice
    },
    autoRenewal: true,
    priceProtection:
      input.contractLength >= 24
        ? 'Locked for contract term, then max 5% annual increases'
        : 'Year 1 locked, then max 5% annual increases',
  };
}

/**
 * Generate pricing recommendations
 */
function generateRecommendations(
  input: PricingInput,
  basePlan: 'PRO' | 'ENTERPRISE'
): string[] {
  const recommendations: string[] = [];

  // Annual billing recommendation
  if (input.billingCycle === 'monthly') {
    recommendations.push(
      'Switch to annual billing to save 17% ($' +
        Math.round((input.monthlyRevenue * 0.17) / 100).toLocaleString() +
        '/year)'
    );
  }

  // Multi-year contract recommendation
  if (input.contractLength === 12) {
    recommendations.push(
      'Consider 24-month contract for additional 5% discount or 36-month for 10% discount'
    );
  }

  // Platform consolidation
  if (input.platformCount > 3 && basePlan === 'PRO') {
    recommendations.push(
      'With ' +
        input.platformCount +
        ' platforms, Enterprise plan provides better value with unlimited connections'
    );
  }

  // Volume discount opportunity
  if (input.monthlyRevenue >= 500000 && basePlan === 'PRO') {
    recommendations.push(
      'Your revenue scale ($' +
        (input.monthlyRevenue / 1000).toFixed(0) +
        'K MRR) qualifies for custom Enterprise pricing with volume discounts'
    );
  }

  // ROI messaging
  if (input.estimatedAtRisk && input.estimatedAtRisk > 100000) {
    recommendations.push(
      'With $' +
        (input.estimatedAtRisk / 100).toLocaleString() +
        ' at risk, even 40% recovery pays for the subscription in less than 1 month'
    );
  }

  return recommendations;
}

/**
 * Format pricing output for proposal/email
 */
export function formatPricingForProposal(pricing: PricingOutput): string {
  const lines: string[] = [];

  lines.push(`## Pricing Summary`);
  lines.push(``);
  lines.push(`**Base Plan:** ${pricing.basePlan}`);
  lines.push(
    `**Base Price:** $${(pricing.baseMonthlyPrice / 100).toLocaleString()}/month or $${(pricing.baseAnnualPrice / 100).toLocaleString()}/year`
  );
  lines.push(``);

  if (pricing.addOns.length > 0) {
    lines.push(`**Add-ons:**`);
    pricing.addOns.forEach((addon) => {
      const price =
        addon.annualPrice > 0
          ? `$${(addon.annualPrice / 100).toLocaleString()}/year`
          : 'Usage-based';
      lines.push(`- ${addon.name}: ${price}`);
    });
    lines.push(``);
  }

  if (pricing.discounts.length > 0) {
    lines.push(`**Discounts:**`);
    pricing.discounts.forEach((discount) => {
      lines.push(
        `- ${discount.name}: -$${(discount.amount / 100).toLocaleString()} (${discount.percentage}%)`
      );
    });
    lines.push(``);
  }

  lines.push(`**Final Price:**`);
  lines.push(
    `- Monthly: $${(pricing.finalMonthlyPrice / 100).toLocaleString()}/month`
  );
  lines.push(
    `- Annual: $${(pricing.finalAnnualPrice / 100).toLocaleString()}/year`
  );
  lines.push(``);

  lines.push(`## ROI Projection`);
  lines.push(``);
  lines.push(
    `- Estimated Monthly Recovery: $${pricing.roi.estimatedMonthlyRecovery.toLocaleString()}`
  );
  lines.push(
    `- Estimated Annual Recovery: $${pricing.roi.estimatedAnnualRecovery.toLocaleString()}`
  );
  lines.push(`- ROI: ${pricing.roi.roiMultiplier}x`);
  lines.push(`- Payback Period: ${pricing.roi.paybackMonths} months`);
  lines.push(
    `- Net Annual Gain: $${pricing.roi.netAnnualGain.toLocaleString()}`
  );

  return lines.join('\n');
}
