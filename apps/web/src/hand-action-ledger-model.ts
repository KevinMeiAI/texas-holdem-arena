import type { ArenaEvent, ArenaPlayer } from "./types";

export const HAND_STREETS = ["PREFLOP", "FLOP", "TURN", "RIVER"] as const;

export type HandStreet = (typeof HAND_STREETS)[number];
export type HandPosition = "SB" | "BB" | null;
export type HandCellState = "FOLDED" | "ALL_IN" | "NOT_DEALT" | "NO_ACTION";

export interface HandActionAudit {
  providerCalls: number;
  protocolFailures: number;
  usedFallback: boolean;
  decisionSummary: string | null;
}

export interface HandLedgerAction {
  eventSequence: number;
  label: string;
  term: string | null;
  tone: "neutral" | "aggressive" | "terminal";
  audit: HandActionAudit | null;
}

export interface HandLedgerCell {
  actions: HandLedgerAction[];
  state: HandCellState | null;
}

export interface HandLedgerRow {
  player: ArenaPlayer;
  position: HandPosition;
  cells: Record<HandStreet, HandLedgerCell>;
}

type EventAction = {
  event: ArenaEvent;
  playerId: string;
  street: HandStreet;
  classification: string;
  commandAction: string;
  paid: number;
  amountTo: number;
  audit: HandActionAudit | null;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isStreet(value: unknown): value is HandStreet {
  return HAND_STREETS.includes(value as HandStreet);
}

function isAggressive(classification: string): boolean {
  return classification === "bet" || classification === "raise" || classification === "short_raise";
}

function readAudit(event: ArenaEvent): HandActionAudit {
  const payload = event.publicPayload;
  const summary = payload.decisionSummary;
  return {
    providerCalls: numberValue(payload.providerCalls),
    protocolFailures: numberValue(payload.protocolFailures),
    usedFallback: payload.usedFallback === true || numberValue(payload.usedFallback) > 0,
    decisionSummary: typeof summary === "string" && summary.trim() ? summary.trim() : null,
  };
}

function collectActions(events: ArenaEvent[]): EventAction[] {
  const pendingAudits = new Map<string, HandActionAudit>();
  const actions: EventAction[] = [];
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "MODEL_DECISION_RECORDED") {
      const playerId = event.actorId ?? (typeof event.publicPayload.playerId === "string" ? event.publicPayload.playerId : null);
      if (playerId) pendingAudits.set(playerId, readAudit(event));
      continue;
    }
    if (event.type !== "ACTION_APPLIED" || !event.actorId || !isStreet(event.publicPayload.street)) continue;
    const command = recordValue(event.publicPayload.command);
    const commandAction = stringValue(command?.action);
    const storedClassification = stringValue(event.publicPayload.classification);
    const classification = storedClassification || commandAction;
    actions.push({
      event,
      playerId: event.actorId,
      street: event.publicPayload.street,
      classification,
      commandAction,
      paid: numberValue(event.publicPayload.paid),
      amountTo: numberValue(event.publicPayload.amountTo ?? command?.amount_to),
      audit: pendingAudits.get(event.actorId) ?? null,
    });
    pendingAudits.delete(event.actorId);
  }
  return actions;
}

function preflopRaiseTerm(raiseNumber: number): string {
  if (raiseNumber === 1) return "Open";
  return `${raiseNumber + 1}-Bet`;
}

function actionTerm(
  action: EventAction,
  preflopRaiseNumber: number,
  preflopAggressorId: string | null,
  flopAggressionCount: number,
): string | null {
  const allIn = action.commandAction === "all_in";
  if (action.street === "PREFLOP") {
    if (action.classification === "call" && preflopRaiseNumber === 0) return allIn ? "All-in" : "Limp";
    if (isAggressive(action.classification)) {
      const term = preflopRaiseTerm(preflopRaiseNumber);
      return allIn ? `${term} Jam` : term;
    }
    return allIn ? "All-in" : null;
  }
  if (action.street === "FLOP"
    && action.classification === "bet"
    && action.playerId === preflopAggressorId
    && flopAggressionCount === 0) {
    return allIn ? "C-Bet Jam" : "C-Bet";
  }
  if (allIn) return isAggressive(action.classification) ? "Jam" : "All-in";
  return null;
}

