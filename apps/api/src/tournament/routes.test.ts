import { describe, expect, it } from "vitest";
import {
  ARENA_DECISION_TIMEOUT_MAX_MS,
  ARENA_DECISION_TIMEOUT_MIN_MS,
  ARENA_DECISION_TIMEOUT_MS,
} from "../model-runtime.js";
import { createTournamentSchema } from "./routes.js";

const validTournament = {
  name: "Timeout test",
  modelConfigIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
  initialStack: 2_000,
  handsPerLevel: 10,
  blindLevels: [{ smallBlind: 10, bigBlind: 20, bigBlindAnte: 0 }],
};

describe("create tournament timeout", () => {
  it("defaults to the Arena timeout and accepts a tournament-specific value", () => {
    expect(createTournamentSchema.parse(validTournament).decisionTimeoutMs).toBe(ARENA_DECISION_TIMEOUT_MS);
    expect(createTournamentSchema.parse({ ...validTournament, decisionTimeoutMs: 240_000 }).decisionTimeoutMs).toBe(240_000);
  });

  it("rejects values outside the supported 30 to 600 second range", () => {
    expect(createTournamentSchema.safeParse({ ...validTournament, decisionTimeoutMs: ARENA_DECISION_TIMEOUT_MIN_MS - 1 }).success).toBe(false);
    expect(createTournamentSchema.safeParse({ ...validTournament, decisionTimeoutMs: ARENA_DECISION_TIMEOUT_MAX_MS + 1 }).success).toBe(false);
  });
});
