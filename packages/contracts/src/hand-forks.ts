import { z } from "zod";
import { pokerActionSchema } from "./model-protocol.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nullableTokenCountSchema = z.number().int().nonnegative().nullable();

export const handForkStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);
export type HandForkStatus = z.infer<typeof handForkStatusSchema>;

export const handForkTargetStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type HandForkTargetStatus = z.infer<typeof handForkTargetStatusSchema>;

export const handForkTrialStatusSchema = z.enum(["RUNNING", "COMPLETED", "CANCELLED"]);
export type HandForkTrialStatus = z.infer<typeof handForkTrialStatusSchema>;

export const handForkTrialOutcomeSchema = z.enum([
  "MODEL_ACTION",
  "PROTOCOL_FALLBACK",
  "INFRA_ERROR",
  "CANCELLED",
]);
export type HandForkTrialOutcome = z.infer<typeof handForkTrialOutcomeSchema>;

export const handForkTurnOutcomeSchema = z.enum(["SUCCESS", "PROTOCOL_ERROR", "INFRA_ERROR"]);
export type HandForkTurnOutcome = z.infer<typeof handForkTurnOutcomeSchema>;

export const handForkSourceErrorCodeSchema = z.enum([
  "SOURCE_NOT_FOUND",
  "TOURNAMENT_NOT_COMPLETED",
  "HAND_NOT_COMPLETED",
  "DECISION_NOT_SUCCEEDED",
  "DECISION_AUDIT_INCOMPLETE",
  "SOURCE_SNAPSHOT_MISSING",
  "SOURCE_CHAIN_MISMATCH",
  "VISIBLE_INPUT_MISMATCH",
  "LEGAL_CONTRACT_MISMATCH",
  "SOURCE_PROTOCOL_UNSUPPORTED",
]);
export type HandForkSourceErrorCode = z.infer<typeof handForkSourceErrorCodeSchema>;

export const handForkLegalActionsSchema = z.object({
  allowed: z.array(pokerActionSchema).min(1).max(6),
  call: z.object({
    amount: z.number().int().nonnegative(),
    will_be_all_in: z.boolean(),
  }).strict().nullable(),
  bet: z.object({
    min_amount_to: z.number().int().positive(),
    max_amount_to: z.number().int().positive(),
  }).strict().nullable(),
  raise: z.object({
    min_amount_to: z.number().int().positive(),
    max_amount_to: z.number().int().positive(),
  }).strict().nullable(),
  all_in: z.object({
    resulting_street_commitment: z.number().int().positive(),
    classification: z.enum(["call", "bet", "raise", "short_raise"]),
  }).strict().nullable(),
}).strict().superRefine((legal, context) => {
  if (new Set(legal.allowed).size !== legal.allowed.length) {
    context.addIssue({ code: "custom", path: ["allowed"], message: "Legal actions must be unique" });
  }
  for (const action of ["call", "bet", "raise", "all_in"] as const) {
    if (legal.allowed.includes(action) !== (legal[action] !== null)) {
      context.addIssue({
        code: "custom",
        path: [action],
        message: `${action} details must match the allowed action set`,
      });
    }
  }
  for (const action of ["bet", "raise"] as const) {
    const bounds = legal[action];
    if (bounds && bounds.max_amount_to < bounds.min_amount_to) {
      context.addIssue({
        code: "custom",
        path: [action],
        message: `${action} maximum must not be below its minimum`,
      });
    }
  }
});
export type HandForkLegalActions = z.infer<typeof handForkLegalActionsSchema>;

