import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  arenaOutputSchema,
  decisionProtocolBundle,
  type ActionDecisionResponse,
  type CanonicalModelRequest,
} from "../../../../packages/contracts/src/index.js";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";
import { createProvider } from "../../../../packages/providers/src/provider-factory.js";
import {
  ProviderCallError,
  type ProviderDecision,
  type ProviderErrorKind,
  type ProviderTransportAudit,
  type ProviderUsage,
} from "../../../../packages/providers/src/provider.js";
import { inspectOutputPolicy } from "../../../../packages/providers/src/output-policy.js";
import {
  ARENA_DECISION_TIMEOUT_MAX_MS,
  ARENA_DECISION_TIMEOUT_MIN_MS,
  ARENA_DECISION_TIMEOUT_MS,
} from "../model-runtime.js";
import {
  CONSISTENCY_PRESETS,
  CONSISTENCY_SCENARIO_REGISTRY_VERSION,
  CONSISTENCY_SCENARIOS,
  consistencyScenario,
  type ConsistencyScenario,
  type ConsistencyTier,
} from "./consistency-scenarios.js";
import { ModelConfigService } from "./model-service.js";
import { SystemPromptVersionService } from "./system-prompt-service.js";

export type ConsistencyRunTier = ConsistencyTier | "single";
export type ConsistencyRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
export type ConsistencyBatchStatus = ConsistencyRunStatus | "PARTIAL";
export type ConsistencySampleOutcome = "VALID_ACTION" | "INVALID_DECISION" | "PROTOCOL_ERROR" | "INFRA_ERROR";

interface ConsistencyRunRow {
  id: string;
  batch_id: string | null;
  model_config_id: string;
  competitor_revision_id: string;
  system_prompt_version_id: string;
  status: ConsistencyRunStatus;
  tier: ConsistencyRunTier;
  scenario_registry_version: string;
  scenario_ids: string[];
  scenario_snapshots: ConsistencyScenario[];
  sample_count: number;
  total_samples: number;
  completed_samples: number;
  protocol_bundle_id: string;
  model_configuration_hash: string;
  system_prompt_hash: string;
  output_schema_hash: string;
  effective_output_mode: string;
  timeout_ms: number;
  execution_mode: "serial";
  summary: ConsistencySummary | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  model_display_name: string;
  model_id: string;
  prompt_name: string;
}

interface ConsistencyBatchRow {
  id: string;
  system_prompt_version_id: string;
  tier: ConsistencyRunTier;
  scenario_registry_version: string;
  scenario_ids: string[];
  scenario_snapshots: ConsistencyScenario[];
  model_config_ids: string[];
  sample_count: number;
  timeout_ms: number;
  max_parallel_models: number;
  protocol_bundle_id: string;
  system_prompt_hash: string;
  output_schema_hash: string;
  created_at: Date;
  prompt_name: string;
}

interface ConsistencySampleRow {
  id: string;
  run_id: string;
  scenario_id: string;
  sample_index: number;
  outcome: ConsistencySampleOutcome;
  action: string | null;
  amount_to: number | null;
  decision_summary: string | null;
  parsed_output: ActionDecisionResponse | null;
  raw_text: string | null;
  error_kind: string | null;
  error_message: string | null;
  latency_ms: number;
  usage: ProviderUsage | null;
  transport_audit: ProviderTransportAudit | null;
  visible_input_hash: string;
  created_at: Date;
}

export interface PublicConsistencySample {
  id: string;
  scenarioId: string;
  sampleIndex: number;
  outcome: ConsistencySampleOutcome;
  action: string | null;
  amountTo: number | null;
  decisionSummary: string | null;
  parsedOutput: ActionDecisionResponse | null;
  rawText: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  latencyMs: number;
  usage: ProviderUsage | null;
  transportAudit: ProviderTransportAudit | null;
  visibleInputHash: string;
  createdAt: string;
}

export interface ScenarioConsistencySummary {
  scenarioId: string;
  completedSamples: number;
  validActions: number;
  validityRate: number | null;
  dominantAction: string | null;
  dominantCount: number;
  dominantShare: number | null;
  pairwiseAgreement: number | null;
  actionDistribution: Record<string, number>;
  sizing: Record<string, { count: number; median: number; min: number; max: number; values: number[] }>;
  outcomes: Record<ConsistencySampleOutcome, number>;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  uniqueInputHashes: string[];
}

export interface ConsistencySummary {
  completedSamples: number;
  validActions: number;
  validityRate: number | null;
  meanDominantShare: number | null;
  meanPairwiseAgreement: number | null;
  outcomes: Record<ConsistencySampleOutcome, number>;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalTokens: number | null;
  scenarios: ScenarioConsistencySummary[];
  dimensions: Record<string, Record<string, {
    scenarios: number;
    meanDominantShare: number | null;
    meanPairwiseAgreement: number | null;
    validityRate: number | null;
  }>>;
}

