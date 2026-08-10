import type { HistoryQuery } from "../../../../packages/contracts/src/model-protocol.js";

export interface HistoryBudgetConfig {
  maxQueries: number;
  maxRecordsPerQuery: number;
  maxApproxTokens: number;
}

export interface HistoryBudgetState extends HistoryBudgetConfig {
  usedQueries: number;
  usedRecords: number;
  usedApproxTokens: number;
}

export interface HistoryQueryResult {
  query: HistoryQuery;
  records: unknown[];
  approximateTokens: number;
}

export class HistoryBudget {
  #state: HistoryBudgetState;

  constructor(config: HistoryBudgetConfig) {
    if (!Number.isSafeInteger(config.maxQueries) || config.maxQueries < 0
      || !Number.isSafeInteger(config.maxRecordsPerQuery) || config.maxRecordsPerQuery < 1
      || !Number.isSafeInteger(config.maxApproxTokens) || config.maxApproxTokens < 1) {
      throw new Error("Invalid history budget configuration");
    }
    this.#state = { ...config, usedQueries: 0, usedRecords: 0, usedApproxTokens: 0 };
  }

  get state(): HistoryBudgetState {
    return { ...this.#state };
  }

  consume(query: HistoryQuery, records: readonly unknown[]): HistoryQueryResult {
    if (this.#state.usedQueries >= this.#state.maxQueries) {
      throw new Error("History query budget is exhausted");
    }
    if (query.limit > this.#state.maxRecordsPerQuery || records.length > query.limit
      || records.length > this.#state.maxRecordsPerQuery) {
      throw new Error("History query exceeds the record limit");
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
}
