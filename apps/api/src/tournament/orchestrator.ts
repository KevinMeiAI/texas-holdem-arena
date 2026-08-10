import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  buildEffectiveSystemPrompt,
  projectArenaEvents,
  tournamentEventToArenaEvents,
  type CanonicalModelRequest,
  type NewArenaEvent,
} from "../../../../packages/contracts/src/index.js";
import { cardCode, createDeck } from "../../../../packages/domain/src/cards.js";
import { createTournament as createDomainTournament, reduceTournament, startTournamentHand, type TournamentConfig, type TournamentState, type TournamentTransition } from "../../../../packages/domain/src/tournament.js";
import { deriveSeed, DeterministicRng, seedCommitment } from "../../../../packages/fairness/src/rng.js";
import type { ModelProvider } from "../../../../packages/providers/src/provider.js";
import { ARENA_DECISION_TIMEOUT_MS } from "../model-runtime.js";
import {
  type AppendEventsInput,
  type PendingDecisionRequest,
  PgEventStore,
} from "../persistence/event-store.js";
import { recoverAggregate } from "../persistence/recovery.js";
import { runModelDecision, type DecisionRunnerConfig } from "./decision-runner.js";
import { HistoryBudget } from "./history-budget.js";
import { HistoryQueryService } from "./history-query-service.js";
import { protocolFallbackAction, toDomainAction } from "./model-action.js";
import { buildModelContext } from "./model-context.js";

export type OperationalStatus = "READY" | "RUNNING" | "PAUSED_INFRA" | "COMPLETED" | "CANCELLED";

export interface ArenaTournamentSetup {
  tournamentId?: string;
  name: string;
  rulesetVersion: string;
  tournament: TournamentConfig;
  providerIdByPlayer: Record<string, string>;
  playerLabels?: Record<string, string>;
  masterSeed?: Uint8Array;
  managedByArena?: boolean;
}

export interface OrchestratorRuntime {
  tournamentId: string;
  name: string;
  rulesetVersion: string;
  operationalStatus: OperationalStatus;
  aggregateVersion: number;
  domain: TournamentState;
  effectivePrompt: ReturnType<typeof buildEffectiveSystemPrompt>;
  providerIdByPlayer: Record<string, string>;
  playerLabels: Record<string, string>;
  masterSeedBase64: string;
  seedCommitment: string;
  seedRevealed: boolean;
  pendingDecisionId: string | null;
}

export interface OrchestratorDependencies {
  eventStore: PgEventStore;
  pool: Pool;
  providers: ReadonlyMap<string, ModelProvider>;
  decisionConfig?: DecisionRunnerConfig;
}

const defaultDecisionConfig: DecisionRunnerConfig = {
  maxInfrastructureAttempts: 3,
  infrastructureRetryDelaysMs: [2_000, 8_000],
  history: { maxQueries: 2, maxEventsPerQuery: 80, maxApproxTokens: 4_000 },
};

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function publicState(runtime: OrchestratorRuntime): unknown {
  const hand = runtime.domain.currentHand;
  return {
    tournamentId: runtime.tournamentId,
    name: runtime.name,
    rulesetVersion: runtime.rulesetVersion,
    promptHash: runtime.effectivePrompt.sha256,
    status: runtime.operationalStatus,
    completedHands: runtime.domain.completedHands,
    championPlayerId: runtime.domain.championPlayerId,
    seedCommitment: runtime.seedCommitment,
    seedRevealed: runtime.seedRevealed,
    ...(runtime.seedRevealed ? { masterSeedBase64: runtime.masterSeedBase64 } : {}),
    players: runtime.domain.players.map((player) => {
      const handPlayer = hand?.players.find((candidate) => candidate.id === player.id);
      return {
        id: player.id,
        displayName: runtime.playerLabels[player.id] ?? player.id,
        seat: player.seat,
        stack: handPlayer?.stack ?? player.stack,
        status: player.status,
        finishingPosition: player.finishingPosition,
        folded: handPlayer?.folded ?? false,
        allIn: handPlayer?.allIn ?? false,
        streetCommitted: handPlayer?.streetCommitted ?? 0,
        totalCommitted: handPlayer?.totalCommitted ?? 0,
      };
    }),
    hand: hand ? {
      handNo: hand.handNo,
      phase: hand.phase,
      positions: hand.positions,
      blinds: {
        smallBlind: hand.smallBlind,
        bigBlind: hand.bigBlind,
        bigBlindAnte: hand.bigBlindAnte,
      },
      boards: hand.boards.map((board) => board.map(cardCode)),
      pots: hand.pots,
      awards: hand.awards,
      currentActorId: hand.betting?.currentActorId ?? null,
    } : null,
  };
}

