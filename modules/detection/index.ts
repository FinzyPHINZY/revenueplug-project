/**
 * Detection Engine Module
 *
 * Comprehensive customer health monitoring and churn prediction system
 */

// Health Score
export {
  calculateHealthScore,
  saveHealthScore,
  getLatestHealthScore,
  calculateAndSaveHealthScore,
  batchCalculateHealthScores,
} from './health-score.js';

// Churn Risk
export {
  analyzeChurnRisk,
  saveChurnRiskAnalysis,
  analyzeAndSaveChurnRisk,
  getLatestChurnRisk,
  getHighRiskCustomers,
} from './churn-risk.js';

// Behavioral Tracking
export {
  trackEvent,
  trackLogin,
  trackLogout,
  trackFeatureUsage,
  trackApiCall,
  trackPaymentMethodUpdate,
  trackSettingsChange,
  trackSupportTicket,
  trackDataExport,
  trackIntegrationAdded,
  trackTeamMemberAdded,
  getEventCount,
  getRecentEvents,
  getEventTimeline,
  analyzeBehavioralPatterns,
  batchTrackEvents,
  cleanupOldEvents,
} from './behavioral-tracking.js';

// Usage Trends
export {
  recordUsageMetric,
  aggregateApiUsage,
  aggregateLoginUsage,
  aggregateActiveUsers,
  aggregateFeatureUsage,
  aggregateAllMetrics,
  getUsageTrend,
  getUsageHistory,
  detectUsageAnomalies,
  getUsageSummary,
  batchAggregateMetrics,
  scheduleDailyAggregation,
} from './usage-trends.js';

// Payment Prediction (Historical Analysis)
export {
  analyzePaymentPattern,
  savePaymentPattern,
  analyzeAndSavePaymentPattern,
  getLatestPaymentPattern,
  getHighPaymentRiskCustomers,
  batchAnalyzePaymentPatterns,
} from './payment-prediction.js';

// Payment Failure Prediction (Future Prediction)
export {
  predictInvoiceFailure,
  predictUpcomingInvoiceFailures,
  getHighRiskPredictions,
  PredictionRiskLevel,
  PredictionModel,
  type PaymentFailurePrediction,
} from './payment-failure-prediction.js';
