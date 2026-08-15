import { cardCode, type Card } from "../../../../packages/domain/src/cards.js";
import type { ProjectedArenaEvent } from "../../../../packages/contracts/src/visibility.js";
import {
  BROADCAST_EQUITY_VERSION,
  calculateBroadcastEquity,
  type BroadcastEquityResult,
} from "./broadcast-equity.js";

export const BROADCAST_VIEW_VERSION = "arena-broadcast-view-v1";

interface BroadcastStatePlayer {
  id: string;
  seat: number;
  stack: number;
  folded: boolean;
  allIn: boolean;
  streetCommitted: number;
  totalCommitted: number;
}

interface BroadcastStateHand {
  handNo: number;
  phase: string;
  positions?: { button: number; smallBlind: number; bigBlind: number; headsUp: boolean };
  blinds?: { smallBlind: number; bigBlind: number; bigBlindAnte: number };
  boards: string[][];
  currentActorId?: string | null;
}

interface BroadcastState {
  tournamentId: string;
  completedHands?: number;
  players: BroadcastStatePlayer[];
  hand: BroadcastStateHand | null;
}

export interface BroadcastLastAction {
  sequence: number;
  street: string;
  action: string;
  classification: string;
  paid: number;
  amountTo: number;
  term: string | null;
}

export interface BroadcastViewPlayer {
  playerId: string;
  seat: number;
  holeCards: string[];
  stack: number;
  folded: boolean;
  allIn: boolean;
  streetCommitted: number;
  equity: number | null;
  outrightWinProbability: number | null;
  tieProbability: number | null;
  lastAction: BroadcastLastAction | null;
}

export interface BroadcastView {
  version: typeof BROADCAST_VIEW_VERSION;
  equityVersion: typeof BROADCAST_EQUITY_VERSION;
  handNo: number;
  sequence: number;
  street: string;
  board: string[];
  pot: number;
  positions: { button: number; smallBlind: number; bigBlind: number; headsUp: boolean } | null;
  blinds: { smallBlind: number; bigBlind: number; bigBlindAnte: number } | null;
  currentActorId: string | null;
  estimated: boolean;
  samples: number;
  players: BroadcastViewPlayer[];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function privateCards(event: ProjectedArenaEvent): [Card, Card] | null {
  const cards = recordValue(event.privatePayload)?.cards;
  return Array.isArray(cards) && cards.length === 2 ? cards as [Card, Card] : null;
}

function actionFromEvent(event: ProjectedArenaEvent): BroadcastLastAction | null {
  if (event.type !== "ACTION_APPLIED") return null;
  const payload = recordValue(event.publicPayload);
  const command = recordValue(payload?.command);
  const action = typeof command?.action === "string" ? command.action : "";
  const street = typeof payload?.street === "string" ? payload.street : "";
  if (!action || !street) return null;
  return {
    sequence: event.sequence,
    street,
    action,
    classification: typeof payload?.classification === "string" ? payload.classification : action,
    paid: numericValue(payload?.paid),
    amountTo: numericValue(payload?.amountTo),
    term: null,
  };
}

export class BroadcastViewBuilder {
  readonly #equityCache = new Map<string, BroadcastEquityResult>();