function statusFor(runtime: OrchestratorRuntime): string {
  if (runtime.operationalStatus === "PAUSED_INFRA") return "PAUSED_INFRA";
  if (runtime.operationalStatus === "COMPLETED") return "COMPLETED";
  if (runtime.operationalStatus === "CANCELLED") return "CANCELLED";
  return runtime.operationalStatus === "READY" ? "READY" : "RUNNING";
}

function nextDecision(runtime: OrchestratorRuntime): PendingDecisionRequest | null {
  const hand = runtime.domain.currentHand;
  if (!hand) return null;
  const playerId = hand.betting?.currentActorId;
  if (!playerId) return null;
  const requestKind = "ACTION" as const;
  const id = randomUUID();
  return {
    id,
    handNo: hand.handNo,
    playerId,
    requestKind,
    promptHash: runtime.effectivePrompt.sha256,
    idempotencyKey: `${hand.handNo}:${requestKind}:${playerId}:${runtime.aggregateVersion + 1}`,
  };
}

function arenaEventsForTransition(transition: TournamentTransition, handNo: number | null): NewArenaEvent[] {
  return transition.events.flatMap((event) => tournamentEventToArenaEvents(event, handNo));
}

export class TournamentOrchestrator {
  readonly #store: PgEventStore;
  readonly #providers: ReadonlyMap<string, ModelProvider>;
  readonly #history: HistoryQueryService;
  readonly #decisionConfig: DecisionRunnerConfig;

  constructor(dependencies: OrchestratorDependencies) {
    this.#store = dependencies.eventStore;
    this.#providers = dependencies.providers;
    this.#history = new HistoryQueryService(dependencies.pool);
    this.#decisionConfig = dependencies.decisionConfig ?? defaultDecisionConfig;
  }

