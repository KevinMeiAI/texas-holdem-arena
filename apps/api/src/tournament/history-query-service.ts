import type { Pool } from "pg";
import type { HistoryQuery } from "../../../../packages/contracts/src/model-protocol.js";

interface PublicEventRow {
  sequence: string;
  hand_no: number | null;
  event_type: string;
  actor_id: string | null;
  public_payload: unknown;
}

export interface HistoryPublicEvent {
  sequence: number;
  handNo: number | null;
  type: string;
  actorId: string | null;
  publicPayload: unknown;
}

interface NormalizedAction {
  sequence: number;
  street: string | null;
  player_id: string | null;
  action: string | null;
  classification: string | null;
  paid: number;
  amount_to: number;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cardCode(value: unknown): string | null {
  const card = objectValue(value);
  const rank = numericValue(card.rank);
  const suit = stringValue(card.suit);
  const symbol = rank === 10 ? "T" : rank === 11 ? "J" : rank === 12 ? "Q" : rank === 13 ? "K" : rank === 14 ? "A" : String(rank);
  return /^[2-9TJQKA]$/.test(symbol) && /^[cdhs]$/.test(suit ?? "") ? `${symbol}${suit}` : null;
}

function mapRows(rows: readonly PublicEventRow[]): HistoryPublicEvent[] {
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    handNo: row.hand_no,
    type: row.event_type,
    actorId: row.actor_id,
    publicPayload: row.public_payload,
  }));
}

function actionRecord(event: HistoryPublicEvent): NormalizedAction | null {
  if (event.type !== "ACTION_APPLIED") return null;
  const payload = objectValue(event.publicPayload);
  const command = objectValue(payload.command);
  const action = stringValue(command.action);
  const storedClassification = stringValue(payload.classification);
  return {
    sequence: event.sequence,
    street: stringValue(payload.street),
    player_id: event.actorId,
    action,
    classification: storedClassification ?? (action === "all_in" ? "all_in_unknown" : action),
    paid: numericValue(payload.paid),
    amount_to: numericValue(payload.amountTo),
  };
}

function boundedActions(actions: readonly NormalizedAction[], limit: number): {
  actions: NormalizedAction[];
  truncated: boolean;
  omitted: number;
  window: "COMPLETE" | "HEAD_AND_TAIL";
} {
  if (actions.length <= limit) {
    return { actions: [...actions], truncated: false, omitted: 0, window: "COMPLETE" };
  }
  if (limit <= 0) {
    return { actions: [], truncated: true, omitted: actions.length, window: "HEAD_AND_TAIL" };
  }
  const headCount = Math.ceil(limit / 2);
  const tailCount = limit - headCount;
  return {
    actions: [...actions.slice(0, headCount), ...(tailCount > 0 ? actions.slice(-tailCount) : [])],
    truncated: true,
    omitted: actions.length - limit,
    window: "HEAD_AND_TAIL",
  };
}

export function summarizeHistoryHand(
  rows: readonly HistoryPublicEvent[],
  actionLimit: number,
): Record<string, unknown> | null {
  const ordered = [...rows].sort((left, right) => left.sequence - right.sequence);
  const handNo = ordered.find((event) => event.handNo !== null)?.handNo ?? null;
  if (handNo === null) return null;
  const allActions = ordered.map(actionRecord).filter((action): action is NormalizedAction => action !== null);
  const limited = boundedActions(allActions, actionLimit);
  const forcedBets = ordered.filter((event) => event.type === "FORCED_BET_POSTED").map((event) => {
    const payload = objectValue(event.publicPayload);
    return {
      player_id: stringValue(payload.playerId),
      kind: stringValue(payload.kind),
      amount: numericValue(payload.amount),
      live: payload.live === true,
    };
  });
  const board = ordered.filter((event) => event.type === "STREET_DEALT").map((event) => {
    const payload = objectValue(event.publicPayload);
    return {
      street: stringValue(payload.street),
      cards: Array.isArray(payload.cards)
        ? payload.cards.map(cardCode).filter((card): card is string => card !== null)
        : [],
    };
  });
  const showdown = ordered.find((event) => event.type === "SHOWDOWN_REVEALED");
  const completed = ordered.find((event) => event.type === "HAND_COMPLETED");
  const awards = ordered.filter((event) => event.type === "POT_AWARDED")
    .map((event) => objectValue(event.publicPayload).award ?? event.publicPayload);
  return {
    kind: "hand_summary",
    hand_no: handNo,
    complete: completed !== undefined,
    forced_bets: forcedBets,
    board,
    total_action_count: allActions.length,
    actions_truncated: limited.truncated,
    omitted_action_count: limited.omitted,
    action_window: limited.window,
    actions: limited.actions,
    showdown: showdown?.publicPayload ?? null,
    awards,
    result: completed?.publicPayload ?? null,
  };
}

