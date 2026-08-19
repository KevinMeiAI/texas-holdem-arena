import { createHash } from "node:crypto";
import {
  MOMENT_DETECTOR_VERSION,
  MOMENT_FACTS_VERSION,
  MOMENT_SCORING_VERSION,
  tournamentMomentFactsSchema,
  type MomentActionFact,
  type MomentAllInLock,
  type MomentEquityTransition,
  type MomentScoreBreakdown,
  type MomentTag,
  type TournamentMomentFacts,
} from "../../../../../packages/contracts/src/moments.js";
import { parseCard } from "../../../../../packages/domain/src/cards.js";
import { evaluateBest, HandCategory } from "../../../../../packages/domain/src/evaluator.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import {
  BROADCAST_VIEW_VERSION,
  type BroadcastView,
} from "../broadcast-view.js";
import { BROADCAST_EQUITY_VERSION } from "../broadcast-equity.js";
import { latestSafeSuspenseCoverFrame } from "./moment-cover-safety.js";

export interface MomentSourceEvent {
  sequence: number;
  type: string;
  actorId: string | null;
  handNo: number | null;
  publicPayload: unknown;
  privatePayload?: unknown;
  eventHash: string;
}

export interface MomentDetectionInput {
  tournamentId: string;
  tournamentStatus: string;
  events: readonly MomentSourceEvent[];
  broadcastFrames: readonly BroadcastView[];
}