  async createAndStart(setup: ArenaTournamentSetup): Promise<OrchestratorRuntime> {
    const tournamentId = setup.tournamentId ?? randomUUID();
    const effectivePrompt = buildEffectiveSystemPrompt();
    const masterSeed = setup.masterSeed ?? randomBytes(32);
    if (masterSeed.byteLength !== 32) throw new Error("Tournament master seed must be 256 bits");
    for (const player of setup.tournament.players) {
      const providerId = setup.providerIdByPlayer[player.id];
      if (!providerId || !this.#providers.has(providerId)) {
        throw new Error(`No provider is registered for player ${player.id}`);
      }
    }
    let runtime: OrchestratorRuntime = {
      tournamentId,
      name: setup.name,
      rulesetVersion: setup.rulesetVersion,
      operationalStatus: "READY",
      aggregateVersion: 0,
      domain: createDomainTournament(setup.tournament),
      effectivePrompt,
      providerIdByPlayer: { ...setup.providerIdByPlayer },
      playerLabels: Object.fromEntries(
        setup.tournament.players.map((player) => [
          player.id,
          setup.playerLabels?.[player.id] ?? player.id,
        ]),
      ),
      masterSeedBase64: Buffer.from(masterSeed).toString("base64"),
      seedCommitment: seedCommitment(masterSeed, tournamentId, setup.rulesetVersion),
      seedRevealed: false,
      pendingDecisionId: null,
    };
    await this.#store.createTournament({
      id: tournamentId,
      name: setup.name,
      rulesetVersion: setup.rulesetVersion,
      configuration: {
        tournament: setup.tournament,
        providerIdByPlayer: setup.providerIdByPlayer,
        playerLabels: setup.playerLabels ?? {},
        promptVersion: effectivePrompt.version,
        managedByArena: setup.managedByArena === true,
      },
      promptHash: effectivePrompt.sha256,
    });
    runtime = await this.#append(runtime, [
      publicArenaEvent("TOURNAMENT_CONFIG_FROZEN", {
        promptHash: effectivePrompt.sha256,
        promptVersion: effectivePrompt.version,
        rulesetVersion: setup.rulesetVersion,
      }),
      publicArenaEvent("RANDOMNESS_COMMITTED", { commitment: runtime.seedCommitment }),
    ], {});
    return this.#advanceUntilDecision(runtime);
  }

  async recover(tournamentId: string): Promise<OrchestratorRuntime> {
    const recovered = await recoverAggregate<OrchestratorRuntime>(
      this.#store,
      tournamentId,
      () => { throw new Error("Tournament has no recovery snapshot"); },
      () => { throw new Error("Orchestrator snapshots must accompany every authoritative append"); },
    );
    return recovered.state;
  }

  async resume(runtime: OrchestratorRuntime): Promise<OrchestratorRuntime> {
    if (runtime.operationalStatus !== "PAUSED_INFRA" || !runtime.pendingDecisionId) {
      throw new Error("Tournament is not paused at a recoverable decision");
    }
    return this.#append(
      { ...runtime, operationalStatus: "RUNNING" },
      [publicArenaEvent("TOURNAMENT_RESUMED", {
        decisionId: runtime.pendingDecisionId,
      })],
      {},
    );
  }

  async pause(runtime: OrchestratorRuntime): Promise<OrchestratorRuntime> {
    if (runtime.operationalStatus !== "RUNNING" || !runtime.pendingDecisionId) {
      throw new Error("Tournament is not running at a pausable decision");
    }
    return this.#append(
      { ...runtime, operationalStatus: "PAUSED_INFRA" },
      [publicArenaEvent("TOURNAMENT_PAUSED_ADMIN", {
        decisionId: runtime.pendingDecisionId,
      })],
      {},
    );
  }

  async cancel(runtime: OrchestratorRuntime): Promise<OrchestratorRuntime> {
    if (runtime.operationalStatus === "COMPLETED" || runtime.operationalStatus === "CANCELLED") {
      throw new Error("Tournament is already terminal");
    }
    const pendingDecisionId = runtime.pendingDecisionId;
    return this.#append(
      {
        ...runtime,
        operationalStatus: "CANCELLED",
        seedRevealed: true,
        pendingDecisionId: null,
      },
      [
        publicArenaEvent("TOURNAMENT_CANCELLED", {}),
        publicArenaEvent("RANDOMNESS_REVEALED", { masterSeedBase64: runtime.masterSeedBase64 }),
      ],
      pendingDecisionId ? { cancelDecisionId: pendingDecisionId } : {},
    );
  }

  async runNextDecision(runtime: OrchestratorRuntime, workerId: string): Promise<OrchestratorRuntime> {
    if (runtime.operationalStatus !== "RUNNING" || !runtime.pendingDecisionId) {
      throw new Error("Tournament has no runnable decision");
    }
    const claimed = await this.#store.claimNextDecision(runtime.tournamentId, workerId, 30_000);
    if (!claimed || claimed.id !== runtime.pendingDecisionId) {
      throw new Error("Expected decision could not be claimed");
    }
    const hand = runtime.domain.currentHand;
    if (!hand || hand.handNo !== claimed.handNo) throw new Error("Decision hand does not match runtime");
    const providerId = runtime.providerIdByPlayer[claimed.playerId];
    const provider = providerId ? this.#providers.get(providerId) : undefined;
    if (!provider) throw new Error(`Provider is unavailable for ${claimed.playerId}`);

    const loaded = await this.#store.loadEvents(runtime.tournamentId, { includePrivate: true });
    const completedHandNos = new Set<number>(
      loaded.filter((item) => item.event.type === "HAND_COMPLETED" && item.event.handNo !== null)
        .map((item) => item.event.handNo!),
    );
    const currentHandEvents = projectArenaEvents(
      loaded.filter((item) => item.event.handNo === hand.handNo),
      {
        role: "MODEL_SELF",
        playerId: claimed.playerId,
        completedHandNos,
      },
    );
    const historyBudget = new HistoryBudget(this.#decisionConfig.history);
    const context = buildModelContext({
      tournamentId: runtime.tournamentId,
      rulesetVersion: runtime.rulesetVersion,
      promptVersion: runtime.effectivePrompt.version,
      state: runtime.domain,
      playerId: claimed.playerId,
      currentHandEvents,
      historyBudget: historyBudget.state,
    });
    const request: CanonicalModelRequest = {
      requestId: claimed.id,
      expectedOutput: "ACTION_OR_HISTORY",
      systemPrompt: runtime.effectivePrompt.text,
      systemPromptHash: runtime.effectivePrompt.sha256,
      userPayload: context,
      timeoutMs: ARENA_DECISION_TIMEOUT_MS,
    };
    const decision = await runModelDecision({
      provider,
      request,
      validateAction: (response) => toDomainAction(hand, response),
      fallbackAction: () => protocolFallbackAction(hand),
      executeHistoryQuery: (query) => this.#history.execute(
        runtime.tournamentId,
        hand.handNo,
        query,
      ),
    }, this.#decisionConfig);

    if (decision.status === "PAUSED_INFRA") {
      runtime = {
        ...runtime,
        operationalStatus: "PAUSED_INFRA",
      };
      return this.#append(runtime, [publicArenaEvent("TOURNAMENT_PAUSED_INFRA", {
        playerId: claimed.playerId,
        errorKind: decision.errorKind,
        attempts: decision.calls.length,
      })], {
        failDecisionInfrastructure: {
          id: claimed.id,
          workerId,
          errorClass: decision.errorKind,
        },
      });
    }

    const priorHandNo = hand.handNo;
    const command = { type: "ACTION" as const, playerId: claimed.playerId, action: decision.action };
    const transition = reduceTournament(runtime.domain, command);
    runtime = {
      ...runtime,
      domain: transition.state,
      pendingDecisionId: null,
      operationalStatus: transition.state.status === "COMPLETED" ? "COMPLETED" : "RUNNING",
      seedRevealed: transition.state.status === "COMPLETED",
    };
    const decisionSummary = decision.response?.decision_summary ?? null;
    const events = [
      publicArenaEvent("MODEL_DECISION_RECORDED", {
        playerId: claimed.playerId,
        requestKind: claimed.requestKind,
        usedFallback: decision.usedFallback,
        protocolFailures: decision.protocolFailures,
        providerCalls: decision.calls.length,
        providerMetrics: decision.calls.map((call) => ({
          outcome: call.outcome,
          errorKind: call.errorKind,
          latencyMs: call.latencyMs,
          usage: call.usage,
        })),
        decisionSummary,
      }, priorHandNo, claimed.playerId),
      ...arenaEventsForTransition(transition, priorHandNo),
    ];
    if (runtime.operationalStatus === "COMPLETED") {
      events.push(publicArenaEvent("RANDOMNESS_REVEALED", {
        masterSeedBase64: runtime.masterSeedBase64,
      }));
    }
    const pending = nextDecision(runtime);
    if (pending) runtime.pendingDecisionId = pending.id;
    runtime = await this.#append(runtime, events, {
      ...(pending ? { decisionRequest: pending } : {}),
      completeDecision: {
        id: claimed.id,
        workerId,
        finalResponse: {
          status: decision.status,
          usedFallback: decision.usedFallback,
          protocolFailures: decision.protocolFailures,
          response: decision.response,
        },
      },
    });
    return this.#advanceUntilDecision(runtime);
  }

  async #advanceUntilDecision(runtime: OrchestratorRuntime): Promise<OrchestratorRuntime> {
    let next = runtime;
    while (next.operationalStatus === "RUNNING" || next.operationalStatus === "READY") {
      if (next.pendingDecisionId || next.domain.status === "COMPLETED") return next;
      if (next.domain.currentHand) throw new Error("Active hand is missing its persisted decision request");
      const handNo = next.domain.completedHands + 1;
      const seed = Buffer.from(next.masterSeedBase64, "base64");
      const deck = new DeterministicRng(
        deriveSeed(seed, `tournament:${next.tournamentId}:hand:${handNo}`),
      ).shuffle(createDeck());
      const transition = startTournamentHand(next.domain, deck);
      next = {
        ...next,
        domain: transition.state,
        operationalStatus: transition.state.status === "COMPLETED" ? "COMPLETED" : "RUNNING",
        seedRevealed: transition.state.status === "COMPLETED",
      };
      const pending = nextDecision(next);
      if (pending) next.pendingDecisionId = pending.id;
      const events = arenaEventsForTransition(
        transition,
        transition.state.currentHand?.handNo ?? handNo,
      );
      if (next.operationalStatus === "COMPLETED") {
        events.push(publicArenaEvent("RANDOMNESS_REVEALED", {
          masterSeedBase64: next.masterSeedBase64,
        }));
      }
      next = await this.#append(
        next,
        events,
        pending ? { decisionRequest: pending } : {},
      );
      if (!pending && transition.state.status === "COMPLETED") return next;
    }
    return next;
  }

  async #append(
    runtime: OrchestratorRuntime,
    events: NewArenaEvent[],
    options: Pick<AppendEventsInput, "decisionRequest" | "completeDecision" | "failDecisionInfrastructure" | "cancelDecisionId">,
  ): Promise<OrchestratorRuntime> {
    const expectedVersion = runtime.aggregateVersion;
    const nextRuntime = {
      ...runtime,
      aggregateVersion: expectedVersion + events.length,
    };
    const snapshot = jsonSafe(nextRuntime);
    const result = await this.#store.append({
      tournamentId: runtime.tournamentId,
      expectedVersion,
      events,
      nextStatus: statusFor(nextRuntime),
      publicState: publicState(nextRuntime),
      snapshot: {
        publicState: publicState(nextRuntime),
        privateState: snapshot,
      },
      ...options,
    });
    return { ...nextRuntime, aggregateVersion: result.aggregateVersion };
  }
}

function publicArenaEvent(
  type: string,
  publicPayload: unknown,
  handNo: number | null = null,
  actorId: string | null = null,
): NewArenaEvent {
  return {
    type,
    actorId,
    handNo,
    publicPayload,
    privateVisibility: "NONE",
    privateOwnerId: null,
  };
}
