import { handEventToArenaEvent, type ProjectedArenaEvent } from "../../../../packages/contracts/src/index.js";
import { actionOrderAfter, initialPositions } from "../../../../packages/domain/src/button.js";
import { createDeck, parseCard, type Card } from "../../../../packages/domain/src/cards.js";
import type { ActionCommand } from "../../../../packages/domain/src/betting.js";
import {
  reduceHand,
  startHand,
  type HandEvent,
  type HandState,
} from "../../../../packages/domain/src/reducer.js";
import type { TournamentState } from "../../../../packages/domain/src/tournament.js";
import { buildModelContext } from "../tournament/model-context.js";
import { CURRENT_RULESET_VERSION } from "../tournament/ruleset-registry.js";

export const CONSISTENCY_SCENARIO_REGISTRY_VERSION = "arena-consistency-scenarios-v1";

export type ConsistencyScenarioRole = "ANCHOR" | "MIXED" | "PRESSURE";
export type ConsistencyStackDepth = "SHORT" | "MEDIUM" | "DEEP";
export type ConsistencyPositionClass = "EARLY" | "IN_POSITION" | "OUT_OF_POSITION" | "SANDWICH";
export type ConsistencyTier = "quick" | "standard" | "full";

export interface LocalizedScenarioText {
  zh: string;
  en: string;
}

export interface ConsistencyScenarioTags {
  street: "PREFLOP" | "FLOP" | "TURN" | "RIVER";
  tableSize: number;
  contenders: number;
  potType: "UNOPENED" | "OPEN_RAISED" | "HEADS_UP" | "MULTIWAY" | "SIDE_POT";
  position: ConsistencyPositionClass;
  stackDepth: ConsistencyStackDepth;
  handClass: string;
  boardTexture: string;
  pressure: string;
}

export interface ConsistencyScenarioPreview {
  heroPosition: string;
  heroStack: number;
  heroStackBb: number;
  holeCards: string[];
  board: string[];
  potBeforeAction: number;
  legalActions: string[];
  actionHistory: unknown[];
}

export interface ConsistencyScenario {
  id: string;
  version: number;
  registryVersion: string;
  title: LocalizedScenarioText;
  summary: LocalizedScenarioText;
  role: ConsistencyScenarioRole;
  tags: ConsistencyScenarioTags;
  preview: ConsistencyScenarioPreview;
  arenaState: Record<string, unknown>;
}

interface ScenarioPlayerInput {
  seat: number;
  stack: number;
}

interface ScenarioActionInput {
  seat: number;
  action: ActionCommand;
}

interface ScenarioBlueprint {
  id: string;
  title: LocalizedScenarioText;
  summary: LocalizedScenarioText;
  role: ConsistencyScenarioRole;
  tags: Omit<ConsistencyScenarioTags, "tableSize" | "contenders">;
  seatCount: number;
  buttonSeat: number;
  heroSeat: number;
  heroCards: [string, string];
  board: string[];
  players: ScenarioPlayerInput[];
  actions: ScenarioActionInput[];
  bigBlindAnte?: number;
}

const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const HAND_NO = 5;

function playerId(seat: number, heroSeat: number): string {
  return seat === heroSeat ? "hero" : `opponent-seat-${seat}`;
}

function tablePlayers(count: number, stack: number, heroSeat: number): ScenarioPlayerInput[] {
  return Array.from({ length: count }, (_, seat) => ({ seat, stack })).map((player) => (
    player.seat === heroSeat ? player : player
  ));
}

function action(seat: number, command: ActionCommand): ScenarioActionInput {
  return { seat, action: command };
}

function fold(seat: number): ScenarioActionInput {
  return action(seat, { action: "fold" });
}

function check(seat: number): ScenarioActionInput {
  return action(seat, { action: "check" });
}

function call(seat: number): ScenarioActionInput {
  return action(seat, { action: "call" });
}

function raiseTo(seat: number, amountTo: number): ScenarioActionInput {
  return action(seat, { action: "raise", amountTo });
}

