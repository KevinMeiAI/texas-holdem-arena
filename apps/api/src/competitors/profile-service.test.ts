import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ArenaService } from "../tournament/arena-service.js";
import type { ArenaLeaderboards, TournamentPlayerStatistics } from "../tournament/statistics.js";
import type { MomentService } from "../tournament/moments/moment-service.js";
import type { CompetitorIdentityService } from "./identity-service.js";
import { CompetitorProfileService } from "./profile-service.js";

const COMPETITOR_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ONE = "22222222-2222-4222-8222-222222222222";
const REVISION_TWO = "33333333-3333-4333-8333-333333333333";
const TOURNAMENT_ONE = "44444444-4444-4444-8444-444444444444";
const TOURNAMENT_TWO = "55555555-5555-4555-8555-555555555555";
const CONSISTENCY_RUN = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-08-20T00:00:00.000Z");

function family() {
  return {
    id: COMPETITOR_ID,
    displayName: "Kimi K3",
    status: "ACTIVE" as const,
    linkedModelConfigCount: 1,
    availableModelConfigCount: 1,
    revisionCount: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW.toISOString(),
  };
}

function revisions() {
  return [{
    id: REVISION_TWO,
    revision_number: 2,
    model_id: "kimi-k3",
    competitor_display_name: "Kimi K3",
    provider_type: "openai-compatible",
    provider_profile: "kimi",
    provider_label: "Moonshot",
    base_url: "https://api.moonshot.cn/v1",
    is_available_current: true,
    is_model_current: true,
    created_at: NOW,
    encrypted_api_key: "must-not-leak",
    parameters: { reasoning_effort: "high" },
  }, {
    id: REVISION_ONE,
    revision_number: 1,
    model_id: "kimi-k2",
    competitor_display_name: "Kimi K2",
    provider_type: "openai-compatible",
    provider_profile: "kimi",
    provider_label: "Moonshot",
    base_url: "https://api.moonshot.cn/v1",
    is_available_current: false,
    is_model_current: false,
    created_at: new Date("2026-08-01T00:00:00.000Z"),
  }];
}

function entries() {
  return [{
    tournament_id: TOURNAMENT_TWO,
    name: "Exhibition 2",
    event_class: "EXHIBITION",
    benchmark_cohort_id: "cohort-old",
    benchmark_track_id: "track-old",
    completed_at: new Date("2026-08-19T00:00:00.000Z"),
    competitor_revision_id: REVISION_TWO,
    display_name_at_entry: "Kimi K3",
  }, {
    tournament_id: TOURNAMENT_ONE,
    name: "Rated 1",
    event_class: "RATED",
    benchmark_cohort_id: "cohort-current",
    benchmark_track_id: "track-current",
    completed_at: new Date("2026-08-10T00:00:00.000Z"),
    competitor_revision_id: REVISION_ONE,
    display_name_at_entry: "Kimi K2",
  }];
}

function leaderboard(): ArenaLeaderboards {
  const identity = {
    competitorId: COMPETITOR_ID,
    revisionIds: [REVISION_ONE],
    modelId: REVISION_ONE,
    displayName: "Kimi K3",
    providerBrand: "kimi" as const,
  };
  return {
    benchmarkCohortId: "cohort-current",
    competition: [{
      ...identity,
      rating: 1532,
      points: 10,
      tournaments: 1,
      championships: 1,
      championshipRate: 1,
      topThree: 1,
      topThreeRate: 1,
      averageFinish: 1,
      sampleWarning: true,
    }],
    reliability: [{
      ...identity,
      decisions: 12,
      validDecisionRate: 1,
      firstPassRate: 11 / 12,
      protocolCorrections: 1,
      fallbacks: 0,
      timeouts: 0,
      infrastructurePauses: 0,
      sampleWarning: true,
    }],
    efficiency: [{
      ...identity,
      decisions: 12,
      providerCalls: 13,
      averageLatencyMs: 2_000,
      p95LatencyMs: 4_000,
      totalTokens: 6_000,
      tokensPerDecision: 500,
      tokenUsageCoverage: 1,
      sampleWarning: true,
    }],
    styles: [{
      ...identity,
      handsPlayed: 8,
      vpipRate: 0.375,
      pfrRate: 0.25,
      threeBetRate: 0.1,
      showdownWinRate: 0.5,
      profile: "均衡",
      sampleWarning: true,
    }],
    methodology: {
      competition: "placements",
      rating: "elo",
      points: "field points",
      separation: "one cohort",
    },
  };
}

