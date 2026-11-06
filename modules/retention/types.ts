/**
 * TypeScript types and interfaces for Retention Campaigns & Actions system
 */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import type {
  ActionPriority,
  ActionType,
  Campaign,
  CampaignAction,
  CampaignActionStatus,
  CampaignStatus,
  CampaignTriggerType,
  EmailTemplateCategory,
  EmailTemplateStatus,
  MetricPeriod,
  RetentionStrategyStatus,
} from '@prisma/client';

// ============================================================================
// TRIGGER CONDITIONS
// ============================================================================

export interface TriggerConditions {
  // Churn risk triggers
  churnRiskLevel?: Array<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'>;
  minChurnScore?: number; // 0-100

  // Payment failure triggers
  paymentFailed?: boolean;
  paymentFailureCount?: number; // Min number of failures

  // Trial ending triggers
  trialEnding?: boolean;
  trialDaysRemaining?: number; // Max days remaining

  // Subscription cancellation triggers
  subscriptionCancelled?: boolean;

  // Usage decline triggers
  usageDecline?: boolean;
  usageDeclinePercent?: number; // Min % decline

  // Health score triggers
  minHealthScore?: number; // 0-100
  maxHealthScore?: number; // 0-100
}

// ============================================================================
// AUDIENCE FILTERS
// ============================================================================

export interface AudienceFilters {
  // Subscription filters
  subscriptionStatus?: string[]; // ACTIVE, TRIALING, etc.
  minMRR?: number; // In cents
  maxMRR?: number; // In cents

  // Customer filters
  customerEmail?: string[]; // Specific emails
  customerExclude?: string[]; // Exclude specific customers

  // Time filters
  subscriptionAgeMinDays?: number; // Min subscription age in days
  subscriptionAgeMaxDays?: number; // Max subscription age in days
}

// ============================================================================
// ACTION CONFIGURATIONS
// ============================================================================

export interface BaseActionConfig {
  type: ActionType;
  delayMinutes: number; // Delay from campaign start or previous action
}

export interface EmailActionConfig extends BaseActionConfig {
  type: 'EMAIL';
  templateId: string;
  personalizations?: Record<string, any>; // Custom merge tag values
  subject?: string; // Override template subject
}

export interface DiscountActionConfig extends BaseActionConfig {
  type: 'DISCOUNT';
  discountPercent: number; // 1-100
  durationMonths: number; // 0 = one-time, >0 = repeating
  name?: string; // Coupon name
}

export interface PersonalOutreachActionConfig extends BaseActionConfig {
  type: 'PERSONAL_OUTREACH';
  taskDescription: string;
  assignedTo?: string; // Sales rep email or ID
  priority?: 'HIGH' | 'MEDIUM' | 'LOW';
  dueInDays?: number; // Task due in X days
}

export interface UsageNudgeActionConfig extends BaseActionConfig {
  type: 'USAGE_NUDGE';
  eventName: string; // Mixpanel event name
  properties?: Record<string, any>; // Event properties
  message?: string; // Nudge message
}

export interface FeatureHighlightActionConfig extends BaseActionConfig {
  type: 'FEATURE_HIGHLIGHT';
  feature: string; // Feature to highlight
  message: string; // Highlight message
  templateId?: string; // Optional email template
}

export type ActionConfig =
  | EmailActionConfig
  | DiscountActionConfig
  | PersonalOutreachActionConfig
  | UsageNudgeActionConfig
  | FeatureHighlightActionConfig;

// ============================================================================
// SERVICE FUNCTION PARAMETERS
// ============================================================================

export interface CreateStrategyParams {
  organizationId: string;
  name: string;
  description?: string;
  triggerConditions: TriggerConditions;
  audienceFilters?: AudienceFilters;
  actions: ActionConfig[];
  cooldownDays: number;
  maxActionsPerCustomer?: number;
  priority: ActionPriority;
}

export interface UpdateStrategyParams {
  name?: string;
  description?: string;
  status?: RetentionStrategyStatus;
  triggerConditions?: TriggerConditions;
  audienceFilters?: AudienceFilters;
  actions?: ActionConfig[];
  cooldownDays?: number;
  maxActionsPerCustomer?: number;
  priority?: ActionPriority;
}

export interface TriggerCampaignParams {
  strategyId: string;
  customerId: string;
  triggerType: CampaignTriggerType;
  triggerContext: Record<string, any>;
}

