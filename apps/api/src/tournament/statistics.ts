import { cardCode, createDeck, type Card } from "../../../../packages/domain/src/cards.js";
import { compareHandRanks, evaluateBest } from "../../../../packages/domain/src/evaluator.js";
import { awardPots, buildPots } from "../../../../packages/domain/src/pots.js";
import type { ProviderBrand } from "../../../../packages/providers/src/provider-brand.js";
import { chooseCount, exactRunouts, sampledRunouts, stringSeed } from "./runout-enumeration.js";

export interface StatisticsEvent {
  sequence: number;
  type: string;
  actorId: string | null;
  handNo: number | null;
  publicPayload: unknown;
  privatePayload?: unknown;
}

export interface StatisticsPlayerState {
  id: string;
  displayName: string;
  seat: number;
  stack: number;
  finishingPosition: number | null;
}

export interface StatisticsTournamentState {
  tournamentId: string;
  completedHands: number;
  championPlayerId: string | null;
  players: StatisticsPlayerState[];
}

export interface TournamentPlayerStatistics {
  playerId: string;
  displayName: string;
  seat: number;
  finishingPosition: number | null;
  knockouts: number;
  handsPlayed: number;
  potsWon: number;
  chipLeadHands: number;
  chipLeadRate: number;
  peakStack: number;
  peakStackBigBlinds: number;
  lowestPositiveStackBigBlinds: number | null;
  netBigBlinds: number;
  vpipHands: number;
  vpipRate: number;
  pfrHands: number;
  pfrRate: number;
  threeBetHands: number;
  threeBetOpportunities: number;
  threeBetRate: number;
  showdownHands: number;
  showdownWins: number;
  showdownWinRate: number | null;
  allInHands: number;
  allInWins: number;
  allInWinRate: number | null;
  allInExpectedBigBlinds: number;
  allInActualBigBlinds: number;
  allInLuckBigBlinds: number;
  allInEstimatedHands: number;
  decisions: number;
  validDecisions: number;
  validDecisionRate: number | null;
  firstPassDecisions: number;
  firstPassRate: number | null;
  providerCalls: number;
  infrastructureRetries: number;
  protocolCorrections: number;
  timeouts: number;
  fallbacks: number;
  infrastructurePauses: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenUsageCoverage: number;
}

export interface TournamentStatistics {
  tournamentId: string;
  completedHands: number;
  initialStack: number;
  totalChips: number;
  players: TournamentPlayerStatistics[];
  methodology: {
    chipPerformance: string;
    allInEquity: string;
    threeBet: string;
    validDecision: string;
    firstPass: string;
    monetaryCost: string;
  };
}

export interface TournamentStatisticsComputation {
  statistics: TournamentStatistics;
  internals: Record<string, { latencySamplesMs: number[] }>;
}

export interface TournamentStatisticsOptions {
  includeAllInEquity?: boolean;
}

interface MutablePlayerStatistics extends TournamentPlayerStatistics {
  latencySamplesMs: number[];
  knownUsageCalls: number;
  measuredProviderCalls: number;
}

interface PlayerHandLedger {
  playerId: string;
  seat: number;
  stack: number;
  liveCommitted: number;
  deadCommitted: number;
  folded: boolean;
}