function player(
  playerId: string,
  finishingPosition: number,
  overrides: Partial<TournamentPlayerStatistics> = {},
): TournamentPlayerStatistics {
  return {
    playerId,
    displayName: "Kimi",
    seat: 0,
    finishingPosition,
    knockouts: 1,
    handsPlayed: 8,
    potsWon: 2,
    chipLeadHands: 1,
    chipLeadRate: 0.125,
    peakStack: 300,
    peakStackBigBlinds: 30,
    lowestPositiveStackBigBlinds: 4,
    netBigBlinds: 10,
    vpipHands: 3,
    vpipRate: 0.375,
    pfrHands: 2,
    pfrRate: 0.25,
    threeBetHands: 1,
    threeBetOpportunities: 2,
    threeBetRate: 0.5,
    showdownHands: 2,
    showdownWins: 1,
    showdownWinRate: 0.5,
    allInHands: 1,
    allInWins: 1,
    allInWinRate: 1,
    allInExpectedBigBlinds: 5,
    allInActualBigBlinds: 10,
    allInLuckBigBlinds: 5,
    allInEstimatedHands: 0,
    decisions: 12,
    validDecisions: 12,
    validDecisionRate: 1,
    firstPassDecisions: 11,
    firstPassRate: 11 / 12,
    providerCalls: 13,
    infrastructureRetries: 1,
    protocolCorrections: 1,
    timeouts: 0,
    fallbacks: 0,
    infrastructurePauses: 0,
    averageLatencyMs: 2_000,
    p95LatencyMs: 4_000,
    inputTokens: 4_000,
    outputTokens: 2_000,
    totalTokens: 6_000,
    tokenUsageCoverage: 1,
    ...overrides,
  };
}

function report(revisionId: string, finishingPosition: number, overrides: Partial<TournamentPlayerStatistics> = {}) {
  return {
    statistics: {
      tournamentId: "tournament",
      completedHands: 8,
      initialStack: 100,
      totalChips: 600,
      players: [
        player(revisionId, finishingPosition, overrides),
        player("77777777-7777-4777-8777-777777777777", finishingPosition === 1 ? 2 : 1),
      ],
      methodology: {
        chipPerformance: "bb",
        allInEquity: "off",
        threeBet: "second raise",
        validDecision: "engine valid",
        firstPass: "one call",
        monetaryCost: "unavailable",
      },
    },
    playerBrands: { [revisionId]: "kimi" as const },
  };
}

