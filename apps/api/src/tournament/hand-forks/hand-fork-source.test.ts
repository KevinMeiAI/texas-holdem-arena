import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  arenaOutputSchema,
  buildEffectiveSystemPrompt,
  decisionProtocolBundle,
  type CanonicalModelRequest,
  type LoadedArenaEvent,
  type StoredArenaEvent,
} from "../../../../../packages/contracts/src/index.js";
import { createDeck } from "../../../../../packages/domain/src/cards.js";
import { currentLegalActions } from "../../../../../packages/domain/src/reducer.js";
import { createTournament, startTournamentHand } from "../../../../../packages/domain/src/tournament.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import { GENESIS_EVENT_HASH, hashArenaEvent } from "../../../../../packages/fairness/src/event-hash.js";
import type { LoadedDecisionTurnRequest, LoadedSnapshot } from "../../persistence/event-store.js";
import { HistoryBudget } from "../history-budget.js";
import { buildModelContext } from "../model-context.js";
import type { OrchestratorRuntime } from "../orchestrator.js";
import { rulesetImplementation } from "../ruleset-registry.js";
import {
  HandForkSourceError,
  HandForkSourceResolver,
  type HandForkSourceStore,
} from "./hand-fork-source.js";

const tournamentId = "11111111-1111-4111-8111-111111111111";
const decisionId = "22222222-2222-4222-8222-222222222222";
const otherDecisionId = "33333333-3333-4333-8333-333333333333";
const expectedVersion = 10;

interface EventSpec {
  type: string;
  actorId?: string | null;
  handNo?: number | null;
  publicPayload?: unknown;
}

