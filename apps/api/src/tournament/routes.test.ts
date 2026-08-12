import { describe, expect, it } from "vitest";
import {
  ARENA_DECISION_TIMEOUT_MAX_MS,
  ARENA_DECISION_TIMEOUT_MIN_MS,
  ARENA_DECISION_TIMEOUT_MS,
} from "../model-runtime.js";
import { createBenchmarkSeriesSchema, createTournamentSchema } from "./routes.js";

const validTournament = {
  name: "Timeout test",
  modelConfigIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
  initialStack: 2_000,
  handsPerLevel: 10,
  blindLevels: [{ smallBlind: 10, bigBlind: 20, bigBlindAnte: 0 }],
};

describe("create tournament timeout", () => {
  it("defaults to the Arena timeout and accepts a tournament-specific value", () => {
    expect(createTournamentSchema.parse(validTournament)).toMatchObject({
      decisionTimeoutMs: ARENA_DECISION_TIMEOUT_MS,
      interfaceTrack: "native",
      historyMode: "query_only",
    });
    expect(createTournamentSchema.parse({ ...validTournament, decisionTimeoutMs: 240_000 }).decisionTimeoutMs).toBe(240_000);
  });

  it("accepts a normalized history-disabled track", () => {
    expect(createTournamentSchema.parse({
      ...validTournament,
      interfaceTrack: "normalized",
      historyMode: "disabled",
    })).toMatchObject({ interfaceTrack: "normalized", historyMode: "disabled" });
  });

  it("rejects values outside the supported 30 to 600 second range", () => {
    expect(createTournamentSchema.safeParse({ ...validTournament, decisionTimeoutMs: ARENA_DECISION_TIMEOUT_MIN_MS - 1 }).success).toBe(false);
    expect(createTournamentSchema.safeParse({ ...validTournament, decisionTimeoutMs: ARENA_DECISION_TIMEOUT_MAX_MS + 1 }).success).toBe(false);
  });
});

describe("create benchmark series", () => {
  it("uses the selected models for the default rotation count", () => {
    expect(createBenchmarkSeriesSchema.parse(validTournament).rotations).toBeUndefined();
    expect(createBenchmarkSeriesSchema.parse({ ...validTournament, rotations: 2 }).rotations).toBe(2);
  });

  it("rejects a single rotation", () => {
    expect(createBenchmarkSeriesSchema.safeParse({ ...validTournament, rotations: 1 }).success).toBe(false);
  });

  it("requires a complete seat rotation cycle", () => {
    const threeModels = {
      ...validTournament,
      modelConfigIds: [...validTournament.modelConfigIds, "33333333-3333-4333-8333-333333333333"],
    };
    expect(createBenchmarkSeriesSchema.safeParse({ ...threeModels, rotations: 2 }).success).toBe(false);
    expect(createBenchmarkSeriesSchema.safeParse({ ...threeModels, rotations: 3 }).success).toBe(true);
  });
});
