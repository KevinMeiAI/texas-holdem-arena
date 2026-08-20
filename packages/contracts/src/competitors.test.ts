import { describe, expect, it } from "vitest";
import { publicCompetitorProfileSchema } from "./competitors.js";

const ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-20T00:00:00.000Z";

function profileFixture() {
  return {
    schemaVersion: "arena-competitor-profile-v1",
    competitor: {
      id: ID,
      displayName: "Alpha",
      status: "ACTIVE",
      providerBrand: "deepseek",
      currentRevision: {
        id: REVISION_ID,
        revisionNumber: 2,
        modelId: "deepseek-v4",
        displayNameAtRevision: "Alpha",
        createdAt: NOW,
      },
      revisionCount: 2,
      createdAt: NOW,
      updatedAt: NOW,
    },
    competitiveScope: { eventClass: "RATED", benchmarkCohortId: "cohort-v1", rankedCompetitors: 6 },
    competition: {
      rank: 1,
      rating: 1532,
      points: 10,
      tournaments: 1,
      championships: 1,
      championshipRate: 1,
      topThree: 1,
      topThreeRate: 1,
      averageFinish: 1,
      sampleWarning: true,
    },
    style: {
      handsPlayed: 18,
      vpipRate: 0.28,
      pfrRate: 0.2,
      threeBetRate: 0.1,
      showdownWinRate: 0.5,
      profile: "均衡",
      sampleWarning: true,
    },
    reliability: {
      decisions: 30,
      validDecisionRate: 1,
      firstPassRate: 0.96,
      protocolCorrections: 1,
      fallbacks: 0,
      timeouts: 0,
      infrastructurePauses: 0,
      sampleWarning: true,
    },
    efficiency: {
      providerCalls: 31,
      averageLatencyMs: 2_000,
      p95LatencyMs: 4_000,
      totalTokens: 12_000,
      tokensPerDecision: 400,
      tokenUsageCoverage: 1,
      sampleWarning: true,
    },
    consistency: null,
    career: {
      appearances: 1,
      ratedAppearances: 1,
      exhibitionAppearances: 0,
      wins: 1,
      podiums: 1,
      handsPlayed: 18,
      decisions: 30,
      firstPlayedAt: NOW,
      lastPlayedAt: NOW,
    },
    recentResults: [],
    featuredMoments: [],
    methodology: {
      competition: "Current comparable cohort only.",
      career: "Completed events are historical facts.",
      consistency: "Latest completed run for the current revision.",
    },
  };
}

describe("public competitor profile contract", () => {
  it("accepts a bounded public career profile", () => {
    const fixture = { ...profileFixture(), recentResults: [{
      tournamentId: "33333333-3333-4333-8333-333333333333",
      name: "Split elimination",
      eventClass: "RATED",
      benchmarkCohortId: "cohort-v1",
      benchmarkTrackId: "track-v1",
      completedAt: NOW,
      competitorRevisionId: REVISION_ID,
      displayNameAtEntry: "Alpha",
      providerBrand: "deepseek",
      fieldSize: 3,
      finishingPosition: 1,
      handsPlayed: 8,
      netBigBlinds: 12,
      peakStackBigBlinds: 30,
      knockouts: 0.5,
      validDecisionRate: 1,
      firstPassRate: 1,
      totalTokens: 2_000,
      tokenUsageCoverage: 0.75,
      countedInCurrentRanking: true,
    }] };
    expect(publicCompetitorProfileSchema.parse(fixture)).toMatchObject({
      competitor: { id: ID, providerBrand: "deepseek" },
      competition: { rank: 1 },
      recentResults: [{ knockouts: 0.5, tokenUsageCoverage: 0.75 }],
    });
  });

  it("rejects unknown fields and invalid rates", () => {
    expect(publicCompetitorProfileSchema.safeParse({
      ...profileFixture(),
      apiKey: "must-not-leak",
    }).success).toBe(false);
    expect(publicCompetitorProfileSchema.safeParse({
      ...profileFixture(),
      reliability: { ...profileFixture().reliability, validDecisionRate: 1.1 },
    }).success).toBe(false);
  });
});