interface AllInEquityResult {
  playerIds: string[];
  expectedAwards: Record<string, number>;
  actualAwards: Record<string, number>;
  estimated: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function nullableRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? null;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function cardFromUnknown(value: unknown): Card | null {
  const card = recordValue(value);
  const rank = safeInteger(card?.rank);
  const suit = stringValue(card?.suit);
  if (!rank || rank < 2 || rank > 14 || !suit || !["c", "d", "h", "s"].includes(suit)) return null;
  return { rank: rank as Card["rank"], suit: suit as Card["suit"] };
}

function eventHandNo(event: StatisticsEvent): number | null {
  if (event.handNo !== null) return event.handNo;
  if (event.type !== "BLIND_LEVEL_SELECTED") return null;
  return safeInteger(recordValue(event.publicPayload)?.handNo);
}

function stacksFromCompletedHand(events: readonly StatisticsEvent[]): Record<string, number> | null {
  const completed = events.find((event) => event.type === "HAND_COMPLETED");
  const result = recordValue(recordValue(completed?.publicPayload)?.result);
  const stacks = recordValue(result?.stacks);
  if (!stacks) return null;
  return Object.fromEntries(Object.entries(stacks).flatMap(([playerId, value]) => {
    const stack = safeInteger(value);
    return stack !== null && stack >= 0 ? [[playerId, stack]] : [];
  }));
}

function blindForHand(events: readonly StatisticsEvent[]): number {
  const selected = events.find((event) => event.type === "BLIND_LEVEL_SELECTED");
  const level = recordValue(recordValue(selected?.publicPayload)?.level);
  return Math.max(1, safeInteger(level?.bigBlind) ?? 1);
}

function privateHoleCards(event: StatisticsEvent): Card[] {
  const cards = recordValue(event.privatePayload)?.cards;
  return Array.isArray(cards) ? cards.map(cardFromUnknown).filter((card): card is Card => card !== null) : [];
}

function publicPlayerId(event: StatisticsEvent): string | null {
  return event.actorId ?? stringValue(recordValue(event.publicPayload)?.playerId);
}

function allInEquity(
  handNo: number,
  events: readonly StatisticsEvent[],
  startingStacks: Readonly<Record<string, number>>,
  seats: Readonly<Record<string, number>>,
): AllInEquityResult | null {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const lastActionIndex = ordered.findLastIndex((event) => event.type === "ACTION_APPLIED");
  const firstBoardIndex = ordered.findIndex((event) => event.type === "STREET_DEALT");
  const lockIndex = lastActionIndex >= 0
    ? lastActionIndex
    : firstBoardIndex >= 0
      ? firstBoardIndex - 1
      : ordered.length - 1;
  if (lockIndex < 0) return null;

  const holeCards = new Map<string, Card[]>();
  for (const event of ordered) {
    if (event.type !== "HOLE_CARDS_DEALT") continue;
    const playerId = publicPlayerId(event);
    const cards = privateHoleCards(event);
    if (playerId && cards.length === 2) holeCards.set(playerId, cards);
  }
  const ledger = new Map<string, PlayerHandLedger>();
  for (const playerId of holeCards.keys()) {
    ledger.set(playerId, {
      playerId,
      seat: seats[playerId] ?? 0,
      stack: startingStacks[playerId] ?? 0,
      liveCommitted: 0,
      deadCommitted: 0,
      folded: false,
    });
  }
  const knownBoard: Card[] = [];
  for (const [index, event] of ordered.entries()) {
    if (index > lockIndex) break;
    const payload = recordValue(event.publicPayload);
    if (event.type === "FORCED_BET_POSTED") {
      const playerId = stringValue(payload?.playerId);
      const player = playerId ? ledger.get(playerId) : null;
      const amount = Math.max(0, safeInteger(payload?.amount) ?? 0);
      if (!player) continue;
      player.stack = Math.max(0, player.stack - amount);
      if (payload?.live === true) player.liveCommitted += amount;
      else player.deadCommitted += amount;
    }
    if (event.type === "ACTION_APPLIED") {
      const player = event.actorId ? ledger.get(event.actorId) : null;
      const amount = Math.max(0, safeInteger(payload?.paid) ?? 0);
      if (!player) continue;
      player.stack = Math.max(0, player.stack - amount);
      player.liveCommitted += amount;
      if (payload?.classification === "fold") player.folded = true;
    }
    if (event.type === "STREET_DEALT") {
      const cards = payload?.cards;
      if (Array.isArray(cards)) knownBoard.push(...cards.map(cardFromUnknown).filter((card): card is Card => card !== null));
    }
  }

  const contenders = [...ledger.values()].filter((player) => !player.folded);
  if (contenders.length < 2
    || !contenders.some((player) => player.stack === 0)
    || contenders.filter((player) => player.stack > 0).length > 1
    || contenders.some((player) => (holeCards.get(player.playerId)?.length ?? 0) !== 2)) {
    return null;
  }
  const built = buildPots([...ledger.values()].map((player) => ({
    playerId: player.playerId,
    seat: player.seat,
    amount: player.liveCommitted,
    deadAmount: player.deadCommitted,
    folded: player.folded,
  })));
  if (built.pots.length === 0) return null;

  const visibleCodes = new Set([
    ...knownBoard.map(cardCode),
    // Folded hole cards remain dead cards. They are hidden from opponents but
    // are known to the post-tournament audit and must never re-enter a runout.
    ...[...holeCards.values()].flat().map(cardCode),
  ]);
  const deck = createDeck().filter((card) => !visibleCodes.has(cardCode(card)));
  const cardsNeeded = 5 - knownBoard.length;
  if (cardsNeeded < 0 || cardsNeeded > deck.length) return null;
  const expectedAwards = Object.fromEntries(contenders.map((player) => [player.playerId, 0]));
  const combinations = chooseCount(deck.length, cardsNeeded);
  const exact = combinations <= 25_000;
  const iterations = exact ? Math.max(1, combinations) : 10_000;
  let visited = 0;
  const visit = (runout: Card[]) => {
    const board = [...knownBoard, ...runout];
    const ranked = contenders.map((player) => ({
      playerId: player.playerId,
      seat: player.seat,
      rank: evaluateBest([...(holeCards.get(player.playerId) ?? []), ...board]),
    }));
    const awards = awardPots(
      built.pots,
      ranked,
      (left, right) => compareHandRanks(left as ReturnType<typeof evaluateBest>, right as ReturnType<typeof evaluateBest>),
      safeInteger(recordValue(recordValue(ordered.find((event) => event.type === "HAND_STARTED")?.publicPayload)?.positions)?.button) ?? 0,
      Math.max(2, Object.keys(seats).length),
    );
    for (const award of awards) expectedAwards[award.playerId] = (expectedAwards[award.playerId] ?? 0) + award.amount;
    visited += 1;
  };
  if (cardsNeeded === 0) visit([]);
  else if (exact) exactRunouts(deck, cardsNeeded, visit);
  else sampledRunouts(deck, cardsNeeded, iterations, stringSeed(`${handNo}:${contenders.map((player) => player.playerId).join(":")}`), visit);
  if (visited === 0) return null;
  for (const playerId of Object.keys(expectedAwards)) expectedAwards[playerId] = expectedAwards[playerId]! / visited;

  const actualAwards: Record<string, number> = Object.fromEntries(contenders.map((player) => [player.playerId, 0]));
  for (const event of ordered) {
    if (event.type !== "POT_AWARDED") continue;
    const award = recordValue(recordValue(event.publicPayload)?.award);
    const playerId = stringValue(award?.playerId);
    const amount = Math.max(0, safeInteger(award?.amount) ?? 0);
    if (playerId && playerId in actualAwards) actualAwards[playerId] = (actualAwards[playerId] ?? 0) + amount;
  }
  return {
    playerIds: contenders.map((player) => player.playerId),
    expectedAwards,
    actualAwards,
    estimated: !exact,
  };
}

function emptyPlayer(player: StatisticsPlayerState, initialStack: number): MutablePlayerStatistics {
  return {
    playerId: player.id,
    displayName: player.displayName,
    seat: player.seat,
    finishingPosition: player.finishingPosition,
    knockouts: 0,
    handsPlayed: 0,
    potsWon: 0,
    chipLeadHands: 0,
    chipLeadRate: 0,
    peakStack: initialStack,
    peakStackBigBlinds: 0,
    lowestPositiveStackBigBlinds: null,
    netBigBlinds: 0,
    vpipHands: 0,
    vpipRate: 0,
    pfrHands: 0,
    pfrRate: 0,
    threeBetHands: 0,
    threeBetOpportunities: 0,
    threeBetRate: 0,
    showdownHands: 0,
    showdownWins: 0,
    showdownWinRate: null,
    allInHands: 0,
    allInWins: 0,
    allInWinRate: null,
    allInExpectedBigBlinds: 0,
    allInActualBigBlinds: 0,
    allInLuckBigBlinds: 0,
    allInEstimatedHands: 0,
    decisions: 0,
    validDecisions: 0,
    validDecisionRate: null,
    firstPassDecisions: 0,
    firstPassRate: null,
    providerCalls: 0,
    infrastructureRetries: 0,
    protocolCorrections: 0,
    timeouts: 0,
    fallbacks: 0,
    infrastructurePauses: 0,
    averageLatencyMs: null,
    p95LatencyMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    tokenUsageCoverage: 0,
    latencySamplesMs: [],
    knownUsageCalls: 0,
    measuredProviderCalls: 0,
  };
}

export function calculateTournamentStatistics(
  state: StatisticsTournamentState,
  events: readonly StatisticsEvent[],
  options: TournamentStatisticsOptions = {},
): TournamentStatisticsComputation {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const grouped = new Map<number, StatisticsEvent[]>();
  for (const event of ordered) {
    const handNo = eventHandNo(event);
    if (handNo === null) continue;
    const hand = grouped.get(handNo) ?? [];
    hand.push(event);
    grouped.set(handNo, hand);
  }
  const firstCompletedStacks = [...grouped.entries()].sort(([left], [right]) => left - right)
    .map(([, handEvents]) => stacksFromCompletedHand(handEvents))
    .find((stacks) => stacks !== null) ?? {};
  const totalChips = Object.values(firstCompletedStacks).reduce((sum, stack) => sum + stack, 0)
    || state.players.reduce((sum, player) => sum + player.stack, 0);
  const initialStack = state.players.length > 0 ? totalChips / state.players.length : 0;
  const metrics = new Map(state.players.map((player) => [player.id, emptyPlayer(player, initialStack)]));
  const seats = Object.fromEntries(state.players.map((player) => [player.id, player.seat]));
  const stacks: Record<string, number> = Object.fromEntries(state.players.map((player) => [player.id, initialStack]));

  for (const [handNo, handEvents] of [...grouped.entries()].sort(([left], [right]) => left - right)) {
    const endStacks = stacksFromCompletedHand(handEvents);
    if (!endStacks) continue;
    const bigBlind = blindForHand(handEvents);
    const startingStacks = { ...stacks };
    const participants = new Set(handEvents
      .filter((event) => event.type === "HOLE_CARDS_DEALT")
      .map(publicPlayerId)
      .filter((playerId): playerId is string => playerId !== null));
    const preflopActions = handEvents.filter((event) => (
      event.type === "ACTION_APPLIED" && recordValue(event.publicPayload)?.street === "PREFLOP"
    ));
    let preflopRaiseCount = 0;
    const vpipPlayers = new Set<string>();
    const pfrPlayers = new Set<string>();
    const threeBetPlayers = new Set<string>();
    const threeBetOpportunityPlayers = new Set<string>();
    for (const event of preflopActions) {
      const playerId = event.actorId;
      const payload = recordValue(event.publicPayload);
      const classification = stringValue(payload?.classification);
      const paid = Math.max(0, safeInteger(payload?.paid) ?? 0);
      if (!playerId) continue;
      if (preflopRaiseCount === 1) threeBetOpportunityPlayers.add(playerId);
      if (paid > 0 && classification !== "fold" && classification !== "check") vpipPlayers.add(playerId);
      if (["bet", "raise", "short_raise"].includes(classification ?? "")) {
        if (preflopRaiseCount === 1) threeBetPlayers.add(playerId);
        pfrPlayers.add(playerId);
        preflopRaiseCount += 1;
      }
    }
    const showdownPlayers = new Set<string>();
    const showdown = handEvents.find((event) => event.type === "SHOWDOWN_REVEALED");
    const revealed = recordValue(showdown?.publicPayload)?.players;
    if (Array.isArray(revealed)) {
      for (const value of revealed) {
        const playerId = stringValue(recordValue(value)?.playerId);
        if (playerId) showdownPlayers.add(playerId);
      }
    }
    const awards = handEvents.filter((event) => event.type === "POT_AWARDED").flatMap((event) => {
      const award = recordValue(recordValue(event.publicPayload)?.award);
      const playerId = stringValue(award?.playerId);
      const potIndex = safeInteger(award?.potIndex);
      const amount = safeInteger(award?.amount);
      return playerId && potIndex !== null && amount !== null ? [{ playerId, potIndex, amount }] : [];
    });
    const awardWinners = new Set(awards.map((award) => award.playerId));
    const wonPots = new Set(awards.map((award) => `${award.playerId}:${award.potIndex}`));
    for (const key of wonPots) {
      const playerId = key.split(":")[0]!;
      const metric = metrics.get(playerId);
      if (metric) metric.potsWon += 1;
    }

    const pots = handEvents.filter((event) => event.type === "POT_CREATED").flatMap((event) => {
      const pot = recordValue(recordValue(event.publicPayload)?.pot);
      const index = safeInteger(pot?.index);
      const contributors = pot?.contributors;
      return index !== null && Array.isArray(contributors)
        ? [{ index, contributors: contributors.filter((value): value is string => typeof value === "string") }]
        : [];
    });
    const eliminated = handEvents.filter((event) => event.type === "PLAYER_ELIMINATED")
      .map((event) => event.actorId)
      .filter((playerId): playerId is string => playerId !== null);
    for (const eliminatedId of eliminated) {
      const relevantPots = new Set(pots.filter((pot) => pot.contributors.includes(eliminatedId)).map((pot) => pot.index));
      const winners = [...new Set(awards.filter((award) => relevantPots.has(award.potIndex)).map((award) => award.playerId))];
      for (const winner of winners) {
        const metric = metrics.get(winner);
        if (metric) metric.knockouts += 1 / winners.length;
      }
    }

    const equity = options.includeAllInEquity === false
      ? null
      : allInEquity(handNo, handEvents, startingStacks, seats);
    for (const playerId of participants) {
      const metric = metrics.get(playerId);
      if (!metric) continue;
      metric.handsPlayed += 1;
      metric.peakStackBigBlinds = Math.max(metric.peakStackBigBlinds, (startingStacks[playerId] ?? 0) / bigBlind);
      if (vpipPlayers.has(playerId)) metric.vpipHands += 1;
      if (pfrPlayers.has(playerId)) metric.pfrHands += 1;
      if (threeBetPlayers.has(playerId)) metric.threeBetHands += 1;
      if (threeBetOpportunityPlayers.has(playerId)) metric.threeBetOpportunities += 1;
      if (showdownPlayers.has(playerId)) {
        metric.showdownHands += 1;
        if (awardWinners.has(playerId)) metric.showdownWins += 1;
      }
      const endStack = endStacks[playerId] ?? 0;
      metric.netBigBlinds += (endStack - (startingStacks[playerId] ?? 0)) / bigBlind;
      metric.peakStack = Math.max(metric.peakStack, endStack);
      metric.peakStackBigBlinds = Math.max(metric.peakStackBigBlinds, endStack / bigBlind);
      if (endStack > 0) {
        const stackBigBlinds = endStack / bigBlind;
        metric.lowestPositiveStackBigBlinds = metric.lowestPositiveStackBigBlinds === null
          ? stackBigBlinds
          : Math.min(metric.lowestPositiveStackBigBlinds, stackBigBlinds);
      }
    }
    if (equity) {
      for (const playerId of equity.playerIds) {
        const metric = metrics.get(playerId);
        if (!metric) continue;
        metric.allInHands += 1;
        if ((equity.actualAwards[playerId] ?? 0) > 0) metric.allInWins += 1;
        metric.allInExpectedBigBlinds += (equity.expectedAwards[playerId] ?? 0) / bigBlind;
        metric.allInActualBigBlinds += (equity.actualAwards[playerId] ?? 0) / bigBlind;
        metric.allInLuckBigBlinds += ((equity.actualAwards[playerId] ?? 0) - (equity.expectedAwards[playerId] ?? 0)) / bigBlind;
        if (equity.estimated) metric.allInEstimatedHands += 1;
      }
    }
    for (const [playerId, stack] of Object.entries(endStacks)) stacks[playerId] = stack;
    const lead = Math.max(...Object.values(stacks));
    for (const [playerId, stack] of Object.entries(stacks)) {
      if (stack === lead) {
        const metric = metrics.get(playerId);
        if (metric) metric.chipLeadHands += 1;
      }
    }
  }

  for (const event of ordered) {
    const payload = recordValue(event.publicPayload);
    const playerId = event.actorId ?? stringValue(payload?.playerId);
    const metric = playerId ? metrics.get(playerId) : null;
    if (!metric) continue;
    if (event.type === "TOURNAMENT_PAUSED_INFRA") metric.infrastructurePauses += 1;
    if (event.type !== "MODEL_DECISION_RECORDED") continue;
    const calls = Math.max(0, safeInteger(payload?.providerCalls) ?? 0);
    const protocolFailures = Math.max(0, safeInteger(payload?.protocolFailures) ?? 0);
    const usedFallback = payload?.usedFallback === true;
    metric.decisions += 1;
    metric.providerCalls += calls;
    metric.protocolCorrections += protocolFailures;
    if (usedFallback) metric.fallbacks += 1;
    else metric.validDecisions += 1;
    if (!usedFallback && calls === 1 && protocolFailures === 0) metric.firstPassDecisions += 1;
    const providerMetrics = payload?.providerMetrics;
    if (!Array.isArray(providerMetrics)) continue;
    for (const rawCall of providerMetrics) {
      const call = recordValue(rawCall);
      if (!call) continue;
      metric.measuredProviderCalls += 1;
      if (call.outcome === "INFRA_ERROR") metric.infrastructureRetries += 1;
      if (call.errorKind === "TIMEOUT") metric.timeouts += 1;
      const latency = finiteNumber(call.latencyMs);
      if (latency !== null && latency >= 0) metric.latencySamplesMs.push(latency);
      const usage = recordValue(call.usage);
      const inputTokens = finiteNumber(usage?.inputTokens);
      const outputTokens = finiteNumber(usage?.outputTokens);
      const totalTokens = finiteNumber(usage?.totalTokens);
      if (inputTokens !== null || outputTokens !== null || totalTokens !== null) {
        metric.knownUsageCalls += 1;
        if (inputTokens !== null) metric.inputTokens = (metric.inputTokens ?? 0) + inputTokens;
        if (outputTokens !== null) metric.outputTokens = (metric.outputTokens ?? 0) + outputTokens;
        if (totalTokens !== null) metric.totalTokens = (metric.totalTokens ?? 0) + totalTokens;
      }
    }
  }

  const players = [...metrics.values()].map((metric) => {
    metric.chipLeadRate = rate(metric.chipLeadHands, state.completedHands);
    metric.vpipRate = rate(metric.vpipHands, metric.handsPlayed);
    metric.pfrRate = rate(metric.pfrHands, metric.handsPlayed);
    metric.threeBetRate = rate(metric.threeBetHands, metric.threeBetOpportunities);
    metric.showdownWinRate = nullableRate(metric.showdownWins, metric.showdownHands);
    metric.allInWinRate = nullableRate(metric.allInWins, metric.allInHands);
    metric.validDecisionRate = nullableRate(metric.validDecisions, metric.decisions);
    metric.firstPassRate = nullableRate(metric.firstPassDecisions, metric.decisions);
    metric.averageLatencyMs = mean(metric.latencySamplesMs);
    metric.p95LatencyMs = percentile95(metric.latencySamplesMs);
    metric.tokenUsageCoverage = rate(metric.knownUsageCalls, metric.measuredProviderCalls);
    const { latencySamplesMs: _latencies, knownUsageCalls: _known, measuredProviderCalls: _measured, ...publicMetric } = metric;
    return publicMetric;
  }).sort((left, right) => (
    (left.finishingPosition ?? Number.MAX_SAFE_INTEGER) - (right.finishingPosition ?? Number.MAX_SAFE_INTEGER)
    || left.seat - right.seat
  ));
  return {
    statistics: {
      tournamentId: state.tournamentId,
      completedHands: state.completedHands,
      initialStack,
      totalChips,
      players,
      methodology: {
        chipPerformance: "Each hand's stack change is divided by that hand's big blind before aggregation.",
        allInEquity: "Exact enumeration is used for at most 25,000 runouts; larger spaces use 10,000 deterministic samples at the final betting lock.",
        threeBet: "A 3-bet is exactly the second preflop raise; its rate is divided by hands where the player acted while facing the opening raise.",
        validDecision: "A decision is valid when the rules engine did not have to execute its fallback action.",
        firstPass: "A first-pass decision used one provider call, no protocol correction, and no fallback.",
        monetaryCost: "Not estimated until provider-specific token pricing is configured and frozen with the tournament.",
      },
    },
    internals: Object.fromEntries([...metrics.values()].map((metric) => [metric.playerId, {
      latencySamplesMs: [...metric.latencySamplesMs],
    }])),
  };
}

export interface CompletedTournamentStatistics {
  createdAt: string;
  statistics: TournamentStatistics;
  internals: TournamentStatisticsComputation["internals"];
}

export interface CompetitiveLeaderboardEntry {
  modelId: string;
  displayName: string;
  providerBrand: ProviderBrand | null;
  rating: number;
  points: number;
  tournaments: number;
  championships: number;
  championshipRate: number;
  topThree: number;
  topThreeRate: number;
  averageFinish: number;
  sampleWarning: boolean;
}

export interface ReliabilityLeaderboardEntry {
  modelId: string;
  displayName: string;
  providerBrand: ProviderBrand | null;
  decisions: number;
  validDecisionRate: number | null;
  firstPassRate: number | null;
  protocolCorrections: number;
  fallbacks: number;
  timeouts: number;
  infrastructurePauses: number;
  sampleWarning: boolean;
}

export interface EfficiencyLeaderboardEntry {
  modelId: string;
  displayName: string;
  providerBrand: ProviderBrand | null;
  decisions: number;
  providerCalls: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalTokens: number | null;
  tokensPerDecision: number | null;
  tokenUsageCoverage: number;
  sampleWarning: boolean;
}

export interface StyleProfileEntry {
  modelId: string;
  displayName: string;
  providerBrand: ProviderBrand | null;
  handsPlayed: number;
  vpipRate: number;
  pfrRate: number;
  threeBetRate: number;
  showdownWinRate: number | null;
  profile: "紧凶" | "紧稳" | "均衡" | "松凶" | "松稳";
  sampleWarning: boolean;
}

export interface ArenaLeaderboards {
  competition: CompetitiveLeaderboardEntry[];
  reliability: ReliabilityLeaderboardEntry[];
  efficiency: EfficiencyLeaderboardEntry[];
  styles: StyleProfileEntry[];
  methodology: {
    competition: string;
    rating: string;
    points: string;
    separation: string;
  };
}

interface AggregateEntry {
  modelId: string;
  displayName: string;
  rating: number;
  points: number;
  tournaments: number;
  championships: number;
  topThree: number;
  finishTotal: number;
  handsPlayed: number;
  vpipHands: number;
  pfrHands: number;
  threeBetHands: number;
  threeBetOpportunities: number;
  showdownHands: number;
  showdownWins: number;
  decisions: number;
  validDecisions: number;
  firstPassDecisions: number;
  providerCalls: number;
  protocolCorrections: number;
  fallbacks: number;
  timeouts: number;
  infrastructurePauses: number;
  latencySamplesMs: number[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenUsageWeightedCalls: number;
  measuredProviderCalls: number;
  hasTokenUsage: boolean;
}

const POINTS_BY_FIELD: Record<number, number[]> = {
  2: [10, 0],
  3: [10, 4, 0],
  4: [10, 5, 2, 0],
  5: [10, 6, 3, 1, 0],
  6: [10, 6, 4, 2, 1, 0],
  7: [10, 7, 5, 3, 2, 1, 0],
  8: [10, 7, 5, 4, 3, 2, 1, 0],
  9: [10, 7, 6, 5, 4, 3, 2, 1, 0],
};

function tournamentPoints(fieldSize: number, finishingPosition: number): number {
  return POINTS_BY_FIELD[fieldSize]?.[finishingPosition - 1] ?? 0;
}

function aggregateEntry(modelId: string, displayName: string): AggregateEntry {
  return {
    modelId,
    displayName,
    rating: 1500,
    points: 0,
    tournaments: 0,
    championships: 0,
    topThree: 0,
    finishTotal: 0,
    handsPlayed: 0,
    vpipHands: 0,
    pfrHands: 0,
    threeBetHands: 0,
    threeBetOpportunities: 0,
    showdownHands: 0,
    showdownWins: 0,
    decisions: 0,
    validDecisions: 0,
    firstPassDecisions: 0,
    providerCalls: 0,
    protocolCorrections: 0,
    fallbacks: 0,
    timeouts: 0,
    infrastructurePauses: 0,
    latencySamplesMs: [],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenUsageWeightedCalls: 0,
    measuredProviderCalls: 0,
    hasTokenUsage: false,
  };
}

function styleProfile(vpip: number, pfr: number): StyleProfileEntry["profile"] {
  const aggression = vpip > 0 ? pfr / vpip : 0;
  if (vpip < 0.23) return aggression >= 0.62 ? "紧凶" : "紧稳";
  if (vpip > 0.38) return aggression >= 0.62 ? "松凶" : "松稳";
  return "均衡";
}

export function buildArenaLeaderboards(
  records: readonly CompletedTournamentStatistics[],
  providerBrands: Readonly<Record<string, ProviderBrand | null>> = {},
): ArenaLeaderboards {
  const entries = new Map<string, AggregateEntry>();
  const chronological = [...records].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const record of chronological) {
    for (const player of record.statistics.players) {
      const existing = entries.get(player.playerId);
      if (existing) existing.displayName = player.displayName;
      else entries.set(player.playerId, aggregateEntry(player.playerId, player.displayName));
    }
    const field = record.statistics.players.filter((player) => player.finishingPosition !== null);
    const priorRatings = new Map(field.map((player) => [player.playerId, entries.get(player.playerId)!.rating]));
    const deltas = new Map<string, number>();
    for (const player of field) {
      let comparisonTotal = 0;
      for (const opponent of field) {
        if (opponent.playerId === player.playerId) continue;
        const playerRating = priorRatings.get(player.playerId) ?? 1500;
        const opponentRating = priorRatings.get(opponent.playerId) ?? 1500;
        const expected = 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
        const actual = player.finishingPosition === opponent.finishingPosition
          ? 0.5
          : (player.finishingPosition ?? Number.MAX_SAFE_INTEGER) < (opponent.finishingPosition ?? Number.MAX_SAFE_INTEGER)
            ? 1
            : 0;
        comparisonTotal += actual - expected;
      }
      deltas.set(player.playerId, field.length > 1 ? 32 * comparisonTotal / (field.length - 1) : 0);
    }
    for (const player of field) {
      const entry = entries.get(player.playerId)!;
      entry.rating += deltas.get(player.playerId) ?? 0;
      entry.tournaments += 1;
      entry.finishTotal += player.finishingPosition ?? 0;
      entry.points += tournamentPoints(field.length, player.finishingPosition ?? field.length);
      if (player.finishingPosition === 1) entry.championships += 1;
      if ((player.finishingPosition ?? Number.MAX_SAFE_INTEGER) <= 3) entry.topThree += 1;
      entry.handsPlayed += player.handsPlayed;
      entry.vpipHands += player.vpipHands;
      entry.pfrHands += player.pfrHands;
      entry.threeBetHands += player.threeBetHands;
      entry.threeBetOpportunities += player.threeBetOpportunities;
      entry.showdownHands += player.showdownHands;
      entry.showdownWins += player.showdownWins;
      entry.decisions += player.decisions;
      entry.validDecisions += player.validDecisions;
      entry.firstPassDecisions += player.firstPassDecisions;
      entry.providerCalls += player.providerCalls;
      entry.protocolCorrections += player.protocolCorrections;
      entry.fallbacks += player.fallbacks;
      entry.timeouts += player.timeouts;
      entry.infrastructurePauses += player.infrastructurePauses;
      entry.latencySamplesMs.push(...(record.internals[player.playerId]?.latencySamplesMs ?? []));
      if (player.inputTokens !== null) entry.inputTokens += player.inputTokens;
      if (player.outputTokens !== null) entry.outputTokens += player.outputTokens;
      if (player.totalTokens !== null) {
        entry.totalTokens += player.totalTokens;
        entry.hasTokenUsage = true;
      }
      entry.measuredProviderCalls += player.providerCalls;
      entry.tokenUsageWeightedCalls += player.providerCalls * player.tokenUsageCoverage;
    }
  }

