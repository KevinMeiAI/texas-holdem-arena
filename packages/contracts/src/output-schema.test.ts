import { describe, expect, it } from "vitest";
import { arenaOutputSchema } from "./output-schema.js";

describe("platform-owned structured output schema", () => {
  it("keeps a strict object root for provider schema modes", () => {
    const action = arenaOutputSchema("ACTION_OR_HISTORY", "arena-output-v2");
    expect(action).toMatchObject({
      version: "arena-output-v2",
      name: "arena_action_or_history",
      sha256: "0530fe097a765006981baa37826fcf45119a49519e3b13e0fd981fb7f6762aeb",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["type", "action", "amount_to", "decision_summary", "query"],
      },
    });
    expect(action.schema).not.toHaveProperty("anyOf");
    expect(action.schema).toHaveProperty(
      "properties.amount_to.description",
      "Must be null for fold, check, call, and all_in; use a positive integer only for bet or raise.",
    );
  });

  it("publishes the v3 summary bound without changing the required envelope", () => {
    const action = arenaOutputSchema("ACTION_OR_HISTORY", "arena-output-v3");
    expect(action.version).toBe("arena-output-v3");
    expect(action.schema).toHaveProperty("properties.decision_summary.anyOf.0.maxLength", 300);
    expect(action.schema).toHaveProperty("required", ["type", "action", "amount_to", "decision_summary", "query"]);
  });
});