function dependencies(options: { existing?: boolean; empty?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("from competitor_revisions r") && sql.includes("provider_connections")) {
      return { rows: options.empty ? [] : revisions(), rowCount: options.empty ? 0 : 2 };
    }
    if (sql.includes("from tournament_entries e")) {
      return { rows: options.empty ? [] : entries(), rowCount: options.empty ? 0 : 2 };
    }
    if (sql.includes("from consistency_runs r")) {
      return {
        rows: [{
          id: CONSISTENCY_RUN,
          competitor_revision_id: REVISION_TWO,
          tier: "full",
          scenario_registry_version: "arena-consistency-scenarios-v1",
          prompt_name: "Arena v11",
          summary: {
            completedSamples: 40,
            validityRate: 0.975,
            meanDominantShare: 0.8,
            meanPairwiseAgreement: 0.7,
          },
          completed_samples: 40,
          scenario_count: 20,
          completed_at: NOW,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const identities = {
    getFamily: vi.fn(async () => options.existing === false ? null : family()),
  };
  const tournamentStatistics = vi.fn(async (id: string, includeAllInEquity: boolean) => {
    expect(includeAllInEquity).toBe(false);
    return id === TOURNAMENT_ONE
      ? report(REVISION_ONE, 1)
      : report(REVISION_TWO, 2, {
        netBigBlinds: -4,
        decisions: 6,
        handsPlayed: 4,
        tokenUsageCoverage: 0.5,
      });
  });
  const arena = {
    leaderboard: vi.fn(async () => options.empty
      ? {
        ...leaderboard(),
        competition: [],
        reliability: [],
        efficiency: [],
        styles: [],
      }
      : leaderboard()),
    tournamentStatistics,
  };
  const moments = { listPublicForPlayers: vi.fn(async () => []) };
  return {
    query,
    identities,
    arena,
    moments,
    service: new CompetitorProfileService(
      { query } as unknown as Pool,
      identities as unknown as CompetitorIdentityService,
      arena as unknown as ArenaService,
      moments as unknown as MomentService,
    ),
  };
}

describe("public competitor profile service", () => {
  it("keeps current-cohort metrics separate from cross-cohort career facts", async () => {
    const { service, arena, moments } = dependencies();

    const profile = await service.getProfile(COMPETITOR_ID);

    expect(profile).toMatchObject({
      competitor: {
        id: COMPETITOR_ID,
        displayName: "Kimi K3",
        providerBrand: "kimi",
        currentRevision: { id: REVISION_TWO, modelId: "kimi-k3" },
      },
      competitiveScope: { benchmarkCohortId: "cohort-current", rankedCompetitors: 1 },
      competition: { rank: 1, rating: 1532, tournaments: 1 },
      consistency: {
        runId: CONSISTENCY_RUN,
        competitorRevisionId: REVISION_TWO,
        validityRate: 0.975,
        completedSamples: 40,
      },
      career: {
        appearances: 2,
        ratedAppearances: 1,
        exhibitionAppearances: 1,
        wins: 1,
        podiums: 2,
        handsPlayed: 12,
        decisions: 18,
      },
    });
    expect(profile?.recentResults.map((result) => ({
      id: result.tournamentId,
      counted: result.countedInCurrentRanking,
      tokenUsageCoverage: result.tokenUsageCoverage,
    }))).toEqual([
      { id: TOURNAMENT_TWO, counted: false, tokenUsageCoverage: 0.5 },
      { id: TOURNAMENT_ONE, counted: true, tokenUsageCoverage: 1 },
    ]);
    expect(arena.tournamentStatistics).toHaveBeenCalledTimes(2);
    expect(moments.listPublicForPlayers).toHaveBeenCalledWith([REVISION_TWO, REVISION_ONE], 6);
    expect(profile?.competitor).not.toHaveProperty("apiKey");
    expect(profile?.competitor.currentRevision).not.toHaveProperty("parameters");
  });

  it("returns a complete unranked empty profile for a family without revisions or events", async () => {
    const { service, arena, moments, query } = dependencies({ empty: true });

    const profile = await service.getProfile(COMPETITOR_ID);

    expect(profile).toMatchObject({
      competitor: { currentRevision: null, providerBrand: null },
      competition: { rank: null, rating: null, tournaments: 0 },
      style: { handsPlayed: 0, profile: null },
      reliability: { decisions: 0 },
      efficiency: { providerCalls: 0, totalTokens: null },
      consistency: null,
      career: { appearances: 0, firstPlayedAt: null, lastPlayedAt: null },
      recentResults: [],
    });
    expect(arena.tournamentStatistics).not.toHaveBeenCalled();
    expect(moments.listPublicForPlayers).toHaveBeenCalledWith([], 6);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("from consistency_runs r"))).toBe(false);
  });

  it("does not expose a profile for an unknown stable identity", async () => {
    const { service, arena, moments } = dependencies({ existing: false });

    await expect(service.getProfile(COMPETITOR_ID)).resolves.toBeNull();
    expect(arena.leaderboard).not.toHaveBeenCalled();
    expect(moments.listPublicForPlayers).not.toHaveBeenCalled();
  });
});
