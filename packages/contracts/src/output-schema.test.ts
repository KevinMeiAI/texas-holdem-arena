import { describe, expect, it } from "vitest";
import { arenaOutputSchema } from "./output-schema.js";

describe("platform-owned structured output schema", () => {
  it("keeps a strict object root for provider schema modes", () => {
    const action = arenaOutputSchema("ACTION_OR_HISTORY");
    expect(action).toMatchObject({
      version: "arena-output-v1",
      name: "arena_action_or_history",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["type", "action", "amount_to", "decision_summary", "query"],
      },
    });
    expect(action.schema).not.toHaveProperty("anyOf");
  });

  it("uses a distinct, stable runout-vote schema", () => {
    const first = arenaOutputSchema("RUNOUT_VOTE");
    const second = arenaOutputSchema("RUNOUT_VOTE");
    expect(first).toEqual(second);
    expect(first.name).toBe("arena_runout_vote");
    expect(first.sha256).not.toBe(arenaOutputSchema("ACTION_OR_HISTORY").sha256);
  });
});
