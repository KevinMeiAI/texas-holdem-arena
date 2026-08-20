import {
  DECISION_BRANCH_SNAPSHOT_VERSION,
  decisionBranchSnapshotV1Schema,
  pokerActionSchema,
  type AdminHandFork,
  type DecisionBranchActionHistoryItem,
  type DecisionBranchSnapshotV1,
  type DecisionBranchTarget,
  type ProviderBrand,
} from "../../../../../packages/contracts/src/index.js";
import { resolveProviderBrand } from "../../../../../packages/providers/src/provider-brand.js";

interface DecisionBranchIdentityPlayer {
  id: string;
  displayName: string;
  seat: number;
  competitorId: string | null;
  providerBrand: ProviderBrand | null;
}

export interface DecisionBranchIdentityContext {
  tournament: { id: string; name: string };
  players: DecisionBranchIdentityPlayer[];
}

export interface DecisionBranchProjectionInput {
  fork: AdminHandFork;
  arenaState: unknown;
  identity: DecisionBranchIdentityContext;
}

export class DecisionBranchProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DecisionBranchProjectionError";
  }
}

const ACTION_ORDER = ["fold", "check", "call", "bet", "raise", "all_in"] as const;
const STREETS = new Set(["PREFLOP", "FLOP", "TURN", "RIVER"]);
const CARD_CODE = /^[2-9TJQKA][cdhs]$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const parsed = record(item);
    return parsed ? [parsed] : [];
  }) : [];
}

function requiredNonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DecisionBranchProjectionError("SOURCE_CONTEXT_INCOMPLETE", `${field} must be a nonnegative integer`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = requiredNonnegativeInteger(value, field);
  if (parsed < 1) {
    throw new DecisionBranchProjectionError("SOURCE_CONTEXT_INCOMPLETE", `${field} must be positive`);
  }
  return parsed;
}

function optionalNonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function street(value: unknown): "PREFLOP" | "FLOP" | "TURN" | "RIVER" | null {
  return typeof value === "string" && STREETS.has(value)
    ? value as "PREFLOP" | "FLOP" | "TURN" | "RIVER"
    : null;
}

function cardCode(value: unknown): string | null {
  if (typeof value === "string") return CARD_CODE.test(value) ? value : null;
  const candidate = record(value);
  if (!candidate) return null;
  const rank = candidate.rank;
  const suit = candidate.suit;
  if (!Number.isInteger(rank) || typeof suit !== "string" || !/^[cdhs]$/.test(suit)) return null;
  const symbol = rank === 10 ? "T" : rank === 11 ? "J" : rank === 12 ? "Q"
    : rank === 13 ? "K" : rank === 14 ? "A" : String(rank);
  const code = `${symbol}${suit}`;
  return CARD_CODE.test(code) ? code : null;
}

function cards(value: unknown, maximum = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(cardCode)
    .filter((card): card is string => card !== null)
    .slice(0, maximum);
}

function positionByPlayer(arenaState: Record<string, unknown>): Map<string, string> {
  const positions = record(arenaState.positions);
  const result = new Map<string, string>();
  for (const entry of records(positions?.by_player)) {
    const playerId = optionalText(entry.player_id, 200);
    const position = optionalText(entry.position, 32);
    if (playerId && position) result.set(playerId, position);
  }
  return result;
}

function sourceBoard(arenaState: Record<string, unknown>): string[] {
  const direct = cards(arenaState.board);
  if (direct.length > 0) return direct;
  const boards = Array.isArray(arenaState.boards) ? arenaState.boards : [];
  return cards(boards[0]);
}