  buildTimeline(rawState: unknown, projectedEvents: readonly ProjectedArenaEvent[]): BroadcastView[] {
    const state = rawState as BroadcastState;
    if (!state?.tournamentId || !Array.isArray(state.players)) return [];
    const handNos = new Set<number>();
    if (typeof state.completedHands === "number" && state.completedHands > 0) handNos.add(state.completedHands);
    if (state.hand?.handNo) handNos.add(state.hand.handNo);
    return [...handNos].sort((left, right) => left - right).flatMap((handNo) => {
      const handEvents = projectedEvents
        .filter((event) => event.handNo === handNo)
        .sort((left, right) => left.sequence - right.sequence);
      if (handEvents.length === 0) return [];
      const totals = new Map(state.players.map((player) => [player.id, { contributed: 0, returned: 0, awarded: 0 }]));
      let completedStacks: Record<string, number> | null = null;
      for (const event of handEvents) {
        const payload = recordValue(event.publicPayload);
        if (event.type === "FORCED_BET_POSTED") {
          const playerId = payload?.playerId;
          if (typeof playerId === "string") {
            const total = totals.get(playerId);
            if (total) total.contributed += numericValue(payload?.amount);
          }
        }
        if (event.type === "ACTION_APPLIED" && event.actorId) {
          const total = totals.get(event.actorId);
          if (total) total.contributed += numericValue(payload?.paid);
        }
        if (event.type === "UNCALLED_BET_RETURNED") {
          const playerId = payload?.playerId;
          if (typeof playerId === "string") {
            const total = totals.get(playerId);
            if (total) total.returned += numericValue(payload?.amount);
          }
        }
        if (event.type === "POT_AWARDED") {
          const award = recordValue(payload?.award);
          const playerId = award?.playerId;
          if (typeof playerId === "string") {
            const total = totals.get(playerId);
            if (total) total.awarded += numericValue(award?.amount);
          }
        }
        if (event.type === "HAND_COMPLETED") {
          const stacks = recordValue(recordValue(payload?.result)?.stacks);
          if (stacks) completedStacks = Object.fromEntries(
            Object.entries(stacks).flatMap(([playerId, value]) => typeof value === "number" ? [[playerId, value]] : []),
          );
        }
      }
      const startingStacks = new Map(state.players.map((player) => {
        const total = totals.get(player.id) ?? { contributed: 0, returned: 0, awarded: 0 };
        const completedStack = completedStacks?.[player.id];
        const starting = completedStack !== undefined
          ? completedStack + total.contributed - total.returned - total.awarded
          : state.hand?.handNo === handNo
            ? player.stack + player.totalCommitted
            : player.stack;
        return [player.id, Math.max(0, starting)] as const;
      }));
      const ledgers = new Map(state.players.map((player) => [player.id, {
        stack: startingStacks.get(player.id) ?? player.stack,
        folded: false,
        allIn: false,
        streetCommitted: 0,
        totalCommitted: 0,
      }]));
      const positionsEvent = handEvents.find((event) => event.type === "HAND_STARTED");
      const positions = recordValue(recordValue(positionsEvent?.publicPayload)?.positions) as BroadcastStateHand["positions"] | null;
      const blindEvent = projectedEvents.find((event) => {
        if (event.type !== "BLIND_LEVEL_SELECTED") return false;
        return recordValue(event.publicPayload)?.handNo === handNo;
      });
      const blindLevel = recordValue(recordValue(blindEvent?.publicPayload)?.level);
      const blinds = blindLevel ? {
        smallBlind: numericValue(blindLevel.smallBlind),
        bigBlind: numericValue(blindLevel.bigBlind),
        bigBlindAnte: numericValue(blindLevel.bigBlindAnte),
      } : null;
      const board: string[] = [];
      const frames: BroadcastView[] = [];
      let phase = "PREFLOP";
      for (const [index, event] of handEvents.entries()) {
        const payload = recordValue(event.publicPayload);
        if (event.type === "FORCED_BET_POSTED") {
          const playerId = payload?.playerId;
          const ledger = typeof playerId === "string" ? ledgers.get(playerId) : null;
          const amount = numericValue(payload?.amount);
          if (ledger) {
            ledger.stack = Math.max(0, ledger.stack - amount);
            if (payload?.live === true) ledger.streetCommitted += amount;
            ledger.totalCommitted += amount;
            ledger.allIn = ledger.stack === 0;
          }
        }
        if (event.type === "ACTION_APPLIED" && event.actorId) {
          const ledger = ledgers.get(event.actorId);
          const amount = numericValue(payload?.paid);
          const command = recordValue(payload?.command);
          if (ledger) {
            ledger.stack = Math.max(0, ledger.stack - amount);
            ledger.streetCommitted += amount;
            ledger.totalCommitted += amount;
            ledger.folded = payload?.classification === "fold";
            ledger.allIn = command?.action === "all_in" || ledger.stack === 0;
          }
          if (typeof payload?.street === "string") phase = payload.street;
        }
        if (event.type === "STREET_DEALT") {
          for (const ledger of ledgers.values()) ledger.streetCommitted = 0;
          const cards = payload?.cards;
          if (Array.isArray(cards)) board.push(...(cards as Card[]).map(cardCode));
          if (typeof payload?.street === "string") phase = payload.street;
        }
        if (event.type === "UNCALLED_BET_RETURNED") {
          const playerId = payload?.playerId;
          const ledger = typeof playerId === "string" ? ledgers.get(playerId) : null;
          const amount = numericValue(payload?.amount);
          if (ledger) {
            ledger.stack += amount;
            ledger.streetCommitted = Math.max(0, ledger.streetCommitted - amount);
            ledger.totalCommitted = Math.max(0, ledger.totalCommitted - amount);
            ledger.allIn = ledger.stack === 0;
          }
        }
        if (event.type === "POT_AWARDED") {
          const award = recordValue(payload?.award);
          const playerId = award?.playerId;
          const ledger = typeof playerId === "string" ? ledgers.get(playerId) : null;
          if (ledger) ledger.stack += numericValue(award?.amount);
        }

        const isFrame = (event.type === "BETTING_ROUND_STARTED" && payload?.street === "PREFLOP")
          || event.type === "ACTION_APPLIED"
          || event.type === "STREET_DEALT"
          || event.type === "SHOWDOWN_REVEALED";
        if (!isFrame) continue;
        const syntheticState: BroadcastState = {
          tournamentId: state.tournamentId,
          ...(state.completedHands !== undefined ? { completedHands: state.completedHands } : {}),
          players: state.players.map((player) => {
            const ledger = ledgers.get(player.id)!;
            return {
              ...player,
              stack: ledger.stack,
              folded: ledger.folded,
              allIn: ledger.allIn,
              streetCommitted: ledger.streetCommitted,
              totalCommitted: ledger.totalCommitted,
            };
          }),
          hand: {
            handNo,
            phase: event.type === "SHOWDOWN_REVEALED" ? "SHOWDOWN" : phase,
            ...(positions ? { positions } : {}),
            ...(blinds ? { blinds } : {}),
            boards: [[...board]],
            currentActorId: event.type === "BETTING_ROUND_STARTED"
              && typeof payload?.actorId === "string" ? payload.actorId : null,
          },
        };
        const frame = this.build(syntheticState, handEvents.slice(0, index + 1));
        if (frame) frames.push({ ...frame, sequence: event.sequence });
      }
      return frames;
    });
  }

