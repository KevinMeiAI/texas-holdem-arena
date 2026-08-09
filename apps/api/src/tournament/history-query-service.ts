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

function mapRows(rows: readonly PublicEventRow[]): HistoryPublicEvent[] {
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    handNo: row.hand_no,
    type: row.event_type,
    actorId: row.actor_id,
    publicPayload: row.public_payload,
  }));
}

const columns = "sequence, hand_no, event_type, actor_id, public_payload";

export class HistoryQueryService {
  constructor(private readonly pool: Pool) {}

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
      const result = await this.pool.query<PublicEventRow>(
        `select ${columns} from arena_events
          where tournament_id = $1 and hand_no = $2
          order by sequence limit $3`,
        [tournamentId, query.hand_no, query.limit],
      );
      return mapRows(result.rows);
    }
    if (query.kind === "recent_hands") {
      const result = await this.pool.query<PublicEventRow>(
        `with recent as (
           select distinct hand_no from arena_events
            where tournament_id = $1 and hand_no < $2 and hand_no is not null
            order by hand_no desc limit $3
         ), bounded as (
           select ${columns} from arena_events
            where tournament_id = $1 and hand_no in (select hand_no from recent)
            order by sequence desc limit $4
         )
         select * from bounded order by sequence`,
        [tournamentId, currentHandNo, query.count, query.limit],
      );
      return mapRows(result.rows);
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
      const result = await this.pool.query<PublicEventRow>(
        `select * from (
           select ${columns} from arena_events
            where ${filters.join(" and ")}
            order by sequence desc limit $${parameters.length}
         ) bounded order by sequence`,
        parameters,
      );
      return mapRows(result.rows);
    }

    const parameters: unknown[] = [tournamentId, currentHandNo];
    const playerFilter = query.player_id ? "and actor_id = $3" : "";
    if (query.player_id) parameters.push(query.player_id);
    parameters.push(query.limit);
    const limitParameter = parameters.length;
    const result = await this.pool.query<{
      actor_id: string;
      actions: string;
      folds: string;
      calls: string;
      aggressive_actions: string;
    }>(
      `select actor_id,
              count(*)::text as actions,
              count(*) filter (where public_payload->'command'->>'action' = 'fold')::text as folds,
              count(*) filter (where public_payload->'command'->>'action' = 'call')::text as calls,
              count(*) filter (where public_payload->'command'->>'action' in ('bet','raise','all_in'))::text as aggressive_actions
         from arena_events
        where tournament_id = $1 and hand_no < $2
          and event_type = 'ACTION_APPLIED' ${playerFilter}
        group by actor_id order by actor_id limit $${limitParameter}`,
      parameters,
    );
    return result.rows.map((row) => ({
      playerId: row.actor_id,
      actions: Number(row.actions),
      folds: Number(row.folds),
      calls: Number(row.calls),
      aggressiveActions: Number(row.aggressive_actions),
    }));
  }
}
