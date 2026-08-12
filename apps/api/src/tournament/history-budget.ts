import type { HistoryQuery } from "../../../../packages/contracts/src/model-protocol.js";
import { ModelProtocolError } from "../../../../packages/contracts/src/model-protocol.js";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";

export interface HistoryBudgetConfig {
  maxQueries: number;
  maxRecordsPerQuery: number;
  maxApproxTokens: number;
  maxBytes?: number;
}

export interface HistoryBudgetState extends HistoryBudgetConfig {
  usedQueries: number;
  usedRecords: number;
  usedApproxTokens: number;
  maxBytes: number;
  usedBytes: number;
}

export interface HistoryQueryResult {
  query: HistoryQuery;
  records: unknown[];
  approximateTokens: number;
  retainedBytes?: number;
  complete?: boolean;
  truncated?: boolean;
  truncationReason?: "RECORD_LIMIT" | "BYTE_BUDGET" | null;
  omittedRecords?: number;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function shrinkRecord(value: unknown, maximumBytes: number): unknown | null {
  if (jsonBytes(value) <= maximumBytes) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const compact = structuredClone(value) as Record<string, unknown>;
  for (const key of ["prior_actions_this_street", "actions", "awards", "forced_bets", "board"] as const) {
    const entries = compact[key];
    if (!Array.isArray(entries)) continue;
    while (entries.length > 0 && jsonBytes(compact) > maximumBytes) entries.pop();
  }
  if (jsonBytes(compact) <= maximumBytes) {
    compact.result_truncated = true;
    return jsonBytes(compact) <= maximumBytes ? compact : null;
  }
  const identity = Object.fromEntries(
    ["kind", "hand_no", "sequence", "player_id", "complete", "total_action_count"]
      .flatMap((key) => Object.hasOwn(compact, key) ? [[key, compact[key]]] : []),
  );
  const minimal = { ...identity, result_truncated: true };
  return jsonBytes(minimal) <= maximumBytes ? minimal : null;
}

export class HistoryBudget {
  #state: HistoryBudgetState;

  constructor(config: HistoryBudgetConfig) {
    if (!Number.isSafeInteger(config.maxQueries) || config.maxQueries < 0
      || !Number.isSafeInteger(config.maxRecordsPerQuery) || config.maxRecordsPerQuery < 1
      || !Number.isSafeInteger(config.maxApproxTokens) || config.maxApproxTokens < 1) {
      throw new Error("Invalid history budget configuration");
    }
    const maxBytes = config.maxBytes ?? config.maxApproxTokens * 4;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid history byte budget");
    this.#state = { ...config, maxBytes, usedQueries: 0, usedRecords: 0, usedApproxTokens: 0, usedBytes: 0 };
  }

  get state(): HistoryBudgetState {
    return { ...this.#state };
  }

  consume(query: HistoryQuery, records: readonly unknown[]): HistoryQueryResult {
    if (this.#state.usedQueries >= this.#state.maxQueries) {
      throw new ModelProtocolError("HISTORY_QUERY_INVALID", "History query budget is exhausted");
    }
    if (query.limit > this.#state.maxRecordsPerQuery || records.length > query.limit
      || records.length > this.#state.maxRecordsPerQuery) {
      throw new ModelProtocolError("HISTORY_QUERY_INVALID", "History query exceeds the record limit");
    }
    const approximateTokens = Math.ceil(JSON.stringify(records).length / 4);
    if (this.#state.usedApproxTokens + approximateTokens > this.#state.maxApproxTokens) {
      throw new Error("History query exceeds the cumulative token budget");
    }
    this.#state = {
      ...this.#state,
      usedQueries: this.#state.usedQueries + 1,
      usedRecords: this.#state.usedRecords + records.length,
      usedApproxTokens: this.#state.usedApproxTokens + approximateTokens,
    };
    return { query, records: [...records], approximateTokens };
  }

  consumeBounded(query: HistoryQuery, records: readonly unknown[]): HistoryQueryResult {
    if (this.#state.usedQueries >= this.#state.maxQueries) {
      throw new ModelProtocolError("HISTORY_QUERY_INVALID", "History query budget is exhausted");
    }
    if (query.limit > this.#state.maxRecordsPerQuery) {
      throw new ModelProtocolError("HISTORY_QUERY_INVALID", "History query exceeds the record limit");
    }
    const recordBounded = records.slice(0, Math.min(query.limit, this.#state.maxRecordsPerQuery));
    const availableBytes = this.#state.maxBytes - this.#state.usedBytes;
    const retained: unknown[] = [];
    for (const record of recordBounded) {
      const remaining = availableBytes - jsonBytes(retained);
      if (remaining <= 2) break;
      const fitted = shrinkRecord(record, remaining - 2);
      if (fitted === null) break;
      const candidate = [...retained, fitted];
      if (jsonBytes(candidate) > availableBytes) break;
      retained.push(fitted);
    }
    const retainedBytes = retained.length === 0 && availableBytes < 2 ? 0 : jsonBytes(retained);
    const recordLimitTruncated = records.length > recordBounded.length;
    const byteTruncated = retained.length < recordBounded.length
      || retained.some((record) => Boolean((record as { result_truncated?: unknown })?.result_truncated));
    const truncated = recordLimitTruncated || byteTruncated;
    const approximateTokens = Math.ceil(retainedBytes / 4);
    this.#state = {
      ...this.#state,
      usedQueries: this.#state.usedQueries + 1,
      usedRecords: this.#state.usedRecords + retained.length,
      usedApproxTokens: this.#state.usedApproxTokens + approximateTokens,
      usedBytes: this.#state.usedBytes + retainedBytes,
    };
    return {
      query,
      records: retained,
      approximateTokens,
      retainedBytes,
      complete: !truncated,
      truncated,
      truncationReason: recordLimitTruncated ? "RECORD_LIMIT" : byteTruncated ? "BYTE_BUDGET" : null,
      omittedRecords: Math.max(0, records.length - retained.length),
    };
  }
}