function betTo(seat: number, amountTo: number): ScenarioActionInput {
  return action(seat, { action: "bet", amountTo });
}

function allIn(seat: number): ScenarioActionInput {
  return action(seat, { action: "all_in" });
}

function scenarioDeck(input: ScenarioBlueprint): Card[] {
  const activeSeats = input.players.map((player) => player.seat);
  const dealOrder = actionOrderAfter(input.buttonSeat, activeSeats, input.seatCount);
  const assigned = new Map<number, string>();
  const heroDealIndex = dealOrder.indexOf(input.heroSeat);
  if (heroDealIndex < 0) throw new Error(`${input.id}: hero seat is not active`);
  assigned.set(heroDealIndex, input.heroCards[0]);
  assigned.set(dealOrder.length + heroDealIndex, input.heroCards[1]);

  const holeCardCount = dealOrder.length * 2;
  const boardIndexes = [holeCardCount + 1, holeCardCount + 2, holeCardCount + 3, holeCardCount + 5, holeCardCount + 7];
  input.board.forEach((card, index) => assigned.set(boardIndexes[index]!, card));

  const assignedCodes = [...assigned.values()];
  if (new Set(assignedCodes).size !== assignedCodes.length) {
    throw new Error(`${input.id}: duplicate requested cards`);
  }
  const reserved = new Set(assignedCodes);
  const remaining = createDeck().filter((card) => !reserved.has(`${"23456789TJQKA"[card.rank - 2]}${card.suit}`));
  const deck: Card[] = [];
  let remainingIndex = 0;
  for (let index = 0; index < 52; index += 1) {
    const code = assigned.get(index);
    deck.push(code ? parseCard(code) : remaining[remainingIndex++]!);
  }
  return deck;
}

