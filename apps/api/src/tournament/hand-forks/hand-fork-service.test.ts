import { describe, expect, it, vi } from "vitest";
import {
  arenaOutputSchema,
  createHandForkRequestSchema,
  decisionProtocolBundle,
  type ActionDecisionResponse,
  type CanonicalModelRequest,
  type CreateHandForkRequest,
  type HandForkLegalActions,
  type HandForkTarget,
  type HandForkTrial,
} from "../../../../../packages/contracts/src/index.js";
import type { ActionCommand } from "../../../../../packages/domain/src/betting.js";
import type { FrozenModelConfig, ModelProvider, ProviderDecision } from "../../../../../packages/providers/src/provider.js";
import { ProviderCallError, classifyProviderError } from "../../../../../packages/providers/src/provider.js";
import type { FrozenModelTarget } from "../../admin/model-service.js";
import type { DecisionResumeState } from "../decision-runner.js";
import {
  HandForkPersistenceConflictError,
  summarizeHandForkTargets,
  summarizeHandForkTrials,
  type BeginHandForkTrialInput,
  type CheckpointHandForkTurnInput,
  type ClaimedHandForkTarget,
  type CompleteHandForkTrialInput,
  type CreateHandForkPersistenceInput,
  type DecryptedHandForkTurnAudit,
  type HandForkPersistenceRecord,
  type HandForkSourcePayloadV1,
  type SaveHandForkTrialResumeStateInput,
} from "./hand-fork-repository.js";
import {
  HandForkService,
  HandForkTargetUnavailableError,
  handForkCreateRequestHash,
  handForkFallbackAction,
  validateHandForkAction,
  type HandForkFrozenModelStore,
  type HandForkRepository,
  type HandForkServiceDependencies,
} from "./hand-fork-service.js";
import { handForkSourcePayload } from "./hand-fork-source-catalog.js";
import type { HandForkResolvedSource } from "./hand-fork-source.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const TOURNAMENT_ID = "10000000-0000-4000-8000-000000000001";
const DECISION_ID = "20000000-0000-4000-8000-000000000002";
const FORK_ID = "30000000-0000-4000-8000-000000000003";
const CLIENT_REQUEST_ID = "40000000-0000-4000-8000-000000000004";
const CREATED_AT = "2026-08-20T00:00:00.000Z";

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function resolvedSource(overrides: Partial<HandForkResolvedSource> = {}): HandForkResolvedSource {
  const protocolBundle = decisionProtocolBundle("arena-native-v11");
  const outputSchema = arenaOutputSchema("ACTION_OR_HISTORY", protocolBundle.outputSchemaVersion);
  return {
    tournamentId: TOURNAMENT_ID,
    tournamentName: "Archived arena final",
    handNo: 12,
    decisionId: DECISION_ID,
    expectedAggregateVersion: 42,
    playerId: "hero",
    playerDisplayName: "Hero",
    street: "TURN",
    heroPosition: "BTN",
    holeCards: ["Ah", "Kd"],
    legalActions: {
      allowed: ["fold", "call", "raise", "all_in"],
      call: { amount: 120, will_be_all_in: false },
      bet: null,
      raise: { min_amount_to: 360, max_amount_to: 1_800 },
      all_in: { resulting_street_commitment: 1_800, classification: "raise" },
    },
    originalAction: "call",
    originalAmountTo: null,
    originalDecisionSummary: "Continue.",
    originalUsedFallback: false,
    decisionEventSequence: 90,
    actionEventSequence: 91,
    sourceEventHash: HASH_B,
    requestHash: HASH_C,
    visibleInputHash: HASH_D,
    legalContractHash: HASH_E,
    snapshotChecksum: HASH_F,
    baseRequest: {
      requestId: DECISION_ID,
      expectedOutput: "ACTION_OR_HISTORY",
      systemPrompt: "Frozen tournament prompt",
      systemPromptHash: HASH_A,
      outputSchema,
      userPayload: {
        schema_version: protocolBundle.contextVersion,
        hero: { player_id: "hero", hole_cards: ["Ah", "Kd"] },
        legal_actions: {
          allowed: ["fold", "call", "raise", "all_in"],
        },
      },
      timeoutMs: 180_000,
      parserPolicy: protocolBundle.parserPolicyVersion,
      adapterProtocolVersion: protocolBundle.adapterProtocolVersion,
    },
    decisionConfig: {
      maxInfrastructureAttempts: 1,
      infrastructureRetryDelaysMs: [],
      history: { maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000, maxBytes: 16_000 },
    },
    protocolBundle,
    historyProtocolVersion: protocolBundle.historyProtocolVersion,
    rulesetVersion: "arena-rules-v2",
    ...overrides,
  };
}

function createRequest(modelConfigIds: string[], overrides: Partial<CreateHandForkRequest> = {}): CreateHandForkRequest {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    sourceDecisionId: DECISION_ID,
    modelConfigIds,
    sampleCount: 1,
    timeoutMs: 120_000,
    maxParallelTargets: 3,
    ...overrides,
  };
}

function actionDecision(
  action: ActionCommand,
  options: { summary?: string; latencyMs?: number; tokens?: [number, number, number] } = {},
): ProviderDecision {
  const parsed: ActionDecisionResponse = action.action === "bet" || action.action === "raise"
    ? {
      type: "action",
      action: action.action,
      amount_to: action.amountTo,
      ...(options.summary ? { decision_summary: options.summary } : {}),
    }
    : {
      type: "action",
      action: action.action,
      ...(options.summary ? { decision_summary: options.summary } : {}),
    };
  const tokens = options.tokens ?? [10, 5, 15];
  return {
    parsed,
    rawText: JSON.stringify(parsed),
    usage: { inputTokens: tokens[0], outputTokens: tokens[1], totalTokens: tokens[2] },
    latencyMs: options.latencyMs ?? 25,
    providerRequestId: "provider-request",
  };
}

function historyDecision(): ProviderDecision {
  const parsed: ActionDecisionResponse = {
    type: "history_query",
    query: { kind: "recent_hands", count: 2, limit: 20 },
  };
  return {
    parsed,
    rawText: JSON.stringify(parsed),
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    latencyMs: 30,
    providerRequestId: "history-request",
  };
}

type ProviderStep = ProviderDecision
  | Error
  | ((request: CanonicalModelRequest) => ProviderDecision | Promise<ProviderDecision>);

class ScriptedProvider implements ModelProvider {
  readonly kind = "mock-scripted" as const;
  readonly requests: CanonicalModelRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly steps: ProviderStep[]) {}

  async decide(request: CanonicalModelRequest): Promise<ProviderDecision> {
    this.requests.push(structuredClone(request));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const step = this.steps.shift();
      if (!step) throw new Error("Provider script exhausted");
      if (step instanceof Error) throw step;
      return typeof step === "function" ? await step(request) : step;
    } finally {
      this.active -= 1;
    }
  }

  classifyError(error: unknown): ProviderCallError {
    return classifyProviderError(error);
  }
}

class FakeModels implements HandForkFrozenModelStore {
  readonly byModelConfig = new Map<string, FrozenModelTarget>();
  readonly freezeCalls: Array<[string, number]> = [];
  readonly runtimeCalls: Array<[string, string, string, number]> = [];
  failFreezeFor: string | null = null;
  failRuntimeForRevision: string | null = null;

