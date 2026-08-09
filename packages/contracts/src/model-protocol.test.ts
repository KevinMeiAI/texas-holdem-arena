import { describe, expect, it } from "vitest";
import { parseModelJson } from "./model-protocol.js";
import { buildEffectiveSystemPrompt } from "./system-prompt.js";

describe("strict model protocol", () => {
  it("accepts exact legal shapes and amount_to semantics", () => {
    expect(parseModelJson('{"type":"action","action":"raise","amount_to":1200}', "ACTION_OR_HISTORY"))
      .toMatchObject({ action: "raise", amount_to: 1200 });
    expect(parseModelJson('{"type":"runout_vote","accept_run_it_twice":true,"message":"twice"}', "RUNOUT_VOTE"))
      .toMatchObject({ accept_run_it_twice: true });
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

  it("enforces query and Unicode message budgets", () => {
    expect(() => parseModelJson(
      '{"type":"history_query","query":{"kind":"recent_hands","count":21,"limit":80}}',
      "ACTION_OR_HISTORY",
    )).toThrow();
    expect(() => parseModelJson(JSON.stringify({
      type: "runout_vote",
      accept_run_it_twice: true,
      message: "🂡".repeat(161),
    }), "RUNOUT_VOTE")).toThrow(/160/);
  });

  it("builds byte-identical prompts and hashes for every seat", () => {
    const first = buildEffectiveSystemPrompt("Play a disciplined tournament strategy.");
    const second = buildEffectiveSystemPrompt("Play a disciplined tournament strategy.");
    expect(first).toEqual(second);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(buildEffectiveSystemPrompt("Different strategy").sha256).not.toBe(first.sha256);
  });
});