function contextualActions(
  rows: readonly HistoryPublicEvent[],
  selectedSequences: ReadonlySet<number>,
): Record<string, unknown>[] {
  const byHand = new Map<number, HistoryPublicEvent[]>();
  for (const event of rows) {
    if (event.handNo === null) continue;
    const handRows = byHand.get(event.handNo) ?? [];
    handRows.push(event);
    byHand.set(event.handNo, handRows);
  }
  const results: Record<string, unknown>[] = [];
  for (const [handNo, handRows] of byHand) {
    let pot = 0;
    let board: string[] = [];
    let streetActions: NormalizedAction[] = [];
    for (const event of handRows.sort((left, right) => left.sequence - right.sequence)) {
      const payload = objectValue(event.publicPayload);
      if (event.type === "FORCED_BET_POSTED") {
        pot += numericValue(payload.amount);
        continue;
      }
      if (event.type === "STREET_DEALT") {
        const dealt = Array.isArray(payload.cards)
          ? payload.cards.map(cardCode).filter((card): card is string => card !== null)
          : [];
        board = [...board, ...dealt];
        streetActions = [];
        continue;
      }
      if (event.type === "UNCALLED_BET_RETURNED") {
        pot = Math.max(0, pot - numericValue(payload.amount));
        continue;
      }
      const action = actionRecord(event);
      if (!action) continue;
      if (selectedSequences.has(event.sequence)) {
        results.push({
          kind: "contextual_player_action",
          hand_no: handNo,
          ...action,
          board_before_action: [...board],
          pot_before_action: pot,
          prior_actions_this_street: streetActions.slice(-8),
        });
      }
      pot += action.paid;
      streetActions.push(action);
    }
  }
  return results.sort((left, right) => numericValue(left.sequence) - numericValue(right.sequence));
}

interface MutablePlayerStats {
  hands: Set<number>;
  vpipHands: Set<number>;
  pfrHands: Set<number>;
  actions: number;
  counts: Record<string, number>;
  perStreet: Record<string, Record<string, number>>;
  facingBetDecisions: number;
  foldsFacingBet: number;
  allInCalls: number;
  allInAggressive: number;
  allInUnknown: number;
}

function mutableStats(): MutablePlayerStats {
  return {
    hands: new Set(),
    vpipHands: new Set(),
    pfrHands: new Set(),
    actions: 0,
    counts: {},
    perStreet: {},
    facingBetDecisions: 0,
    foldsFacingBet: 0,
    allInCalls: 0,
    allInAggressive: 0,
    allInUnknown: 0,
  };
}

export function calculatePublicStats(rows: readonly HistoryPublicEvent[]): Record<string, unknown>[] {
  const stats = new Map<string, MutablePlayerStats>();
  const get = (playerId: string) => {
    const existing = stats.get(playerId) ?? mutableStats();
    stats.set(playerId, existing);
    return existing;
  };
  for (const event of rows) {
    if (event.handNo === null) continue;
    if (event.type === "HOLE_CARDS_DEALT") {
      const playerId = stringValue(objectValue(event.publicPayload).playerId);
      if (playerId) get(playerId).hands.add(event.handNo);
      continue;
    }
    const action = actionRecord(event);
    if (!action?.player_id) continue;
    const player = get(action.player_id);
    player.hands.add(event.handNo);
    player.actions += 1;
    const classification = action.classification ?? "unknown";
    player.counts[classification] = (player.counts[classification] ?? 0) + 1;
    const street = action.street ?? "UNKNOWN";
    const streetCounts = player.perStreet[street] ?? {};
    streetCounts[classification] = (streetCounts[classification] ?? 0) + 1;
    player.perStreet[street] = streetCounts;
    if (street === "PREFLOP" && !["fold", "check"].includes(classification)) {
      player.vpipHands.add(event.handNo);
    }
    if (street === "PREFLOP" && ["bet", "raise", "short_raise"].includes(classification)) {
      player.pfrHands.add(event.handNo);
    }
    if (["fold", "call", "raise", "short_raise"].includes(classification)) {
      player.facingBetDecisions += 1;
      if (classification === "fold") player.foldsFacingBet += 1;
    }
    if (action.action === "all_in") {
      if (classification === "call") player.allInCalls += 1;
      else if (["bet", "raise", "short_raise"].includes(classification)) player.allInAggressive += 1;
      else player.allInUnknown += 1;
    }
  }
  return [...stats.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([playerId, player]) => {
    const handsObserved = player.hands.size;
    return {
      kind: "public_player_stats",
      player_id: playerId,
      hands_observed: handsObserved,
      actions_observed: player.actions,
      vpip_hands: player.vpipHands.size,
      vpip_rate: handsObserved > 0 ? player.vpipHands.size / handsObserved : null,
      pfr_hands: player.pfrHands.size,
      pfr_rate: handsObserved > 0 ? player.pfrHands.size / handsObserved : null,
      action_classification_counts: player.counts,
      actions_by_street: player.perStreet,
      facing_bet_decisions: player.facingBetDecisions,
      folds_facing_bet: player.foldsFacingBet,
      fold_rate_when_facing_bet: player.facingBetDecisions > 0
        ? player.foldsFacingBet / player.facingBetDecisions
        : null,
      all_in_calls: player.allInCalls,
      all_in_aggressive: player.allInAggressive,
      legacy_all_in_unknown: player.allInUnknown,
      sample_warning: handsObserved < 20,
    };
  });
}