export interface PublicConsistencyRun {
  id: string;
  batchId: string | null;
  modelConfigId: string;
  competitorRevisionId: string;
  modelDisplayName: string;
  modelId: string;
  systemPromptVersionId: string;
  promptName: string;
  status: ConsistencyRunStatus;
  tier: ConsistencyRunTier;
  scenarioRegistryVersion: string;
  scenarioIds: string[];
  sampleCount: number;
  totalSamples: number;
  completedSamples: number;
  protocolBundleId: string;
  modelConfigurationHash: string;
  systemPromptHash: string;
  outputSchemaHash: string;
  effectiveOutputMode: string;
  timeoutMs: number;
  executionMode: "serial";
  summary: ConsistencySummary | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  scenarios?: ConsistencyScenario[];
  samples?: PublicConsistencySample[];
}

export interface PublicConsistencyBatch {
  id: string;
  systemPromptVersionId: string;
  promptName: string;
  status: ConsistencyBatchStatus;
  tier: ConsistencyRunTier;
  scenarioRegistryVersion: string;
  scenarioIds: string[];
  modelConfigIds: string[];
  sampleCount: number;
  timeoutMs: number;
  maxParallelModels: number;
  protocolBundleId: string;
  systemPromptHash: string;
  outputSchemaHash: string;
  totalModels: number;
  totalSamples: number;
  completedSamples: number;
  createdAt: string;
  runs: PublicConsistencyRun[];
  scenarios?: ConsistencyScenario[];
}

export interface CreateConsistencyRunInput {
  modelConfigId: string;
  tier: ConsistencyRunTier;
  scenarioId?: string | undefined;
  sampleCount: number;
  systemPromptVersionId?: string | undefined;
  timeoutMs?: number | undefined;
  adminUserId: string;
}

export interface CreateConsistencyBatchInput {
  modelConfigIds: string[];
  tier: ConsistencyRunTier;
  scenarioId?: string | undefined;
  sampleCount: number;
  systemPromptVersionId?: string | undefined;
  timeoutMs?: number | undefined;
  adminUserId: string;
}

interface ExecutedSample {
  outcome: ConsistencySampleOutcome;
  action: string | null;
  amountTo: number | null;
  decisionSummary: string | null;
  parsedOutput: ActionDecisionResponse | null;
  rawText: string | null;
  errorKind: ProviderErrorKind | "ILLEGAL_ACTION" | "HISTORY_QUERY_NOT_ALLOWED" | null;
  errorMessage: string | null;
  latencyMs: number;
  usage: ProviderUsage | null;
  transportAudit: ProviderTransportAudit | null;
  visibleInputHash: string;
}

const RUN_SELECT = `select r.*, m.display_name as model_display_name,
  cr.model_id, p.name as prompt_name
  from consistency_runs r
  join model_configs m on m.id = r.model_config_id
  join competitor_revisions cr on cr.id = r.competitor_revision_id
  join system_prompt_versions p on p.id = r.system_prompt_version_id`;

const BATCH_SELECT = `select b.*, p.name as prompt_name
  from consistency_batches b
  join system_prompt_versions p on p.id = b.system_prompt_version_id`;

export function deriveConsistencyBatchStatus(statuses: readonly ConsistencyRunStatus[]): ConsistencyBatchStatus {
  if (statuses.length === 0) return "FAILED";
  if (statuses.every((status) => status === "COMPLETED")) return "COMPLETED";
  if (statuses.every((status) => status === "CANCELLED")) return "CANCELLED";
  if (statuses.some((status) => status === "RUNNING")) return "RUNNING";
  if (statuses.some((status) => status === "QUEUED")) {
    return statuses.every((status) => status === "QUEUED") ? "QUEUED" : "RUNNING";
  }
  if (statuses.some((status) => status === "COMPLETED")) return "PARTIAL";
  if (statuses.some((status) => status === "FAILED")) return "FAILED";
  return "CANCELLED";
}

function average(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * ordered.length) - 1);
  return ordered[index] ?? null;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  return average(values.filter((value): value is number => value !== null));
}

function emptyOutcomes(): Record<ConsistencySampleOutcome, number> {
  return { VALID_ACTION: 0, INVALID_DECISION: 0, PROTOCOL_ERROR: 0, INFRA_ERROR: 0 };
}

function summarizeScenario(scenarioId: string, samples: readonly PublicConsistencySample[]): ScenarioConsistencySummary {
  const actionDistribution: Record<string, number> = {};
  const outcomes = emptyOutcomes();
  const sizes: Record<string, number[]> = {};
  for (const sample of samples) {
    outcomes[sample.outcome] += 1;
    if (sample.outcome !== "VALID_ACTION" || !sample.action) continue;
    actionDistribution[sample.action] = (actionDistribution[sample.action] ?? 0) + 1;
    if ((sample.action === "bet" || sample.action === "raise") && sample.amountTo !== null) {
      (sizes[sample.action] ??= []).push(sample.amountTo);
    }
  }
  const validActions = outcomes.VALID_ACTION;
  const dominant = Object.entries(actionDistribution)
    .sort(([leftAction, leftCount], [rightAction, rightCount]) => rightCount - leftCount || leftAction.localeCompare(rightAction))[0] ?? null;
  const matchingPairs = Object.values(actionDistribution)
    .reduce((total, count) => total + count * (count - 1), 0);
  const totalPairs = validActions * (validActions - 1);
  const sizing = Object.fromEntries(Object.entries(sizes).map(([actionName, values]) => {
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2 === 1
      ? ordered[middle]!
      : (ordered[middle - 1]! + ordered[middle]!) / 2;
    return [actionName, {
      count: ordered.length,
      median,
      min: ordered[0]!,
      max: ordered.at(-1)!,
      values: ordered,
    }];
  }));
  return {
    scenarioId,
    completedSamples: samples.length,
    validActions,
    validityRate: samples.length > 0 ? validActions / samples.length : null,
    dominantAction: dominant?.[0] ?? null,
    dominantCount: dominant?.[1] ?? 0,
    dominantShare: dominant && validActions > 0 ? dominant[1] / validActions : null,
    pairwiseAgreement: totalPairs > 0 ? matchingPairs / totalPairs : null,
    actionDistribution,
    sizing,
    outcomes,
    averageLatencyMs: average(samples.map((sample) => sample.latencyMs)),
    p95LatencyMs: percentile(samples.map((sample) => sample.latencyMs), 0.95),
    uniqueInputHashes: [...new Set(samples.map((sample) => sample.visibleInputHash))],
  };
}

