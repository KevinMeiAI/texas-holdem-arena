import { describe, expect, it } from "vitest";
import type { ArenaBroadcastLastAction } from "./types";
import { compactBroadcastActionLabel } from "./broadcast-action-label";

function action(overrides: Partial<ArenaBroadcastLastAction> = {}): ArenaBroadcastLastAction {
  return {
    sequence: 1,
    street: "PREFLOP",
    action: "raise",
    classification: "raise",
    paid: 350,
    amountTo: 450,
    term: null,
    ...overrides,
  };
}

describe("compact broadcast action label", () => {
  it("uses the poker term instead of repeating the generic action", () => {
    expect(compactBroadcastActionLabel(action({ term: "OPEN" }), "en")).toBe("OPEN 450");
    expect(compactBroadcastActionLabel(action({ term: "3-BET" }), "zh-CN")).toBe("3-BET 450");
  });

  it("keeps the localized action when no poker term is available", () => {
    expect(compactBroadcastActionLabel(action(), "en")).toBe("Raise to 450");
    expect(compactBroadcastActionLabel(action(), "zh-CN")).toBe("加注至 450");
  });

  it("uses the paid amount for calls", () => {
    expect(compactBroadcastActionLabel(action({ action: "call", classification: "call", paid: 250, amountTo: 450, term: null }), "en")).toBe("Call 250");
  });
});
