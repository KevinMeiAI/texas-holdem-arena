import { createHash } from "node:crypto";
import type {
  CanonicalModelRequest,
  DecisionProtocolBundleDefinition,
  LoadedArenaEvent,
  StoredArenaEvent,
} from "../../../../../packages/contracts/src/index.js";
import { legacyDecisionProtocolBundle } from "../../../../../packages/contracts/src/index.js";
import { cardCode } from "../../../../../packages/domain/src/cards.js";
import type { ActionCommand, BettingAction, Street } from "../../../../../packages/domain/src/betting.js";
import { currentLegalActions, type HandState } from "../../../../../packages/domain/src/reducer.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import { verifyEventChain } from "../../../../../packages/fairness/src/event-hash.js";
import type {
  LoadedDecisionTurnRequest,
  LoadedSnapshot,
  PgEventStore,
} from "../../persistence/event-store.js";
import type { DecisionRunnerConfig } from "../decision-runner.js";
import type { OrchestratorRuntime } from "../orchestrator.js";
import { rulesetImplementation } from "../ruleset-registry.js";
import { toModelLegalActions } from "../model-legal-actions.js";

export type HandForkSourceErrorCode =
  | "SOURCE_NOT_FOUND"
  | "TOURNAMENT_NOT_COMPLETED"
  | "HAND_NOT_COMPLETED"
  | "DECISION_NOT_SUCCEEDED"
  | "DECISION_AUDIT_INCOMPLETE"
  | "SOURCE_SNAPSHOT_MISSING"
  | "SOURCE_CHAIN_MISMATCH"
  | "VISIBLE_INPUT_MISMATCH"
  | "LEGAL_CONTRACT_MISMATCH"
  | "SOURCE_PROTOCOL_UNSUPPORTED";

export class HandForkSourceError extends Error {
  constructor(
    readonly code: HandForkSourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HandForkSourceError";
  }
}

export interface HandForkSourceAssertions {
  tournamentId?: string;
  handNo?: number;
}

export interface HandForkResolvedSource {
  tournamentId: string;
  tournamentName: string;
  handNo: number;
  decisionId: string;
  expectedAggregateVersion: number;
  playerId: string;
  playerDisplayName: string;
  street: Street;
  heroPosition: string;
  holeCards: [string, string];
  legalActions: unknown;
  originalAction: BettingAction;
  originalAmountTo: number | null;
  originalDecisionSummary: string | null;
  originalUsedFallback: boolean;
  decisionEventSequence: number;
  actionEventSequence: number;
  sourceEventHash: string;
  requestHash: string;
  visibleInputHash: string;
  legalContractHash: string;
  snapshotChecksum: string;
  baseRequest: CanonicalModelRequest;
  decisionConfig: DecisionRunnerConfig;
  protocolBundle: DecisionProtocolBundleDefinition;
  historyProtocolVersion: DecisionProtocolBundleDefinition["historyProtocolVersion"];
  rulesetVersion: string;
}

export interface HandForkSourceStore {
  loadDecisionTurnRequest(
    decisionId: string,
    turnIndex: number,
  ): Promise<LoadedDecisionTurnRequest | null>;
  loadSnapshotAtAggregateVersion(
    tournamentId: string,
    aggregateVersion: number,
  ): Promise<LoadedSnapshot | null>;
  loadEvents(
    tournamentId: string,
    options?: { afterSequence?: number; includePrivate?: boolean },
  ): Promise<LoadedArenaEvent[]>;
}

const ACTIONS = new Set<BettingAction>(["fold", "check", "call", "bet", "raise", "all_in"]);
const STREETS = new Set<Street>(["PREFLOP", "FLOP", "TURN", "RIVER"]);
const FORBIDDEN_VISIBLE_KEYS = new Set([
  "apiKey",
  "broadcast",
  "burnCards",
  "deck",
  "encryptedPrivatePayload",
  "equity",
  "equityVersion",
  "estimated",
  "frozenModelConfigByPlayer",
  "masterSeed",
  "masterSeedBase64",
  "outrightWinProbability",
  "privatePayload",
  "samples",
  "tieProbability",
]);