  register(modelConfigId: string, ordinal: number): FrozenModelTarget {
    const target: FrozenModelTarget = {
      modelConfigId,
      competitorRevisionId: uuid(1_000 + ordinal),
      configurationHash: ordinal.toString(16).padStart(64, "0"),
      effectiveOutputMode: "prompt",
      runtimeConfig: {
        provider: "mock-scripted",
        providerProfile: "generic",
        providerDefaultOutputMode: "prompt",
        outputMode: "inherit",
        model: `model-${ordinal}`,
        timeoutMs: 120_000,
        parameters: {},
      },
    };
    this.byModelConfig.set(modelConfigId, target);
    return target;
  }

  async freezeCurrentTarget(modelConfigId: string, timeoutMs: number): Promise<FrozenModelTarget> {
    this.freezeCalls.push([modelConfigId, timeoutMs]);
    if (this.failFreezeFor === modelConfigId) throw new Error("apiKey=super-secret internal detail");
    const target = this.byModelConfig.get(modelConfigId);
    if (!target) throw new Error("missing model");
    return {
      ...structuredClone(target),
      runtimeConfig: { ...structuredClone(target.runtimeConfig), timeoutMs },
    };
  }

  async runtimeConfigForFrozenRevision(
    revisionId: string,
    expectedConfigurationHash: string,
    expectedEffectiveOutputMode: "json_schema" | "json_object" | "prompt",
    timeoutMs: number,
  ): Promise<FrozenModelTarget> {
    this.runtimeCalls.push([
      revisionId,
      expectedConfigurationHash,
      expectedEffectiveOutputMode,
      timeoutMs,
    ]);
    if (this.failRuntimeForRevision === revisionId) {
      throw new Error("frozen runtime is unavailable");
    }
    const target = [...this.byModelConfig.values()]
      .find((candidate) => candidate.competitorRevisionId === revisionId);
    if (!target
      || target.configurationHash !== expectedConfigurationHash
      || target.effectiveOutputMode !== expectedEffectiveOutputMode) {
      throw new Error("frozen identity mismatch");
    }
    return {
      ...structuredClone(target),
      runtimeConfig: { ...structuredClone(target.runtimeConfig), timeoutMs },
    };
  }
}

interface LeaseIdentity {
  workerId: string;
  leaseToken: string;
}

class MemoryHandForkRepository {
  record: HandForkPersistenceRecord | null = null;
  payload: HandForkSourcePayloadV1 | null = null;
  readonly trials = new Map<string, HandForkTrial[]>();
  readonly resumes = new Map<string, DecisionResumeState>();
  readonly turns = new Map<string, DecryptedHandForkTurnAudit[]>();
  readonly leases = new Map<string, LeaseIdentity>();
  readonly checkpoints: CheckpointHandForkTurnInput[] = [];
  readonly completions: CompleteHandForkTrialInput[] = [];
  readonly finishCalls: Array<{ targetId: string; status: "COMPLETED" | "FAILED"; error: string | null }> = [];
  readonly historyOfClaims: string[] = [];
  readonly expiredTargets = new Set<string>();
  lastCreate: CreateHandForkPersistenceInput | null = null;
  claimsEnabled = true;
  renewResult = true;
  maxActiveClaims = 0;
  #createIdentity: { clientRequestId: string; createRequestHash: string } | null = null;
  #activeClaims = new Set<string>();

  async findForkByCreateRequest(
    clientRequestId: string,
    createRequestHash: string,
  ): Promise<HandForkPersistenceRecord | null> {
    if (!this.#createIdentity || this.#createIdentity.clientRequestId !== clientRequestId) return null;
    if (this.#createIdentity.createRequestHash !== createRequestHash) {
      throw new HandForkPersistenceConflictError("client request conflict");
    }
    return this.snapshot(true);
  }

  async createFork(input: CreateHandForkPersistenceInput): Promise<HandForkPersistenceRecord> {
    const existing = await this.findForkByCreateRequest(input.clientRequestId, input.createRequestHash);
    if (existing) return existing;
    this.lastCreate = structuredClone(input);
    this.#createIdentity = {
      clientRequestId: input.clientRequestId,
      createRequestHash: input.createRequestHash,
    };
    this.payload = structuredClone(input.source.privatePayload);
    const targets: HandForkTarget[] = input.targets.map((target, index) => ({
      id: uuid(2_000 + index),
      ordinal: index + 1,
      modelConfigId: target.modelConfigId,
      competitorRevisionId: target.competitorRevisionId,
      competitorFamilyId: uuid(3_000 + index),
      modelDisplayName: `Model ${index + 1}`,
      modelId: `model-${index + 1}`,
      providerProfile: "generic",
      modelConfigurationHash: target.modelConfigurationHash,
      effectiveOutputMode: target.effectiveOutputMode,
      sampleCount: input.sampleCount,
      status: "QUEUED",
      terminalTrials: 0,
      summary: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      trials: [],
    }));
    targets.forEach((target) => this.trials.set(target.id, []));
    this.record = {
      id: FORK_ID,
      status: "QUEUED",
      sourceTournamentId: input.source.tournamentId,
      sourceDecisionId: input.source.decisionId,
      sourceHandNo: input.source.handNo,
      sourcePlayerId: input.source.playerId,
      sourceExpectedAggregateVersion: input.source.expectedAggregateVersion,
      sourceActionEventSequence: input.source.actionEventSequence,
      sourceEventHash: input.source.sourceEventHash,
      sourceRequestHash: input.source.sourceRequestHash,
      sourcePayloadHash: HASH_F,
      visibleInputHash: input.source.visibleInputHash,
      legalContractHash: input.source.legalContractHash,
      protocolBundleId: input.source.protocolBundleId,
      rulesetVersion: input.source.rulesetVersion,
      contextVersion: input.source.contextVersion,
      systemPromptHash: input.source.systemPromptHash,
      outputSchemaHash: input.source.outputSchemaHash,
      parserPolicyVersion: input.source.parserPolicyVersion,
      adapterProtocolVersion: input.source.adapterProtocolVersion,
      historyProtocolVersion: input.source.historyProtocolVersion,
      correctionProtocolVersion: input.source.correctionProtocolVersion,
      historyBudget: structuredClone(input.source.historyBudget),
      sampleCount: input.sampleCount,
      timeoutMs: input.timeoutMs,
      maxParallelTargets: input.maxParallelTargets,
      targetCount: targets.length,
      summary: null,
      errorMessage: null,
      createdByAdminUserId: input.createdByAdminUserId,
      startedAt: null,
      completedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      targets,
    };
    return this.snapshot(true)!;
  }

  snapshot(includeDetail = true): HandForkPersistenceRecord | null {
    if (!this.record) return null;
    const targets: HandForkTarget[] = this.record.targets.map((target) => {
      const cloned = structuredClone(target);
      if (includeDetail) {
        return { ...cloned, trials: structuredClone(this.trials.get(target.id) ?? []) };
      }
      const { trials: _trials, ...summary } = cloned;
      return summary;
    });
    return { ...structuredClone(this.record), targets };
  }

