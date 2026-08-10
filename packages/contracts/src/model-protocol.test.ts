import { describe, expect, it } from "vitest";
import { parseModelJson } from "./model-protocol.js";
import { ARENA_PROMPT_VERSION, buildEffectiveSystemPrompt } from "./system-prompt.js";

describe("strict model protocol", () => {
  it("accepts exact legal shapes and amount_to semantics", () => {
    expect(parseModelJson('{"type":"action","action":"raise","amount_to":1200}', "ACTION_OR_HISTORY"))
      .toMatchObject({ action: "raise", amount_to: 1200 });
  });

  it("normalizes the fixed nullable envelope used by structured-output providers", () => {
    expect(parseModelJson(JSON.stringify({
      type: "action",
      action: "check",
      amount_to: null,
      decision_summary: null,
      query: null,
    }), "ACTION_OR_HISTORY")).toEqual({ type: "action", action: "check" });
    expect(parseModelJson(JSON.stringify({
      type: "action",
      action: "call",
      amount_to: 700,
      decision_summary: "Calling the engine-computed amount.",
      query: null,
    }), "ACTION_OR_HISTORY")).toEqual({
      type: "action",
      action: "call",
      decision_summary: "Calling the engine-computed amount.",
    });
    expect(parseModelJson(JSON.stringify({
      type: "history_query",
      action: null,
      amount_to: null,
      decision_summary: null,
      query: { kind: "player_actions", player_id: "p1", streets: null, actions: null, limit: 20 },
    }), "ACTION_OR_HISTORY")).toEqual({
      type: "history_query",
      query: { kind: "player_actions", player_id: "p1", limit: 20 },
    });
  });

  it("rejects fences, unknown fields and invalid amount placement", () => {
    expect(() => parseModelJson('```json\n{"type":"action","action":"check"}\n```', "ACTION_OR_HISTORY"))
      .toThrow(/one JSON object/);
    expect(() => parseModelJson('{"type":"action","action":"check","extra":1}', "ACTION_OR_HISTORY"))
      .toThrow();
    expect(() => parseModelJson('{"type":"action","action":"call","amount_to":100}', "ACTION_OR_HISTORY"))
      .toThrow(/amount_to/);
    expect(() => parseModelJson('{"type":"action","action":"raise"}', "ACTION_OR_HISTORY"))
      .toThrow(/amount_to/);
  });

  it("drops only a malformed optional summary while preserving the legal action", () => {
    expect(parseModelJson(JSON.stringify({
      type: "action",
      action: "check",
      decision_summary: "x".repeat(301),
    }), "ACTION_OR_HISTORY")).toEqual({ type: "action", action: "check" });
  });

  it("enforces history query budgets", () => {
    expect(() => parseModelJson(
      '{"type":"history_query","query":{"kind":"recent_hands","count":21,"limit":80}}',
      "ACTION_OR_HISTORY",
    )).toThrow();
  });

  it("builds byte-identical prompts and hashes for every seat", () => {
    const first = buildEffectiveSystemPrompt();
    const second = buildEffectiveSystemPrompt();
    expect(first).toEqual(second);
    expect(first.version).toBe("arena-system-v6");
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.text).not.toContain("SHARED STRATEGY PROMPT");
    expect(first.text).not.toContain("shared strategy");
    expect(first.text).toContain('"kind":"recent_hands"');
    expect(first.text).toContain('"kind":"player_actions"');
    expect(first.text).toContain("history_budget_remaining");
    expect(first.text).toContain("dead_button");
    expect(first.text).toContain("For fold/check/call/all_in, amount_to must be null");
    expect(first.text).toContain(ARENA_PROMPT_VERSION);
  });
});
