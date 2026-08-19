import { describe, expect, it } from "vitest";
import {
  MOMENT_DETECTOR_VERSION,
  MOMENT_FACTS_V1,
  MOMENT_FACTS_VERSION,
  MOMENT_SCORING_VERSION,
  storedTournamentMomentFactsSchema,
  tournamentMomentFactsSchema,
} from "./moments.js";

function facts() {
  return {
    id: "00000000-0000-5000-8000-000000000001",
    tournamentId: "00000000-0000-4000-8000-000000000001",
    handNo: 1,
    startSequence: 1,
    focusSequence: 2,
    endSequence: 3,
    factsVersion: MOMENT_FACTS_VERSION,
    detectorVersion: MOMENT_DETECTOR_VERSION,
    scoringVersion: MOMENT_SCORING_VERSION,
    broadcastViewVersion: "arena-broadcast-view-v1",
    equityVersion: "arena-broadcast-equity-v1",
    source: {
      eventHash: "1".repeat(64),
      eventCount: 3,
      startEventHash: "2".repeat(64),
      endEventHash: "3".repeat(64),
    },
    score: 50,
    scoreBreakdown: {
      potImpact: 10,
      tournamentImpact: 20,
      actionDrama: 10,
      equityDrama: 8,
      rarity: 2,
    },
    recommendationRank: 1,
    primaryTag: "LARGE_POT",
    tags: ["LARGE_POT"],
    participantPlayerIds: ["a", "b"],
    featuredPlayerIds: ["a"],
    winnerPlayerIds: ["a"],
    eliminatedPlayerIds: [],
    showdownPlayerIds: ["a", "b"],
    board: ["2c", "3d", "4h", "8s", "Tc"],
    bigBlind: 10,
    potChips: 200,
    potBigBlinds: 20,
    totalChipShare: 0.5,
    startingStacks: { a: 200, b: 200 },
    endingStacks: { a: 300, b: 100 },
    netChanges: { a: 100, b: -100 },
    actionCount: 2,
    preflopRaiseCount: 1,
    overbetSequences: [],
    sidePotCount: 0,
    splitPot: false,
    leadChange: false,
    maxDecisionLatencyMs: null,
    winningHandCategories: [],
    actions: [],
    allInLock: null,
    equityTransitions: [],
  };
}

describe("tournament moment facts versions", () => {
  it("keeps historical v1 facts readable after detector and scoring versions advance", () => {
    const historical = {
      ...facts(),
      factsVersion: MOMENT_FACTS_V1,
      detectorVersion: "arena-moment-detector-v0",
      scoringVersion: "arena-moment-scoring-v0",
    };

    expect(storedTournamentMomentFactsSchema.parse(historical)).toMatchObject({
      factsVersion: MOMENT_FACTS_V1,
      detectorVersion: "arena-moment-detector-v0",
      scoringVersion: "arena-moment-scoring-v0",
    });
    expect(tournamentMomentFactsSchema.safeParse(historical).success).toBe(false);
  });

  it("rejects an unregistered facts shape version instead of misreading it", () => {
    expect(storedTournamentMomentFactsSchema.safeParse({
      ...facts(),
      factsVersion: "arena-moment-facts-v2",
    }).success).toBe(false);
  });
});
