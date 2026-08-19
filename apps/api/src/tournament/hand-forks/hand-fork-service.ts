import { randomUUID } from "node:crypto";
import {
  adminHandForkSchema,
  createHandForkRequestSchema,
  handForkLegalActionsSchema,
  type ActionResponse,
  type AdminHandFork,
  type CreateHandForkRequest,
  type HandForkLegalActions,
  type HandForkProviderUsage,
  type HistoryQuery,
} from "../../../../../packages/contracts/src/index.js";
import { ModelProtocolError } from "../../../../../packages/contracts/src/index.js";
import type { ActionCommand } from "../../../../../packages/domain/src/betting.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import { createProvider } from "../../../../../packages/providers/src/provider-factory.js";
import type {
  FrozenModelConfig,
  ModelProvider,
  ProviderErrorKind,
} from "../../../../../packages/providers/src/provider.js";
import type { EffectiveOutputMode } from "../../../../../packages/providers/src/output-policy.js";
import type { FrozenModelTarget } from "../../admin/model-service.js";
import { providerRuntimeConfigHash } from "../../model-config-audit.js";
import {
  runModelDecision,
  type CallAudit,
  type DecisionResumeState,
  type DecisionRunnerResult,
  type DecisionTurnAudit,
} from "../decision-runner.js";
import type { HistoryQueryService } from "../history-query-service.js";
import {
  HandForkPersistenceConflictError,
  type BeginHandForkTrialInput,
  type CheckpointHandForkTurnInput,
  type ClaimedHandForkTarget,
  type CompleteHandForkTrialInput,
  type DecryptedHandForkTurnAudit,
  type HandForkPersistenceRecord,
  type HandForkSourcePayloadV1,
  type HandForkTargetPersistenceInput,
  type HandForkTurnResponse,
  type HandForkTrialResultV1,
  type PgHandForkRepository,
  type SaveHandForkTrialResumeStateInput,
} from "./hand-fork-repository.js";
import type {
  HandForkSourceResolver,
} from "./hand-fork-source.js";
import {
  handForkSourceIntegrity,
  handForkSourcePayload,
} from "./hand-fork-source-catalog.js";

const GLOBAL_WORKER_LIMIT = 3;
const DEFAULT_LEASE_MS = 660_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const FORBIDDEN_ENVELOPE_KEYS = [
  "arena_state",
  "arena_control",
  "history_results",
  "protocol_correction",
] as const;

export type HandForkRepository = Pick<PgHandForkRepository,
  | "createFork"
  | "listForks"
  | "getFork"
  | "loadSourcePayload"
  | "claimNextTarget"
  | "renewTargetLease"
  | "beginTrial"
  | "saveTrialResumeState"
  | "loadTrialResumeState"
  | "loadTrialTurnAudits"
  | "checkpointTrialTurn"
  | "completeTrial"
  | "finishTarget"
  | "cancelFork"
  | "restorePending"
  | "listRunnableForkIds"
>;

export interface HandForkFrozenModelStore {
  freezeCurrentTarget(modelConfigId: string, timeoutMs: number): Promise<FrozenModelTarget>;
  runtimeConfigForFrozenRevision(
    revisionId: string,
    expectedConfigurationHash: string,
    expectedEffectiveOutputMode: EffectiveOutputMode,
    timeoutMs: number,
  ): Promise<FrozenModelTarget>;
}

export interface HandForkHistoryReader {
  execute(
    tournamentId: string,
    currentHandNo: number,
    query: HistoryQuery,
  ): Promise<unknown[]>;
}

export interface HandForkServiceDependencies {
  repository: HandForkRepository;
  sourceResolver: Pick<HandForkSourceResolver, "resolve">;
  models: HandForkFrozenModelStore;
  history: Pick<HistoryQueryService, "execute"> | HandForkHistoryReader;
  createProvider?: (config: FrozenModelConfig) => ModelProvider;
  providerConfigHash?: (config: FrozenModelConfig) => string;
  randomUUID?: () => string;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  leaseMs?: number;
  pollIntervalMs?: number;
  onWorkerError?: (error: unknown) => void;
}

export class HandForkServiceStoppedError extends Error {
  constructor() {
    super("Hand fork service is shutting down");
    this.name = "HandForkServiceStoppedError";
  }
}

export class HandForkTargetUnavailableError extends Error {
  constructor(readonly modelConfigId: string, options?: ErrorOptions) {
    super("Target model is unavailable for hand fork creation", options);
    this.name = "HandForkTargetUnavailableError";
  }
}

class HandForkLeaseLostError extends Error {
  constructor(message = "Hand fork target lease is no longer owned by this worker") {
    super(message);
    this.name = "HandForkLeaseLostError";
  }
}