export function summarizeConsistencySamples(
  scenarios: readonly ConsistencyScenario[],
  samples: readonly PublicConsistencySample[],
): ConsistencySummary {
  const byScenario = scenarios.map((scenario) => summarizeScenario(
    scenario.id,
    samples.filter((sample) => sample.scenarioId === scenario.id),
  ));
  const outcomes = emptyOutcomes();
  for (const sample of samples) outcomes[sample.outcome] += 1;
  const dimensionKeys = ["street", "tableSize", "potType", "position", "stackDepth", "handClass"] as const;
  const dimensions: ConsistencySummary["dimensions"] = {};
  for (const key of dimensionKeys) {
    const groups = new Map<string, ScenarioConsistencySummary[]>();
    for (const [index, scenario] of scenarios.entries()) {
      const value = String(scenario.tags[key]);
      const group = groups.get(value) ?? [];
      group.push(byScenario[index]!);
      groups.set(value, group);
    }
    dimensions[key] = Object.fromEntries([...groups.entries()].map(([value, summaries]) => {
      const completed = summaries.filter((summary) => summary.completedSamples > 0);
      const totalCompleted = completed.reduce((sum, summary) => sum + summary.completedSamples, 0);
      const valid = completed.reduce((sum, summary) => sum + summary.validActions, 0);
      return [value, {
        scenarios: completed.length,
        meanDominantShare: meanNullable(completed.map((summary) => summary.dominantShare)),
        meanPairwiseAgreement: meanNullable(completed.map((summary) => summary.pairwiseAgreement)),
        validityRate: totalCompleted > 0 ? valid / totalCompleted : null,
      }];
    }));
  }
  const tokenValues = samples.map((sample) => sample.usage?.totalTokens).filter((value): value is number => value !== null && value !== undefined);
  const scenarioValues = byScenario.filter((summary) => summary.completedSamples > 0);
  return {
    completedSamples: samples.length,
    validActions: outcomes.VALID_ACTION,
    validityRate: samples.length > 0 ? outcomes.VALID_ACTION / samples.length : null,
    meanDominantShare: meanNullable(scenarioValues.map((summary) => summary.dominantShare)),
    meanPairwiseAgreement: meanNullable(scenarioValues.map((summary) => summary.pairwiseAgreement)),
    outcomes,
    averageLatencyMs: average(samples.map((sample) => sample.latencyMs)),
    p95LatencyMs: percentile(samples.map((sample) => sample.latencyMs), 0.95),
    totalTokens: tokenValues.length > 0 ? tokenValues.reduce((sum, value) => sum + value, 0) : null,
    scenarios: byScenario,
    dimensions,
  };
}

function publicSample(row: ConsistencySampleRow): PublicConsistencySample {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    sampleIndex: row.sample_index,
    outcome: row.outcome,
    action: row.action,
    amountTo: row.amount_to,
    decisionSummary: row.decision_summary,
    parsedOutput: row.parsed_output,
    rawText: row.raw_text,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    latencyMs: row.latency_ms,
    usage: row.usage,
    transportAudit: row.transport_audit,
    visibleInputHash: row.visible_input_hash,
    createdAt: row.created_at.toISOString(),
  };
}

function publicRun(row: ConsistencyRunRow, detail?: {
  scenarios?: ConsistencyScenario[];
  samples?: PublicConsistencySample[];
  summary: ConsistencySummary;
}): PublicConsistencyRun {
  return {
    id: row.id,
    batchId: row.batch_id,
    modelConfigId: row.model_config_id,
    competitorRevisionId: row.competitor_revision_id,
    modelDisplayName: row.model_display_name,
    modelId: row.model_id,
    systemPromptVersionId: row.system_prompt_version_id,
    promptName: row.prompt_name,
    status: row.status,
    tier: row.tier,
    scenarioRegistryVersion: row.scenario_registry_version,
    scenarioIds: row.scenario_ids,
    sampleCount: row.sample_count,
    totalSamples: row.total_samples,
    completedSamples: row.completed_samples,
    protocolBundleId: row.protocol_bundle_id,
    modelConfigurationHash: row.model_configuration_hash,
    systemPromptHash: row.system_prompt_hash,
    outputSchemaHash: row.output_schema_hash,
    effectiveOutputMode: row.effective_output_mode,
    timeoutMs: row.timeout_ms,
    executionMode: row.execution_mode,
    summary: detail?.summary ?? row.summary,
    errorMessage: row.error_message,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(detail?.scenarios ? { scenarios: detail.scenarios } : {}),
    ...(detail?.samples ? { samples: detail.samples } : {}),
  };
}