export const handForkSourceSummarySchema = z.object({
  tournamentId: z.string().uuid(),
  tournamentName: z.string().min(1).max(200),
  handNo: z.number().int().positive(),
  decisionId: z.string().uuid(),
  playerId: z.string().min(1).max(200),
  playerDisplayName: z.string().min(1).max(200),
  street: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]),
  heroPosition: z.string().min(1).max(32),
  holeCards: z.array(z.string().regex(/^[2-9TJQKA][cdhs]$/)).length(2),
  legalActions: handForkLegalActionsSchema,
  originalAction: pokerActionSchema,
  originalAmountTo: z.number().int().positive().nullable(),
  originalDecisionSummary: z.string().max(300).nullable(),
  originalUsedFallback: z.boolean(),
  actionEventSequence: z.number().int().positive(),
}).strict().superRefine((source, context) => {
  if ((source.originalAction === "bet" || source.originalAction === "raise")
    !== (source.originalAmountTo !== null)) {
    context.addIssue({
      code: "custom",
      path: ["originalAmountTo"],
      message: "Only an original bet or raise uses originalAmountTo",
    });
  }
});
export type HandForkSourceSummary = z.infer<typeof handForkSourceSummarySchema>;

export const handForkSourceIntegritySchema = z.object({
  expectedAggregateVersion: z.number().int().positive(),
  sourceEventHash: sha256Schema,
  sourceRequestHash: sha256Schema,
  sourcePayloadHash: sha256Schema,
  visibleInputHash: sha256Schema,
  legalContractHash: sha256Schema,
  protocolBundleId: z.string().min(1).max(160),
  rulesetVersion: z.string().min(1).max(160),
  contextVersion: z.string().min(1).max(160),
  systemPromptHash: sha256Schema,
  outputSchemaHash: sha256Schema,
  parserPolicyVersion: z.string().min(1).max(160),
  adapterProtocolVersion: z.string().min(1).max(160),
  historyProtocolVersion: z.string().min(1).max(160),
  correctionProtocolVersion: z.string().min(1).max(160),
}).strict();
export type HandForkSourceIntegrity = z.infer<typeof handForkSourceIntegritySchema>;

const handForkSourceCandidateAnchorSchema = z.object({
  decisionId: z.string().uuid(),
  playerId: z.string().min(1).max(200),
  expectedAggregateVersion: z.number().int().positive(),
}).strict();

export const handForkSourceCandidateSchema = z.discriminatedUnion("availability", [
  handForkSourceCandidateAnchorSchema.extend({
    availability: z.literal("AVAILABLE"),
    source: handForkSourceSummarySchema,
    sourceIntegrity: handForkSourceIntegritySchema,
  }).strict(),
  handForkSourceCandidateAnchorSchema.extend({
    availability: z.literal("UNAVAILABLE"),
    reasonCode: handForkSourceErrorCodeSchema,
  }).strict(),
]).superRefine((candidate, context) => {
  if (candidate.availability !== "AVAILABLE") return;
  if (candidate.source.decisionId !== candidate.decisionId) {
    context.addIssue({
      code: "custom",
      path: ["source", "decisionId"],
      message: "Available source decisionId must match its discovery anchor",
    });
  }
  if (candidate.source.playerId !== candidate.playerId) {
    context.addIssue({
      code: "custom",
      path: ["source", "playerId"],
      message: "Available source playerId must match its discovery anchor",
    });
  }
  if (candidate.sourceIntegrity.expectedAggregateVersion !== candidate.expectedAggregateVersion) {
    context.addIssue({
      code: "custom",
      path: ["sourceIntegrity", "expectedAggregateVersion"],
      message: "Available source version must match its discovery anchor",
    });
  }
});
export type HandForkSourceCandidate = z.infer<typeof handForkSourceCandidateSchema>;

export const handForkProviderUsageSchema = z.object({
  inputTokens: nullableTokenCountSchema,
  outputTokens: nullableTokenCountSchema,
  totalTokens: nullableTokenCountSchema,
}).strict();
export type HandForkProviderUsage = z.infer<typeof handForkProviderUsageSchema>;