function hashedEvents(specs: readonly EventSpec[]): StoredArenaEvent[] {
  let previous = GENESIS_EVENT_HASH;
  return specs.map((spec, index) => {
    const sequence = index + 1;
    const hashable = {
      tournamentId,
      sequence,
      aggregateVersion: sequence,
      type: spec.type,
      actorId: spec.actorId ?? null,
      handNo: spec.handNo ?? null,
      publicPayload: spec.publicPayload ?? {},
      encryptedPrivatePayload: null,
      privateVisibility: "NONE" as const,
      privateOwnerId: null,
    };
    const eventHash = hashArenaEvent(hashable, previous);
    const event: StoredArenaEvent = {
      ...hashable,
      prevHash: previous,
      eventHash,
      createdAt: new Date(sequence * 1_000).toISOString(),
    };
    previous = eventHash;
    return event;
  });
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

interface FixtureOptions {
  pauseGap?: boolean;
  legacyDecisionEvent?: boolean;
  omitProtocolBundle?: boolean;
  afterBoundarySameActor?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const decisionConfig = {
    maxInfrastructureAttempts: 3,
    infrastructureRetryDelaysMs: [2_000, 8_000],
    history: { maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 },
  };
  const started = startTournamentHand(createTournament({
    seatCount: 2,
    players: [{ id: "hero", seat: 0 }, { id: "villain", seat: 1 }],
    initialStack: 100,
    initialButton: 0,
    handsPerLevel: 10,
    blindLevels: [{ smallBlind: 1, bigBlind: 2, bigBlindAnte: 0 }],
  }), createDeck());
  const domain = started.state;
  const hand = domain.currentHand!;
  const playerId = hand.betting!.currentActorId!;
  expect(playerId).toBe("hero");
  const protocolBundle = decisionProtocolBundle("arena-native-v11");
  const effectivePrompt = buildEffectiveSystemPrompt(protocolBundle.systemPromptVersion);
  const effectiveOutputSchema = arenaOutputSchema("ACTION_OR_HISTORY", protocolBundle.outputSchemaVersion);
  const rawArenaState = buildModelContext({
    tournamentId,
    rulesetVersion: "arena-rules-v2",
    promptVersion: effectivePrompt.version,
    contextVersion: protocolBundle.contextVersion,
    state: domain,
    playerId,
    currentHandEvents: [],
    historyBudget: new HistoryBudget(decisionConfig.history).state,
  }) as Record<string, unknown>;
  const request: CanonicalModelRequest = {
    requestId: decisionId,
    expectedOutput: "ACTION_OR_HISTORY",
    systemPrompt: effectivePrompt.text,
    systemPromptHash: effectivePrompt.sha256,
    outputSchema: effectiveOutputSchema,
    parserPolicy: protocolBundle.parserPolicyVersion,
    adapterProtocolVersion: protocolBundle.adapterProtocolVersion,
    userPayload: {
      arena_control: {
        mode: "decision",
        correction_attempt: 0,
        max_correction_attempts: 1,
        error_codes: [],
        history_budget_remaining: {
          queries: 2,
          approximate_tokens: 4_000,
          max_records_per_query: 80,
        },
      },
      arena_state: rawArenaState,
      history_results: [],
    },
    timeoutMs: 180_000,
  };
  const runtime: OrchestratorRuntime = {
    tournamentId,
    name: "Source tournament",
    rulesetVersion: "arena-rules-v2",
    protocolBundle,
    operationalStatus: "RUNNING",
    aggregateVersion: expectedVersion,
    domain,
    effectivePrompt,
    effectiveOutputSchema,
    providerIdByPlayer: { hero: "provider-1", villain: "provider-2" },
    playerLabels: { hero: "Hero model", villain: "Villain model" },
    masterSeedBase64: Buffer.alloc(32).toString("base64"),
    seedCommitment: "a".repeat(64),
    seedRevealed: false,
    pendingDecisionId: decisionId,
    decisionTimeoutMs: 180_000,
    decisionConfig,
  };
  if (options.omitProtocolBundle) delete (runtime as Partial<OrchestratorRuntime>).protocolBundle;

  const transition = rulesetImplementation("arena-rules-v2").reduce(domain, {
    type: "ACTION",
    playerId,
    action: { action: "call" },
  });
  const applied = transition.events.find((event) => event.type === "HAND_EVENT"
    && event.event.type === "ACTION_APPLIED");
  if (applied?.type !== "HAND_EVENT" || applied.event.type !== "ACTION_APPLIED") {
    throw new Error("Fixture action event is missing");
  }
  const { type: _type, playerId: _playerId, ...actionPayload } = applied.event;
  const specs: EventSpec[] = Array.from({ length: expectedVersion }, (_, index) => ({
    type: `SOURCE_PREFIX_${index + 1}`,
  }));
  if (options.pauseGap) {
    specs.push({ type: "TOURNAMENT_PAUSED_INFRA", publicPayload: { decisionId } });
    specs.push({ type: "TOURNAMENT_RESUMED", publicPayload: { decisionId } });
  }
  specs.push({
    type: "MODEL_DECISION_RECORDED",
    actorId: playerId,
    handNo: 1,
    publicPayload: {
      ...(options.legacyDecisionEvent ? {} : { decisionId }),
      playerId,
      requestKind: "ACTION",
      usedFallback: false,
      decisionSummary: "Match the blind-sized price.",
    },
  });
  specs.push({
    type: "ACTION_APPLIED",
    actorId: playerId,
    handNo: 1,
    publicPayload: actionPayload,
  });
  const sourceActionVersion = specs.length;
  if (options.afterBoundarySameActor) {
    specs.push({
      type: "MODEL_DECISION_RECORDED",
      actorId: playerId,
      handNo: 1,
      publicPayload: { playerId, usedFallback: false, decisionSummary: null },
    });
    specs.push({
      type: "ACTION_APPLIED",
      actorId: playerId,
      handNo: 1,
      publicPayload: actionPayload,
    });
  }
  specs.push({ type: "HAND_COMPLETED", handNo: 1, publicPayload: { result: {} } });
  specs.push({ type: "TOURNAMENT_COMPLETED", publicPayload: { championPlayerId: "hero" } });
  const events = hashedEvents(specs);
  const source: LoadedDecisionTurnRequest = {
    decisionId,
    tournamentId,
    tournamentName: "Source tournament",
    tournamentStatus: "COMPLETED",
    handNo: 1,
    playerId,
    expectedAggregateVersion: expectedVersion,
    nextExpectedAggregateVersion: sourceActionVersion,
    requestKind: "ACTION",
    decisionStatus: "SUCCEEDED",
    turnIndex: 1,
    requestHash: requestHash(request),
    request,
  };
  const snapshot: LoadedSnapshot = {
    tournamentId,
    eventSequence: expectedVersion,
    aggregateVersion: expectedVersion,
    publicState: {},
    privateState: runtime,
    checksum: "b".repeat(64),
  };
  const store: HandForkSourceStore = {
    loadDecisionTurnRequest: vi.fn(async () => source),
    loadSnapshotAtAggregateVersion: vi.fn(async () => snapshot),
    loadEvents: vi.fn(async () => events.map((event) => ({ event } satisfies LoadedArenaEvent))),
  };
  return { store, source, snapshot, request, rawArenaState, events, sourceActionVersion };
}

async function expectCode(promise: Promise<unknown>, code: HandForkSourceError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "HandForkSourceError", code });
}