function publicBatch(
  row: ConsistencyBatchRow,
  runs: PublicConsistencyRun[],
  includeScenarios: boolean,
): PublicConsistencyBatch {
  return {
    id: row.id,
    systemPromptVersionId: row.system_prompt_version_id,
    promptName: row.prompt_name,
    status: deriveConsistencyBatchStatus(runs.map((run) => run.status)),
    tier: row.tier,
    scenarioRegistryVersion: row.scenario_registry_version,
    scenarioIds: row.scenario_ids,
    modelConfigIds: row.model_config_ids,
    sampleCount: row.sample_count,
    timeoutMs: row.timeout_ms,
    maxParallelModels: row.max_parallel_models,
    protocolBundleId: row.protocol_bundle_id,
    systemPromptHash: row.system_prompt_hash,
    outputSchemaHash: row.output_schema_hash,
    totalModels: runs.length,
    totalSamples: runs.reduce((total, run) => total + run.totalSamples, 0),
    completedSamples: runs.reduce((total, run) => total + run.completedSamples, 0),
    createdAt: row.created_at.toISOString(),
    runs,
    ...(includeScenarios ? { scenarios: row.scenario_snapshots } : {}),
  };
}

function validateDecision(decision: ProviderDecision, scenario: ConsistencyScenario): ExecutedSample {
  const parsed = decision.parsed;
  if (parsed.type === "history_query") {
    return {
      outcome: "INVALID_DECISION",
      action: null,
      amountTo: null,
      decisionSummary: null,
      parsedOutput: parsed,
      rawText: decision.rawText,
      errorKind: "HISTORY_QUERY_NOT_ALLOWED",
      errorMessage: "History queries are disabled in strict consistency tests",
      latencyMs: decision.latencyMs,
      usage: decision.usage,
      transportAudit: decision.transportAudit ?? null,
      visibleInputHash: "",
    };
  }
  const legal = scenario.arenaState.legal_actions as {
    allowed?: unknown;
    bet?: { min_amount_to?: unknown; max_amount_to?: unknown } | null;
    raise?: { min_amount_to?: unknown; max_amount_to?: unknown } | null;
  };
  const allowed = Array.isArray(legal.allowed) ? legal.allowed : [];
  if (!allowed.includes(parsed.action)) {
    return {
      outcome: "INVALID_DECISION",
      action: parsed.action,
      amountTo: parsed.amount_to ?? null,
      decisionSummary: parsed.decision_summary ?? null,
      parsedOutput: parsed,
      rawText: decision.rawText,
      errorKind: "ILLEGAL_ACTION",
      errorMessage: `Action ${parsed.action} is not legal in this scenario`,
      latencyMs: decision.latencyMs,
      usage: decision.usage,
      transportAudit: decision.transportAudit ?? null,
      visibleInputHash: "",
    };
  }
  if (parsed.action === "bet" || parsed.action === "raise") {
    const bounds = legal[parsed.action];
    const minimum = bounds?.min_amount_to;
    const maximum = bounds?.max_amount_to;
    if (!Number.isSafeInteger(parsed.amount_to)
      || typeof minimum !== "number" || typeof maximum !== "number"
      || parsed.amount_to! < minimum || parsed.amount_to! > maximum) {
      return {
        outcome: "INVALID_DECISION",
        action: parsed.action,
        amountTo: parsed.amount_to ?? null,
        decisionSummary: parsed.decision_summary ?? null,
        parsedOutput: parsed,
        rawText: decision.rawText,
        errorKind: "ILLEGAL_ACTION",
        errorMessage: `${parsed.action} amount_to is outside the legal range`,
        latencyMs: decision.latencyMs,
        usage: decision.usage,
        transportAudit: decision.transportAudit ?? null,
        visibleInputHash: "",
      };
    }
  }
  return {
    outcome: "VALID_ACTION",
    action: parsed.action,
    amountTo: parsed.amount_to ?? null,
    decisionSummary: parsed.decision_summary ?? null,
    parsedOutput: parsed,
    rawText: decision.rawText,
    errorKind: null,
    errorMessage: null,
    latencyMs: decision.latencyMs,
    usage: decision.usage,
    transportAudit: decision.transportAudit ?? null,
    visibleInputHash: "",
  };
}

export class ConsistencyTestService {
  readonly #systemPrompts: SystemPromptVersionService;
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  readonly #activeWorkers = new Set<Promise<void>>();
  readonly #maxParallelRuns = 3;
  #stopping = false;

  constructor(
    private readonly pool: Pool,
    private readonly models: ModelConfigService,
    masterKey: Uint8Array,
  ) {
    this.#systemPrompts = new SystemPromptVersionService(pool, masterKey);
  }

