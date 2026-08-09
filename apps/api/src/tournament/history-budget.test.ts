import { describe, expect, it } from "vitest";
import { HistoryBudget } from "./history-budget.js";

describe("bounded model history queries", () => {
  it("accounts for query, event and approximate token budgets", () => {
    const budget = new HistoryBudget({ maxQueries: 2, maxEventsPerQuery: 3, maxApproxTokens: 100 });
    const query = { kind: "recent_hands", count: 1, limit: 3 } as const;
    budget.consume(query, [{ type: "ACTION", player: "p1" }]);
    budget.consume(query, [{ type: "ACTION", player: "p2" }]);
    expect(budget.state).toMatchObject({ usedQueries: 2, usedEvents: 2 });
    expect(() => budget.consume(query, [])).toThrow(/exhausted/);
  });

  it("rejects a result that exceeds the frozen per-query limit", () => {
    const budget = new HistoryBudget({ maxQueries: 2, maxEventsPerQuery: 2, maxApproxTokens: 100 });
    expect(() => budget.consume(
      { kind: "recent_hands", count: 1, limit: 3 },
      [],
    )).toThrow(/event limit/);
  });
});