function fail(code: HandForkSourceErrorCode, message: string, cause?: unknown): never {
  throw new HandForkSourceError(code, message, cause === undefined ? undefined : { cause });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rejectNonModelVisibleData(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectNonModelVisibleData);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, nested] of Object.entries(object)) {
    if (FORBIDDEN_VISIBLE_KEYS.has(key)) {
      fail("VISIBLE_INPUT_MISMATCH", `The audited model view contains forbidden spectator/private field: ${key}`);
    }
    rejectNonModelVisibleData(nested);
  }
}

function canonicalRequest(value: unknown, decisionId: string): CanonicalModelRequest {
  const request = record(value);
  if (!request
    || request.requestId !== decisionId
    || request.expectedOutput !== "ACTION_OR_HISTORY"
    || typeof request.systemPrompt !== "string"
    || typeof request.systemPromptHash !== "string"
    || !Number.isSafeInteger(request.timeoutMs)
    || Number(request.timeoutMs) < 1) {
    return fail("DECISION_AUDIT_INCOMPLETE", "The first audited turn is not a canonical action request");
  }
  if (createHash("sha256").update(request.systemPrompt, "utf8").digest("hex") !== request.systemPromptHash) {
    return fail("DECISION_AUDIT_INCOMPLETE", "The audited system prompt hash does not match its text");
  }
  return jsonValue(request) as unknown as CanonicalModelRequest;
}

function freshArenaState(
  request: CanonicalModelRequest,
  runtime: OrchestratorRuntime,
): Record<string, unknown> {
  const envelope = record(request.userPayload);
  if (!envelope || !Object.hasOwn(envelope, "arena_state")) {
    return fail("SOURCE_PROTOCOL_UNSUPPORTED", "The first audited request has no Arena feedback envelope");
  }
  const historyResults = envelope.history_results;
  if (!Array.isArray(historyResults) || historyResults.length > 0) {
    return fail("DECISION_AUDIT_INCOMPLETE", "A source decision with inherited history cannot be forked");
  }
  const control = record(envelope.arena_control);
  const strict = runtime.protocolBundle.parserPolicyVersion === "arena-parser-strict-v1";
  if (strict && !control) {
    return fail("SOURCE_PROTOCOL_UNSUPPORTED", "The strict first-turn request has no arena_control object");
  }
  if (!strict && control) {
    return fail("SOURCE_PROTOCOL_UNSUPPORTED", "The legacy first-turn request has an unsupported strict control envelope");
  }
  if (control) {
    const errorCodes = control.error_codes;
    if (control.mode !== "decision"
      || control.correction_attempt !== 0
      || !Array.isArray(errorCodes)
      || errorCodes.length > 0) {
      return fail("DECISION_AUDIT_INCOMPLETE", "A protocol-correction turn cannot be used as a fork source");
    }
  } else if (Object.hasOwn(envelope, "protocol_correction")) {
    return fail("DECISION_AUDIT_INCOMPLETE", "A legacy protocol-correction turn cannot be used as a fork source");
  }
  const historyBudget = record(runtime.decisionConfig?.history);
  const visibleBudget = record(control?.history_budget_remaining ?? envelope.history_budget_remaining);
  if (!historyBudget || !visibleBudget
    || visibleBudget.queries !== historyBudget.maxQueries
    || visibleBudget.approximate_tokens !== historyBudget.maxApproxTokens
    || visibleBudget.max_records_per_query !== historyBudget.maxRecordsPerQuery) {
    return fail("SOURCE_PROTOCOL_UNSUPPORTED", "The first-turn history budget is not the frozen source budget");
  }
  const arenaState = record(envelope.arena_state);
  if (!arenaState) {
    return fail("DECISION_AUDIT_INCOMPLETE", "The first audited request contains no object arena_state");
  }
  return arenaState;
}