export interface CreateEmailTemplateParams {
  organizationId: string;
  name: string;
  description?: string;
  category: EmailTemplateCategory;
  subject: string;
  htmlBody: string;
  textBody?: string;
  availableTags: string[];
  status?: EmailTemplateStatus;
}

export interface UpdateEmailTemplateParams {
  name?: string;
  description?: string;
  category?: EmailTemplateCategory;
  status?: EmailTemplateStatus;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  availableTags?: string[];
}

export interface CalculateCampaignMetricsParams {
  organizationId: string;
  strategyId?: string;
  period: Date;
  periodType: MetricPeriod;
}

// ============================================================================
// ACTION EXECUTION RESULTS
// ============================================================================

export interface EmailExecutionResult {
  messageId: string;
  provider: 'resend';
  deliveredAt?: string;
  openedAt?: string;
  clickedAt?: string;
  bouncedAt?: string;
  errorMessage?: string;
}

export interface DiscountExecutionResult {
  stripeCouponId: string;
  discountPercent: number;
  durationMonths: number;
  appliedToSubscription?: string; // Subscription external ID
  errorMessage?: string;
}

export interface PersonalOutreachExecutionResult {
  hubspotTaskId?: string;
  assignedTo: string;
  taskDescription: string;
  createdAt: string;
  errorMessage?: string;
}

export interface UsageNudgeExecutionResult {
  mixpanelEventId?: string;
  eventName: string;
  properties: Record<string, any>;
  sentAt: string;
  errorMessage?: string;
}

export type ActionExecutionResult =
  | EmailExecutionResult
  | DiscountExecutionResult
  | PersonalOutreachExecutionResult
  | UsageNudgeExecutionResult;

export interface ExecuteActionResult {
  success: boolean;
  result?: ActionExecutionResult;
  error?: string;
}

// ============================================================================
// TEMPLATE RENDERING
// ============================================================================

export interface TemplateData {
  // Customer data
  customerName?: string;
  customerEmail?: string;

  // Subscription data
  planName?: string;
  amount?: number; // In cents
  currency?: string;
  trialEndDate?: Date;
  currentPeriodEnd?: Date;

  // Campaign data
  discountCode?: string;
  discountPercent?: number;

  // Custom data
  [key: string]: any;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text?: string;
}

// ============================================================================
// CAMPAIGN STATS
// ============================================================================

export interface CampaignStats {
  activeCampaigns: number;
  conversionRate: number; // Percentage
  revenueRecovered: number; // In cents
  topStrategies: Array<{
    strategyId: string;
    strategyName: string;
    conversions: number;
    revenueRecovered: number;
  }>;
  recentCampaigns: Array<{
    id: string;
    customerName: string;
    status: CampaignStatus;
    triggerType: CampaignTriggerType;
    startedAt: Date;
    convertedAt?: Date;
  }>;
}

// ============================================================================
// CAMPAIGN EXPORTS (with related data)
// ============================================================================

export interface CampaignWithRelations extends Campaign {
  customer: {
    id: string;
    externalId: string;
    email: string | null;
    name: string | null;
  };
  organization: {
    id: string;
    name: string;
  };
  actions: CampaignAction[];
}

export interface CampaignActionWithCampaign extends CampaignAction {
  campaign: CampaignWithRelations;
}

// ============================================================================
// QUEUE JOB DATA
// ============================================================================

export interface CampaignActionJobData {
  actionId: string;
  campaignId: string;
  customerId: string;
  organizationId: string;
}

// ============================================================================
// WEBHOOK EVENT TYPES
// ============================================================================

export interface ResendEmailEvent {
  type: 'email.delivered' | 'email.opened' | 'email.clicked' | 'email.bounced';
  data: {
    email_id: string;
    to: string;
    from: string;
    subject: string;
    tags: Array<{ name: string; value: string }>;
    created_at: string;
  };
}

// ============================================================================
// STRATEGY EVALUATION
// ============================================================================

export interface StrategyEvaluationResult {
  matches: boolean;
  context?: Record<string, any>;
  reason?: string; // Why it didn't match
}

// ============================================================================
// RE-EXPORTS FROM PRISMA
// ============================================================================

export type {
  ActionPriority,
  ActionType,
  Campaign,
  CampaignAction,
  CampaignActionStatus,
  CampaignStatus,
  CampaignTriggerType,
  EmailTemplateCategory,
  EmailTemplateStatus,
  MetricPeriod,
  RetentionStrategyStatus,
};