  build(rawState: unknown, projectedEvents: readonly ProjectedArenaEvent[]): BroadcastView | null {
    const state = rawState as BroadcastState;
    const hand = state?.hand;
    if (!state?.tournamentId || !hand || !Array.isArray(state.players) || !Array.isArray(hand.boards)) return null;
    const events = projectedEvents.filter((event) => event.handNo === hand.handNo);
    const holeCards = new Map<string, [Card, Card]>();
    const latestActions = new Map<string, BroadcastLastAction>();
    let preflopRaiseCount = 0;
    for (const event of events) {
      if (event.type === "HOLE_CARDS_DEALT") {
        const playerId = recordValue(event.publicPayload)?.playerId;
        const cards = privateCards(event);
        if (typeof playerId === "string" && cards) holeCards.set(playerId, cards);
      }
      const action = actionFromEvent(event);
      if (action && event.actorId) {
        const aggressive = ["bet", "raise", "short_raise"].includes(action.classification);
        if (action.street === "PREFLOP" && action.classification === "call" && preflopRaiseCount === 0) {
          action.term = action.action === "all_in" ? "ALL-IN" : "LIMP";
        } else if (action.street === "PREFLOP" && aggressive) {
          preflopRaiseCount += 1;
          action.term = preflopRaiseCount === 1 ? "OPEN" : `${preflopRaiseCount + 1}-BET`;
          if (action.action === "all_in") action.term += " JAM";
        } else if (action.action === "all_in") {
          action.term = aggressive ? "JAM" : "ALL-IN";
        }
        latestActions.set(event.actorId, action);
      }
    }
    const dealtPlayers = state.players.flatMap((player) => {
      const cards = holeCards.get(player.id);
      return cards ? [{ playerId: player.id, holeCards: cards, folded: player.folded }] : [];
    });
    if (dealtPlayers.length === 0) return null;
    const boardCodes = hand.boards[0] ?? [];
    const board = boardCodes.map((code) => {
      const card = events
        .filter((event) => event.type === "STREET_DEALT")
        .flatMap((event) => {
          const cards = recordValue(event.publicPayload)?.cards;
          return Array.isArray(cards) ? cards as Card[] : [];
        })
        .find((candidate) => cardCode(candidate) === code);
      if (!card) throw new Error(`Broadcast board card ${code} is missing from public events`);
      return card;
    });
    const equityKey = [
      state.tournamentId,
      hand.handNo,
      boardCodes.join(""),
      ...dealtPlayers.map((player) => `${player.playerId}:${player.holeCards.map(cardCode).join("")}:${player.folded ? 1 : 0}`),
    ].join("|");
    let equity = this.#equityCache.get(equityKey);
    if (!equity) {
      equity = calculateBroadcastEquity(dealtPlayers, board, { seed: equityKey });
      this.#equityCache.set(equityKey, equity);
      if (this.#equityCache.size > 256) this.#equityCache.delete(this.#equityCache.keys().next().value!);
    }
    const equityByPlayer = new Map(equity.players.map((player) => [player.playerId, player]));
    const currentStreet = ["PREFLOP", "FLOP", "TURN", "RIVER"].includes(hand.phase) ? hand.phase : null;
    return {
      version: BROADCAST_VIEW_VERSION,
      equityVersion: equity.version,
      handNo: hand.handNo,
      sequence: events.at(-1)?.sequence ?? 0,
      street: hand.phase,
      board: [...boardCodes],
      pot: state.players.reduce((sum, player) => sum + Math.max(0, player.totalCommitted), 0),
      positions: hand.positions ?? null,
      blinds: hand.blinds ?? null,
      currentActorId: hand.currentActorId ?? null,
      estimated: equity.estimated,
      samples: equity.samples,
      players: state.players.flatMap((player) => {
        const cards = holeCards.get(player.id);
        if (!cards) return [];
        const playerEquity = equityByPlayer.get(player.id);
        const lastAction = latestActions.get(player.id) ?? null;
        return [{
          playerId: player.id,
          seat: player.seat,
          holeCards: cards.map(cardCode),
          stack: player.stack,
          folded: player.folded,
          allIn: player.allIn,
          streetCommitted: player.streetCommitted,
          equity: playerEquity?.equity ?? null,
          outrightWinProbability: playerEquity?.outrightWinProbability ?? null,
          tieProbability: playerEquity?.tieProbability ?? null,
          lastAction: currentStreet === null || lastAction?.street === currentStreet ? lastAction : null,
        }];
      }),
    };
  }
}