export const handForkTurnMetadataSchema = z.object({
  turnIndex: z.number().int().positive(),
  requestHash: sha256Schema,
  responseHash: sha256Schema.nullable(),
  responseRecorded: z.boolean(),
  outcome: handForkTurnOutcomeSchema,
  errorKind: z.string().max(120).nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  usage: handForkProviderUsageSchema.nullable(),
  providerConfigHash: sha256Schema,
  outputSchemaVersion: z.string().min(1).max(160),
  outputSchemaHash: sha256Schema,
  adapterVersion: z.string().max(160).nullable(),
  appliedOutputMode: z.string().max(80).nullable(),
  finishReason: z.string().max(160).nullable(),
  refusalHash: sha256Schema.nullable(),
  refusalRecorded: z.boolean(),
  responseModel: z.string().max(200).nullable(),
  createdAt: z.string().datetime(),
}).strict().superRefine((turn, context) => {
  if (turn.responseRecorded !== (turn.responseHash !== null)) {
    context.addIssue({
      code: "custom",
      path: ["responseRecorded"],
      message: "responseRecorded must match responseHash presence",
    });
  }
  if (turn.refusalRecorded !== (turn.refusalHash !== null)) {
    context.addIssue({
      code: "custom",
      path: ["refusalRecorded"],
      message: "refusalRecorded must match refusalHash presence",
    });
  }
});
export type HandForkTurnMetadata = z.infer<typeof handForkTurnMetadataSchema>;

export const handForkTrialSchema = z.object({
  id: z.string().uuid(),
  sampleIndex: z.number().int().min(1).max(20),
  status: handForkTrialStatusSchema,
  outcome: handForkTrialOutcomeSchema.nullable(),
  action: pokerActionSchema.nullable(),
  amountTo: z.number().int().positive().nullable(),
  decisionSummary: z.string().max(300).nullable(),
  usedFallback: z.boolean(),
  firstTurnValid: z.boolean(),
  historyQueryCount: z.number().int().nonnegative(),
  protocolFailures: z.number().int().nonnegative(),
  infrastructureFailures: z.number().int().nonnegative(),
  callCount: z.number().int().nonnegative(),
  totalLatencyMs: z.number().int().nonnegative().nullable(),
  usage: handForkProviderUsageSchema.nullable(),
  visibleInputHash: sha256Schema,
  errorKind: z.string().max(120).nullable(),
  errorMessage: z.string().max(1_000).nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  turns: z.array(handForkTurnMetadataSchema).optional(),
}).strict().superRefine((trial, context) => {
  const terminal = trial.status === "COMPLETED" || trial.status === "CANCELLED";
  if (terminal !== (trial.completedAt !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal trials require completedAt" });
  }
  if (trial.status === "RUNNING" && trial.outcome !== null) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "Running trials cannot have an outcome" });
  }
  if (trial.status === "COMPLETED" && trial.outcome === null) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "Completed trials require an outcome" });
  }
  if (trial.status === "CANCELLED" && trial.outcome !== "CANCELLED") {
    context.addIssue({ code: "custom", path: ["outcome"], message: "Cancelled trials require CANCELLED outcome" });
  }
  if (trial.outcome === "MODEL_ACTION" && (trial.action === null || trial.usedFallback)) {
    context.addIssue({ code: "custom", path: ["action"], message: "MODEL_ACTION requires a non-fallback action" });
  }
  if (trial.outcome === "PROTOCOL_FALLBACK" && (trial.action === null || !trial.usedFallback)) {
    context.addIssue({ code: "custom", path: ["usedFallback"], message: "PROTOCOL_FALLBACK requires a fallback action" });
  }
  if ((trial.action === "bet" || trial.action === "raise") !== (trial.amountTo !== null)) {
    context.addIssue({ code: "custom", path: ["amountTo"], message: "Only bet and raise use amountTo" });
  }
  if ((trial.outcome === "MODEL_ACTION" || trial.outcome === "PROTOCOL_FALLBACK")
    !== (trial.action !== null)) {
    context.addIssue({ code: "custom", path: ["action"], message: "Only action outcomes contain a poker action" });
  }
  if ((trial.outcome === "PROTOCOL_FALLBACK") !== trial.usedFallback) {
    context.addIssue({ code: "custom", path: ["usedFallback"], message: "usedFallback must identify only protocol fallback" });
  }
});
export type HandForkTrial = z.infer<typeof handForkTrialSchema>;

