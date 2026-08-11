import { describe, expect, it } from "vitest";
import { styleProfileLabel } from "./leaderboard-format";
import type { StyleProfileEntry } from "./types";

const PROFILES: StyleProfileEntry["profile"][] = ["紧凶", "紧稳", "均衡", "松凶", "松稳"];

describe("leaderboard style profile labels", () => {
  it("preserves the Chinese labels in Chinese mode", () => {
    expect(PROFILES.map((profile) => styleProfileLabel(profile, "zh-CN"))).toEqual(PROFILES);
  });

  it("renders every API profile without Chinese characters in English mode", () => {
    const labels = PROFILES.map((profile) => styleProfileLabel(profile, "en"));

    expect(labels).toEqual(["TAG", "Tight-passive", "Balanced", "LAG", "Loose-passive"]);
    expect(labels.every((label) => !/[\u3400-\u9fff]/u.test(label))).toBe(true);
  });
});