function compactActionHistory(arenaState: Record<string, unknown>, actionSequence: number) {
  const projected: DecisionBranchActionHistoryItem[] = [];
  for (const item of records(arenaState.action_history)) {
    const sequence = optionalNonnegativeInteger(item.sequence);
    if (sequence === null || sequence < 1 || sequence >= actionSequence) continue;
    const type = optionalText(item.type, 40);
    const common = {
      sequence,
      street: street(item.street),
      playerId: optionalText(item.player_id, 200),
      label: null as string | null,
      action: null as (typeof ACTION_ORDER)[number] | null,
      amount: null as number | null,
      amountTo: null as number | null,
      potAfter: optionalNonnegativeInteger(item.pot_after),
      stackAfter: optionalNonnegativeInteger(item.stack_after),
      cards: [] as string[],
    };
    if (type === "forced_bet") {
      projected.push({
        ...common,
        type: "FORCED_BET",
        label: optionalText(item.kind, 40),
        amount: optionalNonnegativeInteger(item.amount),
      });
    } else if (type === "street_started") {
      projected.push({
        ...common,
        type: "STREET_STARTED",
        playerId: optionalText(item.first_actor_id, 200),
      });
    } else if (type === "board_dealt") {
      projected.push({
        ...common,
        type: "BOARD_DEALT",
        cards: cards(item.cards),
      });
    } else if (type === "action") {
      const action = pokerActionSchema.safeParse(item.action);
      if (!action.success) continue;
      projected.push({
        ...common,
        type: "ACTION",
        action: action.data,
        label: optionalText(item.classification, 40),
        amount: optionalNonnegativeInteger(item.paid),
        amountTo: optionalNonnegativeInteger(item.amount_to),
      });
    } else if (type === "uncalled_bet_returned") {
      projected.push({
        ...common,
        type: "UNCALLED_BET_RETURNED",
        amount: optionalNonnegativeInteger(item.amount),
      });
    }
  }
  return projected.sort((left, right) => left.sequence - right.sequence).slice(-120);
}

function legacyActionHistory(arenaState: Record<string, unknown>, actionSequence: number) {
  const projected: DecisionBranchActionHistoryItem[] = [];
  for (const event of records(arenaState.current_hand_events)) {
    const sequence = optionalNonnegativeInteger(event.sequence);
    if (sequence === null || sequence < 1 || sequence >= actionSequence) continue;
    const type = optionalText(event.type, 80);
    const payload = record(event.publicPayload) ?? {};
    const actorId = optionalText(event.actorId, 200);
    const common = {
      sequence,
      street: street(payload.street),
      playerId: actorId,
      label: null as string | null,
      action: null as (typeof ACTION_ORDER)[number] | null,
      amount: null as number | null,
      amountTo: null as number | null,
      potAfter: null,
      stackAfter: null,
      cards: [] as string[],
    };
    if (type === "FORCED_BET_POSTED") {
      projected.push({
        ...common,
        type: "FORCED_BET",
        playerId: optionalText(payload.playerId, 200),
        label: optionalText(payload.kind, 40),
        amount: optionalNonnegativeInteger(payload.amount),
      });
    } else if (type === "BETTING_ROUND_STARTED") {
      projected.push({
        ...common,
        type: "STREET_STARTED",
        playerId: optionalText(payload.actorId, 200),
      });
    } else if (type === "STREET_DEALT") {
      projected.push({ ...common, type: "BOARD_DEALT", cards: cards(payload.cards) });
    } else if (type === "ACTION_APPLIED") {
      const command = record(payload.command);
      const action = pokerActionSchema.safeParse(command?.action);
      if (!action.success) continue;
      projected.push({
        ...common,
        type: "ACTION",
        action: action.data,
        label: optionalText(payload.classification, 40),
        amount: optionalNonnegativeInteger(payload.paid),
        amountTo: optionalNonnegativeInteger(payload.amountTo),
      });
    } else if (type === "UNCALLED_BET_RETURNED") {
      projected.push({
        ...common,
        type: "UNCALLED_BET_RETURNED",
        playerId: optionalText(payload.playerId, 200),
        amount: optionalNonnegativeInteger(payload.amount),
      });
    }
  }
  return projected.sort((left, right) => left.sequence - right.sequence).slice(-120);
}

function sourceActionHistory(arenaState: Record<string, unknown>, actionSequence: number) {
  return Array.isArray(arenaState.action_history)
    ? compactActionHistory(arenaState, actionSequence)
    : legacyActionHistory(arenaState, actionSequence);
}