  async restorePending(): Promise<void> {
    await this.pool.query("update consistency_runs set status = 'QUEUED', updated_at = now() where status = 'RUNNING'");
    const result = await this.pool.query<{ id: string }>(
      "select id from consistency_runs where status = 'QUEUED' order by created_at",
    );
    result.rows.forEach((row) => this.#enqueue(row.id));
  }

  shutdown(): void {
    this.#stopping = true;
  }

  async createRun(input: CreateConsistencyRunInput): Promise<PublicConsistencyRun> {
    const model = await this.models.currentRevision(input.modelConfigId);
    if (!model) throw new Error("Model configuration not found or disabled");
    if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1 || input.sampleCount > 30) {
      throw new Error("sampleCount must be between 1 and 30");
    }
    const timeoutMs = input.timeoutMs ?? ARENA_DECISION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < ARENA_DECISION_TIMEOUT_MIN_MS
      || timeoutMs > ARENA_DECISION_TIMEOUT_MAX_MS) {
      throw new Error(`timeoutMs must be between ${ARENA_DECISION_TIMEOUT_MIN_MS} and ${ARENA_DECISION_TIMEOUT_MAX_MS}`);
    }
    const selectedPrompt = await this.#systemPrompts.resolve(input.systemPromptVersionId);
    if (selectedPrompt.version.status !== "ACTIVE") throw new Error("Archived system prompt versions cannot start consistency tests");
    if (selectedPrompt.version.protocolBundleId !== "arena-native-v11") {
      throw new Error("Consistency scenario registry v1 requires an Arena v11 system prompt");
    }
    const scenarios = input.tier === "single"
      ? [consistencyScenario(input.scenarioId ?? "")].filter((scenario): scenario is ConsistencyScenario => scenario !== null)
      : CONSISTENCY_PRESETS[input.tier].map((id) => consistencyScenario(id)!);
    if (input.tier === "single" && scenarios.length !== 1) throw new Error("A valid scenarioId is required for a single-scenario test");
    const bundle = decisionProtocolBundle(selectedPrompt.version.protocolBundleId);
    const schema = arenaOutputSchema("ACTION_OR_HISTORY", bundle.outputSchemaVersion);
    const runtimeConfig = {
      ...await this.models.runtimeConfigForRevision(model.revisionId),
      timeoutMs,
    };
    const outputPolicy = inspectOutputPolicy(runtimeConfig);
    if (!outputPolicy.supported) throw new Error(outputPolicy.message ?? "Unsupported model output mode");
    const id = randomUUID();
    await this.pool.query(
      `insert into consistency_runs
        (id, model_config_id, competitor_revision_id, system_prompt_version_id,
         created_by_admin_user_id, status, tier, scenario_registry_version,
         scenario_ids, scenario_snapshots, sample_count, total_samples,
         protocol_bundle_id, model_configuration_hash, system_prompt_hash,
         output_schema_hash, effective_output_mode, timeout_ms)
       values ($1, $2, $3, $4, $5, 'QUEUED', $6, $7, $8::jsonb, $9::jsonb,
               $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        input.modelConfigId,
        model.revisionId,
        selectedPrompt.version.id,
        input.adminUserId,
        input.tier,
        CONSISTENCY_SCENARIO_REGISTRY_VERSION,
        JSON.stringify(scenarios.map((scenario) => scenario.id)),
        JSON.stringify(scenarios),
        input.sampleCount,
        scenarios.length * input.sampleCount,
        bundle.id,
        model.configurationHash,
        selectedPrompt.prompt.sha256,
        schema.sha256,
        outputPolicy.effectiveMode,
        timeoutMs,
      ],
    );
    this.#enqueue(id);
    return (await this.getRun(id, false))!;
  }

  async createBatch(input: CreateConsistencyBatchInput): Promise<PublicConsistencyBatch> {
    const modelConfigIds = [...new Set(input.modelConfigIds)];
    if (modelConfigIds.length !== input.modelConfigIds.length || modelConfigIds.length < 2 || modelConfigIds.length > 9) {
      throw new Error("modelConfigIds must contain 2 to 9 unique models");
    }
    if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 1 || input.sampleCount > 30) {
      throw new Error("sampleCount must be between 1 and 30");
    }
    const timeoutMs = input.timeoutMs ?? ARENA_DECISION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < ARENA_DECISION_TIMEOUT_MIN_MS
      || timeoutMs > ARENA_DECISION_TIMEOUT_MAX_MS) {
      throw new Error(`timeoutMs must be between ${ARENA_DECISION_TIMEOUT_MIN_MS} and ${ARENA_DECISION_TIMEOUT_MAX_MS}`);
    }
    const selectedPrompt = await this.#systemPrompts.resolve(input.systemPromptVersionId);
    if (selectedPrompt.version.status !== "ACTIVE") throw new Error("Archived system prompt versions cannot start consistency tests");
    if (selectedPrompt.version.protocolBundleId !== "arena-native-v11") {
      throw new Error("Consistency scenario registry v1 requires an Arena v11 system prompt");
    }
    const scenarios = input.tier === "single"
      ? [consistencyScenario(input.scenarioId ?? "")].filter((scenario): scenario is ConsistencyScenario => scenario !== null)
      : CONSISTENCY_PRESETS[input.tier].map((id) => consistencyScenario(id)!);
    if (input.tier === "single" && scenarios.length !== 1) throw new Error("A valid scenarioId is required for a single-scenario test");
    const bundle = decisionProtocolBundle(selectedPrompt.version.protocolBundleId);
    const schema = arenaOutputSchema("ACTION_OR_HISTORY", bundle.outputSchemaVersion);
    const preparedModels = [];
    for (const modelConfigId of modelConfigIds) {
      const model = await this.models.currentRevision(modelConfigId);
      if (!model) throw new Error(`Model configuration ${modelConfigId} not found or disabled`);
      const runtimeConfig = {
        ...await this.models.runtimeConfigForRevision(model.revisionId),
        timeoutMs,
      };
      const outputPolicy = inspectOutputPolicy(runtimeConfig);
      if (!outputPolicy.supported) {
        throw new Error(`${model.displayName}: ${outputPolicy.message ?? "Unsupported model output mode"}`);
      }
      preparedModels.push({ modelConfigId, model, effectiveOutputMode: outputPolicy.effectiveMode });
    }

    const batchId = randomUUID();
    const runIds: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into consistency_batches
          (id, system_prompt_version_id, created_by_admin_user_id, tier,
           scenario_registry_version, scenario_ids, scenario_snapshots,
           model_config_ids, sample_count, timeout_ms, max_parallel_models,
           protocol_bundle_id, system_prompt_hash, output_schema_hash)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
                 $9, $10, $11, $12, $13, $14)`,
        [
          batchId,
          selectedPrompt.version.id,
          input.adminUserId,
          input.tier,
          CONSISTENCY_SCENARIO_REGISTRY_VERSION,
          JSON.stringify(scenarios.map((scenario) => scenario.id)),
          JSON.stringify(scenarios),
          JSON.stringify(modelConfigIds),
          input.sampleCount,
          timeoutMs,
          this.#maxParallelRuns,
          bundle.id,
          selectedPrompt.prompt.sha256,
          schema.sha256,
        ],
      );
      for (const prepared of preparedModels) {
        const runId = randomUUID();
        runIds.push(runId);
        await client.query(
          `insert into consistency_runs
            (id, batch_id, model_config_id, competitor_revision_id,
             system_prompt_version_id, created_by_admin_user_id, status, tier,
             scenario_registry_version, scenario_ids, scenario_snapshots,
             sample_count, total_samples, protocol_bundle_id,
             model_configuration_hash, system_prompt_hash, output_schema_hash,
             effective_output_mode, timeout_ms)
           values ($1, $2, $3, $4, $5, $6, 'QUEUED', $7, $8, $9::jsonb,
                   $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            runId,
            batchId,
            prepared.modelConfigId,
            prepared.model.revisionId,
            selectedPrompt.version.id,
            input.adminUserId,
            input.tier,
            CONSISTENCY_SCENARIO_REGISTRY_VERSION,
            JSON.stringify(scenarios.map((scenario) => scenario.id)),
            JSON.stringify(scenarios),
            input.sampleCount,
            scenarios.length * input.sampleCount,
            bundle.id,
            prepared.model.configurationHash,
            selectedPrompt.prompt.sha256,
            schema.sha256,
            prepared.effectiveOutputMode,
            timeoutMs,
          ],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    runIds.forEach((id) => this.#enqueue(id));
    return (await this.getBatch(batchId, true))!;
  }

  async listRuns(modelConfigId?: string): Promise<PublicConsistencyRun[]> {
    const result = await this.pool.query<ConsistencyRunRow>(
      `${RUN_SELECT}${modelConfigId ? " where r.model_config_id = $1" : ""} order by r.created_at desc limit 50`,
      modelConfigId ? [modelConfigId] : [],
    );
    return result.rows.map((row) => publicRun(row));
  }

  async listBatches(): Promise<PublicConsistencyBatch[]> {
    const batches = await this.pool.query<ConsistencyBatchRow>(`${BATCH_SELECT} order by b.created_at desc limit 50`);
    if (batches.rows.length === 0) return [];
    const batchIds = batches.rows.map((row) => row.id);
    const runs = await this.pool.query<ConsistencyRunRow>(
      `${RUN_SELECT} where r.batch_id = any($1::uuid[]) order by r.created_at, r.id`,
      [batchIds],
    );
    return batches.rows.map((batch) => publicBatch(
      batch,
      runs.rows.filter((run) => run.batch_id === batch.id).map((run) => publicRun(run)),
      false,
    ));
  }

  async getBatch(id: string, includeDetail = true): Promise<PublicConsistencyBatch | null> {
    const batchResult = await this.pool.query<ConsistencyBatchRow>(`${BATCH_SELECT} where b.id = $1`, [id]);
    const batch = batchResult.rows[0];
    if (!batch) return null;
    const runResult = await this.pool.query<ConsistencyRunRow>(
      `${RUN_SELECT} where r.batch_id = $1 order by array_position($2::uuid[], r.model_config_id)`,
      [id, batch.model_config_ids],
    );
    if (!includeDetail) return publicBatch(batch, runResult.rows.map((run) => publicRun(run)), false);
    const liveRunIds = runResult.rows
      .filter((run) => run.status !== "COMPLETED" || run.summary === null)
      .map((run) => run.id);
    const samplesByRun = await this.#samplesForRuns(liveRunIds);
    const runs = runResult.rows.map((run) => publicRun(run, {
      summary: run.status === "COMPLETED" && run.summary
        ? run.summary
        : summarizeConsistencySamples(batch.scenario_snapshots, samplesByRun.get(run.id) ?? []),
    }));
    return publicBatch(batch, runs, true);
  }

  async getRun(id: string, includeDetail = true): Promise<PublicConsistencyRun | null> {
    const result = await this.pool.query<ConsistencyRunRow>(`${RUN_SELECT} where r.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    if (!includeDetail) return publicRun(row);
    const samples = await this.#samples(id);
    const summary = summarizeConsistencySamples(row.scenario_snapshots, samples);
    return publicRun(row, { scenarios: row.scenario_snapshots, samples, summary });
  }

  async cancelRun(id: string): Promise<PublicConsistencyRun | null> {
    const result = await this.pool.query<{ id: string }>(
      `update consistency_runs
          set status = 'CANCELLED', completed_at = now(), updated_at = now()
        where id = $1 and status in ('QUEUED', 'RUNNING') returning id`,
      [id],
    );
    if (!result.rows[0]) return this.getRun(id, false);
    this.#queued.delete(id);
    const queuedIndex = this.#queue.indexOf(id);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    return this.getRun(id, false);
  }

  async cancelBatch(id: string): Promise<PublicConsistencyBatch | null> {
    const existing = await this.getBatch(id, false);
    if (!existing) return null;
    const result = await this.pool.query<{ id: string }>(
      `update consistency_runs
          set status = 'CANCELLED', completed_at = now(), updated_at = now()
        where batch_id = $1 and status in ('QUEUED', 'RUNNING') returning id`,
      [id],
    );
    for (const row of result.rows) {
      this.#queued.delete(row.id);
      const queuedIndex = this.#queue.indexOf(row.id);
      if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    }
    return this.getBatch(id, false);
  }

  #enqueue(id: string): void {
    if (this.#stopping || this.#queued.has(id)) return;
    this.#queued.add(id);
    this.#queue.push(id);
    this.#pump();
  }

  #pump(): void {
    while (!this.#stopping && this.#activeWorkers.size < this.#maxParallelRuns) {
      const id = this.#queue.shift();
      if (!id) break;
      this.#queued.delete(id);
      let worker: Promise<void>;
      worker = this.#processRun(id).finally(() => {
        this.#activeWorkers.delete(worker);
        this.#pump();
      });
      this.#activeWorkers.add(worker);
    }
  }

  async #processRun(id: string): Promise<void> {
    const claimed = await this.pool.query(
      `update consistency_runs set status = 'RUNNING', started_at = coalesce(started_at, now()),
              updated_at = now()
        where id = $1 and status = 'QUEUED' returning id`,
      [id],
    );
    if (claimed.rowCount !== 1) return;
    try {
      const runResult = await this.pool.query<ConsistencyRunRow>(`${RUN_SELECT} where r.id = $1`, [id]);
      const run = runResult.rows[0];
      if (!run) throw new Error("Consistency run not found after claim");
      const selectedPrompt = await this.#systemPrompts.resolve(run.system_prompt_version_id);
      const bundle = decisionProtocolBundle(run.protocol_bundle_id);
      const schema = arenaOutputSchema("ACTION_OR_HISTORY", bundle.outputSchemaVersion);
      const runtimeConfig = {
        ...await this.models.runtimeConfigForRevision(run.competitor_revision_id),
        timeoutMs: run.timeout_ms,
      };
      const provider = createProvider(runtimeConfig);
      const existing = await this.pool.query<{ scenario_id: string; sample_index: number }>(
        "select scenario_id, sample_index from consistency_samples where run_id = $1",
        [id],
      );
      const completed = new Set(existing.rows.map((row) => `${row.scenario_id}:${row.sample_index}`));
      let consecutiveInfrastructureFailures = 0;
      for (const scenario of run.scenario_snapshots) {
        for (let sampleIndex = 1; sampleIndex <= run.sample_count; sampleIndex += 1) {
          if (this.#stopping) return;
          if (completed.has(`${scenario.id}:${sampleIndex}`)) continue;
          const status = await this.pool.query<{ status: ConsistencyRunStatus }>("select status from consistency_runs where id = $1", [id]);
          if (status.rows[0]?.status !== "RUNNING") return;
          const sample = await this.#executeSample({
            runId: id,
            sampleIndex,
            scenario,
            provider,
            selectedPrompt: selectedPrompt.prompt,
            promptRuntimeVersion: selectedPrompt.version.runtimeVersion,
            bundle,
            schema,
            timeoutMs: run.timeout_ms,
          });
          await this.#insertSample(id, scenario.id, sampleIndex, sample);
          await this.pool.query(
            `update consistency_runs
                set completed_samples = (select count(*) from consistency_samples where run_id = $1),
                    updated_at = now()
              where id = $1`,
            [id],
          );
          if (sample.outcome === "INFRA_ERROR") consecutiveInfrastructureFailures += 1;
          else consecutiveInfrastructureFailures = 0;
          if (sample.errorKind === "AUTH" || sample.errorKind === "CONFIG") {
            throw new Error(`${sample.errorKind}: ${sample.errorMessage ?? "Provider configuration failed"}`);
          }
          if (consecutiveInfrastructureFailures >= 3) {
            throw new Error(`Stopped after 3 consecutive infrastructure failures: ${sample.errorMessage ?? sample.errorKind ?? "unknown error"}`);
          }
        }
      }
      const samples = await this.#samples(id);
      const summary = summarizeConsistencySamples(run.scenario_snapshots, samples);
      await this.pool.query(
        `update consistency_runs
            set status = 'COMPLETED', completed_samples = $2, summary = $3::jsonb,
                completed_at = now(), updated_at = now()
          where id = $1 and status = 'RUNNING'`,
        [id, samples.length, JSON.stringify(summary)],
      );
    } catch (error) {
      await this.pool.query(
        `update consistency_runs
            set status = 'FAILED', error_message = $2, completed_at = now(), updated_at = now()
          where id = $1 and status = 'RUNNING'`,
        [id, error instanceof Error ? error.message : "Unknown consistency runner failure"],
      );
    }
  }

  async #executeSample(input: {
    runId: string;
    sampleIndex: number;
    scenario: ConsistencyScenario;
    provider: ReturnType<typeof createProvider>;
    selectedPrompt: { text: string; sha256: string };
    promptRuntimeVersion: string;
    bundle: ReturnType<typeof decisionProtocolBundle>;
    schema: ReturnType<typeof arenaOutputSchema>;
    timeoutMs: number;
  }): Promise<ExecutedSample> {
    const arenaState = structuredClone(input.scenario.arenaState);
    arenaState.prompt_version = input.promptRuntimeVersion;
    const userPayload = {
      arena_control: {
        mode: "decision",
        correction_attempt: 0,
        max_correction_attempts: 1,
        error_codes: [],
        history_budget_remaining: { queries: 0, approximate_tokens: 0, max_records_per_query: 80 },
      },
      arena_state: arenaState,
      history_results: [],
    };
    const visibleInputHash = createHash("sha256").update(canonicalJson({
      systemPromptHash: input.selectedPrompt.sha256,
      systemPrompt: input.selectedPrompt.text,
      outputSchemaHash: input.schema.sha256,
      adapterProtocolVersion: input.bundle.adapterProtocolVersion,
      userPayload,
    })).digest("hex");
    const request: CanonicalModelRequest = {
      requestId: randomUUID(),
      expectedOutput: "ACTION_OR_HISTORY",
      systemPrompt: input.selectedPrompt.text,
      systemPromptHash: input.selectedPrompt.sha256,
      outputSchema: input.schema,
      userPayload,
      timeoutMs: input.timeoutMs,
      parserPolicy: input.bundle.parserPolicyVersion,
      adapterProtocolVersion: input.bundle.adapterProtocolVersion,
    };
    const started = Date.now();
    try {
      const decision = await input.provider.decide(request);
      return { ...validateDecision(decision, input.scenario), visibleInputHash };
    } catch (error) {
      const classified = input.provider.classifyError(error);
      const protocolError = classified.kind === "INVALID_RESPONSE";
      return {
        outcome: protocolError ? "PROTOCOL_ERROR" : "INFRA_ERROR",
        action: null,
        amountTo: null,
        decisionSummary: null,
        parsedOutput: null,
        rawText: error instanceof ProviderCallError ? error.rawResponseText ?? null : null,
        errorKind: classified.kind,
        errorMessage: classified.message,
        latencyMs: Math.max(0, Date.now() - started),
        usage: null,
        transportAudit: null,
        visibleInputHash,
      };
    }
  }

  async #insertSample(runId: string, scenarioId: string, sampleIndex: number, sample: ExecutedSample): Promise<void> {
    await this.pool.query(
      `insert into consistency_samples
        (id, run_id, scenario_id, sample_index, outcome, action, amount_to,
         decision_summary, parsed_output, raw_text, error_kind, error_message,
         latency_ms, usage, transport_audit, visible_input_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
               $13, $14::jsonb, $15::jsonb, $16)
       on conflict (run_id, scenario_id, sample_index) do nothing`,
      [
        randomUUID(), runId, scenarioId, sampleIndex, sample.outcome, sample.action,
        sample.amountTo, sample.decisionSummary,
        sample.parsedOutput ? JSON.stringify(sample.parsedOutput) : null,
        sample.rawText, sample.errorKind, sample.errorMessage, sample.latencyMs,
        sample.usage ? JSON.stringify(sample.usage) : null,
        sample.transportAudit ? JSON.stringify(sample.transportAudit) : null,
        sample.visibleInputHash,
      ],
    );
  }

  async #samples(runId: string): Promise<PublicConsistencySample[]> {
    const result = await this.pool.query<ConsistencySampleRow>(
      "select * from consistency_samples where run_id = $1 order by scenario_id, sample_index",
      [runId],
    );
    return result.rows.map(publicSample);
  }

  async #samplesForRuns(runIds: readonly string[]): Promise<Map<string, PublicConsistencySample[]>> {
    const byRun = new Map<string, PublicConsistencySample[]>();
    if (runIds.length === 0) return byRun;
    const result = await this.pool.query<ConsistencySampleRow>(
      "select * from consistency_samples where run_id = any($1::uuid[]) order by run_id, scenario_id, sample_index",
      [runIds],
    );
    for (const row of result.rows) {
      const samples = byRun.get(row.run_id) ?? [];
      samples.push(publicSample(row));
      byRun.set(row.run_id, samples);
    }
    return byRun;
  }
}

export function publicConsistencyScenarioRegistry() {
  return {
    version: CONSISTENCY_SCENARIO_REGISTRY_VERSION,
    scenarios: CONSISTENCY_SCENARIOS,
    presets: CONSISTENCY_PRESETS,
  };
}
