import { describe, expect, it } from "vitest";
import { HistoryBudget } from "./history-budget.js";

describe("bounded model history queries", () => {
  it("accounts for query, event and approximate token budgets", () => {
    const budget = new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 3, maxApproxTokens: 100 });
    const query = { kind: "recent_hands", count: 1, limit: 3 } as const;
    budget.consume(query, [{ type: "ACTION", player: "p1" }]);
    budget.consume(query, [{ type: "ACTION", player: "p2" }]);
    expect(budget.state).toMatchObject({ usedQueries: 2, usedRecords: 2 });
    expect(() => budget.consume(query, [])).toThrow(/exhausted/);
  });

  it("rejects a result that exceeds the frozen per-query limit", () => {
    const budget = new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 2, maxApproxTokens: 100 });
    expect(() => budget.consume(
      { kind: "recent_hands", count: 1, limit: 3 },
      [],
    )).toThrow(/record limit/);
  });

  it("deterministically truncates v2 results by canonical UTF-8 bytes", () => {
    const config = { maxQueries: 2, maxRecordsPerQuery: 5, maxApproxTokens: 100, maxBytes: 180 };
    const query = { kind: "recent_hands", count: 2, limit: 5 } as const;
    const records = [
      { kind: "hand_summary", hand_no: 1, actions: Array.from({ length: 20 }, (_, index) => ({ index, action: "raise" })) },
      { kind: "hand_summary", hand_no: 2, actions: [{ action: "fold" }] },
    ];
    const first = new HistoryBudget(config).consumeBounded(query, records);
    const second = new HistoryBudget(config).consumeBounded(query, records);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ truncated: true, truncationReason: "BYTE_BUDGET" });
    expect(first.retainedBytes).toBeLessThanOrEqual(180);
  });

  it("counts UTF-8 bytes rather than JavaScript character units", () => {
    const budget = new HistoryBudget({ maxQueries: 1, maxRecordsPerQuery: 2, maxApproxTokens: 100, maxBytes: 80 });
    const result = budget.consumeBounded(
      { kind: "public_stats", limit: 2 },
      [{ kind: "public_player_stats", player_id: "中文模型" }],
    );
    expect(result.retainedBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(result.records), "utf8") - 20);
    expect(budget.state.usedBytes).toBe(result.retainedBytes);
  });

  it("never exceeds the cumulative byte budget across empty follow-up results", () => {
    const budget = new HistoryBudget({ maxQueries: 2, maxRecordsPerQuery: 2, maxApproxTokens: 100, maxBytes: 2 });
    const query = { kind: "public_stats", limit: 2 } as const;
    expect(budget.consumeBounded(query, []).retainedBytes).toBe(2);
    expect(budget.consumeBounded(query, []).retainedBytes).toBe(0);
    expect(budget.state.usedBytes).toBe(2);
  });
});