describe("HandForkSourceResolver", () => {
  it("resolves a verified decision anchor to its raw model view and original action", async () => {
    const source = fixture();

    const resolved = await new HandForkSourceResolver(source.store).resolve(decisionId, {
      tournamentId,
      handNo: 1,
    });

    expect(resolved).toMatchObject({
      tournamentId,
      tournamentName: "Source tournament",
      decisionId,
      playerId: "hero",
      playerDisplayName: "Hero model",
      street: "PREFLOP",
      heroPosition: "BTN/SB",
      originalAction: "call",
      originalAmountTo: null,
      originalDecisionSummary: "Match the blind-sized price.",
      originalUsedFallback: false,
      actionEventSequence: source.sourceActionVersion,
      requestHash: source.source.requestHash,
      snapshotChecksum: source.snapshot.checksum,
      historyProtocolVersion: "arena-history-v2",
    });
    expect(resolved.baseRequest.userPayload).toEqual(source.rawArenaState);
    expect(record(resolved.baseRequest.userPayload)?.arena_state).toBeUndefined();
    expect(resolved.holeCards).toEqual(record(source.rawArenaState.hero)?.hole_cards);
  });

  it("allows pause and resume events between the expected version and the recorded decision", async () => {
    const source = fixture({ pauseGap: true });

    const resolved = await new HandForkSourceResolver(source.store).resolve(decisionId);

    expect(resolved.decisionEventSequence).toBe(expectedVersion + 3);
    expect(resolved.actionEventSequence).toBe(expectedVersion + 4);
  });

  it("uses the next expected-version boundary for legacy events with repeated same-actor decisions", async () => {
    const source = fixture({ legacyDecisionEvent: true, afterBoundarySameActor: true });

    const resolved = await new HandForkSourceResolver(source.store).resolve(decisionId);

    expect(resolved.actionEventSequence).toBe(source.sourceActionVersion);
  });

  it("rejects an ambiguous legacy boundary instead of guessing which decision belongs to the anchor", async () => {
    const source = fixture({ legacyDecisionEvent: true });
    const specs: EventSpec[] = source.events.map((event) => ({
      type: event.type,
      actorId: event.actorId,
      handNo: event.handNo,
      publicPayload: event.publicPayload,
    }));
    const actionPayload = source.events[source.sourceActionVersion - 1]!.publicPayload;
    specs.splice(expectedVersion, 0,
      {
        type: "MODEL_DECISION_RECORDED",
        actorId: "hero",
        handNo: 1,
        publicPayload: { playerId: "hero", usedFallback: false, decisionSummary: null },
      },
      { type: "ACTION_APPLIED", actorId: "hero", handNo: 1, publicPayload: actionPayload });
    source.source.nextExpectedAggregateVersion = expectedVersion + 4;
    source.store.loadEvents = vi.fn(async () => hashedEvents(specs).map((event) => ({ event })));

    await expectCode(
      new HandForkSourceResolver(source.store).resolve(decisionId),
      "SOURCE_CHAIN_MISMATCH",
    );
  });

  it("prefers an exact decisionId event over another legacy candidate in the same boundary", async () => {
    const source = fixture();
    const specs: EventSpec[] = source.events.map((event) => ({
      type: event.type,
      actorId: event.actorId,
      handNo: event.handNo,
      publicPayload: event.publicPayload,
    }));
    specs.splice(expectedVersion, 0,
      {
        type: "MODEL_DECISION_RECORDED",
        actorId: "hero",
        handNo: 1,
        publicPayload: { playerId: "hero", usedFallback: false, decisionSummary: null },
      },
      {
        type: "ACTION_APPLIED",
        actorId: "hero",
        handNo: 1,
        publicPayload: source.events[source.sourceActionVersion - 1]!.publicPayload,
      });
    source.source.nextExpectedAggregateVersion = expectedVersion + 4;
    source.store.loadEvents = vi.fn(async () => hashedEvents(specs).map((event) => ({ event })));

    const resolved = await new HandForkSourceResolver(source.store).resolve(decisionId);

    expect(resolved.decisionEventSequence).toBe(expectedVersion + 3);
  });

  it("reconstructs the frozen v10-compatible protocol when an old snapshot omitted protocolBundle", async () => {
    const source = fixture({ omitProtocolBundle: true });
    const runtime = source.snapshot.privateState as OrchestratorRuntime;
    const legacyPrompt = buildEffectiveSystemPrompt("arena-system-v10");
    const legacySchema = arenaOutputSchema("ACTION_OR_HISTORY", "arena-output-v2");
    runtime.effectivePrompt = legacyPrompt;
    runtime.effectiveOutputSchema = legacySchema;
    const request = source.request as CanonicalModelRequest;
    request.systemPrompt = legacyPrompt.text;
    request.systemPromptHash = legacyPrompt.sha256;
    request.outputSchema = legacySchema;
    delete request.parserPolicy;
    delete request.adapterProtocolVersion;
    const raw = record(record(request.userPayload)?.arena_state)!;
    raw.schema_version = "model-context-v3";
    raw.legal_actions = JSON.parse(JSON.stringify(currentLegalActions(runtime.domain.currentHand!)));
    request.userPayload = {
      arena_state: raw,
      history_results: [],
      history_budget_remaining: {
        queries: 2,
        approximate_tokens: 4_000,
        max_records_per_query: 80,
      },
    };

    const resolved = await new HandForkSourceResolver(source.store).resolve(decisionId);

    expect(resolved.protocolBundle.id).toBe("arena-native-v10");
    expect(resolved.historyProtocolVersion).toBe("arena-history-legacy-v1");
    expect(record(resolved.legalActions)?.allowed).toEqual(expect.arrayContaining(["fold", "call"]));
  });

  it("rejects first turns that already contain history or protocol correction", async () => {
    const historySource = fixture();
    const historyEnvelope = record((historySource.request as CanonicalModelRequest).userPayload)!;
    historyEnvelope.history_results = [{ records: [] }];
    await expectCode(
      new HandForkSourceResolver(historySource.store).resolve(decisionId),
      "DECISION_AUDIT_INCOMPLETE",
    );

    const correctionSource = fixture();
    const control = record(record((correctionSource.request as CanonicalModelRequest).userPayload)?.arena_control)!;
    control.mode = "protocol_correction";
    control.correction_attempt = 1;
    control.error_codes = ["INVALID_JSON"];
    await expectCode(
      new HandForkSourceResolver(correctionSource.store).resolve(decisionId),
      "DECISION_AUDIT_INCOMPLETE",
    );
  });

  it("rejects audit hashes, missing snapshots, broken chains, and missing adjacent actions", async () => {
    const auditSource = fixture();
    auditSource.store.loadDecisionTurnRequest = vi.fn(async () => {
      throw new Error("Decision request audit hash mismatch");
    });
    await expectCode(
      new HandForkSourceResolver(auditSource.store).resolve(decisionId),
      "DECISION_AUDIT_INCOMPLETE",
    );

    const snapshotSource = fixture();
    snapshotSource.store.loadSnapshotAtAggregateVersion = vi.fn(async () => null);
    await expectCode(
      new HandForkSourceResolver(snapshotSource.store).resolve(decisionId),
      "SOURCE_SNAPSHOT_MISSING",
    );

    const chainSource = fixture();
    const broken = structuredClone(chainSource.events);
    broken[4]!.eventHash = "f".repeat(64);
    chainSource.store.loadEvents = vi.fn(async () => broken.map((event) => ({ event })));
    await expectCode(
      new HandForkSourceResolver(chainSource.store).resolve(decisionId),
      "SOURCE_CHAIN_MISMATCH",
    );

    const adjacencySource = fixture();
    const specs: EventSpec[] = adjacencySource.events.map((event) => ({
      type: event.type,
      actorId: event.actorId,
      handNo: event.handNo,
      publicPayload: event.publicPayload,
    }));
    specs.splice(expectedVersion + 1, 0, { type: "TOURNAMENT_RESUMED" });
    adjacencySource.source.nextExpectedAggregateVersion = expectedVersion + 3;
    adjacencySource.store.loadEvents = vi.fn(async () => hashedEvents(specs).map((event) => ({ event })));
    await expectCode(
      new HandForkSourceResolver(adjacencySource.store).resolve(decisionId),
      "SOURCE_CHAIN_MISMATCH",
    );
  });

  it("rejects a broadcast-style opponent hole-card leak instead of accepting spectator input", async () => {
    const source = fixture();
    const raw = record(record((source.request as CanonicalModelRequest).userPayload)?.arena_state)!;
    const opponents = raw.opponents as Record<string, unknown>[];
    opponents[0]!.hole_cards = ["As", "Ad"];

    await expectCode(
      new HandForkSourceResolver(source.store).resolve(decisionId),
      "VISIBLE_INPUT_MISMATCH",
    );
  });
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