const PRIMARY_TAG_PRIORITY: readonly MomentTag[] = [
  "FINAL_HAND",
  "MULTI_ELIMINATION",
  "ELIMINATION",
  "MULTIWAY_ALL_IN",
  "ALL_IN_UNDERDOG_WIN",
  "EQUITY_REVERSAL",
  "LARGE_POT",
  "FOUR_BET_PLUS",
  "LEAD_CHANGE",
  "RARE_MADE_HAND",
  "HEADS_UP_REACHED",
  "SHORT_STACK_DOUBLE",
  "SIDE_POT",
  "SPLIT_POT",
  "MULTIWAY_SHOWDOWN",
  "OVERBET",
  "ALL_IN",
  "LONG_TANK",
];

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nonnegativeInteger(value: unknown): number {
  const parsed = safeInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function uuidFromHash(material: string): string {
  const hex = createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function eventHandNo(event: MomentSourceEvent, finalHandNo: number | null): number | null {
  if (event.handNo !== null) return event.handNo;
  const payload = recordValue(event.publicPayload);
  if (event.type === "BLIND_LEVEL_SELECTED") return safeInteger(payload?.handNo);
  if (event.type === "TOURNAMENT_COMPLETED") return finalHandNo;
  return null;
}

function completedResult(events: readonly MomentSourceEvent[]): Record<string, unknown> | null {
  const completed = events.find((event) => event.type === "HAND_COMPLETED");
  return recordValue(recordValue(completed?.publicPayload)?.result);
}

function stacksFromResult(result: Record<string, unknown> | null): Record<string, number> {
  const stacks = recordValue(result?.stacks);
  if (!stacks) return {};
  return Object.fromEntries(Object.entries(stacks).flatMap(([playerId, value]) => {
    const stack = safeInteger(value);
    return stack !== null && stack >= 0 ? [[playerId, stack]] : [];
  }));
}

function winnerIds(events: readonly MomentSourceEvent[], result: Record<string, unknown> | null): string[] {
  const fromResult = Array.isArray(result?.winnerPlayerIds)
    ? result.winnerPlayerIds.filter((value): value is string => typeof value === "string")
    : [];
  const fromAwards = events.flatMap((event) => {
    if (event.type !== "POT_AWARDED") return [];
    const playerId = stringValue(recordValue(recordValue(event.publicPayload)?.award)?.playerId);
    return playerId ? [playerId] : [];
  });
  return orderedUnique(fromResult.length > 0 ? fromResult : fromAwards);
}

function startingStacks(
  events: readonly MomentSourceEvent[],
  ending: Readonly<Record<string, number>>,
): Record<string, number> {
  const contributed: Record<string, number> = {};
  const returned: Record<string, number> = {};
  const awarded: Record<string, number> = {};
  const add = (target: Record<string, number>, playerId: string, amount: number) => {
    target[playerId] = (target[playerId] ?? 0) + amount;
  };
  for (const event of events) {
    const payload = recordValue(event.publicPayload);
    if (event.type === "FORCED_BET_POSTED") {
      const playerId = stringValue(payload?.playerId);
      if (playerId) add(contributed, playerId, nonnegativeInteger(payload?.amount));
    }
    if (event.type === "ACTION_APPLIED" && event.actorId) {
      add(contributed, event.actorId, nonnegativeInteger(payload?.paid));
    }
    if (event.type === "UNCALLED_BET_RETURNED") {
      const playerId = stringValue(payload?.playerId);
      if (playerId) add(returned, playerId, nonnegativeInteger(payload?.amount));
    }
    if (event.type === "POT_AWARDED") {
      const award = recordValue(payload?.award);
      const playerId = stringValue(award?.playerId);
      if (playerId) add(awarded, playerId, nonnegativeInteger(award?.amount));
    }
  }
  const ids = orderedUnique([
    ...Object.keys(ending),
    ...Object.keys(contributed),
    ...Object.keys(returned),
    ...Object.keys(awarded),
  ]);
  return Object.fromEntries(ids.map((playerId) => [
    playerId,
    Math.max(0, (ending[playerId] ?? 0)
      + (contributed[playerId] ?? 0)
      - (returned[playerId] ?? 0)
      - (awarded[playerId] ?? 0)),
  ]));
}

function actionsFromEvents(events: readonly MomentSourceEvent[]): MomentActionFact[] {
  return events.flatMap((event) => {
    if (event.type !== "ACTION_APPLIED" || !event.actorId) return [];
    const payload = recordValue(event.publicPayload);
    const command = recordValue(payload?.command);
    const action = stringValue(command?.action) ?? stringValue(payload?.classification);
    const street = stringValue(payload?.street);
    const classification = stringValue(payload?.classification) ?? action;
    if (!action || !street || !classification) return [];
    return [{
      sequence: event.sequence,
      street,
      playerId: event.actorId,
      action,
      classification,
      paid: nonnegativeInteger(payload?.paid),
      amountTo: nonnegativeInteger(payload?.amountTo),
    }];
  });
}

function overbetSequences(events: readonly MomentSourceEvent[]): number[] {
  let pot = 0;
  const result: number[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = recordValue(event.publicPayload);
    if (event.type === "FORCED_BET_POSTED") {
      pot += nonnegativeInteger(payload?.amount);
      continue;
    }
    if (event.type === "UNCALLED_BET_RETURNED") {
      pot = Math.max(0, pot - nonnegativeInteger(payload?.amount));
      continue;
    }
    if (event.type !== "ACTION_APPLIED") continue;
    const paid = nonnegativeInteger(payload?.paid);
    // Restrict this label to an opening post-flop bet. A raise's incremental
    // payment is not a poker-standard bet-size denominator.
    if (payload?.classification === "bet" && pot > 0 && paid > pot) result.push(event.sequence);
    pot += paid;
  }
  return result;
}

function uniqueEquityLeader(frame: BroadcastView): string | null {
  const contenders = frame.players.filter((player) => !player.folded && player.equity !== null);
  const maximum = Math.max(...contenders.map((player) => player.equity ?? 0));
  const leaders = contenders.filter((player) => Math.abs((player.equity ?? 0) - maximum) < 1e-12);
  return leaders.length === 1 ? leaders[0]!.playerId : null;
}

function contenderIds(frame: BroadcastView): string[] {
  return frame.players
    .filter((player) => !player.folded && player.equity !== null)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.playerId);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equityTransitions(frames: readonly BroadcastView[]): MomentEquityTransition[] {
  const byBoardLength = new Map<number, BroadcastView[]>();
  for (const frame of [...frames].sort((left, right) => left.sequence - right.sequence)) {
    if (![0, 3, 4, 5].includes(frame.board.length)) continue;
    const bucket = byBoardLength.get(frame.board.length) ?? [];
    bucket.push(frame);
    byBoardLength.set(frame.board.length, bucket);
  }
  const stages = [...byBoardLength.entries()].sort(([left], [right]) => left - right);
  const result: MomentEquityTransition[] = [];
  for (let index = 0; index < stages.length - 1; index += 1) {
    const from = stages[index]?.[1].at(-1);
    const to = stages[index + 1]?.[1][0];
    if (!from || !to || to.sequence <= from.sequence) continue;
    const beforeIds = contenderIds(from);
    const afterIds = contenderIds(to);
    if (beforeIds.length < 2 || !sameIds(beforeIds, afterIds)) continue;
    const leaderBefore = uniqueEquityLeader(from);
    const leaderAfter = uniqueEquityLeader(to);
    if (!leaderBefore || !leaderAfter || leaderBefore === leaderAfter) continue;
    const afterById = new Map(to.players.map((player) => [player.playerId, player.equity]));
    const maxAbsoluteDelta = Math.max(...from.players.flatMap((player) => {
      if (player.folded || player.equity === null) return [];
      const after = afterById.get(player.playerId);
      return after === null || after === undefined ? [] : [Math.abs(player.equity - after)];
    }));
    if (maxAbsoluteDelta < 0.20) continue;
    result.push({
      fromSequence: from.sequence,
      toSequence: to.sequence,
      fromStreet: from.street,
      toStreet: to.street,
      participantPlayerIds: beforeIds,
      leaderBefore,
      leaderAfter,
      maxAbsoluteDelta,
      estimated: from.estimated || to.estimated,
      samples: Math.min(from.samples, to.samples),
    });
  }
  return result;
}

function allInLock(
  frames: readonly BroadcastView[],
  firstAllInSequence: number | null,
): MomentAllInLock | null {
  if (firstAllInSequence === null) return null;
  for (const frame of [...frames].sort((left, right) => left.sequence - right.sequence)) {
    if (frame.sequence < firstAllInSequence || frame.currentActorId !== null) continue;
    const contenders = frame.players
      .filter((player) => !player.folded && player.equity !== null)
      .sort((left, right) => left.seat - right.seat);
    if (contenders.length < 2
      || !contenders.some((player) => player.allIn)
      || contenders.filter((player) => !player.allIn).length > 1) continue;
    return {
      sequence: frame.sequence,
      street: frame.street,
      board: [...frame.board],
      participantPlayerIds: contenders.map((player) => player.playerId),
      equities: contenders.map((player) => ({ playerId: player.playerId, equity: player.equity! })),
      estimated: frame.estimated,
      samples: frame.samples,
    };
  }
  return null;
}

function maxDecisionLatency(events: readonly MomentSourceEvent[]): number | null {
  const samples = events.flatMap((event) => {
    if (event.type !== "MODEL_DECISION_RECORDED") return [];
    const metrics = recordValue(event.publicPayload)?.providerMetrics;
    if (!Array.isArray(metrics)) return [];
    const latencies = metrics.flatMap((raw) => {
      const latency = safeInteger(recordValue(raw)?.latencyMs);
      return latency !== null && latency >= 0 ? [latency] : [];
    });
    // Provider attempts belonging to one recorded decision are sequential in
    // the Arena runtime. The audience experienced their accumulated wait, not
    // merely the slowest individual attempt.
    return latencies.length > 0 ? [latencies.reduce((sum, latency) => sum + latency, 0)] : [];
  });
  return samples.length > 0 ? Math.max(...samples) : null;
}

function firstAllInSequence(
  events: readonly MomentSourceEvent[],
  frames: readonly BroadcastView[],
): number | null {
  const explicit = events.flatMap((event) => {
    if (event.type !== "ACTION_APPLIED") return [];
    const command = recordValue(recordValue(event.publicPayload)?.command);
    return command?.action === "all_in" ? [event.sequence] : [];
  });
  // The rules engine also permits an ordinary call, bet, raise, or forced bet
  // to consume a player's final chip. Broadcast state is authoritative for
  // that outcome, so it closes the gap left by action-word inspection.
  const stateDerived = frames.flatMap((frame) => (
    frame.players.some((player) => player.allIn) ? [frame.sequence] : []
  ));
  const sequences = [...explicit, ...stateDerived];
  return sequences.length > 0 ? Math.min(...sequences) : null;
}

function winningHandCategories(
  frames: readonly BroadcastView[],
  winners: ReadonlySet<string>,
): Array<"FULL_HOUSE" | "FOUR_OF_A_KIND" | "STRAIGHT_FLUSH"> {
  const finalFrame = [...frames]
    .filter((frame) => frame.board.length === 5)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  if (!finalFrame) return [];
  const categories = new Set<"FULL_HOUSE" | "FOUR_OF_A_KIND" | "STRAIGHT_FLUSH">();
  for (const player of finalFrame.players) {
    if (!winners.has(player.playerId) || player.holeCards.length !== 2) continue;
    try {
      const rank = evaluateBest([...player.holeCards, ...finalFrame.board].map(parseCard));
      if (rank.category === HandCategory.FullHouse) categories.add("FULL_HOUSE");
      if (rank.category === HandCategory.FourOfAKind) categories.add("FOUR_OF_A_KIND");
      if (rank.category === HandCategory.StraightFlush) categories.add("STRAIGHT_FLUSH");
    } catch {
      // A malformed replay frame must not make the entire post-match detector fail.
    }
  }
  return [...categories];
}

function scoreMoment(input: {
  potBigBlinds: number;
  totalChipShare: number;
  tags: ReadonlySet<MomentTag>;
}): { score: number; breakdown: MomentScoreBreakdown } {
  const potImpact = Math.min(22,
    Math.min(12, Math.round(Math.log2(1 + input.potBigBlinds) * 2.5))
    + Math.min(10, Math.round(input.totalChipShare * 40)),
  );
  const tournamentImpact = Math.min(32,
    (input.tags.has("FINAL_HAND") ? 16 : 0)
    + (input.tags.has("MULTI_ELIMINATION") ? 12 : input.tags.has("ELIMINATION") ? 8 : 0)
    + (input.tags.has("HEADS_UP_REACHED") ? 5 : 0)
    + (input.tags.has("LEAD_CHANGE") ? 3 : 0),
  );
  const actionDrama = Math.min(18,
    (input.tags.has("ALL_IN") ? 6 : 0)
    + (input.tags.has("MULTIWAY_ALL_IN") ? 4 : 0)
    + (input.tags.has("FOUR_BET_PLUS") ? 4 : 0)
    + (input.tags.has("OVERBET") ? 2 : 0)
    + (input.tags.has("SIDE_POT") ? 2 : 0),
  );
  const equityDrama = Math.min(20,
    (input.tags.has("EQUITY_REVERSAL") ? 12 : 0)
    + (input.tags.has("ALL_IN_UNDERDOG_WIN") ? 8 : 0),
  );
  const rarity = Math.min(8,
    (input.tags.has("RARE_MADE_HAND") ? 4 : 0)
    + (input.tags.has("SPLIT_POT") ? 2 : 0)
    + (input.tags.has("MULTIWAY_SHOWDOWN") ? 1 : 0)
    + (input.tags.has("LONG_TANK") ? 1 : 0),
  );
  const breakdown = { potImpact, tournamentImpact, actionDrama, equityDrama, rarity };
  return { score: Object.values(breakdown).reduce((sum, value) => sum + value, 0), breakdown };
}

function primaryTag(tags: ReadonlySet<MomentTag>): MomentTag {
  const tag = PRIMARY_TAG_PRIORITY.find((candidate) => tags.has(candidate));
  if (!tag) throw new Error("Moment candidate requires at least one supported tag");
  return tag;
}

function sourceFingerprint(events: readonly MomentSourceEvent[]): TournamentMomentFacts["source"] {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  return {
    eventHash: createHash("sha256").update(canonicalJson(ordered.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      eventHash: event.eventHash,
    })))).digest("hex"),
    eventCount: ordered.length,
    startEventHash: first.eventHash,
    endEventHash: last.eventHash,
  };
}