function checkedRuntime(
  snapshot: LoadedSnapshot,
  source: LoadedDecisionTurnRequest,
): OrchestratorRuntime {
  const value = record(snapshot.privateState);
  const domain = record(value?.domain);
  const hand = record(domain?.currentHand);
  if (!value || !domain || !hand
    || value.tournamentId !== source.tournamentId
    || value.aggregateVersion !== source.expectedAggregateVersion
    || value.pendingDecisionId !== source.decisionId
    || hand.handNo !== source.handNo
    || record(hand.betting)?.currentActorId !== source.playerId) {
    return fail("SOURCE_CHAIN_MISMATCH", "The exact source snapshot does not describe this pending decision");
  }
  const protocol = record(value.protocolBundle);
  const prompt = record(value.effectivePrompt);
  const outputSchema = record(value.effectiveOutputSchema);
  const decisionConfig = record(value.decisionConfig);
  const history = record(decisionConfig?.history);
  if (!prompt || !outputSchema || !decisionConfig || !history
    || typeof value.rulesetVersion !== "string"
    || (protocol !== null && (typeof protocol.id !== "string"
      || typeof protocol.contextVersion !== "string"
      || typeof protocol.historyProtocolVersion !== "string"))
    || typeof prompt.version !== "string"
    || typeof prompt.text !== "string"
    || typeof prompt.sha256 !== "string"
    || typeof outputSchema.version !== "string") {
    return fail("SOURCE_PROTOCOL_UNSUPPORTED", "The source snapshot does not contain a frozen decision protocol");
  }
  let normalizedProtocol: Record<string, unknown> | DecisionProtocolBundleDefinition;
  try {
    normalizedProtocol = protocol ?? legacyDecisionProtocolBundle(prompt.version, outputSchema.version);
  } catch (error) {
    return fail("SOURCE_PROTOCOL_UNSUPPORTED", "The legacy source protocol cannot be reconstructed", error);
  }
  return {
    ...snapshot.privateState as OrchestratorRuntime,
    protocolBundle: normalizedProtocol as unknown as DecisionProtocolBundleDefinition,
  };
}

function verifyProtocol(
  request: CanonicalModelRequest,
  runtime: OrchestratorRuntime,
  arenaState: Record<string, unknown>,
): void {
  const schema = request.outputSchema;
  if (!schema
    || schema.version !== runtime.protocolBundle.outputSchemaVersion
    || request.systemPrompt !== runtime.effectivePrompt.text
    || request.systemPromptHash !== runtime.effectivePrompt.sha256
    || (request.parserPolicy !== runtime.protocolBundle.parserPolicyVersion
      && !(request.parserPolicy === undefined
        && runtime.protocolBundle.parserPolicyVersion === "arena-parser-legacy-v1"))
    || (request.adapterProtocolVersion !== runtime.protocolBundle.adapterProtocolVersion
      && !(request.adapterProtocolVersion === undefined
        && runtime.protocolBundle.adapterProtocolVersion === "arena-adapters-v1"))
    || arenaState.schema_version !== runtime.protocolBundle.contextVersion) {
    fail("SOURCE_PROTOCOL_UNSUPPORTED", "The audited request does not match the frozen source protocol");
  }
  if (schema.sha256 !== createHash("sha256").update(JSON.stringify(schema.schema), "utf8").digest("hex")
    || runtime.effectiveOutputSchema?.sha256 !== schema.sha256) {
    fail("SOURCE_PROTOCOL_UNSUPPORTED", "The frozen output schema hash is inconsistent");
  }
}

