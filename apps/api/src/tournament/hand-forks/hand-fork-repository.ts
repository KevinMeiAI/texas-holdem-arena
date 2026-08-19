import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  actionDecisionResponseSchema,
  actionResponseSchema,
  encryptedPayloadSchema,
  handForkAggregateSummarySchema,
  handForkLegalActionsSchema,
  handForkProviderUsageSchema,
  handForkStatusSchema,
  handForkTargetStatusSchema,
  handForkTargetSummarySchema,
  handForkTrialOutcomeSchema,
  handForkTrialSchema,
  handForkTurnMetadataSchema,
  historyQuerySchema,
  pokerActionSchema,
  type ActionResponse,
  type CanonicalModelRequest,
  type HandForkAggregateSummary,
  type HandForkLegalActions,
  type HandForkProviderUsage,
  type HandForkStatus,
  type HandForkTarget,
  type HandForkTargetStatus,
  type HandForkTargetSummary,
  type HandForkTrial,
  type HandForkTrialOutcome,
  type HandForkTurnMetadata,
  type HandForkTurnOutcome,
} from "../../../../../packages/contracts/src/index.js";
import type { ActionCommand } from "../../../../../packages/domain/src/betting.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import type { ProviderErrorKind, ProviderTransportAudit } from "../../../../../packages/providers/src/provider.js";
import { decryptJson, encryptJson } from "../../security/encryption.js";
import type {
  CallAudit,
  DecisionResumeState,
  DecisionRunnerConfig,
} from "../decision-runner.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const POKER_ACTION_ORDER = ["fold", "check", "call", "bet", "raise", "all_in"] as const;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_TURN_REQUEST_BYTES = 512 * 1024;
const MAX_TURN_RESPONSE_BYTES = 256 * 1024;
const MAX_RESUME_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

const shortTextSchema = z.string().min(1).max(200);
const nullableShortTextSchema = z.string().max(200).nullable();
const providerErrorKindSchema = z.enum([
  "RATE_LIMIT", "SERVER", "NETWORK", "TIMEOUT", "AUTH", "CONFIG", "INVALID_RESPONSE",
]);
const callAuditSchema = z.object({
  attempt: z.number().int().positive(),
  outcome: z.enum(["SUCCESS", "PROTOCOL_ERROR", "INFRA_ERROR"]),
  errorKind: providerErrorKindSchema.nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  usage: handForkProviderUsageSchema.nullable(),
}).strict();
const historyQueryResultSchema = z.object({
  query: historyQuerySchema,
  records: z.array(z.unknown()).max(80),
  approximateTokens: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative().optional(),
  complete: z.boolean().optional(),
  truncated: z.boolean().optional(),
  truncationReason: z.enum(["RECORD_LIMIT", "BYTE_BUDGET"]).nullable().optional(),
  omittedRecords: z.number().int().nonnegative().optional(),
}).strict();
const transportAuditSchema = z.object({
  adapterVersion: z.string().min(1).max(160),
  renderedUserTextSha256: z.string().regex(SHA256_PATTERN),
  redactedWireBodySha256: z.string().regex(SHA256_PATTERN),
  appliedOutputMode: z.enum(["auto", "json_schema", "json_object", "prompt"]),
  appliedSchemaSha256: z.string().regex(SHA256_PATTERN).nullable(),
  finishReason: z.string().max(160).nullable(),
  refusal: z.string().max(100_000).nullable(),
  responseModel: z.string().max(200).nullable(),
  systemFingerprint: z.string().max(200).nullable(),
}).strict();
const decisionResumeStateSchema = z.object({
  historyResults: z.array(historyQueryResultSchema).max(20),
  protocolFailures: z.number().int().nonnegative(),
  correction: z.string().max(160).nullable(),
  calls: z.array(callAuditSchema).max(200),
  pendingHistoryQuery: historyQuerySchema.nullable().optional(),
  pendingOutput: z.object({
    turnIndex: z.number().int().positive(),
    parsed: actionDecisionResponseSchema,
    rawText: z.string().max(MAX_TURN_RESPONSE_BYTES),
    latencyMs: z.number().int().nonnegative(),
    usage: handForkProviderUsageSchema,
    providerRequestId: z.string().max(300).nullable(),
    transportAudit: transportAuditSchema.optional(),
  }).strict().nullable().optional(),
  pendingInfrastructureFailure: z.object({
    turnIndex: z.number().int().positive(),
    errorKind: providerErrorKindSchema,
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
    exhausted: z.boolean(),
    retryDelayMs: z.number().int().nonnegative().max(600_000),
  }).strict().nullable().optional(),
  infrastructureAttempts: z.number().int().nonnegative().max(20).optional(),
}).strict().superRefine((state, context) => {
  if (state.pendingOutput && state.pendingInfrastructureFailure) {
    context.addIssue({ code: "custom", path: ["pendingOutput"], message: "Only one pending provider result is allowed" });
  }
  if (state.pendingOutput && state.pendingHistoryQuery) {
    context.addIssue({ code: "custom", path: ["pendingOutput"], message: "Pending output and history query cannot coexist" });
  }
});
const canonicalModelRequestPersistenceSchema = z.object({
  requestId: shortTextSchema,
  expectedOutput: z.literal("ACTION_OR_HISTORY"),
  systemPrompt: z.string().min(1).max(100_000),
  systemPromptHash: z.string().regex(SHA256_PATTERN),
  outputSchema: z.object({
    version: shortTextSchema,
    name: shortTextSchema,
    schema: z.record(z.string().max(200), z.unknown()),
    sha256: z.string().regex(SHA256_PATTERN),
  }).strict().optional(),
  userPayload: z.record(z.string().max(200), z.unknown()),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  parserPolicy: z.enum(["arena-parser-legacy-v1", "arena-parser-strict-v1"]).optional(),
  adapterProtocolVersion: z.string().min(1).max(160).optional(),
}).strict();
const decisionConfigPersistenceSchema = z.object({
  maxInfrastructureAttempts: z.number().int().min(1).max(20),
  infrastructureRetryDelaysMs: z.array(z.number().int().nonnegative().max(600_000)).max(20),
  history: z.object({
    maxQueries: z.number().int().min(0).max(20),
    maxRecordsPerQuery: z.number().int().min(1).max(80),
    maxApproxTokens: z.number().int().min(0).max(1_000_000),
    maxBytes: z.number().int().min(0).max(4_000_000).optional(),
  }).strict(),
}).strict();
const sourcePayloadSchema = z.object({
  version: z.literal("hand-fork-source-v1"),
  source: z.object({
    tournamentName: z.string().min(1).max(200),
    playerDisplayName: z.string().min(1).max(200),
    street: z.enum(["PREFLOP", "FLOP", "TURN", "RIVER"]),
    heroPosition: z.string().min(1).max(32),
    holeCards: z.tuple([
      z.string().regex(/^[2-9TJQKA][cdhs]$/),
      z.string().regex(/^[2-9TJQKA][cdhs]$/),
    ]),
    legalActions: handForkLegalActionsSchema,
    originalAction: pokerActionSchema,
    originalAmountTo: z.number().int().positive().nullable(),
    originalDecisionSummary: z.string().max(300).nullable(),
    originalUsedFallback: z.boolean(),
    decisionEventSequence: z.number().int().positive(),
    snapshotChecksum: z.string().regex(SHA256_PATTERN),
  }).strict().superRefine((source, context) => {
    if ((source.originalAction === "bet" || source.originalAction === "raise")
      !== (source.originalAmountTo !== null)) {
      context.addIssue({ code: "custom", path: ["originalAmountTo"], message: "Only bet and raise use amountTo" });
    }
  }),
  baseRequest: canonicalModelRequestPersistenceSchema,
  decisionConfig: decisionConfigPersistenceSchema,
}).strict();
const turnResponseSchema = z.object({
  rawText: z.string().max(MAX_TURN_RESPONSE_BYTES),
  parsed: actionDecisionResponseSchema.optional(),
  providerRequestId: z.string().max(300).nullable(),
  transportAudit: transportAuditSchema.optional(),
}).strict();
const actionCommandSchema = z.union([
  z.object({ action: z.enum(["fold", "check", "call", "all_in"]) }).strict(),
  z.object({ action: z.enum(["bet", "raise"]), amountTo: z.number().int().positive() }).strict(),
]);
const trialResultSchema = z.object({
  version: z.literal("hand-fork-trial-result-v1"),
  requestId: z.string().uuid(),
  status: z.enum(["ACTION", "PAUSED_INFRA"]),
  action: actionCommandSchema.nullable(),
  response: actionResponseSchema.nullable(),
  usedFallback: z.boolean(),
  protocolFailures: z.number().int().nonnegative(),
  historyResults: z.array(historyQueryResultSchema).max(20),
  calls: z.array(callAuditSchema).max(200),
  error: z.object({ kind: providerErrorKindSchema, message: z.string().min(1).max(1_000) }).strict().nullable(),
}).strict().superRefine((result, context) => {
  if (result.status === "ACTION" && result.action === null) {
    context.addIssue({ code: "custom", path: ["action"], message: "ACTION results require an action" });
  }
  if (result.status === "PAUSED_INFRA" && (result.action !== null || result.error === null)) {
    context.addIssue({ code: "custom", path: ["error"], message: "PAUSED_INFRA results require only an error" });
  }
  if (result.usedFallback && (result.status !== "ACTION" || result.response !== null)) {
    context.addIssue({ code: "custom", path: ["usedFallback"], message: "Fallback results cannot contain a model response" });
  }
});

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