  async listForks(): Promise<HandForkPersistenceRecord[]> {
    const record = this.snapshot(false);
    return record ? [record] : [];
  }

  async getFork(id: string, includeDetail = true): Promise<HandForkPersistenceRecord | null> {
    return this.record?.id === id ? this.snapshot(includeDetail) : null;
  }

  async loadSourcePayload(forkId: string): Promise<HandForkSourcePayloadV1> {
    if (!this.record || this.record.id !== forkId || !this.payload) throw new Error("unknown fork");
    return structuredClone(this.payload);
  }

  async claimNextTarget(
    workerId: string,
    _leaseMs: number,
  ): Promise<ClaimedHandForkTarget | null> {
    if (!this.claimsEnabled || !this.record) return null;
    const target = this.record.targets.find((candidate) => (
      candidate.status === "QUEUED"
      || (candidate.status === "RUNNING" && this.expiredTargets.has(candidate.id))
    ));
    if (!target) return null;
    target.status = "RUNNING";
    target.startedAt ??= CREATED_AT;
    this.record.status = "RUNNING";
    this.record.startedAt ??= CREATED_AT;
    const leaseToken = uuid(4_000 + target.ordinal);
    this.expiredTargets.delete(target.id);
    this.leases.set(target.id, { workerId, leaseToken });
    this.#activeClaims.add(target.id);
    this.maxActiveClaims = Math.max(this.maxActiveClaims, this.#activeClaims.size);
    this.historyOfClaims.push(target.id);
    return {
      id: target.id,
      forkId: this.record.id,
      modelConfigId: target.modelConfigId,
      competitorRevisionId: target.competitorRevisionId,
      modelConfigurationHash: target.modelConfigurationHash,
      effectiveOutputMode: target.effectiveOutputMode,
      sampleCount: target.sampleCount,
      terminalTrials: target.terminalTrials,
      timeoutMs: this.record.timeoutMs,
      workerId,
      leaseToken,
      leaseExpiresAt: "2026-08-20T00:10:00.000Z",
    };
  }

  async renewTargetLease(
    targetId: string,
    workerId: string,
    leaseToken: string,
  ): Promise<boolean> {
    return this.renewResult && this.hasLease(targetId, workerId, leaseToken);
  }

  async beginTrial(input: BeginHandForkTrialInput): Promise<HandForkTrial | null> {
    this.assertLease(input.targetId, input.workerId, input.leaseToken);
    const trials = this.trials.get(input.targetId)!;
    const existing = trials.find((trial) => trial.sampleIndex === input.sampleIndex);
    if (existing) return structuredClone(existing);
    const target = this.record!.targets.find((candidate) => candidate.id === input.targetId)!;
    const trial: HandForkTrial = {
      id: uuid(5_000 + target.ordinal * 100 + input.sampleIndex),
      sampleIndex: input.sampleIndex,
      status: "RUNNING",
      outcome: null,
      action: null,
      amountTo: null,
      decisionSummary: null,
      usedFallback: false,
      firstTurnValid: null,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 0,
      callCount: 0,
      totalLatencyMs: null,
      usage: null,
      visibleInputHash: input.visibleInputHash,
      errorKind: null,
      errorMessage: null,
      createdAt: CREATED_AT,
      completedAt: null,
    };
    trials.push(trial);
    return structuredClone(trial);
  }

  async saveTrialResumeState(input: SaveHandForkTrialResumeStateInput): Promise<void> {
    this.assertLease(input.targetId, input.workerId, input.leaseToken);
    this.resumes.set(input.trialId, structuredClone(input.state));
  }

  async loadTrialResumeState(trialId: string): Promise<DecisionResumeState | null> {
    return structuredClone(this.resumes.get(trialId) ?? null);
  }

  async loadTrialTurnAudits(trialId: string): Promise<DecryptedHandForkTurnAudit[]> {
    return structuredClone(this.turns.get(trialId) ?? []);
  }

  async checkpointTrialTurn(input: CheckpointHandForkTurnInput): Promise<void> {
    this.assertLease(input.targetId, input.workerId, input.leaseToken);
    this.checkpoints.push(structuredClone(input));
    this.resumes.set(input.trialId, structuredClone(input.resumeState));
    const turns = this.turns.get(input.trialId) ?? [];
    const response = input.response ? structuredClone(input.response) : null;
    turns.push({
      metadata: {
        turnIndex: input.turnIndex,
        requestHash: HASH_A,
        responseHash: response ? HASH_B : null,
        responseRecorded: response !== null,
        outcome: input.outcome,
        errorKind: input.errorKind,
        latencyMs: input.latencyMs,
        usage: input.usage,
        providerConfigHash: input.providerConfigHash,
        outputSchemaVersion: input.outputSchemaVersion,
        outputSchemaHash: input.outputSchemaHash,
        adapterVersion: response?.transportAudit?.adapterVersion ?? null,
        appliedOutputMode: response?.transportAudit?.appliedOutputMode ?? null,
        finishReason: response?.transportAudit?.finishReason ?? null,
        refusalHash: null,
        refusalRecorded: false,
        responseModel: response?.transportAudit?.responseModel ?? null,
        createdAt: CREATED_AT,
      },
      request: structuredClone(input.request),
      response,
    });
    this.turns.set(input.trialId, turns);
  }

  async completeTrial(input: CompleteHandForkTrialInput): Promise<HandForkTrial> {
    this.assertLease(input.targetId, input.workerId, input.leaseToken);
    const trial = this.trials.get(input.targetId)!
      .find((candidate) => candidate.id === input.trialId)!;
    Object.assign(trial, {
      status: "COMPLETED",
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
      usage: input.usage,
      errorKind: input.errorKind,
      errorMessage: input.errorMessage,
      completedAt: CREATED_AT,
    });
    this.completions.push(structuredClone(input));
    const target = this.record!.targets.find((candidate) => candidate.id === input.targetId)!;
    target.terminalTrials = this.trials.get(input.targetId)!
      .filter((candidate) => candidate.status !== "RUNNING").length;
    return structuredClone(trial);
  }

  async finishTarget(
    targetId: string,
    workerId: string,
    leaseToken: string,
    status: "COMPLETED" | "FAILED",
    errorMessage: string | null = null,
  ): Promise<void> {
    this.assertLease(targetId, workerId, leaseToken);
    const target = this.record!.targets.find((candidate) => candidate.id === targetId)!;
    const trials = this.trials.get(targetId)!;
    if (trials.some((trial) => trial.status === "RUNNING")) throw new Error("running trial");
    target.status = status;
    target.summary = summarizeHandForkTrials(target.sampleCount, trials);
    target.terminalTrials = target.summary.terminalTrials;
    target.errorMessage = errorMessage;
    target.completedAt = CREATED_AT;
    this.leases.delete(targetId);
    this.#activeClaims.delete(targetId);
    this.finishCalls.push({ targetId, status, error: errorMessage });
    this.refreshFork();
  }

  async cancelFork(forkId: string): Promise<HandForkPersistenceRecord | null> {
    if (!this.record || this.record.id !== forkId) return null;
    for (const target of this.record.targets) {
      if (target.status !== "QUEUED" && target.status !== "RUNNING") continue;
      for (const trial of this.trials.get(target.id) ?? []) {
        if (trial.status !== "RUNNING") continue;
        trial.status = "CANCELLED";
        trial.outcome = "CANCELLED";
        trial.completedAt = CREATED_AT;
      }
      target.status = "CANCELLED";
      target.summary = summarizeHandForkTrials(target.sampleCount, this.trials.get(target.id) ?? []);
      target.terminalTrials = target.summary.terminalTrials;
      target.completedAt = CREATED_AT;
      this.leases.delete(target.id);
      this.#activeClaims.delete(target.id);
    }
    this.record.status = "CANCELLED";
    this.record.completedAt = CREATED_AT;
    this.record.summary = summarizeHandForkTargets(this.record.targets);
    return this.snapshot(false);
  }

  async restorePending(): Promise<string[]> {
    return this.record?.targets.some((target) => target.status === "QUEUED")
      ? [this.record.id]
      : [];
  }

  async listRunnableForkIds(): Promise<string[]> {
    return this.claimsEnabled
      && this.record?.targets.some((target) => (
        target.status === "QUEUED"
        || (target.status === "RUNNING" && this.expiredTargets.has(target.id))
      ))
      ? [this.record.id]
      : [];
  }

  seedRecoveredTrial(input: {
    targetId: string;
    trial: HandForkTrial;
    resume?: DecisionResumeState;
    turn?: DecryptedHandForkTurnAudit;
  }): void {
    this.trials.set(input.targetId, [structuredClone(input.trial)]);
    if (input.resume) this.resumes.set(input.trial.id, structuredClone(input.resume));
    if (input.turn) this.turns.set(input.trial.id, [structuredClone(input.turn)]);
  }

  private hasLease(targetId: string, workerId: string, leaseToken: string): boolean {
    const target = this.record?.targets.find((candidate) => candidate.id === targetId);
    const lease = this.leases.get(targetId);
    return target?.status === "RUNNING"
      && lease?.workerId === workerId
      && lease.leaseToken === leaseToken;
  }

  private assertLease(targetId: string, workerId: string, leaseToken: string): void {
    if (!this.hasLease(targetId, workerId, leaseToken)) {
      throw new HandForkPersistenceConflictError("lease lost");
    }
  }

  private refreshFork(): void {
    if (!this.record) return;
    const open = this.record.targets.some((target) => target.status === "QUEUED" || target.status === "RUNNING");
    if (open) {
      this.record.status = "RUNNING";
      return;
    }
    this.record.status = this.record.targets.every((target) => target.status === "COMPLETED")
      ? "COMPLETED"
      : this.record.targets.some((target) => target.status === "COMPLETED") ? "PARTIAL" : "FAILED";
    this.record.completedAt = CREATED_AT;
    this.record.summary = summarizeHandForkTargets(this.record.targets);
  }
}

class ManualIntervals {
  readonly entries: Array<{ callback: () => void; intervalMs: number; active: boolean }> = [];

