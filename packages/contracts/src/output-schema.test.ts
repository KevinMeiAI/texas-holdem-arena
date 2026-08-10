import { describe, expect, it } from "vitest";
import { arenaOutputSchema } from "./output-schema.js";

describe("platform-owned structured output schema", () => {
  it("keeps a strict object root for provider schema modes", () => {
    const action = arenaOutputSchema("ACTION_OR_HISTORY");
    expect(action).toMatchObject({
      version: "arena-output-v2",
      name: "arena_action_or_history",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
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
});
