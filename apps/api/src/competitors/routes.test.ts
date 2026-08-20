import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publicCompetitorProfileSchema,
  type PublicCompetitorProfile,
} from "../../../../packages/contracts/src/competitors.js";
import {
  registerCompetitorRoutes,
  type CompetitorProfileRouteService,
} from "./routes.js";

const COMPETITOR_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-20T00:00:00.000Z";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function profile(): PublicCompetitorProfile {
  return publicCompetitorProfileSchema.parse({
    schemaVersion: "arena-competitor-profile-v1",
    competitor: {
      id: COMPETITOR_ID,
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
    competitiveScope: {
      eventClass: "RATED",
      benchmarkCohortId: "cohort-v1",
      rankedCompetitors: 6,
    },
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
  });
}

async function appWith(getProfile: CompetitorProfileRouteService["getProfile"]) {
  const app = Fastify();
  apps.push(app);
  const competitorProfiles = { getProfile } satisfies CompetitorProfileRouteService;
  await registerCompetitorRoutes(app, { competitorProfiles });
  return { app, competitorProfiles };
}

describe("public competitor profile route", () => {
  it("maps an invalid UUID to the same 404 as an unknown competitor", async () => {
    const getProfile = vi.fn<CompetitorProfileRouteService["getProfile"]>();
    const { app } = await appWith(getProfile);
    const response = await app.inject({
      method: "GET",
      url: "/api/public/competitors/not-a-uuid",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "competitor_not_found" });
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("returns 404 when the profile service cannot find the competitor", async () => {
    const getProfile = vi.fn(async () => null);
    const { app } = await appWith(getProfile);
    const response = await app.inject({
      method: "GET",
      url: `/api/public/competitors/${COMPETITOR_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "competitor_not_found" });
    expect(getProfile).toHaveBeenCalledWith(COMPETITOR_ID);
  });

  it("returns a schema-validated public profile", async () => {
    const expected = profile();
    const getProfile = vi.fn(async () => expected);
    const { app } = await appWith(getProfile);
    const response = await app.inject({
      method: "GET",
      url: `/api/public/competitors/${COMPETITOR_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profile: expected });
    expect(publicCompetitorProfileSchema.parse(response.json().profile)).toEqual(expected);
  });

  it("fails closed when the service returns a drifting public DTO", async () => {
    const getProfile = vi.fn(async () => ({ ...profile(), apiKey: "must-not-leak" })) as unknown as
      CompetitorProfileRouteService["getProfile"];
    const { app } = await appWith(getProfile);
    const response = await app.inject({
      method: "GET",
      url: `/api/public/competitors/${COMPETITOR_ID}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "competitor_profile_invalid" });
    expect(response.body).not.toContain("must-not-leak");
  });

  it("does not expose database or aggregation errors from the public route", async () => {
    const getProfile = vi.fn(async () => {
      throw new Error("postgres password leaked in internal tournament query");
    });
    const { app } = await appWith(getProfile);
    const response = await app.inject({
      method: "GET",
      url: `/api/public/competitors/${COMPETITOR_ID}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "competitor_profile_unavailable" });
    expect(response.body).not.toContain("postgres password");
    expect(response.body).not.toContain("tournament query");
  });
});