interface HandForkRow {
  id: string;
  source_tournament_id: string;
  source_decision_id: string;
  source_hand_no: number;
  source_player_id: string;
  source_expected_aggregate_version: string | number;
  source_action_event_sequence: string | number;
  source_event_hash: string;
  source_request_hash: string;
  source_payload_hash: string;
  visible_input_hash: string;
  legal_contract_hash: string;
  protocol_bundle_id: string;
  ruleset_version: string;
  context_version: string;
  system_prompt_hash: string;
  output_schema_hash: string;
  parser_policy_version: string;
  adapter_protocol_version: string;
  history_protocol_version: string;
  correction_protocol_version: string;
  history_budget: Record<string, unknown>;
  status: HandForkStatus;
  sample_count: number;
  timeout_ms: number;
  max_parallel_targets: number;
  target_count: number;
  summary: unknown | null;
  error_message: string | null;
  created_by_admin_user_id: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HandForkTargetRow {
  id: string;
  fork_id: string;
  ordinal: number;
  model_config_id: string;
  competitor_revision_id: string;
  competitor_family_id: string;
  competitor_display_name: string;
  model_id: string;
  provider_profile: string;
  model_configuration_hash: string;
  effective_output_mode: string;
  sample_count: number;
  status: HandForkTargetStatus;
  terminal_trials: number;
  summary: unknown | null;
  error_message: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HandForkTrialRow {
  id: string;
  fork_id: string;
  target_id: string;
  sample_index: number;
  status: HandForkTrial["status"];
  outcome: HandForkTrialOutcome | null;
  action: HandForkTrial["action"];
  amount_to: number | null;
  decision_summary: string | null;
  used_fallback: boolean;
  first_turn_valid: boolean;
  history_query_count: number;
  protocol_failures: number;
  infrastructure_failures: number;
  call_count: number;
  total_latency_ms: number | null;
  usage: unknown | null;
  visible_input_hash: string;
  error_kind: string | null;
  error_message: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  completion_hash?: string | null;
}

interface HandForkTurnRow {
  fork_id: string;
  target_id: string;
  trial_id: string;
  turn_index: number;
  content_hash: string;
  request_hash: string;
  encrypted_request: unknown;
  response_hash: string | null;
  encrypted_response: unknown | null;
  outcome: HandForkTurnOutcome;
  error_kind: string | null;
  provider_config_hash: string;
  output_schema_version: string;
  output_schema_hash: string;
  latency_ms: number | null;
  usage: unknown | null;
  adapter_version: string | null;
  rendered_user_text_hash: string | null;
  redacted_wire_body_hash: string | null;
  applied_output_mode: string | null;
  applied_schema_hash: string | null;
  finish_reason: string | null;
  refusal_hash: string | null;
  encrypted_refusal: unknown | null;
  response_model: string | null;
  system_fingerprint: string | null;
  created_at: Date | string;
}

export interface HandForkSourcePersistenceInput {
  tournamentId: string;
  decisionId: string;
  handNo: number;
  playerId: string;
  expectedAggregateVersion: number;
  actionEventSequence: number;
  sourceEventHash: string;
  sourceRequestHash: string;
  visibleInputHash: string;
  legalContractHash: string;
  protocolBundleId: string;
  rulesetVersion: string;
  contextVersion: string;
  systemPromptHash: string;
  outputSchemaHash: string;
  parserPolicyVersion: string;
  adapterProtocolVersion: string;
  historyProtocolVersion: string;
  correctionProtocolVersion: string;
  historyBudget: Record<string, unknown>;
  // This allowlisted payload is encrypted before it reaches PostgreSQL. The
  // base request contains only the actor-visible, pre-action arena_state.
  privatePayload: HandForkSourcePayloadV1;
}

export interface HandForkSourcePayloadV1 {
  version: "hand-fork-source-v1";
  source: {
    tournamentName: string;
    playerDisplayName: string;
    street: "PREFLOP" | "FLOP" | "TURN" | "RIVER";
    heroPosition: string;
    holeCards: [string, string];
    legalActions: HandForkLegalActions;
    originalAction: NonNullable<HandForkTrial["action"]>;
    originalAmountTo: number | null;
    originalDecisionSummary: string | null;
    originalUsedFallback: boolean;
    decisionEventSequence: number;
    snapshotChecksum: string;
  };
  baseRequest: CanonicalModelRequest;
  decisionConfig: DecisionRunnerConfig;
}

export interface HandForkTargetPersistenceInput {
  modelConfigId: string;
  competitorRevisionId: string;
  modelConfigurationHash: string;
  effectiveOutputMode: string;
}

export interface CreateHandForkPersistenceInput {
  source: HandForkSourcePersistenceInput;
  targets: readonly HandForkTargetPersistenceInput[];
  sampleCount: number;
  timeoutMs: number;
  maxParallelTargets: number;
  createdByAdminUserId: string | null;
}

export interface HandForkPersistenceRecord {
  id: string;
  status: HandForkStatus;
  sourceTournamentId: string;
  sourceDecisionId: string;
  sourceHandNo: number;
  sourcePlayerId: string;
  sourceExpectedAggregateVersion: number;
  sourceActionEventSequence: number;
  sourceEventHash: string;
  sourceRequestHash: string;
  sourcePayloadHash: string;
  visibleInputHash: string;
  legalContractHash: string;
  protocolBundleId: string;
  rulesetVersion: string;
  contextVersion: string;
  systemPromptHash: string;
  outputSchemaHash: string;
  parserPolicyVersion: string;
  adapterProtocolVersion: string;
  historyProtocolVersion: string;
  correctionProtocolVersion: string;
  historyBudget: Record<string, unknown>;
  sampleCount: number;
  timeoutMs: number;
  maxParallelTargets: number;
  targetCount: number;
  summary: HandForkAggregateSummary | null;
  errorMessage: string | null;
  createdByAdminUserId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targets: HandForkTarget[];
}

export interface ClaimedHandForkTarget {
  id: string;
  forkId: string;
  modelConfigId: string;
  competitorRevisionId: string;
  modelConfigurationHash: string;
  effectiveOutputMode: string;
  sampleCount: number;
  terminalTrials: number;
  timeoutMs: number;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface BeginHandForkTrialInput {
  targetId: string;
  workerId: string;
  leaseToken: string;
  sampleIndex: number;
  visibleInputHash: string;
}

export interface HandForkLeaseInput {
  targetId: string;
  workerId: string;
  leaseToken: string;
}

export interface SaveHandForkTrialResumeStateInput extends HandForkLeaseInput {
  trialId: string;
  state: DecisionResumeState;
}

export interface HandForkTurnResponse {
  rawText: string;
  parsed?: z.infer<typeof actionDecisionResponseSchema>;
  providerRequestId: string | null;
  transportAudit?: ProviderTransportAudit;
}

export interface HandForkTurnAuditInput {
  forkId: string;
  targetId: string;
  trialId: string;
  workerId: string;
  leaseToken: string;
  turnIndex: number;
  request: CanonicalModelRequest;
  response?: HandForkTurnResponse;
  outcome: HandForkTurnOutcome;
  errorKind: string | null;
  providerConfigHash: string;
  outputSchemaVersion: string;
  outputSchemaHash: string;
  latencyMs: number | null;
  usage: HandForkProviderUsage | null;
}

export interface CheckpointHandForkTurnInput extends HandForkTurnAuditInput {
  resumeState: DecisionResumeState;
}

export interface CompleteHandForkTrialInput {
  forkId: string;
  targetId: string;
  trialId: string;
  workerId: string;
  leaseToken: string;
  outcome: Exclude<HandForkTrialOutcome, "CANCELLED">;
  action: HandForkTrial["action"];
  amountTo: number | null;
  decisionSummary: string | null;
  usedFallback: boolean;
  firstTurnValid: boolean;
  historyQueryCount: number;
  protocolFailures: number;
  infrastructureFailures: number;
  callCount: number;
  totalLatencyMs: number;
  usage: HandForkProviderUsage | null;
  errorKind: string | null;
  errorMessage: string | null;
  privateResult: HandForkTrialResultV1;
}

export interface HandForkTrialResultV1 {
  version: "hand-fork-trial-result-v1";
  requestId: string;
  status: "ACTION" | "PAUSED_INFRA";
  action: ActionCommand | null;
  response: ActionResponse | null;
  usedFallback: boolean;
  protocolFailures: number;
  historyResults: DecisionResumeState["historyResults"];
  calls: CallAudit[];
  error: { kind: ProviderErrorKind; message: string } | null;
}

export interface DecryptedHandForkTurnAudit {
  metadata: HandForkTurnMetadata;
  request: CanonicalModelRequest;
  response: HandForkTurnResponse | null;
}

export class HandForkPersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandForkPersistenceConflictError";
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertSha256(name: string, value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
}

function assertIntegerBetween(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
}

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "apikey", "apitoken", "authorization", "auth", "bearertoken", "credential", "credentials",
  "accesstoken", "refreshtoken", "secrettoken", "sessiontoken", "clientsecret", "clientkey",
  "privatekey", "password", "passwd", "secret", "cookie", "setcookie", "proxyauthorization",
]);

function assertNoCredentialFields(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_CREDENTIAL_KEYS.has(normalized)) {
      throw new Error(`Fork persistence rejects credential field ${path}.${key}`);
    }
    assertNoCredentialFields(item, `${path}.${key}`);
  }
}

function assertNoHiddenPokerState(value: unknown, path = "arena_state"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoHiddenPokerState(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if (["deck", "burn", "burncard", "burncards", "masterseed", "masterseedbase64"].includes(normalized)) {
      throw new Error(`Fork source rejects hidden poker state ${path}.${key}`);
    }
    if (normalized === "holecards" && !/(^|\.)hero(?:\[[0-9]+\])?$/.test(path)) {
      throw new Error(`Fork source rejects non-hero hole cards ${path}.${key}`);
    }
    assertNoHiddenPokerState(item, `${path}.${key}`);
  }
}