const columns = "sequence, hand_no, event_type, actor_id, public_payload";

export class HistoryQueryService {
  constructor(private readonly pool: Pool) {}

  async #loadHands(tournamentId: string, handNos: readonly number[]): Promise<HistoryPublicEvent[]> {
    if (handNos.length === 0) return [];
    const result = await this.pool.query<PublicEventRow>(
      `select ${columns} from arena_events
        where tournament_id = $1 and hand_no = any($2::integer[])
        order by sequence`,
      [tournamentId, handNos],
    );
    return mapRows(result.rows);
  }

  async execute(
    tournamentId: string,
    currentHandNo: number,
    query: HistoryQuery,
  ): Promise<unknown[]> {
    if (!Number.isSafeInteger(currentHandNo) || currentHandNo < 1) {
      throw new Error("currentHandNo must be positive");
    }
    if (query.kind === "hand") {
      if (query.hand_no >= currentHandNo) throw new Error("History cannot query the current or a future hand");
      const summary = summarizeHistoryHand(await this.#loadHands(tournamentId, [query.hand_no]), query.limit);
      return summary ? [summary] : [];
    }
    if (query.kind === "recent_hands") {
      const recent = await this.pool.query<{ hand_no: number }>(
        `select distinct hand_no from arena_events
          where tournament_id = $1 and hand_no < $2 and hand_no is not null
          order by hand_no desc limit $3`,
        [tournamentId, currentHandNo, query.count],
      );
      const handNos = recent.rows.map((row) => row.hand_no);
      const rows = await this.#loadHands(tournamentId, handNos);
      let remainingActions = query.limit;
      const hands = handNos.flatMap((handNo) => {
        const summary = summarizeHistoryHand(rows.filter((event) => event.handNo === handNo), remainingActions);
        if (!summary) return [];
        remainingActions = Math.max(0, remainingActions - Number(summary.actions ? (summary.actions as unknown[]).length : 0));
        return [summary];
      });
      return [{
        kind: "recent_hands_result",
        requested_hand_count: query.count,
        returned_hand_count: hands.length,
        action_record_limit: query.limit,
        hands,
      }];
    }
    if (query.kind === "player_actions") {
      const parameters: unknown[] = [tournamentId, currentHandNo, query.player_id];
      const filters = [
        "tournament_id = $1",
        "hand_no < $2",
        "event_type = 'ACTION_APPLIED'",
        "actor_id = $3",
      ];
      if (query.streets?.length) {
        parameters.push(query.streets);
        filters.push(`public_payload->>'street' = any($${parameters.length}::text[])`);
      }
      if (query.actions?.length) {
        parameters.push(query.actions);
        filters.push(`public_payload->'command'->>'action' = any($${parameters.length}::text[])`);
      }
      parameters.push(query.limit);
      const selected = await this.pool.query<PublicEventRow>(
        `select * from (
           select ${columns} from arena_events
            where ${filters.join(" and ")}
            order by sequence desc limit $${parameters.length}
         ) bounded order by sequence`,
        parameters,
      );
      const selectedRows = mapRows(selected.rows);
      const handNos = [...new Set(selectedRows.map((event) => event.handNo).filter((handNo): handNo is number => handNo !== null))];
      const rows = await this.#loadHands(tournamentId, handNos);
      return contextualActions(rows, new Set(selectedRows.map((event) => event.sequence)));
    }

    const result = await this.pool.query<PublicEventRow>(
      `select ${columns} from arena_events
        where tournament_id = $1 and hand_no < $2
          and event_type in ('HOLE_CARDS_DEALT', 'ACTION_APPLIED')
        order by sequence`,
      [tournamentId, currentHandNo],
    );
    const allStats = calculatePublicStats(mapRows(result.rows));
    return allStats
      .filter((stats) => !query.player_id || stats.player_id === query.player_id)
      .slice(0, query.limit);
  }
}