function projectedEvents(scenarioId: string, events: readonly HandEvent[]): ProjectedArenaEvent[] {
  return events.map((event, index) => {
    const arenaEvent = handEventToArenaEvent(HAND_NO, event);
    return {
      tournamentId: `consistency:${scenarioId}`,
      sequence: index + 1,
      aggregateVersion: index + 1,
      type: arenaEvent.type,
      actorId: arenaEvent.actorId,
      handNo: arenaEvent.handNo,
      publicPayload: arenaEvent.publicPayload,
      eventHash: `consistency-event-${scenarioId}-${index + 1}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  });
}

function tournamentState(input: ScenarioBlueprint, hand: HandState): TournamentState {
  const totalChips = input.players.reduce((sum, player) => sum + player.stack, 0);
  return {
    status: "RUNNING",
    seatCount: input.seatCount,
    players: input.players.map((player) => ({
      id: playerId(player.seat, input.heroSeat),
      seat: player.seat,
      stack: player.stack,
      status: "ACTIVE",
      eliminatedHandNo: null,
      finishingPosition: null,
      tieGroup: null,
    })),
    initialStack: Math.max(...input.players.map((player) => player.stack)),
    initialButton: input.buttonSeat,
    handsPerLevel: 10,
    blindLevels: [
      { smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, bigBlindAnte: input.bigBlindAnte ?? 0 },
      { smallBlind: 75, bigBlind: 150, bigBlindAnte: input.bigBlindAnte ? 150 : 0 },
    ],
    totalChips,
    completedHands: HAND_NO - 1,
    currentHand: hand,
    currentHandStartingStacks: Object.fromEntries(input.players.map((player) => [
      playerId(player.seat, input.heroSeat),
      player.stack,
    ])),
    previousPositions: null,
    championPlayerId: null,
  };
}

function buildScenario(input: ScenarioBlueprint): ConsistencyScenario {
  const activeSeats = input.players.map((player) => player.seat);
  const positions = initialPositions(input.buttonSeat, activeSeats, input.seatCount);
  let transition = startHand({
    handNo: HAND_NO,
    seatCount: input.seatCount,
    players: input.players.map((player) => ({
      id: playerId(player.seat, input.heroSeat),
      seat: player.seat,
      stack: player.stack,
    })),
    positions,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    bigBlindAnte: input.bigBlindAnte ?? 0,
    deck: scenarioDeck(input),
  });
  const handEvents: HandEvent[] = [...transition.events];
  for (const step of input.actions) {
    const expectedActor = playerId(step.seat, input.heroSeat);
    if (transition.state.betting?.currentActorId !== expectedActor) {
      throw new Error(`${input.id}: expected ${expectedActor}, got ${transition.state.betting?.currentActorId ?? "no actor"}`);
    }
    transition = reduceHand(transition.state, {
      type: "ACTION",
      playerId: expectedActor,
      action: step.action,
    });
    handEvents.push(...transition.events);
  }
  const heroId = playerId(input.heroSeat, input.heroSeat);
  if (transition.state.betting?.currentActorId !== heroId) {
    throw new Error(`${input.id}: scenario does not stop on the hero decision`);
  }
  if (transition.state.phase !== input.tags.street) {
    throw new Error(`${input.id}: expected ${input.tags.street}, got ${transition.state.phase}`);
  }
  const state = tournamentState(input, transition.state);
  const context = buildModelContext({
    tournamentId: `consistency:${input.id}`,
    rulesetVersion: CURRENT_RULESET_VERSION,
    promptVersion: "arena-system-v11",
    contextVersion: "model-context-v4",
    state,
    playerId: heroId,
    currentHandEvents: projectedEvents(input.id, handEvents),
    historyBudget: {
      maxQueries: 0,
      usedQueries: 0,
      maxRecordsPerQuery: 80,
      usedRecords: 0,
      maxApproxTokens: 0,
      usedApproxTokens: 0,
      maxBytes: 0,
      usedBytes: 0,
    },
  }) as Record<string, unknown>;
  const hero = context.hero as Record<string, unknown>;
  const pot = context.pot as Record<string, unknown>;
  const position = context.positions as Record<string, unknown>;
  const legal = context.legal_actions as { allowed?: unknown };
  const legalActions = Array.isArray(legal?.allowed) ? legal.allowed.filter((item): item is string => typeof item === "string") : [];
  if (legalActions.length < 2) throw new Error(`${input.id}: consistency scenarios require at least two legal actions`);
  const contenders = transition.state.players.filter((player) => !player.folded).length;
  const expectedContenders = input.tags.potType === "HEADS_UP" ? 2 : contenders;
  if (input.tags.potType === "HEADS_UP" && contenders !== 2) throw new Error(`${input.id}: expected a heads-up pot`);
  if ((input.tags.potType === "MULTIWAY" || input.tags.potType === "SIDE_POT") && contenders < 3) {
    throw new Error(`${input.id}: expected a multiway pot`);
  }
  const preview: ConsistencyScenarioPreview = {
    heroPosition: String(position.hero_position ?? "UNKNOWN"),
    heroStack: Number(hero.stack ?? 0),
    heroStackBb: Number(hero.stack_bb ?? 0),
    holeCards: Array.isArray(hero.hole_cards) ? hero.hole_cards.map(String) : [],
    board: Array.isArray(context.board) ? context.board.map(String) : [],
    potBeforeAction: Number(pot.total_before_action ?? 0),
    legalActions,
    actionHistory: Array.isArray(context.action_history) ? context.action_history : [],
  };
  return {
    id: input.id,
    version: 1,
    registryVersion: CONSISTENCY_SCENARIO_REGISTRY_VERSION,
    title: input.title,
    summary: input.summary,
    role: input.role,
    tags: {
      ...input.tags,
      tableSize: input.players.length,
      contenders: expectedContenders,
    },
    preview,
    arenaState: context,
  };
}

const BLUEPRINTS: ScenarioBlueprint[] = [
  {
    id: "PF-01-DEEP-UTG-OPEN",
    title: { zh: "深筹前位开池", en: "Deep-stack UTG open" },
    summary: { zh: "9 人桌 UTG，120BB，A♣Q♣，前面无人行动。", en: "Nine-handed UTG with AcQc and 120 BB, first to act." },
    role: "MIXED",
    tags: { street: "PREFLOP", potType: "UNOPENED", position: "EARLY", stackDepth: "DEEP", handClass: "suited_broadway", boardTexture: "preflop", pressure: "first_in" },
    seatCount: 9, buttonSeat: 6, heroSeat: 0, heroCards: ["Ac", "Qc"], board: [], players: tablePlayers(9, 12_000, 0), actions: [], bigBlindAnte: 100,
  },
  {
    id: "PF-02-DEEP-BTN-VS-OPEN",
    title: { zh: "深筹按钮位对抗开池", en: "Deep BTN versus open" },
    summary: { zh: "6 人桌 BTN，120BB，A♠5♠，CO Open 2.5BB。", en: "Six-handed BTN with As5s and 120 BB versus a CO 2.5 BB open." },
    role: "MIXED",
    tags: { street: "PREFLOP", potType: "OPEN_RAISED", position: "IN_POSITION", stackDepth: "DEEP", handClass: "suited_wheel_ace", boardTexture: "preflop", pressure: "facing_open" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["As", "5s"], board: [], players: tablePlayers(6, 12_000, 3), actions: [fold(0), fold(1), raiseTo(2, 250)],
  },
  {
    id: "PF-03-MEDIUM-BB-DEFEND",
    title: { zh: "中筹码大盲防守", en: "Medium-stack BB defense" },
    summary: { zh: "6 人桌 BB，40BB，K♦Q♣，BTN Open 2.2BB。", en: "Six-handed BB with KdQc and 40 BB versus a BTN 2.2 BB open." },
    role: "MIXED",
    tags: { street: "PREFLOP", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "MEDIUM", handClass: "offsuit_broadway", boardTexture: "preflop", pressure: "facing_open" },
    seatCount: 6, buttonSeat: 3, heroSeat: 5, heroCards: ["Kd", "Qc"], board: [], players: tablePlayers(6, 4_000, 5), actions: [fold(0), fold(1), fold(2), raiseTo(3, 220), fold(4)],
  },
  {
    id: "PF-04-DEEP-SB-SQUEEZE",
    title: { zh: "深筹小盲挤压", en: "Deep-stack SB squeeze" },
    summary: { zh: "6 人桌 SB，100BB，J♠J♦，HJ Open、BTN Call。", en: "Six-handed SB with JsJd and 100 BB after a HJ open and BTN call." },
    role: "PRESSURE",
    tags: { street: "PREFLOP", potType: "MULTIWAY", position: "OUT_OF_POSITION", stackDepth: "DEEP", handClass: "premium_pair", boardTexture: "preflop", pressure: "bet_and_call" },
    seatCount: 6, buttonSeat: 3, heroSeat: 4, heroCards: ["Js", "Jd"], board: [], players: tablePlayers(6, 10_000, 4), actions: [fold(0), raiseTo(1, 250), fold(2), call(3)],
  },
  {
    id: "PF-05-SHORT-THREE-HANDED",
    title: { zh: "三人桌短码首次入池", en: "Short-stack three-handed first-in" },
    summary: { zh: "3 人桌 BTN，9BB，K♠7♠，首先行动。", en: "Three-handed BTN with Ks7s and 9 BB, first to act." },
    role: "PRESSURE",
    tags: { street: "PREFLOP", potType: "UNOPENED", position: "IN_POSITION", stackDepth: "SHORT", handClass: "suited_king", boardTexture: "preflop", pressure: "first_in" },
    seatCount: 3, buttonSeat: 0, heroSeat: 0, heroCards: ["Ks", "7s"], board: [], players: tablePlayers(3, 900, 0), actions: [],
  },
  {
    id: "PF-06-HEADS-UP-BB-DEFEND",
    title: { zh: "单挑桌大盲防守", en: "Heads-up BB defense" },
    summary: { zh: "单挑桌 BB，18BB，A♥7♣，BTN/SB Min-raise。", en: "Heads-up BB with Ah7c and 18 BB versus a BTN/SB min-raise." },
    role: "MIXED",
    tags: { street: "PREFLOP", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "SHORT", handClass: "offsuit_ace", boardTexture: "preflop", pressure: "facing_open" },
    seatCount: 2, buttonSeat: 0, heroSeat: 1, heroCards: ["Ah", "7c"], board: [], players: tablePlayers(2, 1_800, 1), actions: [raiseTo(0, 200)],
  },
  {
    id: "PF-07-SIDE-POT-PRESSURE",
    title: { zh: "多人 All-in 与边池压力", en: "Multiway all-in and side-pot pressure" },
    summary: { zh: "UTG All-in 6BB，BTN Raise to 16BB，BB 持 J♠J♥、35BB。", en: "UTG jams 6 BB, BTN raises to 16 BB, and the 35 BB hero in the BB holds JsJh." },
    role: "PRESSURE",
    tags: { street: "PREFLOP", potType: "SIDE_POT", position: "OUT_OF_POSITION", stackDepth: "MEDIUM", handClass: "premium_pair", boardTexture: "preflop", pressure: "all_in_and_raise" },
    seatCount: 6, buttonSeat: 3, heroSeat: 5, heroCards: ["Js", "Jh"], board: [],
    players: [{ seat: 0, stack: 600 }, { seat: 1, stack: 3_500 }, { seat: 2, stack: 3_500 }, { seat: 3, stack: 4_000 }, { seat: 4, stack: 3_500 }, { seat: 5, stack: 3_500 }],
    actions: [allIn(0), fold(1), fold(2), raiseTo(3, 1_600), fold(4)],
  },
  {
    id: "F-01-IP-TOP-PAIR-DRY",
    title: { zh: "有利位置的顶对", en: "Top pair in position" },
    summary: { zh: "BTN 持 A♥Q♥，Q♣7♦2♠，BB Check。", en: "BTN holds AhQh on Qc7d2s after the BB checks." },
    role: "ANCHOR",
    tags: { street: "FLOP", potType: "HEADS_UP", position: "IN_POSITION", stackDepth: "DEEP", handClass: "top_pair_strong_kicker", boardTexture: "dry_rainbow", pressure: "checked_to" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["Ah", "Qh"], board: ["Qc", "7d", "2s"], players: tablePlayers(6, 10_000, 3),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), fold(4), call(5), check(5)],
  },
  {
    id: "F-02-OOP-COMBO-DRAW",
    title: { zh: "不利位置的组合听牌", en: "Combo draw out of position" },
    summary: { zh: "BB 持 8♠7♠，9♠6♦2♠，面对 BTN 约 55% Pot C-Bet。", en: "BB holds 8s7s on 9s6d2s facing a roughly 55% pot BTN c-bet." },
    role: "MIXED",
    tags: { street: "FLOP", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "DEEP", handClass: "combo_draw", boardTexture: "connected_two_tone", pressure: "facing_bet" },
    seatCount: 6, buttonSeat: 3, heroSeat: 5, heroCards: ["8s", "7s"], board: ["9s", "6d", "2s"], players: tablePlayers(6, 10_000, 5),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), fold(4), call(5), check(5), betTo(3, 300)],
  },
  {
    id: "F-03-MULTIWAY-SANDWICH",
    title: { zh: "多人池夹心位边缘顶对", en: "Marginal top pair in the sandwich" },
    summary: { zh: "三人池 CO 持 A♦8♦，A♣J♠7♥，UTG Bet，BTN 尚未行动。", en: "In a three-way pot, CO holds Ad8d on AcJs7h facing a UTG bet with BTN behind." },
    role: "PRESSURE",
    tags: { street: "FLOP", potType: "MULTIWAY", position: "SANDWICH", stackDepth: "DEEP", handClass: "top_pair_weak_kicker", boardTexture: "dry_rainbow", pressure: "bet_with_player_behind" },
    seatCount: 6, buttonSeat: 3, heroSeat: 2, heroCards: ["Ad", "8d"], board: ["Ac", "Js", "7h"], players: tablePlayers(6, 10_000, 2),
    actions: [raiseTo(0, 250), fold(1), call(2), call(3), fold(4), fold(5), betTo(0, 500)],
  },
  {
    id: "F-04-FOUR-WAY-SET-WET",
    title: { zh: "四人池湿润牌面暗三条", en: "Set on a wet four-way flop" },
    summary: { zh: "BTN 持 9♣9♦，9♥8♥6♣，面对 HJ Bet、CO Call。", en: "BTN holds 9c9d on 9h8h6c facing a HJ bet and CO call." },
    role: "PRESSURE",
    tags: { street: "FLOP", potType: "MULTIWAY", position: "IN_POSITION", stackDepth: "DEEP", handClass: "set", boardTexture: "very_wet_two_tone", pressure: "bet_and_call" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["9c", "9d"], board: ["9h", "8h", "6c"], players: tablePlayers(6, 10_000, 3),
    actions: [fold(0), raiseTo(1, 250), call(2), call(3), fold(4), call(5), check(5), betTo(1, 700), call(2)],
  },
  {
    id: "F-05-THREE-BET-PAIRED",
    title: { zh: "3-Bet Pot 的对子牌面", en: "Paired flop in a 3-bet pot" },
    summary: { zh: "SB 持 A♠A♦，K♣K♦7♣，在 3-Bet Pot 中首先行动。", en: "SB holds AsAd on KcKd7c and acts first in a 3-bet pot." },
    role: "ANCHOR",
    tags: { street: "FLOP", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "DEEP", handClass: "overpair", boardTexture: "paired_two_tone", pressure: "first_to_act" },
    seatCount: 6, buttonSeat: 3, heroSeat: 4, heroCards: ["As", "Ad"], board: ["Kc", "Kd", "7c"], players: tablePlayers(6, 10_000, 4),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), raiseTo(4, 900), fold(5), call(3)],
  },
  {
    id: "T-01-OOP-OVERPAIR-DYNAMIC",
    title: { zh: "危险转牌上的超对", en: "Overpair on a dynamic turn" },
    summary: { zh: "SB 持 Q♠Q♦，J♣8♠3♦/T♠，Flop C-Bet 被 Call。", en: "SB holds QsQd on Jc8s3d/Ts after a flop c-bet is called." },
    role: "MIXED",
    tags: { street: "TURN", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "DEEP", handClass: "overpair", boardTexture: "dynamic_turn", pressure: "first_to_act_after_call" },
    seatCount: 6, buttonSeat: 3, heroSeat: 4, heroCards: ["Qs", "Qd"], board: ["Jc", "8s", "3d", "Ts"], players: tablePlayers(6, 10_000, 4),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), raiseTo(4, 900), fold(5), call(3), betTo(4, 600), call(3)],
  },
  {
    id: "T-02-IP-NUT-DRAW",
    title: { zh: "有利位置的坚果听牌", en: "Nut draw in position" },
    summary: { zh: "CO 持 A♠5♠，K♠7♦2♠/4♣，Flop Bet 被 Call，Turn Check 到 Hero。", en: "CO holds As5s on Ks7d2s/4c after a flop bet-call and a turn check." },
    role: "MIXED",
    tags: { street: "TURN", potType: "HEADS_UP", position: "IN_POSITION", stackDepth: "DEEP", handClass: "nut_flush_draw_gutshot", boardTexture: "two_tone_low_turn", pressure: "checked_to" },
    seatCount: 6, buttonSeat: 3, heroSeat: 2, heroCards: ["As", "5s"], board: ["Ks", "7d", "2s", "4c"], players: tablePlayers(6, 10_000, 2),
    actions: [fold(0), fold(1), raiseTo(2, 250), fold(3), fold(4), call(5), check(5), betTo(2, 200), call(5), check(5)],
  },
  {
    id: "T-03-MULTIWAY-FLUSH-PAIRED",
    title: { zh: "多人池对子面成花", en: "Made flush on a paired multiway turn" },
    summary: { zh: "BTN 持 J♥T♥，A♥8♥3♣/3♥，面对 UTG Bet、CO Call。", en: "BTN holds JhTh on Ah8h3c/3h facing a UTG bet and CO call." },
    role: "PRESSURE",
    tags: { street: "TURN", potType: "MULTIWAY", position: "IN_POSITION", stackDepth: "DEEP", handClass: "made_flush_non_nut", boardTexture: "paired_monotone_turn", pressure: "bet_and_call" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["Jh", "Th"], board: ["Ah", "8h", "3c", "3h"], players: tablePlayers(6, 10_000, 3),
    actions: [raiseTo(0, 250), fold(1), call(2), call(3), fold(4), fold(5), check(0), check(2), check(3), betTo(0, 500), call(2)],
  },
  {
    id: "T-04-LOW-SPR-FACING-JAM",
    title: { zh: "低 SPR 面对 All-in", en: "Low-SPR decision facing a jam" },
    summary: { zh: "BB 持 K♦Q♠，K♣J♣8♦/2♠，Turn 面对 BTN All-in。", en: "BB holds KdQs on KcJc8d/2s facing a BTN turn jam." },
    role: "PRESSURE",
    tags: { street: "TURN", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "SHORT", handClass: "top_pair_strong_kicker", boardTexture: "wet_low_spr", pressure: "facing_all_in" },
    seatCount: 6, buttonSeat: 3, heroSeat: 5, heroCards: ["Kd", "Qs"], board: ["Kc", "Jc", "8d", "2s"], players: tablePlayers(6, 2_000, 5),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), fold(4), call(5), check(5), betTo(3, 400), call(5), check(5), allIn(3)],
  },
  {
    id: "R-01-IP-BLUFF-CATCHER",
    title: { zh: "河牌面对 Overbet 的 Bluff Catcher", en: "River bluff catcher versus overbet" },
    summary: { zh: "BTN 持 Q♣J♣，Q♦9♠7♠/2♣/A♥，面对 BB River Overbet。", en: "BTN holds QcJc on Qd9s7s/2c/Ah facing a BB river overbet." },
    role: "MIXED",
    tags: { street: "RIVER", potType: "HEADS_UP", position: "IN_POSITION", stackDepth: "DEEP", handClass: "bluff_catcher", boardTexture: "river_overcard_missed_draws", pressure: "facing_overbet" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["Qc", "Jc"], board: ["Qd", "9s", "7s", "2c", "Ah"], players: tablePlayers(6, 10_000, 3),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), fold(4), call(5), check(5), betTo(3, 200), call(5), check(5), check(3), betTo(5, 1_200)],
  },
  {
    id: "R-02-IP-NUTS-SIZING",
    title: { zh: "坚果牌的河牌价值尺寸", en: "River value sizing with the nuts" },
    summary: { zh: "BTN 持 A♠J♦，K♣Q♦T♠/3♥/2♣，BB River Check。", en: "BTN holds AsJd on KcQdTs/3h/2c after the BB checks the river." },
    role: "ANCHOR",
    tags: { street: "RIVER", potType: "HEADS_UP", position: "IN_POSITION", stackDepth: "DEEP", handClass: "nut_straight", boardTexture: "dry_runout", pressure: "checked_to" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["As", "Jd"], board: ["Kc", "Qd", "Ts", "3h", "2c"], players: tablePlayers(6, 10_000, 3),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), fold(4), call(5), check(5), betTo(3, 300), call(5), check(5), betTo(3, 700), call(5), check(5)],
  },
  {
    id: "R-03-OOP-MISSED-DRAW",
    title: { zh: "不利位置的错失听牌", en: "Missed draw out of position" },
    summary: { zh: "BB 持 8♠7♠，A♣K♦6♠/5♥/2♣，River 首先行动。", en: "BB holds 8s7s on AcKd6s/5h/2c and acts first on the river." },
    role: "MIXED",
    tags: { street: "RIVER", potType: "HEADS_UP", position: "OUT_OF_POSITION", stackDepth: "DEEP", handClass: "missed_straight_draw_air", boardTexture: "missed_draw_runout", pressure: "first_to_act" },
    seatCount: 6, buttonSeat: 3, heroSeat: 5, heroCards: ["8s", "7s"], board: ["Ac", "Kd", "6s", "5h", "2c"], players: tablePlayers(6, 10_000, 5),
    actions: [fold(0), fold(1), fold(2), raiseTo(3, 250), fold(4), call(5), check(5), betTo(3, 200), call(5), check(5), check(3)],
  },
  {
    id: "R-04-MULTIWAY-NUT-FLUSH-PAIRED",
    title: { zh: "多人池对子面坚果同花", en: "Nut flush on a paired multiway river" },
    summary: { zh: "BTN 持 K♣Q♣，A♣9♣4♣/2♦/2♠，面对 UTG Bet、CO Call。", en: "BTN holds KcQc on Ac9c4c/2d/2s facing a UTG bet and CO call." },
    role: "PRESSURE",
    tags: { street: "RIVER", potType: "MULTIWAY", position: "IN_POSITION", stackDepth: "DEEP", handClass: "nut_flush_on_paired_board", boardTexture: "monotone_paired_river", pressure: "bet_and_call" },
    seatCount: 6, buttonSeat: 3, heroSeat: 3, heroCards: ["Kc", "Qc"], board: ["Ac", "9c", "4c", "2d", "2s"], players: tablePlayers(6, 10_000, 3),
    actions: [raiseTo(0, 250), fold(1), call(2), call(3), fold(4), fold(5), betTo(0, 400), call(2), call(3), check(0), check(2), check(3), betTo(0, 1_200), call(2)],
  },
];

export const CONSISTENCY_SCENARIOS: readonly ConsistencyScenario[] = Object.freeze(BLUEPRINTS.map(buildScenario));

const QUICK_IDS = [
  "PF-02-DEEP-BTN-VS-OPEN",
  "F-02-OOP-COMBO-DRAW",
  "T-04-LOW-SPR-FACING-JAM",
  "R-01-IP-BLUFF-CATCHER",
] as const;

const STANDARD_IDS = [
  "PF-01-DEEP-UTG-OPEN",
  "PF-02-DEEP-BTN-VS-OPEN",
  "PF-03-MEDIUM-BB-DEFEND",
  "PF-05-SHORT-THREE-HANDED",
  "PF-06-HEADS-UP-BB-DEFEND",
  "F-01-IP-TOP-PAIR-DRY",
  "F-02-OOP-COMBO-DRAW",
  "F-03-MULTIWAY-SANDWICH",
  "T-01-OOP-OVERPAIR-DYNAMIC",
  "T-02-IP-NUT-DRAW",
  "T-04-LOW-SPR-FACING-JAM",
  "R-01-IP-BLUFF-CATCHER",
] as const;

export const CONSISTENCY_PRESETS: Readonly<Record<ConsistencyTier, readonly string[]>> = Object.freeze({
  quick: QUICK_IDS,
  standard: STANDARD_IDS,
  full: CONSISTENCY_SCENARIOS.map((scenario) => scenario.id),
});

export function consistencyScenario(id: string): ConsistencyScenario | null {
  return CONSISTENCY_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function consistencyScenariosForTier(tier: ConsistencyTier): ConsistencyScenario[] {
  return CONSISTENCY_PRESETS[tier].map((id) => {
    const scenario = consistencyScenario(id);
    if (!scenario) throw new Error(`Unknown consistency scenario in ${tier} preset: ${id}`);
    return scenario;
  });
}