function topStackPlayerIds(stacks: Readonly<Record<string, number>>): string[] {
  const entries = Object.entries(stacks);
  if (entries.length === 0) return [];
  const maximum = Math.max(...entries.map(([, stack]) => stack));
  return entries.filter(([, stack]) => stack === maximum).map(([playerId]) => playerId).sort();
}

function hasThreeConsecutive(selected: readonly TournamentMomentFacts[], handNo: number): boolean {
  const hands = new Set([...selected.map((moment) => moment.handNo), handNo]);
  let run = 0;
  for (const candidate of [...hands].sort((left, right) => left - right)) {
    run = hands.has(candidate - 1) ? run + 1 : 1;
    if (run >= 3) return true;
  }
  return false;
}

export function rankRecommendedMoments(
  candidates: readonly TournamentMomentFacts[],
  completedHandCount: number,
): TournamentMomentFacts[] {
  const ordered = [...candidates].sort((left, right) => right.score - left.score || left.handNo - right.handNo);
  const requested = Math.max(3, Math.min(12, Math.ceil(completedHandCount / 10)));
  const target = Math.min(ordered.length, requested);
  const selected: TournamentMomentFacts[] = [];
  const primaryCounts = new Map<MomentTag, number>();
  const winnerCounts = new Map<string, number>();
  const winnerLimit = Math.max(1, Math.ceil(target / 3));
  const mayAdd = (candidate: TournamentMomentFacts) => {
    if ((primaryCounts.get(candidate.primaryTag) ?? 0) >= 2 && candidate.primaryTag !== "FINAL_HAND") return false;
    const winnerKey = candidate.winnerPlayerIds.join("|");
    if ((winnerCounts.get(winnerKey) ?? 0) >= winnerLimit) return false;
    return !hasThreeConsecutive(selected, candidate.handNo);
  };
  const add = (candidate: TournamentMomentFacts) => {
    if (selected.some((moment) => moment.id === candidate.id)) return;
    selected.push(candidate);
    primaryCounts.set(candidate.primaryTag, (primaryCounts.get(candidate.primaryTag) ?? 0) + 1);
    const winnerKey = candidate.winnerPlayerIds.join("|");
    winnerCounts.set(winnerKey, (winnerCounts.get(winnerKey) ?? 0) + 1);
  };
  const finalHand = ordered.find((candidate) => candidate.tags.includes("FINAL_HAND"));
  if (finalHand) add(finalHand);
  for (const candidate of ordered) {
    if (selected.length >= target) break;
    if (mayAdd(candidate)) add(candidate);
  }
  // Diversity is a recommendation preference, not a reason to return fewer
  // cards than requested when a short tournament has homogeneous outcomes.
  for (const candidate of ordered) {
    if (selected.length >= target) break;
    add(candidate);
  }
  const ranks = new Map(selected
    .sort((left, right) => right.score - left.score || left.handNo - right.handNo)
    .map((candidate, index) => [candidate.id, index + 1]));
  return ordered.map((candidate) => tournamentMomentFactsSchema.parse({
    ...candidate,
    recommendationRank: ranks.get(candidate.id) ?? null,
  }));
}

