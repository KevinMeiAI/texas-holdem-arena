import type { HistoryQuery } from "../../../../packages/contracts/src/model-protocol.js";

export interface HistoryBudgetConfig {
  maxQueries: number;
  maxEventsPerQuery: number;
  maxApproxTokens: number;
}

export interface HistoryBudgetState extends HistoryBudgetConfig {
  usedQueries: number;
  usedEvents: number;
  usedApproxTokens: number;
}

export interface HistoryQueryResult {
  query: HistoryQuery;
  events: unknown[];
  approximateTokens: number;
}

export class HistoryBudget {
  #state: HistoryBudgetState;

  constructor(config: HistoryBudgetConfig) {
    if (!Number.isSafeInteger(config.maxQueries) || config.maxQueries < 0
      || !Number.isSafeInteger(config.maxEventsPerQuery) || config.maxEventsPerQuery < 1
      || !Number.isSafeInteger(config.maxApproxTokens) || config.maxApproxTokens < 1) {
      throw new Error("Invalid history budget configuration");
    }
    this.#state = { ...config, usedQueries: 0, usedEvents: 0, usedApproxTokens: 0 };
  }

  get state(): HistoryBudgetState {
    return { ...this.#state };
  }

  consume(query: HistoryQuery, events: readonly unknown[]): HistoryQueryResult {
    if (this.#state.usedQueries >= this.#state.maxQueries) {
      throw new Error("History query budget is exhausted");
    }
    if (query.limit > this.#state.maxEventsPerQuery || events.length > query.limit
      || events.length > this.#state.maxEventsPerQuery) {
      throw new Error("History query exceeds the event limit");
    }
    const approximateTokens = Math.ceil(JSON.stringify(events).length / 4);
    if (this.#state.usedApproxTokens + approximateTokens > this.#state.maxApproxTokens) {
      throw new Error("History query exceeds the cumulative token budget");
    }
    this.#state = {
      ...this.#state,
      usedQueries: this.#state.usedQueries + 1,
      usedEvents: this.#state.usedEvents + events.length,
      usedApproxTokens: this.#state.usedApproxTokens + approximateTokens,
    };
    return { query, events: [...events], approximateTokens };
  }
}