interface TargetHeartbeat {
  assertOwned(): void;
  stop(): Promise<void>;
}

interface TrialTrace {
  readonly turns: Map<number, DecisionTurnAudit>;
}

function boundedErrorMessage(error: unknown, prefix?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const redacted = detail
    .replaceAll(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replaceAll(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  const message = prefix ? `${prefix}: ${redacted}` : redacted;
  return Array.from(message).slice(0, MAX_ERROR_MESSAGE_LENGTH).join("");
}

function isFencingError(error: unknown): boolean {
  return error instanceof HandForkPersistenceConflictError
    || error instanceof HandForkLeaseLostError;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertBareArenaState(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hand fork source userPayload must be a bare arena_state object");
  }
  for (const key of FORBIDDEN_ENVELOPE_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new Error(`Hand fork source userPayload already contains the ${key} envelope`);
    }
  }
}

function effectiveOutputMode(value: string): EffectiveOutputMode {
  if (value === "json_schema" || value === "json_object" || value === "prompt") return value;
  throw new Error("Frozen hand fork target contains an unsupported effective output mode");
}

function historyProtocolVersion(
  value: string,
): "arena-history-legacy-v1" | "arena-history-v2" {
  if (value === "arena-history-legacy-v1" || value === "arena-history-v2") return value;
  throw new Error("Frozen hand fork source contains an unsupported history protocol version");
}

export function validateHandForkAction(
  legal: HandForkLegalActions,
  response: ActionResponse,
): ActionCommand {
  const action = response.action;
  if (!legal.allowed.includes(action)) {
    throw new ModelProtocolError("ACTION_NOT_ALLOWED", `${action} is not in the frozen legal action set`);
  }
  if (action === "bet" || action === "raise") {
    if (response.amount_to === undefined) {
      throw new ModelProtocolError("AMOUNT_TO_REQUIRED", `${action} requires amount_to`);
    }
    const bounds = legal[action];
    if (!bounds) {
      throw new ModelProtocolError("ACTION_NOT_ALLOWED", `${action} has no frozen sizing contract`);
    }
    if (response.amount_to < bounds.min_amount_to || response.amount_to > bounds.max_amount_to) {
      throw new ModelProtocolError("AMOUNT_TO_OUT_OF_RANGE", `${action} amount_to is outside the frozen legal range`);
    }
    return { action, amountTo: response.amount_to };
  }
  if (response.amount_to !== undefined) {
    throw new ModelProtocolError("AMOUNT_TO_MUST_BE_NULL", `${action} cannot contain amount_to`);
  }
  return { action };
}

export function handForkFallbackAction(legal: HandForkLegalActions): ActionCommand {
  if (legal.allowed.includes("check")) return { action: "check" };
  if (legal.allowed.includes("fold")) return { action: "fold" };
  throw new Error("Frozen legal action set contains neither check nor fold for protocol fallback");
}

function aggregateUsage(calls: readonly CallAudit[]): HandForkProviderUsage | null {
  const observed = calls.flatMap((call) => call.usage ? [call.usage] : []);
  if (observed.length === 0) return null;
  const sum = (key: keyof HandForkProviderUsage): number | null => {
    const values = observed.flatMap((usage) => usage[key] === null ? [] : [usage[key]]);
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
  };
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
  };
}

function turnAuditFromPersisted(turn: DecryptedHandForkTurnAudit): DecisionTurnAudit {
  return {
    turnIndex: turn.metadata.turnIndex,
    request: clone(turn.request),
    outcome: turn.metadata.outcome,
    errorKind: turn.metadata.errorKind as CallAudit["errorKind"],
    latencyMs: turn.metadata.latencyMs,
    usage: turn.metadata.usage,
    ...(turn.response ? { response: clone(turn.response) } : {}),
  };
}

function turnResponseForPersistence(
  response: NonNullable<DecisionTurnAudit["response"]>,
): HandForkTurnResponse {
  return {
    rawText: response.rawText,
    providerRequestId: response.providerRequestId,
    ...(response.parsed ? { parsed: response.parsed } : {}),
    ...(response.transportAudit ? { transportAudit: response.transportAudit } : {}),
  };
}