function formattedAmount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function actionLabel(action: EventAction): string {
  const allIn = action.commandAction === "all_in";
  if (allIn) {
    const prefix = action.classification === "call" ? "全下跟注至"
      : action.classification === "bet" ? "全下下注至"
        : action.classification === "raise" || action.classification === "short_raise" ? "全下加注至"
          : "全下至";
    return action.amountTo > 0 ? `${prefix} ${formattedAmount(action.amountTo)}` : prefix.replace(/至$/, "");
  }
  if (action.classification === "fold") return "弃牌";
  if (action.classification === "check") return "过牌";
  if (action.classification === "call") return action.paid > 0 ? `跟注 ${formattedAmount(action.paid)}` : "跟注";
  if (action.classification === "bet") return action.amountTo > 0 ? `下注至 ${formattedAmount(action.amountTo)}` : "下注";
  if (action.classification === "raise" || action.classification === "short_raise") {
    return action.amountTo > 0 ? `加注至 ${formattedAmount(action.amountTo)}` : "加注";
  }
  const fallback = action.commandAction.replaceAll("_", " ").trim();
  return fallback ? fallback.toUpperCase() : "行动";
}

function actionTone(classification: string): HandLedgerAction["tone"] {
  if (classification === "fold") return "terminal";
  return isAggressive(classification) ? "aggressive" : "neutral";
}

function emptyCells(): Record<HandStreet, HandLedgerCell> {
  return {
    PREFLOP: { actions: [], state: null },
    FLOP: { actions: [], state: null },
    TURN: { actions: [], state: null },
    RIVER: { actions: [], state: null },
  };
}

export function buildHandActionLedger(players: ArenaPlayer[], events: ArenaEvent[]): HandLedgerRow[] {
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  const actions = collectActions(orderedEvents);
  const participantIds = new Set<string>();
  for (const event of orderedEvents) {
    if (event.type === "HOLE_CARDS_DEALT" && typeof event.publicPayload.playerId === "string") {
      participantIds.add(event.publicPayload.playerId);
    }
  }
  for (const action of actions) participantIds.add(action.playerId);

  const handStarted = orderedEvents.find((event) => event.type === "HAND_STARTED");
  const positions = recordValue(handStarted?.publicPayload.positions);
  const smallBlindSeat = numberValue(positions?.smallBlind);
  const bigBlindSeat = numberValue(positions?.bigBlind);
  const hasSmallBlind = Number.isSafeInteger(Number(positions?.smallBlind));
  const hasBigBlind = Number.isSafeInteger(Number(positions?.bigBlind));

  const rows = players
    .filter((player) => participantIds.has(player.id))
    .sort((left, right) => left.seat - right.seat)
    .map<HandLedgerRow>((player) => ({
      player,
      position: hasSmallBlind && player.seat === smallBlindSeat ? "SB"
        : hasBigBlind && player.seat === bigBlindSeat ? "BB" : null,
      cells: emptyCells(),
    }));
  const rowByPlayer = new Map(rows.map((row) => [row.player.id, row]));

  const preflopAggressorId = [...actions]
    .reverse()
    .find((action) => action.street === "PREFLOP" && isAggressive(action.classification))?.playerId ?? null;
  let preflopRaiseCount = 0;
  let flopAggressionCount = 0;
  for (const action of actions) {
    const row = rowByPlayer.get(action.playerId);
    if (!row) continue;
    const raiseNumber = action.street === "PREFLOP" && isAggressive(action.classification)
      ? preflopRaiseCount + 1
      : preflopRaiseCount;
    row.cells[action.street].actions.push({
      eventSequence: action.event.sequence,
      label: actionLabel(action),
      term: actionTerm(action, raiseNumber, preflopAggressorId, flopAggressionCount),
      tone: actionTone(action.classification),
      audit: action.audit,
    });
    if (action.street === "PREFLOP" && isAggressive(action.classification)) preflopRaiseCount += 1;
    if (action.street === "FLOP" && isAggressive(action.classification)) flopAggressionCount += 1;
  }

  const dealtStreets = new Set<HandStreet>(["PREFLOP"]);
  for (const event of orderedEvents) {
    if (event.type === "STREET_DEALT" && isStreet(event.publicPayload.street)) dealtStreets.add(event.publicPayload.street);
  }
  const streetIndex = new Map(HAND_STREETS.map((street, index) => [street, index]));
  for (const row of rows) {
    const playerActions = actions.filter((action) => action.playerId === row.player.id);
    const folded = playerActions.find((action) => action.classification === "fold");
    const allIn = playerActions.find((action) => action.commandAction === "all_in");
    for (const street of HAND_STREETS) {
      const cell = row.cells[street];
      if (cell.actions.length > 0) continue;
      const index = streetIndex.get(street) ?? 0;
      const foldedEarlier = folded && (streetIndex.get(folded.street) ?? 0) < index;
      const allInEarlier = allIn && (streetIndex.get(allIn.street) ?? 0) < index;
      cell.state = foldedEarlier ? "FOLDED"
        : allInEarlier ? "ALL_IN"
          : dealtStreets.has(street) ? "NO_ACTION" : "NOT_DEALT";
    }
  }
  return rows;
}