  const competition = [...entries.values()].map((entry): CompetitiveLeaderboardEntry => ({
    modelId: entry.modelId,
    displayName: entry.displayName,
    providerBrand: providerBrands[entry.modelId] ?? null,
    rating: Math.round(entry.rating),
    points: Math.round(entry.points * 10) / 10,
    tournaments: entry.tournaments,
    championships: entry.championships,
    championshipRate: rate(entry.championships, entry.tournaments),
    topThree: entry.topThree,
    topThreeRate: rate(entry.topThree, entry.tournaments),
    averageFinish: entry.finishTotal / Math.max(1, entry.tournaments),
    sampleWarning: entry.tournaments < 10,
  })).sort((left, right) => (
    right.rating - left.rating || right.points - left.points || left.averageFinish - right.averageFinish
  ));
  const reliability = [...entries.values()].map((entry): ReliabilityLeaderboardEntry => ({
    modelId: entry.modelId,
    displayName: entry.displayName,
    providerBrand: providerBrands[entry.modelId] ?? null,
    decisions: entry.decisions,
    validDecisionRate: nullableRate(entry.validDecisions, entry.decisions),
    firstPassRate: nullableRate(entry.firstPassDecisions, entry.decisions),
    protocolCorrections: entry.protocolCorrections,
    fallbacks: entry.fallbacks,
    timeouts: entry.timeouts,
    infrastructurePauses: entry.infrastructurePauses,
    sampleWarning: entry.decisions < 50,
  })).sort((left, right) => (
    (right.validDecisionRate ?? -1) - (left.validDecisionRate ?? -1)
    || (right.firstPassRate ?? -1) - (left.firstPassRate ?? -1)
    || right.decisions - left.decisions
  ));
  const efficiency = [...entries.values()].map((entry): EfficiencyLeaderboardEntry => ({
    modelId: entry.modelId,
    displayName: entry.displayName,
    providerBrand: providerBrands[entry.modelId] ?? null,
    decisions: entry.decisions,
    providerCalls: entry.providerCalls,
    averageLatencyMs: mean(entry.latencySamplesMs),
    p95LatencyMs: percentile95(entry.latencySamplesMs),
    totalTokens: entry.hasTokenUsage ? entry.totalTokens : null,
    tokensPerDecision: entry.hasTokenUsage && entry.decisions > 0 ? entry.totalTokens / entry.decisions : null,
    tokenUsageCoverage: rate(entry.tokenUsageWeightedCalls, entry.measuredProviderCalls),
    sampleWarning: entry.decisions < 50,
  })).sort((left, right) => (
    (left.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.averageLatencyMs ?? Number.MAX_SAFE_INTEGER)
    || left.providerCalls - right.providerCalls
  ));
  const styles = [...entries.values()].map((entry): StyleProfileEntry => {
    const vpipRate = rate(entry.vpipHands, entry.handsPlayed);
    const pfrRate = rate(entry.pfrHands, entry.handsPlayed);
    return {
      modelId: entry.modelId,
      displayName: entry.displayName,
      providerBrand: providerBrands[entry.modelId] ?? null,
      handsPlayed: entry.handsPlayed,
      vpipRate,
      pfrRate,
      threeBetRate: rate(entry.threeBetHands, entry.threeBetOpportunities),
      showdownWinRate: nullableRate(entry.showdownWins, entry.showdownHands),
      profile: styleProfile(vpipRate, pfrRate),
      sampleWarning: entry.handsPlayed < 200,
    };
  }).sort((left, right) => {
    const rank = new Map(competition.map((entry, index) => [entry.modelId, index]));
    return (rank.get(left.modelId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.modelId) ?? Number.MAX_SAFE_INTEGER);
  });
  return {
    competition,
    reliability,
    efficiency,
    styles,
    methodology: {
      competition: "Only completed tournament placements affect the competitive leaderboard.",
      rating: "A 1500-base multiplayer Elo rating applies simultaneous pairwise placement comparisons with K=32.",
      points: "Six-player fields score 10/6/4/2/1/0; equivalent published scales are used for two to nine players.",
      separation: "Reliability, latency, token usage, and style never alter competitive rating or points.",
    },
  };
}