  setInterval = (callback: () => void, intervalMs: number): number => {
    this.entries.push({ callback, intervalMs, active: true });
    return this.entries.length - 1;
  };

  clearInterval = (handle: unknown): void => {
    const entry = this.entries[Number(handle)];
    if (entry) entry.active = false;
  };

  fire(intervalMs: number): void {
    for (const entry of this.entries) {
      if (entry.active && entry.intervalMs === intervalMs) entry.callback();
    }
  }
}

function serviceFixture(input: {
  modelCount?: number;
  source?: HandForkResolvedSource;
  repository?: MemoryHandForkRepository;
  providers?: ScriptedProvider[];
  intervals?: ManualIntervals;
  history?: HandForkServiceDependencies["history"];
  onWorkerError?: (error: unknown) => void;
  now?: () => number;
} = {}) {
  const modelCount = input.modelCount ?? 1;
  const source = input.source ?? resolvedSource();
  const repository = input.repository ?? new MemoryHandForkRepository();
  const models = new FakeModels();
  const modelIds = Array.from({ length: modelCount }, (_, index) => uuid(100 + index));
  const frozen = modelIds.map((id, index) => models.register(id, index + 1));
  const providers = input.providers ?? frozen.map(() => new ScriptedProvider([actionDecision({ action: "call" })]));
  const byModel = new Map(frozen.map((target, index) => [target.runtimeConfig.model, providers[index]!]));
  const history = input.history ?? { execute: vi.fn(async () => []) };
  const dependencies: HandForkServiceDependencies = {
    repository: repository as unknown as HandForkRepository,
    sourceResolver: { resolve: vi.fn(async () => structuredClone(source)) },
    models,
    history,
    createProvider: (config) => {
      const provider = byModel.get(config.model);
      if (!provider) throw new Error(`No provider for ${config.model}`);
      return provider;
    },
    randomUUID: (() => {
      let next = 9_000;
      return () => uuid(next++);
    })(),
    now: input.now ?? (() => Date.parse(CREATED_AT) + 25),
    ...(input.intervals ? {
      setInterval: input.intervals.setInterval,
      clearInterval: input.intervals.clearInterval,
      leaseMs: 15_000,
      pollIntervalMs: 1_500,
    } : {}),
    ...(input.onWorkerError ? { onWorkerError: input.onWorkerError } : {}),
  };
  return {
    service: new HandForkService(dependencies),
    repository,
    models,
    modelIds,
    providers,
    source,
    history,
  };
}

async function createRecoverableFork(
  repository: MemoryHandForkRepository,
  models: FakeModels,
): Promise<{
  source: HandForkResolvedSource;
  frozen: FrozenModelTarget;
  targetId: string;
}> {
  const source = resolvedSource();
  const modelId = uuid(100);
  const frozen = models.register(modelId, 1);
  await repository.createFork({
    clientRequestId: uuid(7_001),
    createRequestHash: HASH_A,
    source: {
      tournamentId: source.tournamentId,
      decisionId: source.decisionId,
      handNo: source.handNo,
      playerId: source.playerId,
      expectedAggregateVersion: source.expectedAggregateVersion,
      actionEventSequence: source.actionEventSequence,
      sourceEventHash: source.sourceEventHash,
      sourceRequestHash: source.requestHash,
      visibleInputHash: source.visibleInputHash,
      legalContractHash: source.legalContractHash,
      protocolBundleId: source.protocolBundle.id,
      rulesetVersion: source.rulesetVersion,
      contextVersion: source.protocolBundle.contextVersion,
      systemPromptHash: source.baseRequest.systemPromptHash,
      outputSchemaHash: source.baseRequest.outputSchema!.sha256,
      parserPolicyVersion: source.protocolBundle.parserPolicyVersion,
      adapterProtocolVersion: source.protocolBundle.adapterProtocolVersion,
      historyProtocolVersion: source.protocolBundle.historyProtocolVersion,
      correctionProtocolVersion: source.protocolBundle.correctionProtocolVersion,
      historyBudget: source.decisionConfig.history,
      privatePayload: handForkSourcePayload(source),
    },
    targets: [{
      modelConfigId: modelId,
      competitorRevisionId: frozen.competitorRevisionId,
      modelConfigurationHash: frozen.configurationHash,
      effectiveOutputMode: frozen.effectiveOutputMode,
    }],
    sampleCount: 1,
    timeoutMs: 120_000,
    maxParallelTargets: 1,
    createdByAdminUserId: null,
  });
  return {
    source,
    frozen,
    targetId: repository.record!.targets[0]!.id,
  };
}

function runningTrial(source: HandForkResolvedSource, trialId = uuid(5_101)): HandForkTrial {
  return {
    id: trialId,
    sampleIndex: 1,
    status: "RUNNING",
    outcome: null,
    action: null,
    amountTo: null,
    decisionSummary: null,
    usedFallback: false,
    firstTurnValid: null,
    historyQueryCount: 0,
    protocolFailures: 0,
    infrastructureFailures: 0,
    callCount: 0,
    totalLatencyMs: null,
    usage: null,
    visibleInputHash: source.visibleInputHash,
    errorKind: null,
    errorMessage: null,
    createdAt: CREATED_AT,
    completedAt: null,
  };
}

async function waitUntil(predicate: () => boolean, message = "condition", timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("HandForkService", () => {
  it("hashes semantic create parameters independently of the idempotency key", () => {
    const first = createRequest([uuid(100), uuid(101)]);
    const retry = { ...first, clientRequestId: uuid(7_002) };

    expect(handForkCreateRequestHash(retry)).toBe(handForkCreateRequestHash(first));
    for (const changed of [
      { ...first, sourceDecisionId: uuid(7_003) },
      { ...first, modelConfigIds: [uuid(101), uuid(100)] },
      { ...first, sampleCount: 2 },
      { ...first, timeoutMs: 180_000 },
      { ...first, maxParallelTargets: 2 },
    ]) {
      expect(handForkCreateRequestHash(changed)).not.toBe(handForkCreateRequestHash(first));
    }
    const { maxParallelTargets: _defaultParallelism, ...withoutDefault } = first;
    expect(_defaultParallelism).toBe(3);
    const parsedDefault = createHandForkRequestSchema.parse(withoutDefault);
    expect(handForkCreateRequestHash(parsedDefault)).toBe(handForkCreateRequestHash(first));
  });

  it("returns a persisted retry before resolving or freezing mutable dependencies", async () => {
    const fixture = serviceFixture();
    fixture.repository.claimsEnabled = false;
    const request = createRequest(fixture.modelIds);
    const first = await fixture.service.create(request, null);
    fixture.models.failFreezeFor = fixture.modelIds[0]!;

    const retry = await fixture.service.create(request, null);
    expect(retry.id).toBe(first.id);
    expect(fixture.models.freezeCalls).toHaveLength(1);
    await expect(fixture.service.create({ ...request, sampleCount: 2 }, null))
      .rejects.toBeInstanceOf(HandForkPersistenceConflictError);
    expect(fixture.models.freezeCalls).toHaveLength(1);
    await fixture.service.shutdown();
  });

  it("freezes targets and runs each fresh trial with a bare source payload, durable request ID and timeout", async () => {
    const fixture = serviceFixture();
    const created = await fixture.service.create(createRequest(fixture.modelIds), null);

    expect(created.status).toBe("QUEUED");
    expect(fixture.models.freezeCalls).toEqual([[fixture.modelIds[0], 120_000]]);
    expect(fixture.repository.lastCreate?.targets[0]).toMatchObject({
      modelConfigId: fixture.modelIds[0],
      competitorRevisionId: fixture.models.byModelConfig.get(fixture.modelIds[0]!)!.competitorRevisionId,
      effectiveOutputMode: "prompt",
    });
    expect(fixture.repository.lastCreate).toMatchObject({
      clientRequestId: CLIENT_REQUEST_ID,
      createRequestHash: handForkCreateRequestHash(createRequest(fixture.modelIds)),
    });
    expect(fixture.repository.lastCreate?.source.privatePayload.baseRequest.userPayload)
      .not.toHaveProperty("arena_state");

    await waitUntil(() => fixture.repository.completions.length === 1, "trial completion");
    const providerRequest = fixture.providers[0]!.requests[0]!;
    const arenaState = (providerRequest.userPayload as { arena_state: Record<string, unknown> }).arena_state;
    expect(providerRequest.timeoutMs).toBe(120_000);
    expect(providerRequest.requestId).toBe(fixture.repository.completions[0]!.trialId);
    expect(arenaState).toEqual(fixture.source.baseRequest.userPayload);
    expect(arenaState).not.toHaveProperty("arena_state");
    expect(fixture.repository.completions[0]).toMatchObject({
      outcome: "MODEL_ACTION",
      action: "call",
      firstTurnValid: true,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 0,
      callCount: 1,
      totalLatencyMs: 25,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const detail = await fixture.service.get(FORK_ID);
    expect(JSON.stringify(detail)).not.toContain("Frozen tournament prompt");
    expect(JSON.stringify(detail)).not.toContain("rawText");
    await fixture.service.shutdown();
  });

  it("wraps a target-freeze failure in a stable conflict error without exposing the cause", async () => {
    const fixture = serviceFixture();
    fixture.models.failFreezeFor = fixture.modelIds[0]!;

    const failure = fixture.service.create(createRequest(fixture.modelIds), null);
    await expect(failure).rejects.toBeInstanceOf(HandForkTargetUnavailableError);
    await expect(failure).rejects.not.toThrow(/super-secret|apiKey/);
    expect(fixture.repository.lastCreate).toBeNull();
    await fixture.service.shutdown();
  });

  it("runs at most three target workers globally", async () => {
    const gate = deferred<ProviderDecision>();
    const providers = Array.from({ length: 5 }, () => new ScriptedProvider([
      () => gate.promise,
    ]));
    const fixture = serviceFixture({ modelCount: 5, providers });
    await fixture.service.create(createRequest(fixture.modelIds), null);

    await waitUntil(
      () => providers.reduce((sum, provider) => sum + provider.requests.length, 0) === 3,
      "three concurrent targets",
    );
    expect(fixture.repository.maxActiveClaims).toBe(3);
    expect(providers.slice(3).every((provider) => provider.requests.length === 0)).toBe(true);
    gate.resolve(actionDecision({ action: "call" }));
    await waitUntil(() => fixture.repository.snapshot()?.status === "COMPLETED", "all targets");
    expect(fixture.repository.maxActiveClaims).toBe(3);
    expect(providers.every((provider) => provider.requests.length === 1)).toBe(true);
    await fixture.service.shutdown();
  });

  it("keeps trials strictly serial inside one target and clears request-local state", async () => {
    const provider = new ScriptedProvider([
      async () => { await new Promise((resolve) => setTimeout(resolve, 4)); return actionDecision({ action: "call" }); },
      async () => { await new Promise((resolve) => setTimeout(resolve, 4)); return actionDecision({ action: "call" }); },
      async () => { await new Promise((resolve) => setTimeout(resolve, 4)); return actionDecision({ action: "call" }); },
    ]);
    const fixture = serviceFixture({ providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds, { sampleCount: 3 }), null);
    await waitUntil(() => fixture.repository.completions.length === 3, "three serial trials");

    expect(provider.maxActive).toBe(1);
    expect(new Set(provider.requests.map((request) => request.requestId)).size).toBe(3);
    expect(fixture.repository.completions.map((trial) => trial.historyQueryCount)).toEqual([0, 0, 0]);
    expect(fixture.repository.completions.map((trial) => trial.protocolFailures)).toEqual([0, 0, 0]);
    await fixture.service.shutdown();
  });

  it("executes history only against the source tournament and hand, then injects it into the next turn", async () => {
    const provider = new ScriptedProvider([
      historyDecision(),
      actionDecision({ action: "call" }, { latencyMs: 20, tokens: [6, 3, 9] }),
    ]);
    const execute = vi.fn(async () => [{ hand_no: 10, actions: [] }]);
    const fixture = serviceFixture({ providers: [provider], history: { execute } });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => fixture.repository.completions.length === 1, "history trial");

    expect(execute).toHaveBeenCalledWith(
      TOURNAMENT_ID,
      12,
      { kind: "recent_hands", count: 2, limit: 20 },
    );
    expect((provider.requests[1]!.userPayload as { history_results: unknown[] }).history_results).toHaveLength(1);
    expect(fixture.repository.completions[0]).toMatchObject({
      firstTurnValid: true,
      historyQueryCount: 1,
      callCount: 2,
      totalLatencyMs: 25,
      usage: { inputTokens: 14, outputTokens: 5, totalTokens: 19 },
    });
    await fixture.service.shutdown();
  });

  it("measures trial wall-clock time across provider calls and history execution", async () => {
    let nowMs = Date.parse(CREATED_AT);
    const provider = new ScriptedProvider([
      () => {
        nowMs += 30;
        return historyDecision();
      },
      () => {
        nowMs += 20;
        return actionDecision({ action: "call" }, { latencyMs: 20 });
      },
    ]);
    const execute = vi.fn(async () => {
      nowMs += 40;
      return [{ hand_no: 10, actions: [] }];
    });
    const fixture = serviceFixture({ providers: [provider], history: { execute }, now: () => nowMs });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => fixture.repository.completions.length === 1, "wall-clock trial");

    // Provider-reported latency totals 50 ms. The persisted metric is the
    // 90 ms end-to-end trial duration, including the history service.
    expect(fixture.repository.completions[0]!.totalLatencyMs).toBe(90);
    await fixture.service.shutdown();
  });

  it("does not relabel a successful retry as a valid first turn", async () => {
    const source = resolvedSource({
      decisionConfig: {
        maxInfrastructureAttempts: 2,
        infrastructureRetryDelaysMs: [0],
        history: { maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000, maxBytes: 16_000 },
      },
    });
    const provider = new ScriptedProvider([
      new ProviderCallError("TIMEOUT", "first attempt timed out", true),
      actionDecision({ action: "call" }),
    ]);
    const fixture = serviceFixture({ source, providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => fixture.repository.completions.length === 1, "retried trial");

    expect(fixture.repository.completions[0]).toMatchObject({
      outcome: "MODEL_ACTION",
      firstTurnValid: false,
      infrastructureFailures: 1,
      callCount: 2,
    });
    await fixture.service.shutdown();
  });

  it("counts a valid history query even when the history service is unavailable", async () => {
    const provider = new ScriptedProvider([historyDecision()]);
    const execute = vi.fn(async () => {
      throw new Error("history database unavailable");
    });
    const fixture = serviceFixture({ providers: [provider], history: { execute } });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => fixture.repository.completions.length === 1, "history outage trial");

    expect(fixture.repository.completions[0]).toMatchObject({
      outcome: "INFRA_ERROR",
      firstTurnValid: true,
      historyQueryCount: 1,
      callCount: 1,
    });
    await fixture.service.shutdown();
  });

  it("records protocol fallback and rejects an illegal first output", async () => {
    const source = resolvedSource({
      legalActions: {
        allowed: ["check", "bet", "all_in"],
        call: null,
        bet: { min_amount_to: 100, max_amount_to: 500 },
        raise: null,
        all_in: { resulting_street_commitment: 500, classification: "bet" },
      },
    });
    const provider = new ScriptedProvider([
      actionDecision({ action: "call" }),
      actionDecision({ action: "call" }),
    ]);
    const fixture = serviceFixture({ source, providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => fixture.repository.completions.length === 1, "fallback trial");

    expect(fixture.repository.completions[0]).toMatchObject({
      outcome: "PROTOCOL_FALLBACK",
      action: "check",
      usedFallback: true,
      firstTurnValid: false,
      protocolFailures: 2,
      callCount: 2,
    });
    await fixture.service.shutdown();
  });

  it.each(["AUTH", "CONFIG"] as const)("stops a target immediately on %s", async (kind) => {
    const provider = new ScriptedProvider([
      new ProviderCallError(kind, `${kind} failed`, false),
    ]);
    const fixture = serviceFixture({ providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds, { sampleCount: 5 }), null);
    await waitUntil(() => fixture.repository.finishCalls.length === 1, `${kind} target failure`);

    expect(provider.requests).toHaveLength(1);
    expect(fixture.repository.completions).toHaveLength(1);
    expect(fixture.repository.completions[0]).toMatchObject({
      outcome: "INFRA_ERROR",
      firstTurnValid: null,
      infrastructureFailures: 1,
      totalLatencyMs: 25,
      errorKind: kind,
    });
    expect(fixture.repository.finishCalls[0]).toMatchObject({ status: "FAILED" });
    await fixture.service.shutdown();
  });

  it("opens the target circuit after three consecutive infrastructure-error trials", async () => {
    const errors = Array.from({ length: 3 }, () => new ProviderCallError("TIMEOUT", "slow", true));
    const provider = new ScriptedProvider(errors);
    const fixture = serviceFixture({ providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds, { sampleCount: 5 }), null);
    await waitUntil(() => fixture.repository.finishCalls.length === 1, "infra circuit breaker");

    expect(fixture.repository.completions).toHaveLength(3);
    expect(fixture.repository.finishCalls[0]).toMatchObject({ status: "FAILED" });
    expect(provider.requests).toHaveLength(3);
    await fixture.service.shutdown();
  });

  it("resets the infrastructure streak after a completed model action", async () => {
    const provider = new ScriptedProvider([
      new ProviderCallError("TIMEOUT", "slow-1", true),
      actionDecision({ action: "call" }),
      new ProviderCallError("TIMEOUT", "slow-2", true),
      new ProviderCallError("TIMEOUT", "slow-3", true),
      actionDecision({ action: "call" }),
    ]);
    const fixture = serviceFixture({ providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds, { sampleCount: 5 }), null);
    await waitUntil(() => fixture.repository.finishCalls.length === 1, "completed target");

    expect(fixture.repository.completions.map((trial) => trial.outcome)).toEqual([
      "INFRA_ERROR", "MODEL_ACTION", "INFRA_ERROR", "INFRA_ERROR", "MODEL_ACTION",
    ]);
    expect(fixture.repository.finishCalls[0]).toMatchObject({ status: "COMPLETED" });
    await fixture.service.shutdown();
  });

  it("resumes an atomic pending output with the original request ID and no duplicate provider call", async () => {
    const repository = new MemoryHandForkRepository();
    repository.claimsEnabled = false;
    const models = new FakeModels();
    const modelId = uuid(100);
    const frozen = models.register(modelId, 1);
    const source = resolvedSource();
    await repository.createFork({
      clientRequestId: uuid(7_003),
      createRequestHash: HASH_B,
      source: {
        tournamentId: source.tournamentId,
        decisionId: source.decisionId,
        handNo: source.handNo,
        playerId: source.playerId,
        expectedAggregateVersion: source.expectedAggregateVersion,
        actionEventSequence: source.actionEventSequence,
        sourceEventHash: source.sourceEventHash,
        sourceRequestHash: source.requestHash,
        visibleInputHash: source.visibleInputHash,
        legalContractHash: source.legalContractHash,
        protocolBundleId: source.protocolBundle.id,
        rulesetVersion: source.rulesetVersion,
        contextVersion: source.protocolBundle.contextVersion,
        systemPromptHash: source.baseRequest.systemPromptHash,
        outputSchemaHash: source.baseRequest.outputSchema!.sha256,
        parserPolicyVersion: source.protocolBundle.parserPolicyVersion,
        adapterProtocolVersion: source.protocolBundle.adapterProtocolVersion,
        historyProtocolVersion: source.protocolBundle.historyProtocolVersion,
        correctionProtocolVersion: source.protocolBundle.correctionProtocolVersion,
        historyBudget: source.decisionConfig.history,
        privatePayload: handForkSourcePayload(source),
      },
      targets: [{
        modelConfigId: modelId,
        competitorRevisionId: frozen.competitorRevisionId,
        modelConfigurationHash: frozen.configurationHash,
        effectiveOutputMode: frozen.effectiveOutputMode,
      }],
      sampleCount: 1,
      timeoutMs: 120_000,
      maxParallelTargets: 1,
      createdByAdminUserId: null,
    });
    const targetId = repository.record!.targets[0]!.id;
    const trialId = uuid(5_101);
    const requestId = uuid(8_888);
    const decision = actionDecision({ action: "call" });
    const resume: DecisionResumeState = {
      historyResults: [],
      protocolFailures: 0,
      correction: null,
      calls: [{ attempt: 1, outcome: "SUCCESS", errorKind: null, latencyMs: 25, usage: decision.usage }],
      pendingHistoryQuery: null,
      pendingOutput: {
        turnIndex: 1,
        parsed: decision.parsed,
        rawText: decision.rawText,
        latencyMs: decision.latencyMs,
        usage: decision.usage,
        providerRequestId: decision.providerRequestId,
      },
      pendingInfrastructureFailure: null,
      infrastructureAttempts: 0,
    };
    const trial: HandForkTrial = {
      id: trialId,
      sampleIndex: 1,
      status: "RUNNING",
      outcome: null,
      action: null,
      amountTo: null,
      decisionSummary: null,
      usedFallback: false,
      firstTurnValid: null,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 0,
      callCount: 0,
      totalLatencyMs: null,
      usage: null,
      visibleInputHash: source.visibleInputHash,
      errorKind: null,
      errorMessage: null,
      createdAt: CREATED_AT,
      completedAt: null,
    };
    repository.seedRecoveredTrial({
      targetId,
      trial,
      resume,
      turn: {
        metadata: {
          turnIndex: 1,
          requestHash: HASH_A,
          responseHash: HASH_B,
          responseRecorded: true,
          outcome: "SUCCESS",
          errorKind: null,
          latencyMs: 25,
          usage: decision.usage,
          providerConfigHash: HASH_C,
          outputSchemaVersion: source.baseRequest.outputSchema!.version,
          outputSchemaHash: source.baseRequest.outputSchema!.sha256,
          adapterVersion: null,
          appliedOutputMode: null,
          finishReason: null,
          refusalHash: null,
          refusalRecorded: false,
          responseModel: null,
          createdAt: CREATED_AT,
        },
        request: { ...structuredClone(source.baseRequest), requestId, timeoutMs: 120_000 },
        response: {
          rawText: decision.rawText,
          parsed: decision.parsed,
          providerRequestId: decision.providerRequestId,
        },
      },
    });
    const provider = new ScriptedProvider([actionDecision({ action: "fold" })]);
    const intervals = new ManualIntervals();
    const service = new HandForkService({
      repository: repository as unknown as HandForkRepository,
      sourceResolver: { resolve: vi.fn() },
      models,
      history: { execute: vi.fn(async () => []) },
      createProvider: () => provider,
      setInterval: intervals.setInterval,
      clearInterval: intervals.clearInterval,
      leaseMs: 15_000,
      pollIntervalMs: 1_500,
      randomUUID: () => uuid(9_999),
    });
    repository.claimsEnabled = true;
    expect(await service.restorePending()).toEqual([FORK_ID]);
    await waitUntil(() => repository.completions.length === 1, "recovered trial");

    expect(provider.requests).toHaveLength(0);
    expect(repository.completions[0]!.privateResult.requestId).toBe(requestId);
    expect(repository.completions[0]).toMatchObject({ outcome: "MODEL_ACTION", action: "call" });
    await service.shutdown();
  });

  it.each([
    { failure: "source" as const, errorKind: "SERVER" },
    { failure: "runtime" as const, errorKind: "CONFIG" },
  ])("terminates a recovered running trial when frozen $failure data is unavailable", async ({
    failure,
    errorKind,
  }) => {
    const repository = new MemoryHandForkRepository();
    repository.claimsEnabled = false;
    const models = new FakeModels();
    const recovered = await createRecoverableFork(repository, models);
    const trial = runningTrial(recovered.source);
    repository.seedRecoveredTrial({ targetId: recovered.targetId, trial });
    if (failure === "source") {
      repository.loadSourcePayload = async () => {
        throw new Error("encrypted source cannot be materialized");
      };
    } else {
      models.failRuntimeForRevision = recovered.frozen.competitorRevisionId;
    }
    const provider = new ScriptedProvider([]);
    const service = new HandForkService({
      repository: repository as unknown as HandForkRepository,
      sourceResolver: { resolve: vi.fn() },
      models,
      history: { execute: vi.fn(async () => []) },
      createProvider: () => provider,
      randomUUID: () => uuid(9_999),
      now: () => Date.parse(CREATED_AT) + 75,
    });
    repository.claimsEnabled = true;
    expect(await service.restorePending()).toEqual([FORK_ID]);
    await waitUntil(() => repository.finishCalls.length === 1, `${failure} recovery failure`);

    expect(provider.requests).toHaveLength(0);
    expect(repository.completions).toHaveLength(1);
    expect(repository.completions[0]).toMatchObject({
      trialId: trial.id,
      outcome: "INFRA_ERROR",
      errorKind,
      totalLatencyMs: 75,
      privateResult: { requestId: trial.id, status: "PAUSED_INFRA" },
    });
    expect(repository.finishCalls[0]).toMatchObject({ status: "FAILED" });
    await service.shutdown();
  });

  it("terminalizes a recovered trial when source and audit ciphertext are both unreadable", async () => {
    const repository = new MemoryHandForkRepository();
    repository.claimsEnabled = false;
    const models = new FakeModels();
    const recovered = await createRecoverableFork(repository, models);
    const trial = runningTrial(recovered.source);
    repository.seedRecoveredTrial({ targetId: recovered.targetId, trial });
    repository.loadSourcePayload = async () => {
      throw new Error("source decryption failed");
    };
    repository.loadTrialResumeState = async () => {
      throw new Error("resume decryption failed");
    };
    repository.loadTrialTurnAudits = async () => {
      throw new Error("turn decryption failed");
    };
    const workerErrors: unknown[] = [];
    const service = new HandForkService({
      repository: repository as unknown as HandForkRepository,
      sourceResolver: { resolve: vi.fn() },
      models,
      history: { execute: vi.fn(async () => []) },
      createProvider: () => new ScriptedProvider([]),
      randomUUID: () => uuid(9_999),
      now: () => Date.parse(CREATED_AT) + 75,
      onWorkerError: (error) => workerErrors.push(error),
    });
    repository.claimsEnabled = true;
    expect(await service.restorePending()).toEqual([FORK_ID]);
    await waitUntil(() => repository.finishCalls.length === 1, "unreadable audit recovery");

    expect(workerErrors).toHaveLength(2);
    expect(repository.completions[0]).toMatchObject({
      trialId: trial.id,
      outcome: "INFRA_ERROR",
      firstTurnValid: null,
      historyQueryCount: 0,
      callCount: 0,
      errorKind: "SERVER",
      privateResult: { requestId: trial.id },
    });
    expect(repository.finishCalls[0]).toMatchObject({ status: "FAILED" });
    await service.shutdown();
  });

  it("documents at-least-once replay before the first committed provider checkpoint", async () => {
    const repository = new MemoryHandForkRepository();
    repository.claimsEnabled = false;
    const models = new FakeModels();
    const recovered = await createRecoverableFork(repository, models);
    const trial = runningTrial(recovered.source);
    // This is the irreducible crash state: the provider may have received the
    // prior request, but no response/checkpoint exists locally to prove it.
    repository.seedRecoveredTrial({ targetId: recovered.targetId, trial });
    const provider = new ScriptedProvider([actionDecision({ action: "call" })]);
    const service = new HandForkService({
      repository: repository as unknown as HandForkRepository,
      sourceResolver: { resolve: vi.fn() },
      models,
      history: { execute: vi.fn(async () => []) },
      createProvider: () => provider,
      randomUUID: () => uuid(9_999),
      now: () => Date.parse(CREATED_AT) + 75,
    });
    repository.claimsEnabled = true;
    expect(await service.restorePending()).toEqual([FORK_ID]);
    await waitUntil(() => repository.completions.length === 1, "pre-checkpoint replay");

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.requestId).toBe(trial.id);
    expect(repository.completions[0]).toMatchObject({
      outcome: "MODEL_ACTION",
      action: "call",
      privateResult: { requestId: trial.id },
    });
    await service.shutdown();
  });

  it("fences a late provider result after heartbeat renewal loses the lease", async () => {
    const gate = deferred<ProviderDecision>();
    const intervals = new ManualIntervals();
    const repository = new MemoryHandForkRepository();
    repository.renewResult = false;
    const provider = new ScriptedProvider([() => gate.promise]);
    const errors: unknown[] = [];
    const fixture = serviceFixture({
      repository,
      providers: [provider],
      intervals,
      onWorkerError: (error) => errors.push(error),
    });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => provider.requests.length === 1, "provider call");
    intervals.fire(5_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.resolve(actionDecision({ action: "call" }));
    await waitUntil(() => errors.length === 0 && repository.historyOfClaims.length === 1, "lease fencing");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(repository.checkpoints).toHaveLength(0);
    expect(repository.completions).toHaveLength(0);
    await fixture.service.shutdown();
  });

  it("does not revive a cancelled fork when an in-flight provider returns late", async () => {
    const gate = deferred<ProviderDecision>();
    const provider = new ScriptedProvider([() => gate.promise]);
    const fixture = serviceFixture({ providers: [provider] });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await waitUntil(() => provider.requests.length === 1, "provider call");
    const cancelled = await fixture.service.cancel(FORK_ID);
    expect(cancelled?.status).toBe("CANCELLED");
    gate.resolve(actionDecision({ action: "call" }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fixture.repository.snapshot()?.status).toBe("CANCELLED");
    expect(fixture.repository.completions).toHaveLength(0);
    await fixture.service.shutdown();
  });

  it("uses a periodic poll to reclaim a target only after its prior process lease expires", async () => {
    const intervals = new ManualIntervals();
    const repository = new MemoryHandForkRepository();
    repository.claimsEnabled = false;
    const fixture = serviceFixture({ repository, intervals });
    await fixture.service.create(createRequest(fixture.modelIds), null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.providers[0]!.requests).toHaveLength(0);

    const target = repository.record!.targets[0]!;
    target.status = "RUNNING";
    repository.claimsEnabled = true;
    intervals.fire(1_500);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.providers[0]!.requests).toHaveLength(0);

    repository.expiredTargets.add(target.id);
    intervals.fire(1_500);
    await waitUntil(() => fixture.repository.completions.length === 1, "periodic pickup");
    expect(fixture.providers[0]!.requests).toHaveLength(1);
    await fixture.service.shutdown();
    expect(intervals.entries.filter((entry) => entry.intervalMs === 1_500).every((entry) => !entry.active)).toBe(true);
  });

  it("never overlaps periodic repository polls", async () => {
    const intervals = new ManualIntervals();
    const repository = new MemoryHandForkRepository();
    const firstPoll = deferred<string[]>();
    let pollCalls = 0;
    repository.listRunnableForkIds = async () => {
      pollCalls += 1;
      return firstPoll.promise;
    };
    const fixture = serviceFixture({ repository, intervals });

    expect(pollCalls).toBe(1);
    intervals.fire(1_500);
    intervals.fire(1_500);
    expect(pollCalls).toBe(1);
    firstPoll.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    intervals.fire(1_500);
    expect(pollCalls).toBe(2);
    await fixture.service.shutdown();
  });
});

describe("hand fork legal contract", () => {
  const legal: HandForkLegalActions = {
    allowed: ["fold", "call", "raise", "all_in"],
    call: { amount: 100, will_be_all_in: false },
    bet: null,
    raise: { min_amount_to: 300, max_amount_to: 900 },
    all_in: { resulting_street_commitment: 1_000, classification: "raise" as const },
  };

  it("validates frozen action bounds without reconstructing HandState", () => {
    expect(validateHandForkAction(legal, { type: "action", action: "raise", amount_to: 500 }))
      .toEqual({ action: "raise", amountTo: 500 });
    expect(() => validateHandForkAction(legal, { type: "action", action: "raise", amount_to: 901 }))
      .toThrowError(expect.objectContaining({ code: "AMOUNT_TO_OUT_OF_RANGE" }));
    expect(() => validateHandForkAction(legal, { type: "action", action: "check" }))
      .toThrowError(expect.objectContaining({ code: "ACTION_NOT_ALLOWED" }));
  });

  it("falls back to check before fold and never invents another action", () => {
    expect(handForkFallbackAction({
      allowed: ["fold", "check"],
      call: null,
      bet: null,
      raise: null,
      all_in: null,
    })).toEqual({ action: "check" });
    expect(handForkFallbackAction({
      allowed: ["fold"],
      call: null,
      bet: null,
      raise: null,
      all_in: null,
    })).toEqual({ action: "fold" });
  });
});