function firstTurnValidity(
  trace: TrialTrace,
  legal: HandForkLegalActions,
  result: DecisionRunnerResult,
): boolean | null {
  const firstOutput = [...trace.turns.values()]
    .sort((left, right) => left.turnIndex - right.turnIndex)[0];
  if (!firstOutput) return null;
  // An infrastructure failure contains no model output. A later retry must not
  // be re-labelled as the model's first turn. A terminal infrastructure-only
  // trial stays unobserved; a trial that later produces an action records that
  // its literal first turn was not successful.
  if (firstOutput.outcome === "INFRA_ERROR") return result.status === "ACTION" ? false : null;
  if (firstOutput.outcome === "PROTOCOL_ERROR") return false;
  const parsed = firstOutput.response?.parsed;
  if (!parsed) return false;
  if (parsed.type === "history_query") {
    const accepted = result.historyResults.some((historyResult) => (
      canonicalJson(historyResult.query) === canonicalJson(parsed.query)
    ));
    if (accepted) return true;
    // Reaching the history service proves the model emitted a schema-valid
    // query. A history outage does not turn that model output into a protocol
    // failure; only an explicit protocol correction does.
    return result.protocolFailures > 0 ? false : true;
  }
  try {
    validateHandForkAction(legal, parsed);
    return true;
  } catch (error) {
    if (error instanceof ModelProtocolError) return false;
    throw error;
  }
}

function emittedHistoryQueryCount(trace: TrialTrace): number {
  return [...trace.turns.values()].filter((turn) => (
    turn.response?.parsed?.type === "history_query"
  )).length;
}

function requestIdForTrial(
  resumeState: DecisionResumeState | null,
  turns: readonly DecryptedHandForkTurnAudit[],
  trialId: string,
): string {
  const requestIds = new Set(turns.map((turn) => turn.request.requestId));
  if (requestIds.size > 1) throw new Error("Recovered hand fork trial contains multiple request IDs");
  const persisted = requestIds.values().next().value as string | undefined;
  if (persisted) return persisted;
  if ((resumeState?.calls.length ?? 0) > 0) {
    throw new Error("Recovered hand fork trial has call state but no auditable request ID");
  }
  // The trial UUID is already random, globally unique and durable before the
  // provider call begins. Reusing it as requestId closes the crash window in
  // which a generated-but-not-yet-checkpointed request ID would be lost.
  // It is an audit correlation ID, not a provider idempotency key. Provider
  // execution therefore remains at-least-once until the first checkpoint has
  // committed; after that checkpoint, pending output is resumed without a
  // duplicate provider call.
  return trialId;
}

function amountTo(action: ActionCommand | null): number | null {
  return action && (action.action === "bet" || action.action === "raise")
    ? action.amountTo
    : null;
}

function actionSummary(result: DecisionRunnerResult): string | null {
  return result.status === "ACTION" ? result.response?.decision_summary ?? null : null;
}

function privateTrialResult(requestId: string, result: DecisionRunnerResult): HandForkTrialResultV1 {
  if (result.status === "ACTION") {
    return {
      version: "hand-fork-trial-result-v1",
      requestId,
      status: "ACTION",
      action: clone(result.action),
      response: result.response ? clone(result.response) : null,
      usedFallback: result.usedFallback,
      protocolFailures: result.protocolFailures,
      historyResults: clone(result.historyResults),
      calls: clone(result.calls),
      error: null,
    };
  }
  return {
    version: "hand-fork-trial-result-v1",
    requestId,
    status: "PAUSED_INFRA",
    action: null,
    response: null,
    usedFallback: false,
    protocolFailures: result.protocolFailures,
    historyResults: clone(result.historyResults),
    calls: clone(result.calls),
    error: { kind: result.errorKind, message: boundedErrorMessage(result.message) },
  };
}

function trailingInfrastructureFailures(target: HandForkPersistenceRecord["targets"][number] | undefined): number {
  const trials = [...(target?.trials ?? [])]
    .filter((trial) => trial.status === "COMPLETED")
    .sort((left, right) => left.sampleIndex - right.sampleIndex);
  let count = 0;
  for (let index = trials.length - 1; index >= 0; index -= 1) {
    if (trials[index]?.outcome !== "INFRA_ERROR") break;
    count += 1;
  }
  return count;
}