export const handForkSizingSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  median: z.number().nonnegative(),
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
}).strict();

export const handForkTargetSummarySchema = z.object({
  requestedSamples: z.number().int().min(1).max(20),
  terminalTrials: z.number().int().nonnegative(),
  terminalCoverage: z.number().min(0).max(1),
  completedTrials: z.number().int().nonnegative(),
  reliabilityEligibleTrials: z.number().int().nonnegative(),
  modelActionTrials: z.number().int().nonnegative(),
  actionDistributionTrials: z.number().int().nonnegative(),
  modelActionCoverage: z.number().min(0).max(1),
  fallbackTrials: z.number().int().nonnegative(),
  infrastructureErrorTrials: z.number().int().nonnegative(),
  cancelledTrials: z.number().int().nonnegative(),
  modalAction: pokerActionSchema.nullable(),
  modalCount: z.number().int().nonnegative(),
  modalShare: z.number().min(0).max(1).nullable(),
  pairwiseAgreement: z.number().min(0).max(1).nullable(),
  pairwiseComparisonPairs: z.number().int().nonnegative(),
  actionDistribution: z.record(z.string(), z.number().int().nonnegative()),
  sizing: z.record(z.string(), handForkSizingSummarySchema),
  firstTurnValidRate: z.number().min(0).max(1).nullable(),
  historyQueryRate: z.number().min(0).max(1).nullable(),
  correctionRate: z.number().min(0).max(1).nullable(),
  latencyObservedTrials: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().int().nonnegative().nullable(),
  tokenObservedTrials: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().nullable(),
}).strict().superRefine((summary, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (summary.terminalTrials !== summary.completedTrials + summary.cancelledTrials) {
    issue("terminalTrials", "terminalTrials must equal completedTrials plus cancelledTrials");
  }
  if (summary.completedTrials !== summary.modelActionTrials
    + summary.fallbackTrials + summary.infrastructureErrorTrials) {
    issue("completedTrials", "completedTrials must equal all non-cancelled outcomes");
  }
  if (summary.reliabilityEligibleTrials !== summary.completedTrials) {
    issue("reliabilityEligibleTrials", "Reliability rates use completedTrials as their denominator");
  }
  if (summary.actionDistributionTrials !== summary.modelActionTrials) {
    issue("actionDistributionTrials", "Action distributions use only model actions");
  }
  if (summary.terminalTrials > summary.requestedSamples) {
    issue("terminalTrials", "terminalTrials cannot exceed requestedSamples");
  }
  if (summary.terminalCoverage !== summary.terminalTrials / summary.requestedSamples) {
    issue("terminalCoverage", "terminalCoverage must use requestedSamples as its denominator");
  }
  if (summary.modelActionCoverage !== summary.modelActionTrials / summary.requestedSamples) {
    issue("modelActionCoverage", "modelActionCoverage must use requestedSamples as its denominator");
  }
  const distributionTotal = Object.entries(summary.actionDistribution).reduce((total, [action, count]) => {
    if (!pokerActionSchema.safeParse(action).success) issue("actionDistribution", `Unknown poker action: ${action}`);
    return total + count;
  }, 0);
  if (distributionTotal !== summary.actionDistributionTrials) {
    issue("actionDistribution", "Action distribution counts must match actionDistributionTrials");
  }
  const expectedPairs = summary.actionDistributionTrials * (summary.actionDistributionTrials - 1) / 2;
  if (summary.pairwiseComparisonPairs !== expectedPairs) {
    issue("pairwiseComparisonPairs", "Pairwise denominator must contain every unordered model-action pair");
  }
  if ((summary.pairwiseComparisonPairs === 0) !== (summary.pairwiseAgreement === null)) {
    issue("pairwiseAgreement", "Pairwise agreement is available exactly when comparison pairs exist");
  }
  if (summary.modalCount > summary.actionDistributionTrials
    || (summary.modalAction === null) !== (summary.actionDistributionTrials === 0)) {
    issue("modalAction", "Modal action coverage is inconsistent with the action distribution");
  }
  if ((summary.actionDistributionTrials === 0) !== (summary.modalShare === null)) {
    issue("modalShare", "Modal share is available exactly when model actions exist");
  }
  if (summary.latencyObservedTrials > summary.reliabilityEligibleTrials) {
    issue("latencyObservedTrials", "Latency coverage cannot exceed reliabilityEligibleTrials");
  }
  if ((summary.latencyObservedTrials === 0)
    !== (summary.averageLatencyMs === null && summary.p95LatencyMs === null)) {
    issue("averageLatencyMs", "Latency statistics require a non-zero latency denominator");
  }
  if (summary.tokenObservedTrials > summary.reliabilityEligibleTrials) {
    issue("tokenObservedTrials", "Token coverage cannot exceed reliabilityEligibleTrials");
  }
  if ((summary.tokenObservedTrials === 0) !== (summary.totalTokens === null)) {
    issue("totalTokens", "Token totals require a non-zero token denominator");
  }
  for (const [name, rate] of [["firstTurnValidRate", summary.firstTurnValidRate],
    ["historyQueryRate", summary.historyQueryRate], ["correctionRate", summary.correctionRate]] as const) {
    if ((summary.reliabilityEligibleTrials === 0) !== (rate === null)) {
      issue(name, `${name} requires reliabilityEligibleTrials`);
    }
  }
});
export type HandForkTargetSummary = z.infer<typeof handForkTargetSummarySchema>;