function assertBoundedJson(name: string, value: unknown, maximumBytes: number): void {
  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (depth > 40) throw new Error(`${name} exceeds the maximum JSON depth`);
    if (typeof candidate === "string" && candidate.length > 200_000) {
      throw new Error(`${path} exceeds the maximum string length`);
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 10_000) throw new Error(`${path} exceeds the maximum array length`);
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      if (key.length > 200) throw new Error(`${path} contains an overlong key`);
      visit(item, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, name, 0);
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  }
}

export function validateHandForkSourcePayload(value: HandForkSourcePayloadV1): HandForkSourcePayloadV1 {
  const payload = sourcePayloadSchema.parse(value) as HandForkSourcePayloadV1;
  const forbiddenEnvelopeKeys = [
    "arena_state", "arena_control", "history_results", "protocol_correction",
  ];
  const visiblePayload = payload.baseRequest.userPayload as Record<string, unknown>;
  for (const key of forbiddenEnvelopeKeys) {
    if (Object.hasOwn(visiblePayload, key)) {
      throw new Error(`Fork source baseRequest.userPayload must be bare arena_state, not an envelope containing ${key}`);
    }
  }
  assertBoundedJson("source.privatePayload", payload, MAX_SOURCE_BYTES);
  assertNoCredentialFields(payload, "source.privatePayload");
  assertNoHiddenPokerState(payload.baseRequest.userPayload);
  return payload;
}

function checkedResumeState(value: DecisionResumeState): DecisionResumeState {
  const state = decisionResumeStateSchema.parse(value) as DecisionResumeState;
  assertBoundedJson("resumeState", state, MAX_RESUME_BYTES);
  assertNoCredentialFields(state, "resumeState");
  return state;
}

function checkedTurnRequest(value: CanonicalModelRequest): CanonicalModelRequest {
  const request = canonicalModelRequestPersistenceSchema.parse(value) as CanonicalModelRequest;
  assertBoundedJson("turn.request", request, MAX_TURN_REQUEST_BYTES);
  assertNoCredentialFields(request, "turn.request");
  return request;
}

function checkedTurnResponse(value: HandForkTurnResponse | undefined): HandForkTurnResponse | undefined {
  if (value === undefined) return undefined;
  const response = turnResponseSchema.parse(value) as HandForkTurnResponse;
  assertBoundedJson("turn.response", response, MAX_TURN_RESPONSE_BYTES);
  assertNoCredentialFields(response, "turn.response");
  return response;
}

function checkedTrialResult(value: HandForkTrialResultV1): HandForkTrialResultV1 {
  const result = trialResultSchema.parse(value) as HandForkTrialResultV1;
  assertBoundedJson("trial.privateResult", result, MAX_RESULT_BYTES);
  assertNoCredentialFields(result, "trial.privateResult");
  return result;
}

function sourceAad(forkId: string): string {
  return `arena:hand-fork:${forkId}:source`;
}

function trialResumeAad(forkId: string, targetId: string, trialId: string): string {
  return `arena:hand-fork:${forkId}:${targetId}:${trialId}:resume`;
}

function trialResultAad(forkId: string, targetId: string, trialId: string): string {
  return `arena:hand-fork:${forkId}:${targetId}:${trialId}:result`;
}

function turnAad(
  forkId: string,
  targetId: string,
  trialId: string,
  turnIndex: number,
  kind: "request" | "response" | "refusal",
): string {
  return `arena:hand-fork:${forkId}:${targetId}:${trialId}:turn:${turnIndex}:${kind}`;
}

function mapTurnMetadata(row: HandForkTurnRow): HandForkTurnMetadata {
  return handForkTurnMetadataSchema.parse({
    turnIndex: row.turn_index,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    responseRecorded: row.encrypted_response !== null,
    outcome: row.outcome,
    errorKind: row.error_kind,
    latencyMs: row.latency_ms,
    usage: row.usage === null ? null : handForkProviderUsageSchema.parse(row.usage),
    providerConfigHash: row.provider_config_hash,
    outputSchemaVersion: row.output_schema_version,
    outputSchemaHash: row.output_schema_hash,
    adapterVersion: row.adapter_version,
    appliedOutputMode: row.applied_output_mode,
    finishReason: row.finish_reason,
    refusalHash: row.refusal_hash,
    refusalRecorded: row.encrypted_refusal !== null,
    responseModel: row.response_model,
    createdAt: iso(row.created_at),
  });
}

function mapTrial(row: HandForkTrialRow, turns?: HandForkTurnMetadata[]): HandForkTrial {
  return handForkTrialSchema.parse({
    id: row.id,
    sampleIndex: row.sample_index,
    status: row.status,
    outcome: row.outcome,
    action: row.action,
    amountTo: row.amount_to,
    decisionSummary: row.decision_summary,
    usedFallback: row.used_fallback,
    firstTurnValid: row.first_turn_valid,
    historyQueryCount: row.history_query_count,
    protocolFailures: row.protocol_failures,
    infrastructureFailures: row.infrastructure_failures,
    callCount: row.call_count,
    totalLatencyMs: row.total_latency_ms,
    usage: row.usage === null ? null : handForkProviderUsageSchema.parse(row.usage),
    visibleInputHash: row.visible_input_hash,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    createdAt: iso(row.created_at),
    completedAt: nullableIso(row.completed_at),
    ...(turns ? { turns } : {}),
  });
}