function checkedHandAndVisibleInput(
  runtime: OrchestratorRuntime,
  source: LoadedDecisionTurnRequest,
  arenaState: Record<string, unknown>,
): {
    hand: HandState;
    street: Street;
    heroPosition: string;
    holeCards: [string, string];
    legalActions: unknown;
  } {
  if (arenaState.tournament_id !== source.tournamentId || arenaState.hand_no !== source.handNo) {
    return fail("VISIBLE_INPUT_MISMATCH", "The audited arena_state identity does not match the decision anchor");
  }
  rejectNonModelVisibleData(arenaState);
  const hero = record(arenaState.hero);
  const betting = record(arenaState.betting);
  const positions = record(arenaState.positions);
  const hand = runtime.domain.currentHand;
  const handHero = hand?.players.find((player) => player.id === source.playerId);
  const holeCards = hero?.hole_cards;
  if (!hand || !handHero
    || hero?.player_id !== source.playerId
    || betting?.current_actor_id !== source.playerId
    || !Array.isArray(holeCards)
    || holeCards.length !== 2
    || !holeCards.every((card) => typeof card === "string")
    || canonicalJson(holeCards) !== canonicalJson(handHero.holeCards.map(cardCode))) {
    return fail("VISIBLE_INPUT_MISMATCH", "The audited model view does not match the pre-action hand snapshot");
  }
  for (const collection of [arenaState.players, arenaState.opponents]) {
    if (!Array.isArray(collection)) continue;
    for (const player of collection) {
      const candidate = record(player);
      if (candidate && (Object.hasOwn(candidate, "hole_cards") || Object.hasOwn(candidate, "holeCards"))) {
        return fail("VISIBLE_INPUT_MISMATCH", "A fork source cannot contain broadcast opponent hole cards");
      }
    }
  }
  const street = betting.street;
  if (typeof street !== "string" || !STREETS.has(street as Street)) {
    return fail("VISIBLE_INPUT_MISMATCH", "The audited model view has no valid betting street");
  }
  if (!Object.hasOwn(arenaState, "legal_actions")) {
    return fail("LEGAL_CONTRACT_MISMATCH", "The audited model view has no legal-action contract");
  }
  const legalActions = arenaState.legal_actions;
  const expectedDomainLegal = currentLegalActions(hand);
  const expectedModelLegal = toModelLegalActions(expectedDomainLegal);
  if (!expectedModelLegal) {
    return fail("LEGAL_CONTRACT_MISMATCH", "The source snapshot is not accepting a poker action");
  }
  const usesStrictContract = Array.isArray(record(legalActions)?.allowed);
  const expectedLegal = usesStrictContract ? expectedModelLegal : jsonValue(expectedDomainLegal);
  if (canonicalJson(legalActions) !== canonicalJson(expectedLegal)) {
    return fail("LEGAL_CONTRACT_MISMATCH", "The audited legal actions do not match the source snapshot");
  }
  return {
    hand,
    street: street as Street,
    heroPosition: typeof positions?.hero_position === "string" ? positions.hero_position : "UNKNOWN",
    holeCards: [holeCards[0] as string, holeCards[1] as string],
    legalActions: expectedModelLegal,
  };
}

function eventDecisionId(event: StoredArenaEvent): string | null {
  const value = record(event.publicPayload)?.decisionId;
  return typeof value === "string" ? value : null;
}

function sourceDecisionEvent(
  events: readonly StoredArenaEvent[],
  source: LoadedDecisionTurnRequest,
): StoredArenaEvent {
  const upperBound = source.nextExpectedAggregateVersion ?? events.at(-1)?.aggregateVersion ?? 0;
  const inBoundary = events.filter((event) => (
    event.aggregateVersion > source.expectedAggregateVersion
      && event.aggregateVersion <= upperBound
      && event.type === "MODEL_DECISION_RECORDED"
      && event.handNo === source.handNo
      && event.actorId === source.playerId
  ));
  const direct = events.filter((event) => event.type === "MODEL_DECISION_RECORDED"
    && eventDecisionId(event) === source.decisionId);
  if (direct.length > 0) {
    if (direct.length !== 1 || !inBoundary.includes(direct[0]!)) {
      return fail("SOURCE_CHAIN_MISMATCH", "The decisionId event anchor is not unique inside its version boundary");
    }
    return direct[0]!;
  }
  if (inBoundary.some((event) => eventDecisionId(event) !== null)) {
    return fail("SOURCE_CHAIN_MISMATCH", "The version boundary belongs to a different decisionId");
  }
  if (inBoundary.length !== 1) {
    return fail("SOURCE_CHAIN_MISMATCH", "Legacy decision events are missing or ambiguous inside the version boundary");
  }
  return inBoundary[0]!;
}

