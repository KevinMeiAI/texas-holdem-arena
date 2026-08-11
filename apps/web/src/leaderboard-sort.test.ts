import { describe, expect, it } from "vitest";
import { sortLeaderboardEntries } from "./leaderboard-sort";

const entries = [
  { id: "a", value: 3 },
  { id: "b", value: null },
  { id: "c", value: 1 },
  { id: "d", value: 3 },
];

describe("leaderboard sorting", () => {
  it("sorts numeric metrics in either direction while keeping missing values last", () => {
    expect(sortLeaderboardEntries(entries, (entry) => entry.value, "desc").map((entry) => entry.id))
      .toEqual(["a", "d", "c", "b"]);
    expect(sortLeaderboardEntries(entries, (entry) => entry.value, "asc").map((entry) => entry.id))
      .toEqual(["c", "a", "d", "b"]);
  });

  it("sorts model names and preserves source order for ties", () => {
    const models = [
      { id: "first", name: "Gemini" },
      { id: "second", name: "DeepSeek" },
      { id: "third", name: "Gemini" },
    ];
    expect(sortLeaderboardEntries(models, (entry) => entry.name, "asc").map((entry) => entry.id))
      .toEqual(["second", "first", "third"]);
  });
});