function mapTarget(row: HandForkTargetRow, trials?: HandForkTrial[]): HandForkTarget {
  return {
    id: row.id,
    ordinal: row.ordinal,
    modelConfigId: row.model_config_id,
    competitorRevisionId: row.competitor_revision_id,
    competitorFamilyId: row.competitor_family_id,
    modelDisplayName: row.competitor_display_name,
    modelId: row.model_id,
    providerProfile: row.provider_profile,
    modelConfigurationHash: row.model_configuration_hash,
    effectiveOutputMode: row.effective_output_mode,
    sampleCount: row.sample_count,
    status: handForkTargetStatusSchema.parse(row.status),
    terminalTrials: row.terminal_trials,
    summary: row.summary === null ? null : handForkTargetSummarySchema.parse(row.summary),
    errorMessage: row.error_message,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(trials ? { trials } : {}),
  };
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? null;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function summarizeHandForkTrials(
  requestedSamples: number,
  trials: readonly HandForkTrial[],
): HandForkTargetSummary {
  assertIntegerBetween("requestedSamples", requestedSamples, 1, 20);
  if (new Set(trials.map((trial) => trial.sampleIndex)).size !== trials.length
    || trials.some((trial) => trial.sampleIndex > requestedSamples)) {
    throw new Error("Hand fork trials must have unique sample indexes inside the requested range");
  }
  const terminal = trials.filter((trial) => trial.status !== "RUNNING");
  const completed = terminal.filter((trial) => trial.status === "COMPLETED");
  const modelActions = terminal.filter((trial) => trial.outcome === "MODEL_ACTION" && trial.action !== null);
  const actionDistribution: Record<string, number> = {};
  const sizingValues: Record<string, number[]> = {};
  for (const trial of modelActions) {
    actionDistribution[trial.action!] = (actionDistribution[trial.action!] ?? 0) + 1;
    if (trial.amountTo !== null) (sizingValues[trial.action!] ??= []).push(trial.amountTo);
  }
  let modalAction: HandForkTrial["action"] = null;
  let modalCount = 0;
  for (const action of POKER_ACTION_ORDER) {
    const count = actionDistribution[action] ?? 0;
    if (count > modalCount) {
      modalAction = action;
      modalCount = count;
    }
  }
  const pairDenominator = modelActions.length * (modelActions.length - 1) / 2;
  const matchingPairs = Object.values(actionDistribution)
    .reduce((sum, count) => sum + count * (count - 1) / 2, 0);
  const latencies = completed.flatMap((trial) => trial.totalLatencyMs === null ? [] : [trial.totalLatencyMs]);
  const tokenValues = completed.flatMap((trial) => trial.usage?.totalTokens ?? []);
  const totalTokens = tokenValues.reduce((sum, value) => sum + value, 0);
  return handForkTargetSummarySchema.parse({
    requestedSamples,
    terminalTrials: terminal.length,
    terminalCoverage: terminal.length / requestedSamples,
    completedTrials: completed.length,
    reliabilityEligibleTrials: completed.length,
    modelActionTrials: modelActions.length,
    actionDistributionTrials: modelActions.length,
    modelActionCoverage: modelActions.length / requestedSamples,
    fallbackTrials: terminal.filter((trial) => trial.outcome === "PROTOCOL_FALLBACK").length,
    infrastructureErrorTrials: terminal.filter((trial) => trial.outcome === "INFRA_ERROR").length,
    cancelledTrials: terminal.filter((trial) => trial.outcome === "CANCELLED").length,
    modalAction,
    modalCount,
    modalShare: modelActions.length === 0 ? null : modalCount / modelActions.length,
    pairwiseAgreement: pairDenominator === 0 ? null : matchingPairs / pairDenominator,
    pairwiseComparisonPairs: pairDenominator,
    actionDistribution,
    sizing: Object.fromEntries(Object.entries(sizingValues).map(([action, values]) => [action, {
      count: values.length,
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
    }])),
    firstTurnValidRate: completed.length === 0 ? null : completed.filter((trial) => trial.firstTurnValid).length / completed.length,
    historyQueryRate: completed.length === 0 ? null : completed.filter((trial) => trial.historyQueryCount > 0).length / completed.length,
    correctionRate: completed.length === 0 ? null : completed.filter((trial) => trial.protocolFailures > 0).length / completed.length,
    latencyObservedTrials: latencies.length,
    averageLatencyMs: average(latencies),
    p95LatencyMs: percentile95(latencies),
    tokenObservedTrials: tokenValues.length,
    totalTokens: tokenValues.length > 0 ? totalTokens : null,
  });
}

export function summarizeHandForkTargets(targets: readonly HandForkTarget[]): HandForkAggregateSummary {
  const summaries = targets.flatMap((target) => target.summary ? [target.summary] : []);
  const terminalTargets = targets.filter((target) => (
    target.status === "COMPLETED" || target.status === "FAILED" || target.status === "CANCELLED"
  )).length;
  const requestedTrials = targets.reduce((sum, target) => sum + target.sampleCount, 0);
  const terminalTrials = summaries.reduce((sum, summary) => sum + summary.terminalTrials, 0);
  return handForkAggregateSummarySchema.parse({
    totalTargets: targets.length,
    terminalTargets,
    targetTerminalCoverage: terminalTargets / targets.length,
    completedTargets: targets.filter((target) => target.status === "COMPLETED").length,
    failedTargets: targets.filter((target) => target.status === "FAILED").length,
    cancelledTargets: targets.filter((target) => target.status === "CANCELLED").length,
    requestedTrials,
    terminalTrials,
    trialTerminalCoverage: requestedTrials === 0 ? 0 : terminalTrials / requestedTrials,
    completedTrials: summaries.reduce((sum, summary) => sum + summary.completedTrials, 0),
    cancelledTrials: summaries.reduce((sum, summary) => sum + summary.cancelledTrials, 0),
    modelActionTrials: summaries.reduce((sum, summary) => sum + summary.modelActionTrials, 0),
    fallbackTrials: summaries.reduce((sum, summary) => sum + summary.fallbackTrials, 0),
    infrastructureErrorTrials: summaries.reduce((sum, summary) => sum + summary.infrastructureErrorTrials, 0),
  });
}

const TARGET_SELECT = `
  select ft.*, cr.competitor_family_id, cr.competitor_display_name,
         cr.model_id, cr.provider_profile
    from hand_fork_targets ft
    join competitor_revisions cr on cr.id = ft.competitor_revision_id`;

export class PgHandForkRepository {
  constructor(private readonly pool: Pool, private readonly masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) throw new Error("Hand fork repository requires a 32-byte master key");
  }

  async createFork(input: CreateHandForkPersistenceInput): Promise<HandForkPersistenceRecord> {
    assertIntegerBetween("sampleCount", input.sampleCount, 1, 20);
    assertIntegerBetween("timeoutMs", input.timeoutMs, 30_000, 600_000);
    assertIntegerBetween("maxParallelTargets", input.maxParallelTargets, 1, 3);
    assertIntegerBetween("targets.length", input.targets.length, 1, 9);
    assertIntegerBetween("source.handNo", input.source.handNo, 1, Number.MAX_SAFE_INTEGER);
    assertIntegerBetween("source.expectedAggregateVersion", input.source.expectedAggregateVersion, 1, Number.MAX_SAFE_INTEGER);
    assertIntegerBetween("source.actionEventSequence", input.source.actionEventSequence, 1, Number.MAX_SAFE_INTEGER);
    for (const [name, value] of Object.entries({
      sourceEventHash: input.source.sourceEventHash,
      sourceRequestHash: input.source.sourceRequestHash,
      visibleInputHash: input.source.visibleInputHash,
      legalContractHash: input.source.legalContractHash,
      systemPromptHash: input.source.systemPromptHash,
      outputSchemaHash: input.source.outputSchemaHash,
    })) assertSha256(name, value);
    const modelConfigIds = new Set(input.targets.map((target) => target.modelConfigId));
    const revisionIds = new Set(input.targets.map((target) => target.competitorRevisionId));
    if (modelConfigIds.size !== input.targets.length || revisionIds.size !== input.targets.length) {
      throw new Error("Hand fork targets must use unique model configurations and revisions");
    }
    z.string().uuid().parse(input.source.tournamentId);
    z.string().uuid().parse(input.source.decisionId);
    if (input.source.playerId.length < 1 || input.source.playerId.length > 200) throw new Error("source.playerId is invalid");
    for (const [name, value] of Object.entries({
      protocolBundleId: input.source.protocolBundleId,
      rulesetVersion: input.source.rulesetVersion,
      contextVersion: input.source.contextVersion,
      parserPolicyVersion: input.source.parserPolicyVersion,
      adapterProtocolVersion: input.source.adapterProtocolVersion,
      historyProtocolVersion: input.source.historyProtocolVersion,
      correctionProtocolVersion: input.source.correctionProtocolVersion,
    })) {
      if (value.length < 1 || value.length > 160) throw new Error(`${name} must contain 1 to 160 characters`);
    }
    input.targets.forEach((target) => {
      z.string().uuid().parse(target.modelConfigId);
      z.string().uuid().parse(target.competitorRevisionId);
      assertSha256("modelConfigurationHash", target.modelConfigurationHash);
      if (target.effectiveOutputMode.length < 1 || target.effectiveOutputMode.length > 80) {
        throw new Error("effectiveOutputMode must contain 1 to 80 characters");
      }
    });
    const sourcePayload = validateHandForkSourcePayload(input.source.privatePayload);
    if (sourcePayload.baseRequest.requestId !== input.source.decisionId
      || sourcePayload.baseRequest.systemPromptHash !== input.source.systemPromptHash
      || sourcePayload.baseRequest.outputSchema?.sha256 !== input.source.outputSchemaHash
      || sha256(sourcePayload.baseRequest.userPayload) !== input.source.visibleInputHash
      || sha256(sourcePayload.source.legalActions) !== input.source.legalContractHash
      || sourcePayload.source.decisionEventSequence >= input.source.actionEventSequence) {
      throw new Error("Allowlisted source payload does not match its immutable source columns");
    }
    const historyBudget = decisionConfigPersistenceSchema.shape.history.parse(input.source.historyBudget);
    if (canonicalJson(historyBudget) !== canonicalJson(sourcePayload.decisionConfig.history)) {
      throw new Error("Persisted history budget must match the allowlisted source decision configuration");
    }
    const forkId = randomUUID();
    const sourcePayloadHash = sha256(sourcePayload);
    const encryptedSourcePayload = encryptJson(sourcePayload, this.masterKey, sourceAad(forkId));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const sourceInserted = await client.query(
        `insert into hand_forks
          (id, source_tournament_id, source_decision_id, source_hand_no,
           source_player_id, source_expected_aggregate_version,
           source_action_event_sequence, source_event_hash, source_request_hash,
           source_payload_hash, encrypted_source_payload, visible_input_hash,
           legal_contract_hash, protocol_bundle_id, ruleset_version,
           context_version, system_prompt_hash, output_schema_hash,
           parser_policy_version, adapter_protocol_version,
           history_protocol_version, correction_protocol_version, history_budget,
           status, sample_count, timeout_ms, max_parallel_targets, target_count,
           created_by_admin_user_id)
         select
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb,
           'QUEUED', $24, $25, $26, $27, $28
           from decision_requests d
           join tournaments t on t.id = d.tournament_id
           join decision_turns turn_one
             on turn_one.decision_id = d.id and turn_one.turn_index = 1
            and turn_one.request_hash = $9
           join arena_events source_action
             on source_action.tournament_id = d.tournament_id
            and source_action.sequence = $7 and source_action.event_hash = $8
            and source_action.event_type = 'ACTION_APPLIED'
            and source_action.hand_no = $4 and source_action.actor_id = $5
           join state_snapshots source_snapshot
             on source_snapshot.tournament_id = d.tournament_id
            and source_snapshot.aggregate_version = $6
            and source_snapshot.checksum = $29
          where d.id = $3 and d.tournament_id = $2 and d.hand_no = $4
            and d.player_id = $5 and d.expected_aggregate_version = $6
            and d.request_kind = 'ACTION' and d.status = 'SUCCEEDED'
            and t.status = 'COMPLETED'`,
        [
          forkId,
          input.source.tournamentId,
          input.source.decisionId,
          input.source.handNo,
          input.source.playerId,
          input.source.expectedAggregateVersion,
          input.source.actionEventSequence,
          input.source.sourceEventHash,
          input.source.sourceRequestHash,
          sourcePayloadHash,
          JSON.stringify(encryptedSourcePayload),
          input.source.visibleInputHash,
          input.source.legalContractHash,
          input.source.protocolBundleId,
          input.source.rulesetVersion,
          input.source.contextVersion,
          input.source.systemPromptHash,
          input.source.outputSchemaHash,
          input.source.parserPolicyVersion,
          input.source.adapterProtocolVersion,
          input.source.historyProtocolVersion,
          input.source.correctionProtocolVersion,
          JSON.stringify(historyBudget),
          input.sampleCount,
          input.timeoutMs,
          input.maxParallelTargets,
          input.targets.length,
          input.createdByAdminUserId,
          sourcePayload.source.snapshotChecksum,
        ],
      );
      if (sourceInserted.rowCount !== 1) {
        throw new HandForkPersistenceConflictError("Source decision is no longer a completed, forkable action");
      }
      for (const [index, target] of input.targets.entries()) {
        const targetInserted = await client.query(
          `insert into hand_fork_targets
            (id, fork_id, ordinal, model_config_id, competitor_revision_id,
             sample_count, model_configuration_hash, effective_output_mode, status)
           select $1, $2, $3, $4, $5, $6, $7, $8, 'QUEUED'
             from competitor_revisions cr
            where cr.id = $5 and cr.model_config_id = $4
              and cr.configuration_hash = $7`,
          [
            randomUUID(), forkId, index + 1, target.modelConfigId,
            target.competitorRevisionId, input.sampleCount,
            target.modelConfigurationHash, target.effectiveOutputMode,
          ],
        );
        if (targetInserted.rowCount !== 1) {
          throw new HandForkPersistenceConflictError("Target model revision does not match its frozen configuration");
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return (await this.getFork(forkId, true))!;
  }

  async listForks(limit = 50): Promise<HandForkPersistenceRecord[]> {
    assertIntegerBetween("limit", limit, 1, 200);
    const result = await this.pool.query<HandForkRow>(
      "select * from hand_forks order by created_at desc, id limit $1",
      [limit],
    );
    if (result.rows.length === 0) return [];
    const targetResult = await this.pool.query<HandForkTargetRow>(
      `${TARGET_SELECT} where ft.fork_id = any($1::uuid[]) order by ft.fork_id, ft.ordinal`,
      [result.rows.map((row) => row.id)],
    );
    return result.rows.map((row) => this.#mapFork(
      row,
      targetResult.rows.filter((target) => target.fork_id === row.id).map((target) => mapTarget(target)),
    ));
  }

  async getFork(id: string, includeDetail = true): Promise<HandForkPersistenceRecord | null> {
    const forkResult = await this.pool.query<HandForkRow>("select * from hand_forks where id = $1", [id]);
    const row = forkResult.rows[0];
    if (!row) return null;
    const targetResult = await this.pool.query<HandForkTargetRow>(
      `${TARGET_SELECT} where ft.fork_id = $1 order by ft.ordinal`,
      [id],
    );
    if (!includeDetail || targetResult.rows.length === 0) {
      return this.#mapFork(row, targetResult.rows.map((target) => mapTarget(target)));
    }
    const trialResult = await this.pool.query<HandForkTrialRow>(
      "select * from hand_fork_trials where fork_id = $1 order by target_id, sample_index",
      [id],
    );
    const turnResult = trialResult.rows.length === 0 ? { rows: [] as HandForkTurnRow[] } : await this.pool.query<HandForkTurnRow>(
      "select * from hand_fork_turns where fork_id = $1 order by target_id, trial_id, turn_index",
      [id],
    );
    const trialsByTarget = new Map<string, HandForkTrial[]>();
    for (const trialRow of trialResult.rows) {
      const turns = turnResult.rows
        .filter((turn) => turn.trial_id === trialRow.id)
        .map(mapTurnMetadata);
      const trials = trialsByTarget.get(trialRow.target_id) ?? [];
      trials.push(mapTrial(trialRow, turns));
      trialsByTarget.set(trialRow.target_id, trials);
    }
    return this.#mapFork(row, targetResult.rows.map((target) => mapTarget(
      target,
      trialsByTarget.get(target.id) ?? [],
    )));
  }

  async loadSourcePayload(forkId: string): Promise<HandForkSourcePayloadV1> {
    const result = await this.pool.query<{
      encrypted_source_payload: unknown;
      source_payload_hash: string;
    }>(
      "select encrypted_source_payload, source_payload_hash from hand_forks where id = $1",
      [forkId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Unknown hand fork: ${forkId}`);
    const payload = decryptJson(
      encryptedPayloadSchema.parse(row.encrypted_source_payload),
      this.masterKey,
      sourceAad(forkId),
    );
    if (sha256(payload) !== row.source_payload_hash) throw new Error("Hand fork source payload hash mismatch");
    return sourcePayloadSchema.parse(payload) as HandForkSourcePayloadV1;
  }

  async claimNextTarget(workerId: string, leaseMs: number, forkId: string | null = null): Promise<ClaimedHandForkTarget | null> {
    if (!workerId.trim() || workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    assertIntegerBetween("leaseMs", leaseMs, 1_000, 3_600_000);
    if (forkId !== null) z.string().uuid().parse(forkId);
    const leaseToken = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const claimed = await client.query<{
        id: string;
        fork_id: string;
        model_config_id: string;
        competitor_revision_id: string;
        model_configuration_hash: string;
        effective_output_mode: string;
        sample_count: number;
        terminal_trials: number;
        lease_expires_at: Date | string;
        timeout_ms: number;
      }>(
        `with candidate_fork as materialized (
           select f.id
             from hand_forks f
            where f.status in ('QUEUED', 'RUNNING')
              and ($3::uuid is null or f.id = $3)
              and (
                select count(*)
                  from hand_fork_targets active
                 where active.fork_id = f.id and active.status = 'RUNNING'
                   and active.lease_expires_at > now()
              ) < f.max_parallel_targets
              and exists (
                select 1 from hand_fork_targets available
                 where available.fork_id = f.id
                   and (available.status = 'QUEUED' or (
                     available.status = 'RUNNING' and available.lease_expires_at <= now()
                   ))
                   and not exists (
                     select 1 from hand_fork_targets serial_target
                      where serial_target.competitor_revision_id = available.competitor_revision_id
                        and serial_target.id <> available.id
                        and serial_target.status = 'RUNNING'
                        and serial_target.lease_expires_at > now()
                   )
              )
            order by f.created_at, f.id
            for update of f skip locked
            limit 1
         ), candidate as materialized (
           select ft.id
             from hand_fork_targets ft
             join candidate_fork f on f.id = ft.fork_id
             join competitor_revisions cr on cr.id = ft.competitor_revision_id
            where (ft.status = 'QUEUED' or (
              ft.status = 'RUNNING' and ft.lease_expires_at <= now()
            ))
              and not exists (
                select 1 from hand_fork_targets serial_target
                 where serial_target.competitor_revision_id = ft.competitor_revision_id
                   and serial_target.id <> ft.id
                   and serial_target.status = 'RUNNING'
                   and serial_target.lease_expires_at > now()
              )
            order by ft.ordinal
            for update of ft, cr skip locked
            limit 1
         )
         update hand_fork_targets ft
            set status = 'RUNNING', worker_id = $1,
                lease_token = $4,
                lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
                started_at = coalesce(ft.started_at, now()), updated_at = now()
           from candidate c, hand_forks f
          where ft.id = c.id and f.id = ft.fork_id
         returning ft.id, ft.fork_id, ft.model_config_id,
                   ft.competitor_revision_id, ft.model_configuration_hash,
                   ft.effective_output_mode, ft.sample_count,
                   ft.terminal_trials, ft.lease_expires_at, f.timeout_ms`,
        [workerId, leaseMs, forkId, leaseToken],
      );
      const row = claimed.rows[0];
      if (!row) {
        await client.query("commit");
        return null;
      }
      await client.query(
        `update hand_forks
            set status = 'RUNNING', started_at = coalesce(started_at, now()), updated_at = now()
          where id = $1 and status = 'QUEUED'`,
        [row.fork_id],
      );
      await client.query("commit");
      return {
        id: row.id,
        forkId: row.fork_id,
        modelConfigId: row.model_config_id,
        competitorRevisionId: row.competitor_revision_id,
        modelConfigurationHash: row.model_configuration_hash,
        effectiveOutputMode: row.effective_output_mode,
        sampleCount: row.sample_count,
        terminalTrials: row.terminal_trials,
        timeoutMs: row.timeout_ms,
        workerId,
        leaseToken,
        leaseExpiresAt: iso(row.lease_expires_at),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async renewTargetLease(
    targetId: string,
    workerId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    z.string().uuid().parse(targetId);
    z.string().uuid().parse(leaseToken);
    if (!workerId.trim() || workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    assertIntegerBetween("leaseMs", leaseMs, 1_000, 3_600_000);
    const result = await this.pool.query(
      `update hand_fork_targets
          set lease_expires_at = now() + ($4::integer * interval '1 millisecond'), updated_at = now()
        where id = $1 and status = 'RUNNING' and worker_id = $2
          and lease_token = $3 and lease_expires_at > now()`,
      [targetId, workerId, leaseToken, leaseMs],
    );
    return result.rowCount === 1;
  }

  async beginTrial(input: BeginHandForkTrialInput): Promise<HandForkTrial | null> {
    z.string().uuid().parse(input.targetId);
    z.string().uuid().parse(input.leaseToken);
    if (!input.workerId.trim() || input.workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    assertIntegerBetween("sampleIndex", input.sampleIndex, 1, 20);
    assertSha256("visibleInputHash", input.visibleInputHash);
    const trialId = randomUUID();
    const inserted = await this.pool.query<HandForkTrialRow>(
      `insert into hand_fork_trials
        (id, fork_id, target_id, sample_index, status, visible_input_hash)
       select $1, ft.fork_id, ft.id, $5, 'RUNNING', $6
         from hand_fork_targets ft
         join hand_forks f on f.id = ft.fork_id
        where ft.id = $2 and ft.status = 'RUNNING' and ft.worker_id = $3
          and ft.lease_token = $4 and ft.lease_expires_at > now()
          and $5 between 1 and ft.sample_count
          and $6 = f.visible_input_hash
       on conflict (target_id, sample_index) do nothing
       returning *`,
      [trialId, input.targetId, input.workerId, input.leaseToken, input.sampleIndex, input.visibleInputHash],
    );
    if (inserted.rows[0]) return mapTrial(inserted.rows[0]);
    const existing = await this.pool.query<HandForkTrialRow>(
      `select tr.*
         from hand_fork_trials tr
         join hand_fork_targets ft on ft.id = tr.target_id
        where tr.target_id = $1 and tr.sample_index = $2
          and ft.status = 'RUNNING' and ft.worker_id = $3
          and ft.lease_token = $4 and ft.lease_expires_at > now()`,
      [input.targetId, input.sampleIndex, input.workerId, input.leaseToken],
    );
    return existing.rows[0] ? mapTrial(existing.rows[0]) : null;
  }

  async saveTrialResumeState(
    input: SaveHandForkTrialResumeStateInput,
    queryable: Queryable = this.pool,
  ): Promise<void> {
    const state = checkedResumeState(input.state);
    const ids = await this.#leasedTrialIds(input, queryable);
    const encrypted = encryptJson(
      state,
      this.masterKey,
      trialResumeAad(ids.forkId, input.targetId, input.trialId),
    );
    const result = await queryable.query(
      `update hand_fork_trials tr
          set encrypted_resume_state = $2::jsonb, resume_state_hash = $3, updated_at = now()
         from hand_fork_targets ft
        where tr.id = $1 and tr.target_id = $4 and tr.status = 'RUNNING'
          and ft.id = tr.target_id and ft.status = 'RUNNING'
          and ft.worker_id = $5 and ft.lease_token = $6
          and ft.lease_expires_at > now()`,
      [input.trialId, JSON.stringify(encrypted), sha256(state), input.targetId, input.workerId, input.leaseToken],
    );
    if (result.rowCount !== 1) throw new HandForkPersistenceConflictError("Trial write lease is no longer valid");
  }

  async loadTrialResumeState(trialId: string): Promise<DecisionResumeState | null> {
    const result = await this.pool.query<{
      fork_id: string;
      target_id: string;
      encrypted_resume_state: unknown | null;
      resume_state_hash: string | null;
    }>(
      `select fork_id, target_id, encrypted_resume_state, resume_state_hash
         from hand_fork_trials where id = $1`,
      [trialId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Unknown hand fork trial: ${trialId}`);
    if (row.encrypted_resume_state === null || row.resume_state_hash === null) return null;
    const state = decryptJson(
      encryptedPayloadSchema.parse(row.encrypted_resume_state),
      this.masterKey,
      trialResumeAad(row.fork_id, row.target_id, trialId),
    );
    if (sha256(state) !== row.resume_state_hash) throw new Error("Hand fork trial resume state hash mismatch");
    return decisionResumeStateSchema.parse(state) as DecisionResumeState;
  }

  async appendTurn(input: HandForkTurnAuditInput, queryable: Queryable = this.pool): Promise<void> {
    z.string().uuid().parse(input.forkId);
    z.string().uuid().parse(input.targetId);
    z.string().uuid().parse(input.trialId);
    z.string().uuid().parse(input.leaseToken);
    if (!input.workerId.trim() || input.workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    assertIntegerBetween("turnIndex", input.turnIndex, 1, Number.MAX_SAFE_INTEGER);
    assertSha256("providerConfigHash", input.providerConfigHash);
    assertSha256("outputSchemaHash", input.outputSchemaHash);
    if (input.outputSchemaVersion.length < 1 || input.outputSchemaVersion.length > 160) {
      throw new Error("outputSchemaVersion must contain 1 to 160 characters");
    }
    if (input.errorKind !== null && input.errorKind.length > 120) throw new Error("errorKind is too long");
    if (input.latencyMs !== null) assertIntegerBetween("latencyMs", input.latencyMs, 0, Number.MAX_SAFE_INTEGER);
    const usage = input.usage === null ? null : handForkProviderUsageSchema.parse(input.usage);
    const request = checkedTurnRequest(input.request);
    const response = checkedTurnResponse(input.response);
    const transportAudit = response?.transportAudit;
    const turnContent = {
      forkId: input.forkId,
      targetId: input.targetId,
      trialId: input.trialId,
      turnIndex: input.turnIndex,
      request,
      response: response ?? null,
      outcome: input.outcome,
      errorKind: input.errorKind,
      providerConfigHash: input.providerConfigHash,
      outputSchemaVersion: input.outputSchemaVersion,
      outputSchemaHash: input.outputSchemaHash,
      latencyMs: input.latencyMs,
      usage,
    };
    const contentHash = sha256(turnContent);
    const requestHash = sha256(request);
    const responseHash = response === undefined ? null : sha256(response);
    const encryptedRequest = encryptJson(
      request,
      this.masterKey,
      turnAad(input.forkId, input.targetId, input.trialId, input.turnIndex, "request"),
    );
    const encryptedResponse = response === undefined ? null : encryptJson(
      response,
      this.masterKey,
      turnAad(input.forkId, input.targetId, input.trialId, input.turnIndex, "response"),
    );
    const refusalHash = transportAudit?.refusal === null || transportAudit?.refusal === undefined
      ? null
      : sha256(transportAudit.refusal);
    const encryptedRefusal = transportAudit?.refusal === null || transportAudit?.refusal === undefined
      ? null
      : encryptJson(
        transportAudit.refusal,
        this.masterKey,
        turnAad(input.forkId, input.targetId, input.trialId, input.turnIndex, "refusal"),
      );
    const inserted = await queryable.query(
      `insert into hand_fork_turns
        (fork_id, target_id, trial_id, turn_index, content_hash, request_hash,
         encrypted_request, response_hash, encrypted_response, outcome,
         error_kind, provider_config_hash, output_schema_version,
         output_schema_hash, latency_ms, usage, adapter_version,
         rendered_user_text_hash, redacted_wire_body_hash, applied_output_mode,
         applied_schema_hash, finish_reason, refusal_hash, encrypted_refusal, response_model,
         system_fingerprint)
       select $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11,
              $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20,
              $21, $22, $23, $24::jsonb, $25, $26
         from hand_fork_trials tr
         join hand_fork_targets ft on ft.id = tr.target_id
        where tr.id = $3 and tr.fork_id = $1 and tr.target_id = $2
          and tr.status = 'RUNNING'
          and ft.status = 'RUNNING' and ft.worker_id = $27
          and ft.lease_token = $28 and ft.lease_expires_at > now()
       on conflict (trial_id, turn_index) do nothing`,
      [
        input.forkId, input.targetId, input.trialId, input.turnIndex,
        contentHash, requestHash, JSON.stringify(encryptedRequest), responseHash,
        encryptedResponse ? JSON.stringify(encryptedResponse) : null,
        input.outcome, input.errorKind, input.providerConfigHash,
        input.outputSchemaVersion, input.outputSchemaHash, input.latencyMs,
        usage ? JSON.stringify(usage) : null,
        transportAudit?.adapterVersion ?? null,
        transportAudit?.renderedUserTextSha256 ?? null,
        transportAudit?.redactedWireBodySha256 ?? null,
        transportAudit?.appliedOutputMode ?? null,
        transportAudit?.appliedSchemaSha256 ?? null,
        transportAudit?.finishReason ?? null,
        refusalHash,
        encryptedRefusal ? JSON.stringify(encryptedRefusal) : null,
        transportAudit?.responseModel ?? null,
        transportAudit?.systemFingerprint ?? null,
        input.workerId,
        input.leaseToken,
      ],
    );
    if (inserted.rowCount === 1) return;
    const existing = await queryable.query<{ content_hash: string }>(
      `select turn.content_hash
         from hand_fork_turns turn
         join hand_fork_targets ft on ft.id = turn.target_id
        where turn.trial_id = $1 and turn.turn_index = $2
          and ft.id = $3 and ft.status = 'RUNNING' and ft.worker_id = $4
          and ft.lease_token = $5 and ft.lease_expires_at > now()`,
      [input.trialId, input.turnIndex, input.targetId, input.workerId, input.leaseToken],
    );
    if (existing.rows[0]?.content_hash === contentHash) return;
    throw new HandForkPersistenceConflictError("Hand fork turn index already contains different content");
  }

  async checkpointTrialTurn(input: CheckpointHandForkTurnInput): Promise<void> {
    const { resumeState, ...turn } = input;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.appendTurn(turn, client);
      await this.saveTrialResumeState({
        trialId: input.trialId,
        targetId: input.targetId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        state: resumeState,
      }, client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeTrial(input: CompleteHandForkTrialInput): Promise<HandForkTrial> {
    z.string().uuid().parse(input.forkId);
    z.string().uuid().parse(input.targetId);
    z.string().uuid().parse(input.trialId);
    z.string().uuid().parse(input.leaseToken);
    if (!input.workerId.trim() || input.workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    const parsedOutcome = handForkTrialOutcomeSchema.parse(input.outcome);
    if (parsedOutcome === "CANCELLED") throw new Error("Workers cannot complete a trial as CANCELLED");
    if (input.outcome === "MODEL_ACTION" && (input.action === null || input.usedFallback)) {
      throw new Error("MODEL_ACTION requires a non-fallback action");
    }
    if (input.outcome === "PROTOCOL_FALLBACK" && (input.action === null || !input.usedFallback)) {
      throw new Error("PROTOCOL_FALLBACK requires a fallback action");
    }
    if (input.outcome === "INFRA_ERROR" && (input.action !== null || input.usedFallback)) {
      throw new Error("INFRA_ERROR cannot contain a poker action");
    }
    if ((input.action === "bet" || input.action === "raise") !== (input.amountTo !== null)) {
      throw new Error("Only bet and raise use amountTo");
    }
    if (input.amountTo !== null) assertIntegerBetween("amountTo", input.amountTo, 1, Number.MAX_SAFE_INTEGER);
    if (input.decisionSummary !== null && input.decisionSummary.length > 300) throw new Error("decisionSummary is too long");
    if (input.errorKind !== null && input.errorKind.length > 120) throw new Error("errorKind is too long");
    if (input.errorMessage !== null && input.errorMessage.length > 1_000) throw new Error("errorMessage is too long");
    for (const [name, value] of Object.entries({
      historyQueryCount: input.historyQueryCount,
      protocolFailures: input.protocolFailures,
      infrastructureFailures: input.infrastructureFailures,
      callCount: input.callCount,
      totalLatencyMs: input.totalLatencyMs,
    })) assertIntegerBetween(name, value, 0, Number.MAX_SAFE_INTEGER);
    const usage = input.usage === null ? null : handForkProviderUsageSchema.parse(input.usage);
    const privateResult = checkedTrialResult(input.privateResult);
    const expectedResultStatus = input.outcome === "INFRA_ERROR" ? "PAUSED_INFRA" : "ACTION";
    if (privateResult.status !== expectedResultStatus || privateResult.usedFallback !== input.usedFallback) {
      throw new Error("Private trial result does not match its public outcome");
    }
    const publicAction = input.action === null ? null : input.action === "bet" || input.action === "raise"
      ? { action: input.action, amountTo: input.amountTo! }
      : { action: input.action };
    if (canonicalJson(privateResult.action) !== canonicalJson(publicAction)) {
      throw new Error("Private trial action does not match its public action");
    }
    const resultHash = sha256(privateResult);
    const completionHash = sha256({
      forkId: input.forkId,
      targetId: input.targetId,
      trialId: input.trialId,
      outcome: input.outcome,
      action: input.action,
      amountTo: input.amountTo,
      decisionSummary: input.decisionSummary,
      usedFallback: input.usedFallback,
      firstTurnValid: input.firstTurnValid,
      historyQueryCount: input.historyQueryCount,
      protocolFailures: input.protocolFailures,
      infrastructureFailures: input.infrastructureFailures,
      callCount: input.callCount,
      totalLatencyMs: input.totalLatencyMs,
      usage,
      errorKind: input.errorKind,
      errorMessage: input.errorMessage,
      privateResult,
    });
    const encryptedResult = encryptJson(
      privateResult,
      this.masterKey,
      trialResultAad(input.forkId, input.targetId, input.trialId),
    );
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query<HandForkTrialRow>(
        `update hand_fork_trials tr
            set status = 'COMPLETED', outcome = $2, action = $3, amount_to = $4,
                decision_summary = $5, used_fallback = $6, first_turn_valid = $7,
                history_query_count = $8, protocol_failures = $9,
                infrastructure_failures = $10, call_count = $11,
                total_latency_ms = $12, usage = $13::jsonb, error_kind = $14,
                error_message = $15, encrypted_result = $16::jsonb,
                result_hash = $17, completion_hash = $18,
                completed_at = now(), updated_at = now()
           from hand_fork_targets ft
          where tr.id = $1 and tr.fork_id = $19 and tr.target_id = $20
            and tr.status = 'RUNNING' and ft.id = tr.target_id
            and ft.status = 'RUNNING' and ft.worker_id = $21
            and ft.lease_token = $22 and ft.lease_expires_at > now()
         returning tr.*`,
        [
          input.trialId, input.outcome, input.action, input.amountTo,
          input.decisionSummary, input.usedFallback, input.firstTurnValid,
          input.historyQueryCount, input.protocolFailures,
          input.infrastructureFailures, input.callCount, input.totalLatencyMs,
          usage ? JSON.stringify(usage) : null,
          input.errorKind, input.errorMessage, JSON.stringify(encryptedResult), resultHash,
          completionHash, input.forkId, input.targetId, input.workerId, input.leaseToken,
        ],
      );
      let row = updated.rows[0];
      if (!row) {
        const existing = await client.query<HandForkTrialRow & { result_hash: string | null }>(
          `select tr.*
             from hand_fork_trials tr
             join hand_fork_targets ft on ft.id = tr.target_id
            where tr.id = $1 and tr.fork_id = $2 and tr.target_id = $3
              and ft.status = 'RUNNING' and ft.worker_id = $4
              and ft.lease_token = $5 and ft.lease_expires_at > now()`,
          [input.trialId, input.forkId, input.targetId, input.workerId, input.leaseToken],
        );
        if (existing.rows[0]?.status !== "COMPLETED"
          || existing.rows[0].completion_hash !== completionHash) {
          throw new HandForkPersistenceConflictError("Hand fork trial is already terminal with different content");
        }
        row = existing.rows[0];
      }
      const targetProgress = await client.query(
        `update hand_fork_targets
            set terminal_trials = (
                  select count(*)::integer from hand_fork_trials
                   where target_id = $1 and status in ('COMPLETED', 'CANCELLED')
                ),
                updated_at = now()
          where id = $1 and status = 'RUNNING' and worker_id = $2
            and lease_token = $3 and lease_expires_at > now()`,
        [input.targetId, input.workerId, input.leaseToken],
      );
      if (targetProgress.rowCount !== 1) {
        throw new HandForkPersistenceConflictError("Trial completion lease expired before progress was recorded");
      }
      await client.query("commit");
      return mapTrial(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadTrialResult(trialId: string): Promise<HandForkTrialResultV1 | null> {
    const result = await this.pool.query<HandForkTrialRow & {
      encrypted_result: unknown | null;
      result_hash: string | null;
      completion_hash: string | null;
    }>(
      "select * from hand_fork_trials where id = $1",
      [trialId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Unknown hand fork trial: ${trialId}`);
    if (row.encrypted_result === null || row.result_hash === null) return null;
    const value = decryptJson(
      encryptedPayloadSchema.parse(row.encrypted_result),
      this.masterKey,
      trialResultAad(row.fork_id, row.target_id, trialId),
    );
    if (sha256(value) !== row.result_hash) throw new Error("Hand fork trial result hash mismatch");
    const completionHash = sha256({
      forkId: row.fork_id,
      targetId: row.target_id,
      trialId,
      outcome: row.outcome,
      action: row.action,
      amountTo: row.amount_to,
      decisionSummary: row.decision_summary,
      usedFallback: row.used_fallback,
      firstTurnValid: row.first_turn_valid,
      historyQueryCount: row.history_query_count,
      protocolFailures: row.protocol_failures,
      infrastructureFailures: row.infrastructure_failures,
      callCount: row.call_count,
      totalLatencyMs: row.total_latency_ms,
      usage: row.usage === null ? null : handForkProviderUsageSchema.parse(row.usage),
      errorKind: row.error_kind,
      errorMessage: row.error_message,
      privateResult: value,
    });
    if (completionHash !== row.completion_hash) throw new Error("Hand fork trial completion hash mismatch");
    return trialResultSchema.parse(value) as HandForkTrialResultV1;
  }

  async loadTrialTurnAudits(trialId: string): Promise<DecryptedHandForkTurnAudit[]> {
    const result = await this.pool.query<HandForkTurnRow>(
      "select * from hand_fork_turns where trial_id = $1 order by turn_index",
      [trialId],
    );
    return result.rows.map((row) => {
      const request = canonicalModelRequestPersistenceSchema.parse(decryptJson(
        encryptedPayloadSchema.parse(row.encrypted_request),
        this.masterKey,
        turnAad(row.fork_id, row.target_id, row.trial_id, row.turn_index, "request"),
      )) as CanonicalModelRequest;
      if (sha256(request) !== row.request_hash) throw new Error("Hand fork turn request hash mismatch");
      const response = row.encrypted_response === null ? null : turnResponseSchema.parse(decryptJson(
        encryptedPayloadSchema.parse(row.encrypted_response),
        this.masterKey,
        turnAad(row.fork_id, row.target_id, row.trial_id, row.turn_index, "response"),
      )) as HandForkTurnResponse;
      if (response !== null && sha256(response) !== row.response_hash) {
        throw new Error("Hand fork turn response hash mismatch");
      }
      const refusal = row.encrypted_refusal === null ? null : decryptJson(
        encryptedPayloadSchema.parse(row.encrypted_refusal),
        this.masterKey,
        turnAad(row.fork_id, row.target_id, row.trial_id, row.turn_index, "refusal"),
      );
      if (refusal !== null && (typeof refusal !== "string" || sha256(refusal) !== row.refusal_hash)) {
        throw new Error("Hand fork turn refusal hash mismatch");
      }
      const responseRefusal = response && typeof response === "object" && !Array.isArray(response)
        ? (response as { transportAudit?: { refusal?: unknown } }).transportAudit?.refusal ?? null
        : null;
      if (responseRefusal !== refusal) throw new Error("Hand fork turn refusal audit mismatch");
      const contentHash = sha256({
        forkId: row.fork_id,
        targetId: row.target_id,
        trialId: row.trial_id,
        turnIndex: row.turn_index,
        request,
        response,
        outcome: row.outcome,
        errorKind: row.error_kind,
        providerConfigHash: row.provider_config_hash,
        outputSchemaVersion: row.output_schema_version,
        outputSchemaHash: row.output_schema_hash,
        latencyMs: row.latency_ms,
        usage: row.usage === null ? null : handForkProviderUsageSchema.parse(row.usage),
      });
      if (contentHash !== row.content_hash) throw new Error("Hand fork turn content hash mismatch");
      return { metadata: mapTurnMetadata(row), request, response };
    });
  }

  async finishTarget(
    targetId: string,
    workerId: string,
    leaseToken: string,
    status: "COMPLETED" | "FAILED",
    errorMessage: string | null = null,
  ): Promise<void> {
    z.string().uuid().parse(targetId);
    z.string().uuid().parse(leaseToken);
    if (!workerId.trim() || workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    if (errorMessage !== null && errorMessage.length > 1_000) throw new Error("errorMessage is too long");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const identity = await client.query<{ fork_id: string }>(
        "select fork_id from hand_fork_targets where id = $1",
        [targetId],
      );
      if (!identity.rows[0]) throw new Error(`Unknown hand fork target: ${targetId}`);
      const forkLock = await client.query(
        "select id from hand_forks where id = $1 and status in ('QUEUED', 'RUNNING') for update",
        [identity.rows[0].fork_id],
      );
      if (forkLock.rowCount !== 1) throw new HandForkPersistenceConflictError("Hand fork is already terminal");
      const targetResult = await client.query<{ fork_id: string; sample_count: number }>(
        `select fork_id, sample_count
           from hand_fork_targets
          where id = $1 and status = 'RUNNING' and worker_id = $2
            and lease_token = $3 and lease_expires_at > now()
          for update`,
        [targetId, workerId, leaseToken],
      );
      const target = targetResult.rows[0];
      if (!target) throw new HandForkPersistenceConflictError("Hand fork target lease is no longer valid");
      const trialsResult = await client.query<HandForkTrialRow>(
        "select * from hand_fork_trials where target_id = $1 order by sample_index",
        [targetId],
      );
      const summary = summarizeHandForkTrials(target.sample_count, trialsResult.rows.map((row) => mapTrial(row)));
      if (summary.terminalTrials !== trialsResult.rows.length) {
        throw new HandForkPersistenceConflictError("A target cannot finish while a trial is still running");
      }
      if (status === "COMPLETED" && summary.completedTrials !== target.sample_count) {
        throw new HandForkPersistenceConflictError("A target cannot complete before every requested trial completed");
      }
      const updated = await client.query(
        `update hand_fork_targets
            set status = $3, summary = $4::jsonb, error_message = $5,
                terminal_trials = $6, worker_id = null, lease_token = null, lease_expires_at = null,
                completed_at = now(), updated_at = now()
          where id = $1 and status = 'RUNNING' and worker_id = $2
            and lease_token = $7 and lease_expires_at > now()`,
        [targetId, workerId, status, JSON.stringify(summary), errorMessage, summary.terminalTrials, leaseToken],
      );
      if (updated.rowCount !== 1) throw new HandForkPersistenceConflictError("Hand fork target lease expired before completion");
      await this.#refreshForkStatus(client, target.fork_id);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelFork(forkId: string): Promise<HandForkPersistenceRecord | null> {
    z.string().uuid().parse(forkId);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const fork = await client.query<{ status: HandForkStatus }>(
        "select status from hand_forks where id = $1 for update",
        [forkId],
      );
      if (fork.rows[0] && (fork.rows[0].status === "QUEUED" || fork.rows[0].status === "RUNNING")) {
        await client.query(
          `update hand_fork_trials
              set status = 'CANCELLED', outcome = 'CANCELLED', action = null,
                  amount_to = null, decision_summary = null, used_fallback = false,
                  encrypted_result = null, result_hash = null,
                  completed_at = now(), updated_at = now()
            where fork_id = $1 and status = 'RUNNING'`,
          [forkId],
        );
        const openTargets = await client.query<{ id: string; sample_count: number }>(
          `select id, sample_count from hand_fork_targets
            where fork_id = $1 and status in ('QUEUED', 'RUNNING')
            order by ordinal for update`,
          [forkId],
        );
        for (const target of openTargets.rows) {
          const trials = await client.query<HandForkTrialRow>(
            "select * from hand_fork_trials where target_id = $1 order by sample_index",
            [target.id],
          );
          const summary = summarizeHandForkTrials(
            target.sample_count,
            trials.rows.map((row) => mapTrial(row)),
          );
          await client.query(
            `update hand_fork_targets
                set status = 'CANCELLED', terminal_trials = $2,
                    summary = $3::jsonb, worker_id = null, lease_token = null,
                    lease_expires_at = null, completed_at = now(), updated_at = now()
              where id = $1 and status in ('QUEUED', 'RUNNING')`,
            [target.id, summary.terminalTrials, JSON.stringify(summary)],
          );
        }
        await this.#refreshForkStatus(client, forkId, "CANCELLED");
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.getFork(forkId, false);
  }

  async restorePending(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update hand_fork_targets
            set status = 'QUEUED', worker_id = null, lease_expires_at = null,
                lease_token = null, completed_at = null, updated_at = now()
          where status = 'RUNNING'
            and lease_expires_at <= now()
            and exists (
              select 1 from hand_forks f
               where f.id = hand_fork_targets.fork_id
                 and f.status in ('QUEUED', 'RUNNING')
            )`,
      );
      const runnable = await client.query<{ id: string }>(
        `select distinct f.id
           from hand_forks f
           join hand_fork_targets ft on ft.fork_id = f.id
          where f.status in ('QUEUED', 'RUNNING') and ft.status = 'QUEUED'
          order by f.id`,
      );
      await client.query("commit");
      return runnable.rows.map((row) => row.id);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRunnableForkIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `select distinct f.id
         from hand_forks f
         join hand_fork_targets ft on ft.fork_id = f.id
        where f.status in ('QUEUED', 'RUNNING')
          and (ft.status = 'QUEUED' or (
            ft.status = 'RUNNING' and ft.lease_expires_at <= now()
          ))
        order by f.created_at, f.id`,
    );
    return result.rows.map((row) => row.id);
  }

  async #leasedTrialIds(input: {
    trialId: string;
    targetId: string;
    workerId: string;
    leaseToken: string;
  }, queryable: Queryable = this.pool): Promise<{ forkId: string; targetId: string }> {
    z.string().uuid().parse(input.trialId);
    z.string().uuid().parse(input.targetId);
    z.string().uuid().parse(input.leaseToken);
    if (!input.workerId.trim() || input.workerId.length > 200) throw new Error("workerId must contain 1 to 200 characters");
    const result = await queryable.query<{ fork_id: string; target_id: string }>(
      `select tr.fork_id, tr.target_id
         from hand_fork_trials tr
         join hand_fork_targets ft on ft.id = tr.target_id
        where tr.id = $1 and tr.target_id = $2 and tr.status = 'RUNNING'
          and ft.status = 'RUNNING' and ft.worker_id = $3
          and ft.lease_token = $4 and ft.lease_expires_at > now()`,
      [input.trialId, input.targetId, input.workerId, input.leaseToken],
    );
    const row = result.rows[0];
    if (!row) throw new HandForkPersistenceConflictError("Trial write lease is no longer valid");
    return { forkId: row.fork_id, targetId: row.target_id };
  }

  async #refreshForkStatus(
    client: PoolClient,
    forkId: string,
    forcedStatus: "CANCELLED" | null = null,
  ): Promise<void> {
    const result = await client.query<{
      status: HandForkTargetStatus;
      summary: unknown | null;
      sample_count: number;
    }>(
      "select status, summary, sample_count from hand_fork_targets where fork_id = $1 order by ordinal",
      [forkId],
    );
    if (result.rows.length === 0) throw new Error("Hand fork has no targets");
    const summaries = result.rows.map((row) => (
      row.summary === null ? null : handForkTargetSummarySchema.parse(row.summary)
    ));
    const open = result.rows.some((row) => row.status === "QUEUED" || row.status === "RUNNING");
    let status: HandForkStatus;
    if (forcedStatus) status = forcedStatus;
    else if (open) status = "RUNNING";
    else if (result.rows.every((row) => row.status === "COMPLETED")) status = "COMPLETED";
    else if (result.rows.some((row) => row.status === "COMPLETED")) status = "PARTIAL";
    else if (result.rows.every((row) => row.status === "CANCELLED")) status = "CANCELLED";
    else status = "FAILED";
    const terminalTargets = result.rows.filter((row) => (
      row.status === "COMPLETED" || row.status === "FAILED" || row.status === "CANCELLED"
    )).length;
    const requestedTrials = result.rows.reduce((sum, row) => sum + row.sample_count, 0);
    const terminalTrials = summaries.reduce((sum, summary) => sum + (summary?.terminalTrials ?? 0), 0);
    const summary = handForkAggregateSummarySchema.parse({
      totalTargets: result.rows.length,
      terminalTargets,
      targetTerminalCoverage: terminalTargets / result.rows.length,
      completedTargets: result.rows.filter((row) => row.status === "COMPLETED").length,
      failedTargets: result.rows.filter((row) => row.status === "FAILED").length,
      cancelledTargets: result.rows.filter((row) => row.status === "CANCELLED").length,
      requestedTrials,
      terminalTrials,
      trialTerminalCoverage: requestedTrials === 0 ? 0 : terminalTrials / requestedTrials,
      completedTrials: summaries.reduce((sum, summary) => sum + (summary?.completedTrials ?? 0), 0),
      cancelledTrials: summaries.reduce((sum, summary) => sum + (summary?.cancelledTrials ?? 0), 0),
      modelActionTrials: summaries.reduce((sum, summary) => sum + (summary?.modelActionTrials ?? 0), 0),
      fallbackTrials: summaries.reduce((sum, summary) => sum + (summary?.fallbackTrials ?? 0), 0),
      infrastructureErrorTrials: summaries.reduce((sum, summary) => sum + (summary?.infrastructureErrorTrials ?? 0), 0),
    });
    const terminal = forcedStatus !== null || !open;
    await client.query(
      `update hand_forks
          set status = $2, summary = $3::jsonb,
              completed_at = case when $4 then coalesce(completed_at, now()) else null end,
              updated_at = now()
        where id = $1 and ($5::boolean or status <> 'CANCELLED')`,
      [forkId, status, JSON.stringify(summary), terminal, forcedStatus !== null],
    );
  }

  #mapFork(row: HandForkRow, targets: HandForkTarget[]): HandForkPersistenceRecord {
    return {
      id: row.id,
      status: handForkStatusSchema.parse(row.status),
      sourceTournamentId: row.source_tournament_id,
      sourceDecisionId: row.source_decision_id,
      sourceHandNo: row.source_hand_no,
      sourcePlayerId: row.source_player_id,
      sourceExpectedAggregateVersion: Number(row.source_expected_aggregate_version),
      sourceActionEventSequence: Number(row.source_action_event_sequence),
      sourceEventHash: row.source_event_hash,
      sourceRequestHash: row.source_request_hash,
      sourcePayloadHash: row.source_payload_hash,
      visibleInputHash: row.visible_input_hash,
      legalContractHash: row.legal_contract_hash,
      protocolBundleId: row.protocol_bundle_id,
      rulesetVersion: row.ruleset_version,
      contextVersion: row.context_version,
      systemPromptHash: row.system_prompt_hash,
      outputSchemaHash: row.output_schema_hash,
      parserPolicyVersion: row.parser_policy_version,
      adapterProtocolVersion: row.adapter_protocol_version,
      historyProtocolVersion: row.history_protocol_version,
      correctionProtocolVersion: row.correction_protocol_version,
      historyBudget: row.history_budget,
      sampleCount: row.sample_count,
      timeoutMs: row.timeout_ms,
      maxParallelTargets: row.max_parallel_targets,
      targetCount: row.target_count,
      summary: row.summary === null ? null : handForkAggregateSummarySchema.parse(row.summary),
      errorMessage: row.error_message,
      createdByAdminUserId: row.created_by_admin_user_id,
      startedAt: nullableIso(row.started_at),
      completedAt: nullableIso(row.completed_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      targets,
    };
  }
}