function checkedOriginalAction(
  events: readonly StoredArenaEvent[],
  decisionEvent: StoredArenaEvent,
  source: LoadedDecisionTurnRequest,
  runtime: OrchestratorRuntime,
): {
    actionEvent: StoredArenaEvent;
    action: ActionCommand;
    actionName: BettingAction;
    amountTo: number | null;
    summary: string | null;
    usedFallback: boolean;
  } {
  const index = events.indexOf(decisionEvent);
  const actionEvent = events[index + 1];
  if (!actionEvent
    || actionEvent.sequence !== decisionEvent.sequence + 1
    || actionEvent.type !== "ACTION_APPLIED"
    || actionEvent.handNo !== source.handNo
    || actionEvent.actorId !== source.playerId) {
    return fail("SOURCE_CHAIN_MISMATCH", "The source decision is not immediately followed by its action event");
  }
  const payload = record(actionEvent.publicPayload);
  const command = record(payload?.command);
  const actionName = command?.action;
  if (typeof actionName !== "string" || !ACTIONS.has(actionName as BettingAction)) {
    return fail("SOURCE_CHAIN_MISMATCH", "The source action event contains no valid poker action");
  }
  const amountTo = command?.amountTo;
  if ((actionName === "bet" || actionName === "raise")
    ? !Number.isSafeInteger(amountTo) || Number(amountTo) < 1
    : amountTo !== undefined) {
    return fail("SOURCE_CHAIN_MISMATCH", "The source action amount is malformed");
  }
  const action: ActionCommand = actionName === "bet" || actionName === "raise"
    ? { action: actionName, amountTo: Number(amountTo) }
    : { action: actionName as "fold" | "check" | "call" | "all_in" };
  let expectedPayload: unknown;
  try {
    const transition = rulesetImplementation(runtime.rulesetVersion).reduce(runtime.domain, {
      type: "ACTION",
      playerId: source.playerId,
      action,
    });
    const applied = transition.events.find((event) => event.type === "HAND_EVENT"
      && event.event.type === "ACTION_APPLIED");
    if (applied?.type !== "HAND_EVENT" || applied.event.type !== "ACTION_APPLIED") {
      return fail("SOURCE_CHAIN_MISMATCH", "The source ruleset did not produce an action event");
    }
    const { type: _type, playerId: _playerId, ...publicPayload } = applied.event;
    expectedPayload = publicPayload;
  } catch (error) {
    return fail("SOURCE_CHAIN_MISMATCH", "The persisted source action is not legal in its exact snapshot", error);
  }
  if (canonicalJson(payload) !== canonicalJson(expectedPayload)) {
    return fail("SOURCE_CHAIN_MISMATCH", "The persisted source action disagrees with the source ruleset");
  }
  const decisionPayload = record(decisionEvent.publicPayload);
  if (decisionPayload?.playerId !== source.playerId || decisionPayload.requestKind !== source.requestKind) {
    return fail("SOURCE_CHAIN_MISMATCH", "The source decision event does not match its request anchor");
  }
  const summary = decisionPayload?.decisionSummary;
  if (summary !== null && summary !== undefined && typeof summary !== "string") {
    return fail("SOURCE_CHAIN_MISMATCH", "The source decision summary is malformed");
  }
  if (typeof decisionPayload?.usedFallback !== "boolean") {
    return fail("SOURCE_CHAIN_MISMATCH", "The source fallback marker is missing");
  }
  return {
    actionEvent,
    action,
    actionName: actionName as BettingAction,
    amountTo: actionName === "bet" || actionName === "raise" ? Number(amountTo) : null,
    summary: typeof summary === "string" ? summary : null,
    usedFallback: decisionPayload.usedFallback,
  };
}

export class HandForkSourceResolver {
  constructor(private readonly store: HandForkSourceStore) {}