export const handForkTargetSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().min(1).max(9),
  modelConfigId: z.string().uuid(),
  competitorRevisionId: z.string().uuid(),
  competitorFamilyId: z.string().uuid(),
  modelDisplayName: z.string().min(1).max(200),
  modelId: z.string().min(1).max(300),
  providerProfile: z.string().min(1).max(120),
  modelConfigurationHash: sha256Schema,
  effectiveOutputMode: z.string().min(1).max(80),
  sampleCount: z.number().int().min(1).max(20),
  status: handForkTargetStatusSchema,
  terminalTrials: z.number().int().nonnegative(),
  summary: handForkTargetSummarySchema.nullable(),
  errorMessage: z.string().max(1_000).nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  trials: z.array(handForkTrialSchema).optional(),
}).strict().superRefine((target, context) => {
  const terminal = target.status === "COMPLETED" || target.status === "FAILED" || target.status === "CANCELLED";
  if (terminal !== (target.completedAt !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal targets require completedAt" });
  }
  if (terminal && target.summary === null) {
    context.addIssue({ code: "custom", path: ["summary"], message: "Terminal targets require a summary" });
  }
  if (target.terminalTrials > target.sampleCount) {
    context.addIssue({ code: "custom", path: ["terminalTrials"], message: "terminalTrials cannot exceed sampleCount" });
  }
  if (target.summary && target.summary.terminalTrials !== target.terminalTrials) {
    context.addIssue({ code: "custom", path: ["terminalTrials"], message: "Target and summary terminalTrials must match" });
  }
  if (target.status === "COMPLETED" && target.terminalTrials !== target.sampleCount) {
    context.addIssue({ code: "custom", path: ["terminalTrials"], message: "Completed targets require every sample to be terminal" });
  }
});
export type HandForkTarget = z.infer<typeof handForkTargetSchema>;

export const handForkAggregateSummarySchema = z.object({
  totalTargets: z.number().int().min(1).max(9),
  terminalTargets: z.number().int().nonnegative(),
  targetTerminalCoverage: z.number().min(0).max(1),
  completedTargets: z.number().int().nonnegative(),
  failedTargets: z.number().int().nonnegative(),
  cancelledTargets: z.number().int().nonnegative(),
  requestedTrials: z.number().int().nonnegative(),
  terminalTrials: z.number().int().nonnegative(),
  trialTerminalCoverage: z.number().min(0).max(1),
  completedTrials: z.number().int().nonnegative(),
  cancelledTrials: z.number().int().nonnegative(),
  modelActionTrials: z.number().int().nonnegative(),
  fallbackTrials: z.number().int().nonnegative(),
  infrastructureErrorTrials: z.number().int().nonnegative(),
}).strict().superRefine((summary, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (summary.terminalTargets !== summary.completedTargets + summary.failedTargets + summary.cancelledTargets) {
    issue("terminalTargets", "terminalTargets must equal all terminal target statuses");
  }
  if (summary.terminalTargets > summary.totalTargets) issue("terminalTargets", "terminalTargets cannot exceed totalTargets");
  if (summary.targetTerminalCoverage !== summary.terminalTargets / summary.totalTargets) {
    issue("targetTerminalCoverage", "targetTerminalCoverage must use totalTargets as its denominator");
  }
  if (summary.terminalTrials !== summary.completedTrials + summary.cancelledTrials) {
    issue("terminalTrials", "terminalTrials must equal completedTrials plus cancelledTrials");
  }
  if (summary.completedTrials !== summary.modelActionTrials
    + summary.fallbackTrials + summary.infrastructureErrorTrials) {
    issue("completedTrials", "completedTrials must equal all non-cancelled outcomes");
  }
  if (summary.terminalTrials > summary.requestedTrials) issue("terminalTrials", "terminalTrials cannot exceed requestedTrials");
  const expectedCoverage = summary.requestedTrials === 0 ? 0 : summary.terminalTrials / summary.requestedTrials;
  if (summary.trialTerminalCoverage !== expectedCoverage) {
    issue("trialTerminalCoverage", "trialTerminalCoverage must use requestedTrials as its denominator");
  }
});
export type HandForkAggregateSummary = z.infer<typeof handForkAggregateSummarySchema>;

export const adminHandForkSchema = z.object({
  id: z.string().uuid(),
  status: handForkStatusSchema,
  source: handForkSourceSummarySchema,
  sourceIntegrity: handForkSourceIntegritySchema,
  sampleCount: z.number().int().min(1).max(20),
  timeoutMs: z.number().int().min(30_000).max(600_000),
  maxParallelTargets: z.number().int().min(1).max(3),
  summary: handForkAggregateSummarySchema.nullable(),
  errorMessage: z.string().max(1_000).nullable(),
  createdByAdminUserId: z.string().uuid().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  targets: z.array(handForkTargetSchema).min(1).max(9),
}).strict().superRefine((fork, context) => {
  const terminal = fork.status === "COMPLETED" || fork.status === "PARTIAL"
    || fork.status === "FAILED" || fork.status === "CANCELLED";
  if (terminal !== (fork.completedAt !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal forks require completedAt" });
  }
  if (terminal && fork.summary === null) {
    context.addIssue({ code: "custom", path: ["summary"], message: "Terminal forks require a summary" });
  }
  if (fork.status === "RUNNING" && fork.startedAt === null) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "Running forks require startedAt" });
  }
});
export type AdminHandFork = z.infer<typeof adminHandForkSchema>;

export const createHandForkRequestSchema = z.object({
  sourceDecisionId: z.string().uuid(),
  modelConfigIds: z.array(z.string().uuid()).min(1).max(9),
  sampleCount: z.number().int().min(1).max(20),
  timeoutMs: z.number().int().min(30_000).max(600_000),
  maxParallelTargets: z.number().int().min(1).max(3).default(3),
}).strict().superRefine((request, context) => {
  if (new Set(request.modelConfigIds).size !== request.modelConfigIds.length) {
    context.addIssue({ code: "custom", path: ["modelConfigIds"], message: "Target models must be unique" });
  }
});
export type CreateHandForkRequest = z.infer<typeof createHandForkRequestSchema>;