export function detectTournamentMoments(input: MomentDetectionInput): TournamentMomentFacts[] {
  if (input.tournamentStatus !== "COMPLETED") {
    throw new Error("Moments can only be derived after a tournament is completed");
  }
  const orderedEvents = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const tournamentCompleted = orderedEvents.find((event) => event.type === "TOURNAMENT_COMPLETED");
  const completedHandNos = [...new Set(orderedEvents.flatMap((event) => (
    event.type === "HAND_COMPLETED" && event.handNo !== null ? [event.handNo] : []
  )))].sort((left, right) => left - right);
  const finalHandNo = safeInteger(recordValue(tournamentCompleted?.publicPayload)?.completedHands)
    ?? completedHandNos.at(-1)
    ?? null;
  const maximumFieldSize = Math.max(0, ...completedHandNos.map((handNo) => orderedEvents.filter((event) => (
    eventHandNo(event, finalHandNo) === handNo && event.type === "HOLE_CARDS_DEALT"
  )).length));

  const candidates: TournamentMomentFacts[] = [];
  for (const handNo of completedHandNos) {
    const handEvents = orderedEvents.filter((event) => eventHandNo(event, finalHandNo) === handNo);
    if (handEvents.length === 0) continue;
    const result = completedResult(handEvents);
    const endingStacks = stacksFromResult(result);
    const participants = orderedUnique(handEvents.flatMap((event) => {
      if (event.type !== "HOLE_CARDS_DEALT") return [];
      const playerId = stringValue(recordValue(event.publicPayload)?.playerId);
      return playerId ? [playerId] : [];
    }));
    const winners = winnerIds(handEvents, result);
    if (participants.length < 2 || winners.length === 0 || Object.keys(endingStacks).length === 0) continue;
    const startStacks = startingStacks(handEvents, endingStacks);
    const netChanges = Object.fromEntries(Object.keys(startStacks).map((playerId) => [
      playerId,
      (endingStacks[playerId] ?? 0) - startStacks[playerId]!,
    ]));
    const blindEvent = handEvents.find((event) => event.type === "BLIND_LEVEL_SELECTED");
    const bigBlind = Math.max(1, nonnegativeInteger(recordValue(recordValue(blindEvent?.publicPayload)?.level)?.bigBlind));
    const potChips = handEvents.reduce((sum, event) => {
      if (event.type !== "POT_AWARDED") return sum;
      return sum + nonnegativeInteger(recordValue(recordValue(event.publicPayload)?.award)?.amount);
    }, 0);
    if (potChips <= 0) continue;
    const totalChips = Object.values(endingStacks).reduce((sum, stack) => sum + stack, 0);
    const potBigBlinds = potChips / bigBlind;
    const totalChipShare = totalChips > 0 ? Math.min(1, potChips / totalChips) : 0;
    const actions = actionsFromEvents(handEvents);
    const preflopRaiseCount = actions.filter((action) => action.street === "PREFLOP"
      && ["bet", "raise", "short_raise"].includes(action.classification)).length;
    const overs = overbetSequences(handEvents);
    const frames = input.broadcastFrames.filter((frame) => frame.handNo === handNo);
    const allInAt = firstAllInSequence(handEvents, frames);
    const lock = allInLock(frames, allInAt);
    const transitions = equityTransitions(frames);
    const eliminations = orderedUnique(handEvents.flatMap((event) => (
      event.type === "PLAYER_ELIMINATED" && event.actorId ? [event.actorId] : []
    )));
    const showdown = orderedUnique(handEvents.flatMap((event) => {
      if (event.type !== "SHOWDOWN_REVEALED") return [];
      const players = recordValue(event.publicPayload)?.players;
      return Array.isArray(players) ? players.flatMap((raw) => {
        const playerId = stringValue(recordValue(raw)?.playerId);
        return playerId ? [playerId] : [];
      }) : [];
    }));
    const pots = handEvents.flatMap((event) => {
      if (event.type !== "POT_CREATED") return [];
      const pot = recordValue(recordValue(event.publicPayload)?.pot);
      return pot ? [pot] : [];
    });
    const sidePotCount = Math.max(0, pots.length - 1);
    const awardGroups = new Map<string, Set<string>>();
    for (const event of handEvents) {
      if (event.type !== "POT_AWARDED") continue;
      const award = recordValue(recordValue(event.publicPayload)?.award);
      const playerId = stringValue(award?.playerId);
      if (!playerId) continue;
      const key = `${nonnegativeInteger(award?.potIndex)}:${nonnegativeInteger(award?.boardIndex)}`;
      const group = awardGroups.get(key) ?? new Set<string>();
      group.add(playerId);
      awardGroups.set(key, group);
    }
    const splitPot = [...awardGroups.values()].some((group) => group.size > 1);
    const leadBefore = topStackPlayerIds(startStacks);
    const leadAfter = topStackPlayerIds(endingStacks);
    const leadChange = leadBefore.length === 1 && leadAfter.length === 1 && leadBefore[0] !== leadAfter[0];
    const shortStackDoubleIds = participants.filter((playerId) => {
      const starting = startStacks[playerId] ?? 0;
      return starting > 0 && starting <= bigBlind * 10 && (endingStacks[playerId] ?? 0) >= starting * 2;
    });
    const latency = maxDecisionLatency(handEvents);
    const rareCategories = winningHandCategories(frames, new Set(winners));
    const underdogWinners = lock && sidePotCount === 0 && !splitPot
      ? winners.filter((winner) => {
        const equity = lock.equities.find((item) => item.playerId === winner)?.equity;
        const best = Math.max(...lock.equities.map((item) => item.equity));
        const margin = lock.estimated ? 0.08 : 1e-12;
        return equity !== undefined && equity < 0.5 && equity <= best - margin;
      })
      : [];

    const tags = new Set<MomentTag>();
    if (finalHandNo === handNo) tags.add("FINAL_HAND");
    if (eliminations.length > 0) tags.add("ELIMINATION");
    if (eliminations.length > 1) tags.add("MULTI_ELIMINATION");
    if (maximumFieldSize > 2 && participants.length > 2
      && Object.values(endingStacks).filter((stack) => stack > 0).length === 2) tags.add("HEADS_UP_REACHED");
    if (allInAt !== null) tags.add("ALL_IN");
    if ((lock?.participantPlayerIds.length ?? 0) >= 3) tags.add("MULTIWAY_ALL_IN");
    if (potBigBlinds >= 20 || totalChipShare >= 0.20) tags.add("LARGE_POT");
    if (leadChange) tags.add("LEAD_CHANGE");
    if (shortStackDoubleIds.length > 0) tags.add("SHORT_STACK_DOUBLE");
    if (preflopRaiseCount >= 3) tags.add("FOUR_BET_PLUS");
    if (overs.length > 0) tags.add("OVERBET");
    if (sidePotCount > 0) tags.add("SIDE_POT");
    if (splitPot) tags.add("SPLIT_POT");
    if (showdown.length >= 3) tags.add("MULTIWAY_SHOWDOWN");
    if (transitions.length > 0) tags.add("EQUITY_REVERSAL");
    if (underdogWinners.length > 0) tags.add("ALL_IN_UNDERDOG_WIN");
    if (rareCategories.length > 0) tags.add("RARE_MADE_HAND");
    if (latency !== null && latency >= 60_000) tags.add("LONG_TANK");
    if (tags.size === 0) continue;

    const { score, breakdown } = scoreMoment({ potBigBlinds, totalChipShare, tags });
    const source = sourceFingerprint(handEvents);
    const startSequence = handEvents[0]!.sequence;
    const endSequence = handEvents.at(-1)!.sequence;
    const safeCoverFrame = latestSafeSuspenseCoverFrame({
      handNo,
      startSequence,
      endSequence,
      frames,
      events: handEvents,
    });
    // focusSequence is the default editorial cover. It must stay causal and
    // unresolved; otherwise a suspense card can reveal its own winner before
    // the audience presses play. A neutral start-event cover is the safe
    // fallback for malformed historical replays without any usable frame.
    const focusSequence = safeCoverFrame?.sequence ?? startSequence;
    const finalFrame = [...frames].sort((left, right) => left.sequence - right.sequence).at(-1);
    const featured = orderedUnique([
      ...winners,
      ...eliminations,
      ...shortStackDoubleIds,
      ...underdogWinners,
      ...(leadChange ? [...leadBefore, ...leadAfter] : []),
    ]);
    const broadcastViewVersion = finalFrame?.version ?? BROADCAST_VIEW_VERSION;
    const equityVersion = finalFrame?.equityVersion ?? BROADCAST_EQUITY_VERSION;
    const candidate = tournamentMomentFactsSchema.parse({
      id: uuidFromHash([
        "arena-moment",
        input.tournamentId,
        handNo,
        MOMENT_FACTS_VERSION,
        MOMENT_DETECTOR_VERSION,
        MOMENT_SCORING_VERSION,
        broadcastViewVersion,
        equityVersion,
        source.eventHash,
      ].join("\0")),
      tournamentId: input.tournamentId,
      handNo,
      startSequence,
      focusSequence,
      endSequence,
      factsVersion: MOMENT_FACTS_VERSION,
      detectorVersion: MOMENT_DETECTOR_VERSION,
      scoringVersion: MOMENT_SCORING_VERSION,
      broadcastViewVersion,
      equityVersion,
      source,
      score,
      scoreBreakdown: breakdown,
      recommendationRank: null,
      primaryTag: primaryTag(tags),
      tags: PRIMARY_TAG_PRIORITY.filter((tag) => tags.has(tag)),
      participantPlayerIds: participants,
      featuredPlayerIds: featured.length > 0 ? featured : winners,
      winnerPlayerIds: winners,
      eliminatedPlayerIds: eliminations,
      showdownPlayerIds: showdown,
      board: finalFrame?.board ?? [],
      bigBlind,
      potChips,
      potBigBlinds,
      totalChipShare,
      startingStacks: startStacks,
      endingStacks,
      netChanges,
      actionCount: actions.length,
      preflopRaiseCount,
      overbetSequences: overs,
      sidePotCount,
      splitPot,
      leadChange,
      maxDecisionLatencyMs: latency,
      winningHandCategories: rareCategories,
      actions,
      allInLock: lock,
      equityTransitions: transitions,
    });
    candidates.push(candidate);
  }
  return rankRecommendedMoments(candidates, completedHandNos.length);
}