  async resolve(
    decisionId: string,
    assertions: HandForkSourceAssertions = {},
  ): Promise<HandForkResolvedSource> {
    let source: LoadedDecisionTurnRequest | null;
    try {
      source = await this.store.loadDecisionTurnRequest(decisionId, 1);
    } catch (error) {
      return fail("DECISION_AUDIT_INCOMPLETE", "The first decision turn could not be verified", error);
    }
    if (!source) return fail("SOURCE_NOT_FOUND", `Decision source not found: ${decisionId}`);
    if (assertions.tournamentId && assertions.tournamentId !== source.tournamentId) {
      return fail("SOURCE_CHAIN_MISMATCH", "The requested tournament does not own this decision");
    }
    if (assertions.handNo && assertions.handNo !== source.handNo) {
      return fail("SOURCE_CHAIN_MISMATCH", "The requested hand does not own this decision");
    }
    if (source.decisionStatus !== "SUCCEEDED") {
      return fail("DECISION_NOT_SUCCEEDED", "Only a successfully completed source decision can be forked");
    }
    if (source.requestKind !== "ACTION") {
      return fail("SOURCE_PROTOCOL_UNSUPPORTED", "Only action decision requests can be forked");
    }
    if (source.tournamentStatus !== "COMPLETED") {
      return fail("TOURNAMENT_NOT_COMPLETED", "Fork sources are available after the tournament completes");
    }
    let snapshot: LoadedSnapshot | null;
    try {
      snapshot = await this.store.loadSnapshotAtAggregateVersion(
        source.tournamentId,
        source.expectedAggregateVersion,
      );
    } catch (error) {
      return fail("SOURCE_SNAPSHOT_MISSING", "The exact pre-action snapshot could not be verified", error);
    }
    if (!snapshot) {
      return fail("SOURCE_SNAPSHOT_MISSING", "The exact pre-action snapshot is unavailable");
    }
    let loadedEvents: LoadedArenaEvent[];
    try {
      loadedEvents = await this.store.loadEvents(source.tournamentId);
    } catch (error) {
      return fail("SOURCE_CHAIN_MISMATCH", "The source event chain could not be loaded", error);
    }
    const events = loadedEvents.map(({ event }) => event);
    const chain = verifyEventChain(events);
    if (!chain.valid) {
      return fail(
        "SOURCE_CHAIN_MISMATCH",
        `The source event chain is invalid at sequence ${chain.errorSequence ?? "unknown"}`,
      );
    }
    const snapshotEvent = events.find((event) => event.aggregateVersion === snapshot.aggregateVersion);
    if (!snapshotEvent || snapshotEvent.sequence !== snapshot.eventSequence) {
      return fail("SOURCE_CHAIN_MISMATCH", "The source snapshot is not anchored to the verified event chain");
    }
    if (!events.some((event) => event.type === "HAND_COMPLETED" && event.handNo === source.handNo)) {
      return fail("HAND_NOT_COMPLETED", "Fork sources are available after the source hand completes");
    }
    if (!events.some((event) => event.type === "TOURNAMENT_COMPLETED")) {
      return fail("TOURNAMENT_NOT_COMPLETED", "The source event chain has no tournament completion event");
    }

    const runtime = checkedRuntime(snapshot, source);
    const request = canonicalRequest(source.request, source.decisionId);
    const arenaState = freshArenaState(request, runtime);
    verifyProtocol(request, runtime, arenaState);
    const visible = checkedHandAndVisibleInput(runtime, source, arenaState);
    const decisionEvent = sourceDecisionEvent(events, source);
    const original = checkedOriginalAction(events, decisionEvent, source, runtime);
    const baseRequest: CanonicalModelRequest = {
      ...request,
      userPayload: jsonValue(arenaState),
    };
    return {
      tournamentId: source.tournamentId,
      tournamentName: source.tournamentName,
      handNo: source.handNo,
      decisionId: source.decisionId,
      expectedAggregateVersion: source.expectedAggregateVersion,
      playerId: source.playerId,
      playerDisplayName: runtime.playerLabels[source.playerId] ?? source.playerId,
      street: visible.street,
      heroPosition: visible.heroPosition,
      holeCards: visible.holeCards,
      legalActions: jsonValue(visible.legalActions),
      originalAction: original.actionName,
      originalAmountTo: original.amountTo,
      originalDecisionSummary: original.summary,
      originalUsedFallback: original.usedFallback,
      decisionEventSequence: decisionEvent.sequence,
      actionEventSequence: original.actionEvent.sequence,
      sourceEventHash: original.actionEvent.eventHash,
      requestHash: source.requestHash,
      visibleInputHash: canonicalHash(arenaState),
      legalContractHash: canonicalHash(visible.legalActions),
      snapshotChecksum: snapshot.checksum,
      baseRequest,
      decisionConfig: jsonValue(runtime.decisionConfig!),
      protocolBundle: jsonValue(runtime.protocolBundle),
      historyProtocolVersion: runtime.protocolBundle.historyProtocolVersion,
      rulesetVersion: runtime.rulesetVersion,
    };
  }
}

export function handForkSourceResolver(store: PgEventStore): HandForkSourceResolver {
  return new HandForkSourceResolver(store);
}
