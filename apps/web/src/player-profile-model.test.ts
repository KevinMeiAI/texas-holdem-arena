import { describe, expect, it } from "vitest";
import {
  publicCompetitorProfileSchema,
  type PublicCompetitorProfile,
} from "../../../packages/contracts/src/competitors";
import {
  buildPlayerProfileModel,
  canonicalPlayerUrl,
  formatProfileLatency,
  formatProfilePercent,
  formatProfileTokens,
  playerResultTrend,
  playerProfileSampleWarning,
  playerProfileTokenCoverageCopy,
  playerStoryCardFilename,
  profileConsistencyTierLabel,
  profileEventClassLabel,
  profileResultScopeLabel,
  profileStyleLabel,
} from "./player-profile-model";

const COMPETITOR_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";

function profile(): PublicCompetitorProfile {
  return publicCompetitorProfileSchema.parse({
    schemaVersion: "arena-competitor-profile-v1",
    competitor: {
      id: COMPETITOR_ID,
      displayName: "Kimi K3 / 河牌专家",
      status: "ACTIVE",
      providerBrand: "kimi",
      currentRevision: {
        id: REVISION_ID,
        revisionNumber: 2,
        modelId: "kimi-k3",
        displayNameAtRevision: "Kimi K3",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      revisionCount: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    },
    competitiveScope: {
      eventClass: "RATED",
      benchmarkCohortId: "cohort-current",
      rankedCompetitors: 6,
    },
    competition: {
      rank: 2,
      rating: 1532,
      points: 15,
      tournaments: 3,
      championships: 1,
      championshipRate: 1 / 3,
      topThree: 2,
      topThreeRate: 2 / 3,
      averageFinish: 2.3,
      sampleWarning: true,
    },
    style: {
      handsPlayed: 45,
      vpipRate: 0.375,
      pfrRate: 0.25,
      threeBetRate: 0.1,
      showdownWinRate: 0.5,
      profile: "均衡",
      sampleWarning: false,
    },
    reliability: {
      decisions: 80,
      validDecisionRate: 0.975,
      firstPassRate: 0.925,
      protocolCorrections: 4,
      fallbacks: 1,
      timeouts: 2,
      infrastructurePauses: 1,
      sampleWarning: false,
    },
    efficiency: {
      providerCalls: 84,
      averageLatencyMs: 875,
      p95LatencyMs: 2_450,
      totalTokens: 42_000,
      tokensPerDecision: 525,
      tokenUsageCoverage: 0.75,
      sampleWarning: true,
    },
    consistency: {
      runId: "33333333-3333-4333-8333-333333333333",
      competitorRevisionId: REVISION_ID,
      tier: "full",
      scenarioRegistryVersion: "arena-consistency-scenarios-v1",
      promptName: "Arena v11",
      validityRate: 0.975,
      meanDominantShare: 0.8,
      meanPairwiseAgreement: 0.7,
      completedSamples: 40,
      scenarioCount: 20,
      completedAt: "2026-08-20T00:00:00.000Z",
    },
    career: {
      appearances: 2,
      ratedAppearances: 1,
      exhibitionAppearances: 1,
      wins: 1,
      podiums: 2,
      handsPlayed: 70,
      decisions: 120,
      firstPlayedAt: "2026-08-10T00:00:00.000Z",
      lastPlayedAt: "2026-08-19T00:00:00.000Z",
    },
    recentResults: [{
      tournamentId: "55555555-5555-4555-8555-555555555555",
      name: "Later exhibition",
      eventClass: "EXHIBITION",
      benchmarkCohortId: "cohort-old",
      benchmarkTrackId: "track-old",
      completedAt: "2026-08-19T00:00:00.000Z",
      competitorRevisionId: REVISION_ID,
      displayNameAtEntry: "Kimi K3",
      providerBrand: "kimi",
      fieldSize: 6,
      finishingPosition: 4,
      handsPlayed: 25,
      netBigBlinds: -4.5,
      peakStackBigBlinds: 21,
      knockouts: 0,
      validDecisionRate: 1,
      firstPassRate: 0.9,
      totalTokens: 18_000,
      tokenUsageCoverage: 0.5,
      countedInCurrentRanking: false,
    }, {
      tournamentId: "44444444-4444-4444-8444-444444444444",
      name: "Earlier rated final",
      eventClass: "RATED",
      benchmarkCohortId: "cohort-current",
      benchmarkTrackId: "track-current",
      completedAt: "2026-08-10T00:00:00.000Z",
      competitorRevisionId: REVISION_ID,
      displayNameAtEntry: "Kimi K3",
      providerBrand: "kimi",
      fieldSize: 6,
      finishingPosition: 1,
      handsPlayed: 45,
      netBigBlinds: 12.25,
      peakStackBigBlinds: 48,
      knockouts: 2,
      validDecisionRate: 0.95,
      firstPassRate: 0.9,
      totalTokens: 24_000,
      tokenUsageCoverage: 1,
      countedInCurrentRanking: true,
    }],
    featuredMoments: [],
    methodology: {
      competition: "current cohort",
      career: "all completed events",
      consistency: "latest completed run",
    },
  });
}

describe("player profile model", () => {
  it("formats percentages, latency, and token coverage in both locales", () => {
    expect(formatProfilePercent(0.975, "zh-CN")).toBe("97.5%");
    expect(formatProfilePercent(1 / 3, "en")).toBe("33.3%");
    expect(formatProfilePercent(null, "en")).toBe("—");
    expect(formatProfilePercent(Number.NaN, "en")).toBe("—");

    expect(formatProfileLatency(875, "zh-CN")).toBe("875 毫秒");
    expect(formatProfileLatency(875, "en")).toBe("875 ms");
    expect(formatProfileLatency(2_450, "zh-CN")).toBe("2.5 秒");
    expect(formatProfileLatency(2_450, "en")).toBe("2.5 s");
    expect(formatProfileLatency(null, "en")).toBe("—");
    expect(formatProfileTokens(42_000, "zh-CN")).toBe("42,000");
    expect(formatProfileTokens(42_000, "en")).toBe("42,000");
    expect(formatProfileTokens(null, "en")).toBe("—");

    expect(playerProfileTokenCoverageCopy(0.75, "zh-CN")).toBe("Token 覆盖 75%");
    expect(playerProfileTokenCoverageCopy(0.75, "en")).toBe("Token coverage 75%");
    expect(playerProfileTokenCoverageCopy(null, "en")).toBe("Token coverage —");
  });

  it("maps every style without leaking Chinese into English mode", () => {
    const styles = ["紧凶", "紧稳", "均衡", "松凶", "松稳"] as const;
    expect(styles.map((style) => profileStyleLabel(style, "zh-CN"))).toEqual(styles);
    expect(styles.map((style) => profileStyleLabel(style, "en"))).toEqual([
      "TAG",
      "Tight-passive",
      "Balanced",
      "LAG",
      "Loose-passive",
    ]);
    expect(profileStyleLabel(null, "en")).toBe("—");
  });

  it("localizes event, consistency, and ranking-scope labels", () => {
    expect(profileEventClassLabel("RATED", "zh-CN")).toBe("评级赛");
    expect(profileEventClassLabel("EXHIBITION", "en")).toBe("Exhibition");
    expect(profileConsistencyTierLabel("full", "zh-CN")).toBe("完整");
    expect(profileConsistencyTierLabel("quick", "en")).toBe("Quick");
    expect(profileResultScopeLabel(true, "RATED", "zh-CN")).toBe("计入当前排名");
    expect(profileResultScopeLabel(false, "RATED", "en")).toBe("Historical cohort");
    expect(profileResultScopeLabel(true, "EXHIBITION", "en")).toBe("Unrated");
  });

  it("returns localized warnings only for limited samples", () => {
    expect(playerProfileSampleWarning(true, "zh-CN")).toBe("样本量有限");
    expect(playerProfileSampleWarning(true, "en")).toBe("Limited sample");
    expect(playerProfileSampleWarning(false, "en")).toBeNull();
  });

  it("creates chronological trend points without mutating the API result order", () => {
    const source = profile();
    const originalOrder = source.recentResults.map((result) => result.tournamentId);
    const trend = playerResultTrend(source);

    expect(trend).toEqual([
      {
        ordinal: 1,
        tournamentId: "44444444-4444-4444-8444-444444444444",
        tournamentName: "Earlier rated final",
        completedAt: "2026-08-10T00:00:00.000Z",
        finishingPosition: 1,
        fieldSize: 6,
        netBigBlinds: 12.25,
        countedInCurrentRanking: true,
      },
      {
        ordinal: 2,
        tournamentId: "55555555-5555-4555-8555-555555555555",
        tournamentName: "Later exhibition",
        completedAt: "2026-08-19T00:00:00.000Z",
        finishingPosition: 4,
        fieldSize: 6,
        netBigBlinds: -4.5,
        countedInCurrentRanking: false,
      },
    ]);
    expect(source.recentResults.map((result) => result.tournamentId)).toEqual(originalOrder);
  });

  it("builds localized display values from a validated public profile", () => {
    const model = buildPlayerProfileModel(profile(), "en");

    expect(model).toMatchObject({
      locale: "en",
      styleLabel: "Balanced",
      rates: {
        championship: "33.3%",
        topThree: "66.7%",
        validDecision: "97.5%",
        consistencyValidity: "97.5%",
      },
      efficiency: {
        averageLatency: "875 ms",
        p95Latency: "2.5 s",
        tokenCoverage: "Token coverage 75%",
      },
      sampleWarnings: {
        competition: "Limited sample",
        style: null,
        reliability: null,
        efficiency: "Limited sample",
      },
    });
    expect(model.resultTrend.map((point) => point.finishingPosition)).toEqual([1, 4]);
  });

  it("builds canonical player links and rejects non-UUID ids or unsafe origins", () => {
    expect(canonicalPlayerUrl(
      "https://arena.example/app?from=share#state",
      COMPETITOR_ID.toUpperCase(),
    )).toBe(`https://arena.example/players/${COMPETITOR_ID}`);
    expect(() => canonicalPlayerUrl("file:///tmp/index.html", COMPETITOR_ID))
      .toThrow(/HTTP\(S\)/);
    expect(() => canonicalPlayerUrl("javascript:alert(1)", COMPETITOR_ID))
      .toThrow(/HTTP\(S\)/);
    expect(() => canonicalPlayerUrl("https://arena.example", "../admin"))
      .toThrow(/UUID/i);
  });

  it("produces an ASCII PNG filename without path separators", () => {
    expect(playerStoryCardFilename(profile()))
      .toBe("arena-player-kimi-k3-11111111.png");

    const unsafe = profile();
    unsafe.competitor.displayName = " ../../河牌 决胜!! ";
    expect(playerStoryCardFilename(unsafe))
      .toBe("arena-player-player-11111111.png");
  });
});