function publicFork(
  record: HandForkPersistenceRecord,
  payload: HandForkSourcePayloadV1,
): AdminHandFork {
  return adminHandForkSchema.parse({
    id: record.id,
    status: record.status,
    source: {
      tournamentId: record.sourceTournamentId,
      tournamentName: payload.source.tournamentName,
      handNo: record.sourceHandNo,
      decisionId: record.sourceDecisionId,
      playerId: record.sourcePlayerId,
      playerDisplayName: payload.source.playerDisplayName,
      street: payload.source.street,
      heroPosition: payload.source.heroPosition,
      holeCards: payload.source.holeCards,
      legalActions: payload.source.legalActions,
      originalAction: payload.source.originalAction,
      originalAmountTo: payload.source.originalAmountTo,
      originalDecisionSummary: payload.source.originalDecisionSummary,
      originalUsedFallback: payload.source.originalUsedFallback,
      actionEventSequence: record.sourceActionEventSequence,
    },
    sourceIntegrity: {
      expectedAggregateVersion: record.sourceExpectedAggregateVersion,
      sourceEventHash: record.sourceEventHash,
      sourceRequestHash: record.sourceRequestHash,
      sourcePayloadHash: record.sourcePayloadHash,
      visibleInputHash: record.visibleInputHash,
      legalContractHash: record.legalContractHash,
      protocolBundleId: record.protocolBundleId,
      rulesetVersion: record.rulesetVersion,
      contextVersion: record.contextVersion,
      systemPromptHash: record.systemPromptHash,
      outputSchemaHash: record.outputSchemaHash,
      parserPolicyVersion: record.parserPolicyVersion,
      adapterProtocolVersion: record.adapterProtocolVersion,
      historyProtocolVersion: record.historyProtocolVersion,
      correctionProtocolVersion: record.correctionProtocolVersion,
    },
    sampleCount: record.sampleCount,
    timeoutMs: record.timeoutMs,
    maxParallelTargets: record.maxParallelTargets,
    summary: record.summary,
    errorMessage: record.errorMessage,
    createdByAdminUserId: record.createdByAdminUserId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    targets: record.targets,
  });
}

export class HandForkService {
  readonly #repository: HandForkRepository;
  readonly #sourceResolver: Pick<HandForkSourceResolver, "resolve">;
  readonly #models: HandForkFrozenModelStore;
  readonly #history: HandForkHistoryReader;
  readonly #createProvider: (config: FrozenModelConfig) => ModelProvider;
  readonly #providerConfigHash: (config: FrozenModelConfig) => string;
  readonly #randomUUID: () => string;
  readonly #now: () => number;
  readonly #setInterval: (callback: () => void, intervalMs: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  readonly #leaseMs: number;
  readonly #renewalMs: number;
  readonly #pollIntervalMs: number;
  readonly #onWorkerError: (error: unknown) => void;
  readonly #activeWorkers = new Set<Promise<void>>();
  readonly #pollTimer: unknown;
  #polling: Promise<void> | null = null;
  #workVersion = 0;
  #stopping = false;

