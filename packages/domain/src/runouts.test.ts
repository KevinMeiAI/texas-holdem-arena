import { describe, expect, it } from "vitest";
import { castRunoutVote, createRunoutVote } from "./runouts.js";

describe("run-it-twice negotiation", () => {
  it("requires unanimous consent and preserves ordered messages", () => {
    let state = createRunoutVote(["b", "c", "a"]);
    state = castRunoutVote(state, "b", { acceptRunItTwice: true, message: "yes" });
    expect(state.currentVoterId).toBe("c");
    state = castRunoutVote(state, "c", { acceptRunItTwice: false, message: "once" });
    state = castRunoutVote(state, "a", { acceptRunItTwice: true });
    expect(state).toMatchObject({ complete: true, currentVoterId: null, runCount: 1 });
    expect(state.votes.map((vote) => vote.message)).toEqual(["yes", "once", ""]);
  });

  it("runs twice only when every vote accepts", () => {
    let state = createRunoutVote(["a", "b"]);
    state = castRunoutVote(state, "a", { acceptRunItTwice: true });
    state = castRunoutVote(state, "b", { acceptRunItTwice: true });
    expect(state.runCount).toBe(2);
  });

  it("treats timeout fallback as a recorded rejection", () => {
    let state = createRunoutVote(["a", "b"]);
    state = castRunoutVote(state, "a", { acceptRunItTwice: true });
    state = castRunoutVote(state, "b", {
      acceptRunItTwice: false,
      source: "timeout",
      message: "",
    });
    expect(state.runCount).toBe(1);
    expect(state.votes[1]?.source).toBe("timeout");
  });
});