function sourcePlayers(
  fork: AdminHandFork,
  arenaState: Record<string, unknown>,
  identity: DecisionBranchIdentityContext,
  bigBlind: number,
) {
  const hero = record(arenaState.hero);
  if (!hero || hero.player_id !== fork.source.playerId) {
    throw new DecisionBranchProjectionError("SOURCE_CONTEXT_MISMATCH", "Frozen arena state does not contain the source hero");
  }
  const collection = records(arenaState.opponents).length > 0
    ? records(arenaState.opponents)
    : records(arenaState.players).filter((player) => player.player_id !== fork.source.playerId);
  const rawPlayers = [hero, ...collection];
  const identityById = new Map(identity.players.map((player) => [player.id, player]));
  const positions = positionByPlayer(arenaState);
  const seen = new Set<string>();
  return rawPlayers.map((player) => {
    const playerId = optionalText(player.player_id, 200);
    if (!playerId || seen.has(playerId)) {
      throw new DecisionBranchProjectionError("SOURCE_CONTEXT_MISMATCH", "Frozen arena state contains duplicate or invalid players");
    }
    seen.add(playerId);
    if (playerId !== fork.source.playerId
      && (Object.hasOwn(player, "hole_cards") || Object.hasOwn(player, "holeCards"))) {
      throw new DecisionBranchProjectionError(
        "SOURCE_CONTEXT_UNSAFE",
        "Opponent hole cards cannot enter a public decision branch source",
      );
    }
    const publicIdentity = identityById.get(playerId);
    if (!publicIdentity) {
      throw new DecisionBranchProjectionError("PLAYER_IDENTITY_UNAVAILABLE", `No public identity is available for ${playerId}`);
    }
    const stack = requiredNonnegativeInteger(player.stack, `player ${playerId} stack`);
    return {
      playerId,
      displayName: publicIdentity.displayName,
      seat: requiredNonnegativeInteger(player.seat, `player ${playerId} seat`),
      position: playerId === fork.source.playerId
        ? fork.source.heroPosition
        : positions.get(playerId) ?? null,
      stack,
      stackBigBlinds: stack / bigBlind,
      streetCommitted: requiredNonnegativeInteger(
        player.street_committed ?? 0,
        `player ${playerId} street commitment`,
      ),
      totalCommitted: requiredNonnegativeInteger(
        player.total_committed ?? 0,
        `player ${playerId} total commitment`,
      ),
      folded: playerId === fork.source.playerId ? false : player.folded === true,
      allIn: playerId === fork.source.playerId ? false : player.all_in === true,
      competitorId: publicIdentity.competitorId,
      providerBrand: publicIdentity.providerBrand,
    };
  }).sort((left, right) => left.seat - right.seat);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function targetProjection(
  fork: AdminHandFork,
  target: AdminHandFork["targets"][number],
): DecisionBranchTarget {
  if (target.status !== "COMPLETED" || !target.summary || !target.trials) {
    throw new DecisionBranchProjectionError("FORK_INCOMPLETE", "Every published decision branch target must be complete");
  }
  const trials = [...target.trials].sort((left, right) => left.sampleIndex - right.sampleIndex);
  if (trials.length !== fork.sampleCount || trials.some((trial) => (
    trial.status !== "COMPLETED"
    || trial.outcome === null
    || trial.outcome === "CANCELLED"
    || trial.visibleInputHash !== fork.sourceIntegrity.visibleInputHash
  ))) {
    throw new DecisionBranchProjectionError(
      "FORK_INCOMPLETE",
      "Every published trial must be complete and use the frozen visible input",
    );
  }
  const publicTrials = trials.map((trial) => ({
    sampleIndex: trial.sampleIndex,
    outcome: trial.outcome!,
    action: trial.action,
    amountTo: trial.amountTo,
    decisionSummary: trial.outcome === "MODEL_ACTION"
      ? optionalText(trial.decisionSummary, 300)
      : null,
    usedFallback: trial.usedFallback,
  }));
  const modelActions = publicTrials.filter((trial) => trial.outcome === "MODEL_ACTION" && trial.action !== null);
  const counts = new Map<(typeof ACTION_ORDER)[number], number>();
  for (const trial of modelActions) counts.set(trial.action!, (counts.get(trial.action!) ?? 0) + 1);
  const actionDistribution = ACTION_ORDER.flatMap((action) => {
    const count = counts.get(action) ?? 0;
    return count === 0 ? [] : [{ action, count, share: count / modelActions.length }];
  });
  const modal = [...actionDistribution].sort((left, right) => (
    right.count - left.count || ACTION_ORDER.indexOf(left.action) - ACTION_ORDER.indexOf(right.action)
  ))[0] ?? null;
  const sizing = (["bet", "raise"] as const).flatMap((action) => {
    const values = modelActions.flatMap((trial) => trial.action === action && trial.amountTo !== null
      ? [trial.amountTo]
      : []);
    return values.length === 0 ? [] : [{
      action,
      count: values.length,
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
    }];
  });
  return {
    ordinal: target.ordinal,
    competitorId: target.competitorFamilyId,
    competitorRevisionId: target.competitorRevisionId,
    displayName: target.modelDisplayName,
    modelId: target.modelId,
    providerBrand: resolveProviderBrand({
      providerProfile: target.providerProfile,
      label: target.modelDisplayName,
      modelId: target.modelId,
    }),
    effectiveOutputMode: target.effectiveOutputMode,
    requestedSamples: target.sampleCount,
    completedTrials: target.summary.completedTrials,
    modelActionTrials: target.summary.modelActionTrials,
    fallbackTrials: target.summary.fallbackTrials,
    infrastructureErrorTrials: target.summary.infrastructureErrorTrials,
    modalAction: modal?.action ?? null,
    modalShare: modal ? modal.share : null,
    pairwiseAgreement: target.summary.pairwiseAgreement,
    firstTurnValidRate: target.summary.firstTurnValidRate,
    historyQueryRate: target.summary.historyQueryRate,
    correctionRate: target.summary.correctionRate,
    averageLatencyMs: target.summary.averageLatencyMs,
    p95LatencyMs: target.summary.p95LatencyMs,
    actionDistribution,
    sizing,
    trials: publicTrials,
  };
}

export function buildDecisionBranchSnapshot(
  input: DecisionBranchProjectionInput,
): DecisionBranchSnapshotV1 {
  const { fork, identity } = input;
  if (fork.status !== "COMPLETED" || !fork.completedAt) {
    throw new DecisionBranchProjectionError("FORK_INCOMPLETE", "Only a completed hand fork can become a public decision branch");
  }
  if (identity.tournament.id !== fork.source.tournamentId) {
    throw new DecisionBranchProjectionError("SOURCE_CONTEXT_MISMATCH", "Public identity belongs to another tournament");
  }
  const arenaState = record(input.arenaState);
  if (!arenaState
    || arenaState.tournament_id !== fork.source.tournamentId
    || arenaState.hand_no !== fork.source.handNo) {
    throw new DecisionBranchProjectionError("SOURCE_CONTEXT_MISMATCH", "Frozen arena state belongs to another decision");
  }
  const betting = record(arenaState.betting);
  const blinds = record(arenaState.blinds);
  if (!betting || betting.current_actor_id !== fork.source.playerId || !blinds) {
    throw new DecisionBranchProjectionError("SOURCE_CONTEXT_MISMATCH", "Frozen arena state is not anchored to the source actor");
  }
  const bigBlind = requiredPositiveInteger(blinds.big_blind, "big blind");
  const players = sourcePlayers(fork, arenaState, identity, bigBlind);
  const pot = record(arenaState.pot);
  const derivedPot = players.reduce((total, player) => total + player.totalCommitted, 0);
  const potBeforeAction = optionalNonnegativeInteger(pot?.total_before_action) ?? derivedPot;
  const callAmount = fork.source.legalActions.call?.amount ?? 0;
  const snapshot = {
    version: DECISION_BRANCH_SNAPSHOT_VERSION,
    source: {
      tournamentId: fork.source.tournamentId,
      tournamentName: fork.source.tournamentName,
      handNo: fork.source.handNo,
      actionSequence: fork.source.actionEventSequence,
      street: fork.source.street,
      heroPlayerId: fork.source.playerId,
      heroDisplayName: fork.source.playerDisplayName,
      heroPosition: fork.source.heroPosition,
      heroHoleCards: fork.source.holeCards,
      board: sourceBoard(arenaState),
      blinds: {
        smallBlind: requiredPositiveInteger(blinds.small_blind, "small blind"),
        bigBlind,
        bigBlindAnte: requiredNonnegativeInteger(blinds.big_blind_ante ?? 0, "big blind ante"),
      },
      potBeforeAction,
      potBigBlinds: potBeforeAction / bigBlind,
      currentBet: requiredNonnegativeInteger(betting.current_bet ?? 0, "current bet"),
      callAmount,
      legalActions: fork.source.legalActions,
      players,
      actionHistory: sourceActionHistory(arenaState, fork.source.actionEventSequence),
      originalDecision: {
        action: fork.source.originalAction,
        amountTo: fork.source.originalAmountTo,
        decisionSummary: optionalText(fork.source.originalDecisionSummary, 300),
        usedFallback: fork.source.originalUsedFallback,
      },
    },
    methodology: {
      scope: "DECISION_ONLY" as const,
      continuationSimulated: false as const,
      sameVisibleInput: true as const,
      sampleCountPerModel: fork.sampleCount,
      targetCount: fork.targets.length,
      createdAt: fork.createdAt,
      completedAt: fork.completedAt,
    },
    targets: [...fork.targets]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((target) => targetProjection(fork, target)),
  };
  return decisionBranchSnapshotV1Schema.parse(snapshot);
}