  constructor(dependencies: HandForkServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#sourceResolver = dependencies.sourceResolver;
    this.#models = dependencies.models;
    this.#history = dependencies.history;
    this.#createProvider = dependencies.createProvider ?? createProvider;
    this.#providerConfigHash = dependencies.providerConfigHash ?? providerRuntimeConfigHash;
    this.#randomUUID = dependencies.randomUUID ?? randomUUID;
    this.#now = dependencies.now ?? Date.now;
    this.#setInterval = dependencies.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.#clearInterval = dependencies.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.#leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs > 3_600_000) {
      throw new Error("Hand fork leaseMs must be between 1,000 and 3,600,000 milliseconds");
    }
    this.#renewalMs = Math.min(30_000, Math.max(5_000, Math.floor(this.#leaseMs / 3)));
    this.#pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#pollIntervalMs)
      || this.#pollIntervalMs < 1_000
      || this.#pollIntervalMs > 2_000) {
      throw new Error("Hand fork pollIntervalMs must be between 1,000 and 2,000 milliseconds");
    }
    this.#onWorkerError = dependencies.onWorkerError ?? (() => {});
    this.#pollTimer = this.#setInterval(() => this.#poll(), this.#pollIntervalMs);
    this.#poll();
  }

  async create(rawInput: CreateHandForkRequest, adminUserId: string | null): Promise<AdminHandFork> {
    if (this.#stopping) throw new HandForkServiceStoppedError();
    const input = createHandForkRequestSchema.parse(rawInput);
    const source = await this.#sourceResolver.resolve(input.sourceDecisionId);
    const payload = clone(handForkSourcePayload(source));
    const integrity = handForkSourceIntegrity(source);
    assertBareArenaState(payload.baseRequest.userPayload);
    const outputSchema = payload.baseRequest.outputSchema;
    if (!outputSchema) throw new Error("Fork source decision has no frozen output schema");

    const frozenTargets = await Promise.all(input.modelConfigIds.map(async (modelConfigId) => {
      try {
        return await this.#models.freezeCurrentTarget(modelConfigId, input.timeoutMs);
      } catch (error) {
        throw new HandForkTargetUnavailableError(modelConfigId, { cause: error });
      }
    }));
    const targets: HandForkTargetPersistenceInput[] = frozenTargets.map((target, index) => {
      if (target.modelConfigId !== input.modelConfigIds[index]) {
        throw new Error("Frozen hand fork target does not match the requested model configuration");
      }
      return {
        modelConfigId: target.modelConfigId,
        competitorRevisionId: target.competitorRevisionId,
        modelConfigurationHash: target.configurationHash,
        effectiveOutputMode: target.effectiveOutputMode,
      };
    });
    const record = await this.#repository.createFork({
      source: {
        tournamentId: source.tournamentId,
        decisionId: source.decisionId,
        handNo: source.handNo,
        playerId: source.playerId,
        expectedAggregateVersion: source.expectedAggregateVersion,
        actionEventSequence: source.actionEventSequence,
        sourceEventHash: integrity.sourceEventHash,
        sourceRequestHash: integrity.sourceRequestHash,
        visibleInputHash: integrity.visibleInputHash,
        legalContractHash: integrity.legalContractHash,
        protocolBundleId: integrity.protocolBundleId,
        rulesetVersion: integrity.rulesetVersion,
        contextVersion: integrity.contextVersion,
        systemPromptHash: integrity.systemPromptHash,
        outputSchemaHash: integrity.outputSchemaHash,
        parserPolicyVersion: integrity.parserPolicyVersion,
        adapterProtocolVersion: integrity.adapterProtocolVersion,
        historyProtocolVersion: integrity.historyProtocolVersion,
        correctionProtocolVersion: integrity.correctionProtocolVersion,
        historyBudget: clone(source.decisionConfig.history),
        privatePayload: payload,
      },
      targets,
      sampleCount: input.sampleCount,
      timeoutMs: input.timeoutMs,
      maxParallelTargets: input.maxParallelTargets,
      createdByAdminUserId: adminUserId,
    });
    this.#requestPump();
    return publicFork(record, payload);
  }

  async list(limit = 50): Promise<AdminHandFork[]> {
    const records = await this.#repository.listForks(limit);
    return Promise.all(records.map(async (record) => (
      publicFork(record, await this.#repository.loadSourcePayload(record.id))
    )));
  }

  async get(id: string): Promise<AdminHandFork | null> {
    const record = await this.#repository.getFork(id, true);
    if (!record) return null;
    return publicFork(record, await this.#repository.loadSourcePayload(id));
  }

  async cancel(id: string): Promise<AdminHandFork | null> {
    const record = await this.#repository.cancelFork(id);
    if (!record) return null;
    this.#requestPump();
    return publicFork(record, await this.#repository.loadSourcePayload(id));
  }

  async restorePending(): Promise<string[]> {
    if (this.#stopping) throw new HandForkServiceStoppedError();
    const ids = await this.#repository.restorePending();
    if (ids.length > 0) this.#requestPump();
    return ids;
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#clearInterval(this.#pollTimer);
    await this.#polling;
    await Promise.allSettled([...this.#activeWorkers]);
  }

  #poll(): void {
    if (this.#stopping || this.#polling) return;
    let current!: Promise<void>;
    current = (async () => {
      try {
        const runnable = await this.#repository.listRunnableForkIds();
        if (runnable.length > 0) this.#requestPump();
      } catch (error) {
        this.#reportWorkerError(error);
      } finally {
        if (this.#polling === current) this.#polling = null;
      }
    })();
    this.#polling = current;
  }

  #requestPump(): void {
    if (this.#stopping) return;
    this.#workVersion += 1;
    this.#fillWorkers();
  }

  #fillWorkers(): void {
    while (!this.#stopping && this.#activeWorkers.size < GLOBAL_WORKER_LIMIT) {
      const observedWorkVersion = this.#workVersion;
      let worker!: Promise<void>;
      worker = this.#workerLoop().finally(() => {
        this.#activeWorkers.delete(worker);
        if (!this.#stopping && this.#workVersion !== observedWorkVersion) this.#fillWorkers();
      });
      this.#activeWorkers.add(worker);
    }
  }

  async #workerLoop(): Promise<void> {
    const workerId = `hand-fork-worker:${this.#randomUUID()}`;
    while (!this.#stopping) {
      let claimed: ClaimedHandForkTarget | null;
      try {
        claimed = await this.#repository.claimNextTarget(workerId, this.#leaseMs);
      } catch (error) {
        this.#reportWorkerError(error);
        return;
      }
      if (!claimed) return;
      try {
        await this.#processTarget(claimed);
      } catch (error) {
        if (!isFencingError(error)) this.#reportWorkerError(error);
      }
    }
  }

  #reportWorkerError(error: unknown): void {
    try {
      this.#onWorkerError(error);
    } catch {
      // Observability hooks must never take down the scheduler.
    }
  }

  #startHeartbeat(claimed: ClaimedHandForkTarget): TargetHeartbeat {
    let stopped = false;
    let failure: unknown = null;
    let renewal = Promise.resolve();
    const renew = (): void => {
      if (stopped || failure) return;
      renewal = renewal.then(async () => {
        if (stopped || failure) return;
        const renewed = await this.#repository.renewTargetLease(
          claimed.id,
          claimed.workerId,
          claimed.leaseToken,
          this.#leaseMs,
        );
        if (!renewed) throw new HandForkLeaseLostError();
      }).catch((error: unknown) => {
        failure = error;
      });
    };
    const timer = this.#setInterval(renew, this.#renewalMs);
    return {
      assertOwned: () => {
        if (failure) {
          if (failure instanceof Error) throw failure;
          throw new HandForkLeaseLostError(String(failure));
        }
      },
      stop: async () => {
        stopped = true;
        this.#clearInterval(timer);
        await renewal;
      },
    };
  }

  async #processTarget(claimed: ClaimedHandForkTarget): Promise<void> {
    const heartbeat = this.#startHeartbeat(claimed);
    try {
      let fork: HandForkPersistenceRecord;
      let recoverableFork: HandForkPersistenceRecord | null = null;
      let payload: HandForkSourcePayloadV1;
      let outputSchema: NonNullable<HandForkSourcePayloadV1["baseRequest"]["outputSchema"]>;
      let legal: HandForkLegalActions;
      try {
        const loadedFork = await this.#repository.getFork(claimed.forkId, true);
        if (!loadedFork) throw new Error(`Unknown claimed hand fork: ${claimed.forkId}`);
        if (!loadedFork.targets.some((target) => target.id === claimed.id)) {
          throw new Error("Claimed target is absent from its hand fork aggregate");
        }
        fork = loadedFork;
        recoverableFork = loadedFork;
        payload = await this.#repository.loadSourcePayload(claimed.forkId);
        assertBareArenaState(payload.baseRequest.userPayload);
        const frozenSchema = payload.baseRequest.outputSchema;
        if (!frozenSchema) throw new Error("Fork source decision has no frozen output schema");
        outputSchema = frozenSchema;
        legal = handForkLegalActionsSchema.parse(payload.source.legalActions);
        historyProtocolVersion(fork.historyProtocolVersion);
      } catch (error) {
        this.#reportWorkerError(error);
        heartbeat.assertOwned();
        if (recoverableFork) {
          await this.#completeRecoveredTrialFailure({
            claimed,
            fork: recoverableFork,
            heartbeat,
            errorKind: "SERVER",
            errorMessage: "Frozen source payload is unavailable",
          });
        }
        await this.#repository.finishTarget(
          claimed.id,
          claimed.workerId,
          claimed.leaseToken,
          "FAILED",
          "Frozen source payload is unavailable",
        );
        return;
      }

      let frozen: FrozenModelTarget;
      let provider: ModelProvider;
      let runtimeHash: string;
      try {
        frozen = await this.#models.runtimeConfigForFrozenRevision(
          claimed.competitorRevisionId,
          claimed.modelConfigurationHash,
          effectiveOutputMode(claimed.effectiveOutputMode),
          claimed.timeoutMs,
        );
        if (frozen.modelConfigId !== claimed.modelConfigId
          || frozen.competitorRevisionId !== claimed.competitorRevisionId
          || frozen.configurationHash !== claimed.modelConfigurationHash
          || frozen.effectiveOutputMode !== claimed.effectiveOutputMode) {
          throw new Error("Materialized frozen model target does not match its claimed identity");
        }
        provider = this.#createProvider(frozen.runtimeConfig);
        runtimeHash = this.#providerConfigHash(frozen.runtimeConfig);
      } catch (error) {
        this.#reportWorkerError(error);
        heartbeat.assertOwned();
        await this.#completeRecoveredTrialFailure({
          claimed,
          fork,
          heartbeat,
          legal,
          errorKind: "CONFIG",
          errorMessage: "Frozen model configuration is unavailable",
        });
        await this.#repository.finishTarget(
          claimed.id,
          claimed.workerId,
          claimed.leaseToken,
          "FAILED",
          "Frozen model configuration is unavailable",
        );
        return;
      }
      let consecutiveInfra = trailingInfrastructureFailures(
        fork.targets.find((target) => target.id === claimed.id),
      );

      for (let sampleIndex = claimed.terminalTrials + 1;
        sampleIndex <= claimed.sampleCount;
        sampleIndex += 1) {
        heartbeat.assertOwned();
        const completion = await this.#runTrial({
          claimed,
          fork,
          payload,
          legal,
          provider,
          runtimeHash,
          outputSchema,
          sampleIndex,
          heartbeat,
        });
        if (!completion) return;
        if (completion.outcome === "INFRA_ERROR") {
          consecutiveInfra += 1;
          const terminalKind = completion.errorKind === "AUTH" || completion.errorKind === "CONFIG";
          if (terminalKind || consecutiveInfra >= 3) {
            heartbeat.assertOwned();
            await this.#repository.finishTarget(
              claimed.id,
              claimed.workerId,
              claimed.leaseToken,
              "FAILED",
              boundedErrorMessage(
                completion.errorMessage ?? completion.errorKind ?? "Infrastructure failure",
                terminalKind
                  ? `Target stopped after ${completion.errorKind}`
                  : "Target stopped after three consecutive infrastructure-error trials",
              ),
            );
            return;
          }
        } else {
          consecutiveInfra = 0;
        }
      }

      heartbeat.assertOwned();
      await this.#repository.finishTarget(
        claimed.id,
        claimed.workerId,
        claimed.leaseToken,
        "COMPLETED",
      );
    } finally {
      await heartbeat.stop();
    }
  }

  async #completeRecoveredTrialFailure(input: {
    claimed: ClaimedHandForkTarget;
    fork: HandForkPersistenceRecord;
    heartbeat: TargetHeartbeat;
    legal?: HandForkLegalActions;
    errorKind: ProviderErrorKind;
    errorMessage: string;
  }): Promise<void> {
    const target = input.fork.targets.find((candidate) => candidate.id === input.claimed.id);
    const running = (target?.trials ?? []).filter((trial) => trial.status === "RUNNING");
    if (running.length === 0) return;
    if (running.length > 1) {
      throw new Error("Recovered hand fork target contains multiple running trials");
    }
    const trial = running[0]!;
    let resumeState: DecisionResumeState | null = null;
    let persistedTurns: DecryptedHandForkTurnAudit[] = [];
    try {
      [resumeState, persistedTurns] = await Promise.all([
        this.#repository.loadTrialResumeState(trial.id),
        this.#repository.loadTrialTurnAudits(trial.id),
      ]);
    } catch (error) {
      // Source corruption can share a cause (for example, an unavailable
      // master key) with resume/turn decryption. Do not let diagnostic reads
      // prevent lease-fenced terminalization; the durable trial UUID remains
      // a safe request correlation ID and unavailable metrics stay empty.
      this.#reportWorkerError(error);
    }
    const requestId = requestIdForTrial(resumeState, persistedTurns, trial.id);
    const trace: TrialTrace = {
      turns: new Map(persistedTurns.map((turn) => [
        turn.metadata.turnIndex,
        turnAuditFromPersisted(turn),
      ])),
    };
    const calls = resumeState?.calls ?? [];
    const decision: DecisionRunnerResult = {
      status: "PAUSED_INFRA",
      errorKind: input.errorKind,
      message: input.errorMessage,
      protocolFailures: resumeState?.protocolFailures ?? 0,
      historyResults: clone(resumeState?.historyResults ?? []),
      calls: clone(calls),
    };
    input.heartbeat.assertOwned();
    await this.#repository.completeTrial({
      forkId: input.claimed.forkId,
      targetId: input.claimed.id,
      workerId: input.claimed.workerId,
      leaseToken: input.claimed.leaseToken,
      trialId: trial.id,
      outcome: "INFRA_ERROR",
      action: null,
      amountTo: null,
      decisionSummary: null,
      usedFallback: false,
      firstTurnValid: input.legal ? firstTurnValidity(trace, input.legal, decision) : null,
      historyQueryCount: emittedHistoryQueryCount(trace),
      protocolFailures: decision.protocolFailures,
      infrastructureFailures: calls.filter((call) => call.outcome === "INFRA_ERROR").length,
      callCount: calls.length,
      totalLatencyMs: this.#trialWallClockMs(trial.createdAt),
      usage: aggregateUsage(calls),
      errorKind: input.errorKind,
      errorMessage: input.errorMessage,
      privateResult: privateTrialResult(requestId, decision),
    });
  }

  #trialWallClockMs(createdAt: string): number {
    const startedAt = Date.parse(createdAt);
    if (!Number.isFinite(startedAt)) throw new Error("Hand fork trial has an invalid creation timestamp");
    return Math.max(0, Math.round(this.#now() - startedAt));
  }

  async #runTrial(input: {
    claimed: ClaimedHandForkTarget;
    fork: HandForkPersistenceRecord;
    payload: HandForkSourcePayloadV1;
    legal: HandForkLegalActions;
    provider: ModelProvider;
    runtimeHash: string;
    outputSchema: NonNullable<HandForkSourcePayloadV1["baseRequest"]["outputSchema"]>;
    sampleIndex: number;
    heartbeat: TargetHeartbeat;
  }): Promise<CompleteHandForkTrialInput | null> {
    const trialInput: BeginHandForkTrialInput = {
      targetId: input.claimed.id,
      workerId: input.claimed.workerId,
      leaseToken: input.claimed.leaseToken,
      sampleIndex: input.sampleIndex,
      visibleInputHash: input.fork.visibleInputHash,
    };
    const trial = await this.#repository.beginTrial(trialInput);
    if (!trial) return null;
    if (trial.status !== "RUNNING") {
      throw new HandForkPersistenceConflictError("Claimed hand fork trial is already terminal");
    }
    const [resumeState, persistedTurns] = await Promise.all([
      this.#repository.loadTrialResumeState(trial.id),
      this.#repository.loadTrialTurnAudits(trial.id),
    ]);
    const requestId = requestIdForTrial(resumeState, persistedTurns, trial.id);
    const request = {
      ...clone(input.payload.baseRequest),
      requestId,
      timeoutMs: input.claimed.timeoutMs,
      userPayload: clone(input.payload.baseRequest.userPayload),
    };
    assertBareArenaState(request.userPayload);
    const trace: TrialTrace = {
      turns: new Map(persistedTurns.map((turn) => [
        turn.metadata.turnIndex,
        turnAuditFromPersisted(turn),
      ])),
    };
    const leaseFields = {
      targetId: input.claimed.id,
      workerId: input.claimed.workerId,
      leaseToken: input.claimed.leaseToken,
      trialId: trial.id,
    } as const;
    const saveResumeState = async (state: DecisionResumeState): Promise<void> => {
      input.heartbeat.assertOwned();
      const persistence: SaveHandForkTrialResumeStateInput = { ...leaseFields, state };
      await this.#repository.saveTrialResumeState(persistence);
    };
    const checkpointTurn = async (checkpoint: {
      turn: DecisionTurnAudit;
      resumeState: DecisionResumeState;
    }): Promise<void> => {
      input.heartbeat.assertOwned();
      const persistence: CheckpointHandForkTurnInput = {
        forkId: input.claimed.forkId,
        ...leaseFields,
        turnIndex: checkpoint.turn.turnIndex,
        request: checkpoint.turn.request,
        ...(checkpoint.turn.response ? {
          response: turnResponseForPersistence(checkpoint.turn.response),
        } : {}),
        outcome: checkpoint.turn.outcome,
        errorKind: checkpoint.turn.errorKind,
        providerConfigHash: input.runtimeHash,
        outputSchemaVersion: input.outputSchema.version,
        outputSchemaHash: input.outputSchema.sha256,
        latencyMs: checkpoint.turn.latencyMs,
        usage: checkpoint.turn.usage,
        resumeState: checkpoint.resumeState,
      };
      await this.#repository.checkpointTrialTurn(persistence);
      trace.turns.set(checkpoint.turn.turnIndex, clone(checkpoint.turn));
    };

    const decision = await runModelDecision({
      provider: input.provider,
      request,
      resumeState,
      saveResumeState,
      checkpointTurn,
      validateAction: (response) => validateHandForkAction(input.legal, response),
      fallbackAction: () => handForkFallbackAction(input.legal),
      executeHistoryQuery: (query) => this.#history.execute(
        input.fork.sourceTournamentId,
        input.fork.sourceHandNo,
        query,
      ),
      historyProtocolVersion: historyProtocolVersion(input.fork.historyProtocolVersion),
    }, input.payload.decisionConfig);
    input.heartbeat.assertOwned();

    const action = decision.status === "ACTION" ? decision.action : null;
    const outcome = decision.status === "PAUSED_INFRA"
      ? "INFRA_ERROR"
      : decision.usedFallback ? "PROTOCOL_FALLBACK" : "MODEL_ACTION";
    const completion: CompleteHandForkTrialInput = {
      forkId: input.claimed.forkId,
      ...leaseFields,
      outcome,
      action: action?.action ?? null,
      amountTo: amountTo(action),
      decisionSummary: actionSummary(decision),
      usedFallback: decision.status === "ACTION" && decision.usedFallback,
      firstTurnValid: firstTurnValidity(
        trace,
        input.legal,
        decision,
      ),
      historyQueryCount: emittedHistoryQueryCount(trace),
      protocolFailures: decision.protocolFailures,
      infrastructureFailures: decision.calls.filter((call) => call.outcome === "INFRA_ERROR").length,
      callCount: decision.calls.length,
      totalLatencyMs: this.#trialWallClockMs(trial.createdAt),
      usage: aggregateUsage(decision.calls),
      errorKind: decision.status === "PAUSED_INFRA" ? decision.errorKind : null,
      errorMessage: decision.status === "PAUSED_INFRA"
        ? boundedErrorMessage(decision.message)
        : null,
      privateResult: privateTrialResult(requestId, decision),
    };
    await this.#repository.completeTrial(completion);
    return completion;
  }
}
