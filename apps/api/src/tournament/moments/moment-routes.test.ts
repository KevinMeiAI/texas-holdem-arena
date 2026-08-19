import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publicMomentDtoSchema,
  tournamentMomentFactsSchema,
  type PublicMomentDto,
} from "../../../../../packages/contracts/src/moments.js";
import type { AuthService } from "../../auth/auth-service.js";
import type { AppConfig } from "../../config.js";
import {
  ArenaService,
  TournamentMomentInputError,
  type ArenaBroadcastReplayState,
} from "../arena-service.js";
import { BROADCAST_EQUITY_VERSION } from "../broadcast-equity.js";
import { BROADCAST_VIEW_VERSION, type BroadcastView } from "../broadcast-view.js";
import {
  momentEditorialUpdateSchema,
  momentReplayWindow,
  registerMomentRoutes,
} from "./moment-routes.js";
import type { MomentService } from "./moment-service.js";

const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000001";
const MOMENT_ID = "00000000-0000-5000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function facts() {
  return tournamentMomentFactsSchema.parse({
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 2,
    startSequence: 20,
    focusSequence: 23,
    endSequence: 30,
    factsVersion: "arena-moment-facts-v1",
    detectorVersion: "arena-moment-detector-v1",
    scoringVersion: "arena-moment-scoring-v1",
    broadcastViewVersion: BROADCAST_VIEW_VERSION,
    equityVersion: BROADCAST_EQUITY_VERSION,
    source: {
      eventHash: "1".repeat(64),
      eventCount: 11,
      startEventHash: "2".repeat(64),
      endEventHash: "3".repeat(64),
    },
    score: 70,
    scoreBreakdown: { potImpact: 20, tournamentImpact: 24, actionDrama: 10, equityDrama: 12, rarity: 4 },
    recommendationRank: 1,
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND"],
    participantPlayerIds: ["a", "b"],
    featuredPlayerIds: ["a"],
    winnerPlayerIds: ["a"],
    eliminatedPlayerIds: ["b"],
    showdownPlayerIds: ["a", "b"],
    board: ["2c", "3d", "4h", "8s", "Tc"],
    bigBlind: 10,
    potChips: 200,
    potBigBlinds: 20,
    totalChipShare: 1,
    startingStacks: { a: 100, b: 100 },
    endingStacks: { a: 200, b: 0 },
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
  });
}

function publicMoment(): PublicMomentDto {
  return publicMomentDtoSchema.parse({
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 2,
    status: "PUBLISHED",
    slug: "final-hand",
    titleZh: "最后一手",
    titleEn: "Final hand",
    summaryZh: null,
    summaryEn: null,
    coverSequence: 23,
    playbackStartSequence: 21,
    playbackEndSequence: 25,
    spoilerMode: "SUSPENSE",
    isPrimary: true,
    publicationRevision: 1,
    publishedAt: "2026-08-20T00:00:00.000Z",
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND"],
    score: 70,
    facts: facts(),
  });
}

function frame(sequence: number): BroadcastView {
  return {
    version: BROADCAST_VIEW_VERSION,
    equityVersion: BROADCAST_EQUITY_VERSION,
    handNo: 2,
    sequence,
    street: "PREFLOP",
    board: [],
    pot: 20,
    pots: [],
    positions: null,
    blinds: null,
    currentActorId: null,
    estimated: true,
    samples: 500,
    players: [],
  };
}

async function appWith(options: {
  arena?: Partial<ArenaService>;
  moments?: Partial<MomentService>;
  authenticated?: boolean;
}) {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyCookie);
  const auth = {
    session: vi.fn(async (token?: string) => options.authenticated !== false && token === "session"
      ? { adminUserId: ADMIN_ID, email: "admin@localhost", expiresAt: "2026-08-21T00:00:00.000Z" }
      : null),
    verifyCsrf: vi.fn(async (session?: string, csrf?: string) => session === "session" && csrf === "csrf"),
  } as unknown as AuthService;
  const arena = {
    publicState: vi.fn(async () => ({ tournamentId: TOURNAMENT_ID, status: "COMPLETED" })),
    ...options.arena,
  } as unknown as ArenaService;
  const moments = {
    listAdmin: vi.fn(async () => []),
    listPublic: vi.fn(async () => []),
    getPublicBySlug: vi.fn(async () => null),
    ...options.moments,
  } as unknown as MomentService;
  await registerMomentRoutes(app, {
    auth,
    config: {} as AppConfig,
    arena,
    moments,
  });
  return { app, arena, moments };
}

const adminHeaders = {
  cookie: "arena_session=session; arena_csrf=csrf",
  "x-arena-csrf": "csrf",
};

describe("moment route boundaries", () => {
  it("accepts only editorial PATCH fields", () => {
    expect(momentEditorialUpdateSchema.safeParse({ expectedRevision: null, titleEn: "A title" }).success).toBe(true);
    expect(momentEditorialUpdateSchema.safeParse({}).success).toBe(false);
    expect(momentEditorialUpdateSchema.safeParse({ expectedRevision: null }).success).toBe(false);
    expect(momentEditorialUpdateSchema.safeParse({ expectedRevision: null, status: "PUBLISHED" }).success).toBe(false);
    expect(momentEditorialUpdateSchema.safeParse({ expectedRevision: null, createdByAdminUserId: ADMIN_ID }).success).toBe(false);
  });

  it("rejects mutation without CSRF before calling the service", async () => {
    const editPublication = vi.fn();
    const { app } = await appWith({ moments: { editPublication } });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/moments/${MOMENT_ID}`,
      headers: { cookie: "arena_session=session; arena_csrf=csrf" },
      payload: { expectedRevision: null, titleEn: "A title" },
    });

    expect(response.statusCode).toBe(403);
    expect(editPublication).not.toHaveBeenCalled();
  });

  it("maps an unfinished tournament generation to 409 without auditing", async () => {
    const momentDetectionInput = vi.fn(async () => {
      throw new TournamentMomentInputError("RUNNING");
    });
    const { app } = await appWith({ arena: { momentDetectionInput } });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tournaments/${TOURNAMENT_ID}/moments/generate`,
      headers: adminHeaders,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "tournament_not_completed", status: "RUNNING" });
  });

  it("passes authenticated admin identity into atomic candidate generation", async () => {
    const generated = facts();
    const rebuild = vi.fn(async () => [generated]);
    const momentDetectionInput = vi.fn(async () => ({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events: [],
      broadcastFrames: [],
    }));
    const { app } = await appWith({
      arena: { momentDetectionInput },
      moments: { rebuild },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tournaments/${TOURNAMENT_ID}/moments/generate`,
      headers: adminHeaders,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ generatedCount: 1, moments: [{ id: MOMENT_ID }] });
    expect(rebuild).toHaveBeenCalledWith(expect.any(Object), ADMIN_ID);
  });

  it("keeps an unpublished slug indistinguishable from a missing one", async () => {
    const { app } = await appWith({ moments: { getPublicBySlug: vi.fn(async () => null) } });
    const detail = await app.inject({ method: "GET", url: "/api/public/moments/draft-hand" });
    const replay = await app.inject({ method: "GET", url: "/api/public/moments/draft-hand/replay" });

    expect(detail.statusCode).toBe(404);
    expect(replay.statusCode).toBe(404);
  });
});

describe("moment replay window", () => {
  it("returns copied, bounded arrays with a starting frame and elimination baseline", () => {
    const replay: ArenaBroadcastReplayState = {
      state: { tournamentId: TOURNAMENT_ID, status: "COMPLETED" },
      timeline: [frame(19), frame(22), frame(24), frame(26)],
      events: [
        { tournamentId: TOURNAMENT_ID, sequence: 10, aggregateVersion: 10, type: "PLAYER_ELIMINATED", actorId: "c", handNo: 1, publicPayload: {}, eventHash: "a".repeat(64), createdAt: "2026-08-20T00:00:00.000Z" },
        { tournamentId: TOURNAMENT_ID, sequence: 22, aggregateVersion: 22, type: "ACTION_APPLIED", actorId: "a", handNo: 2, publicPayload: {}, eventHash: "b".repeat(64), createdAt: "2026-08-20T00:00:01.000Z" },
        { tournamentId: TOURNAMENT_ID, sequence: 26, aggregateVersion: 26, type: "HAND_COMPLETED", actorId: null, handNo: 2, publicPayload: {}, eventHash: "c".repeat(64), createdAt: "2026-08-20T00:00:02.000Z" },
      ],
      playerBrands: { a: "chatgpt" },
    };
    const originalTimeline = [...replay.timeline];
    const originalEvents = [...replay.events];
    const window = momentReplayWindow(replay, publicMoment());

    expect(window.timeline.map((item) => item.sequence)).toEqual([22, 24]);
    expect(window.events.map((item) => item.sequence)).toEqual([22]);
    expect(window.initialFrame?.sequence).toBe(19);
    expect(window.coverFrame?.sequence).toBe(22);
    expect(window.initialEliminatedPlayerIds).toEqual(["c"]);
    expect(window.timeline).not.toBe(replay.timeline);
    expect(window.events).not.toBe(replay.events);
    expect(replay.timeline).toEqual(originalTimeline);
    expect(replay.events).toEqual(originalEvents);
  });

  it("never uses a frame beyond the playback or authoritative moment window", () => {
    const replay: ArenaBroadcastReplayState = {
      state: { tournamentId: TOURNAMENT_ID, status: "COMPLETED" },
      timeline: [frame(31)],
      events: [],
      playerBrands: {},
    };
    const moment = publicMomentDtoSchema.parse({
      ...publicMoment(),
      coverSequence: 30,
      playbackStartSequence: 29,
      playbackEndSequence: 29,
    });

    const window = momentReplayWindow(replay, moment);

    expect(window.initialFrame).toBeNull();
    expect(window.coverFrame).toBeNull();
    expect(window.timeline).toEqual([]);
  });

  it("never fills the opening baseline with a future frame", () => {
    const replay: ArenaBroadcastReplayState = {
      state: { tournamentId: TOURNAMENT_ID, status: "COMPLETED" },
      timeline: [frame(22)],
      events: [],
      playerBrands: {},
    };
    const moment = publicMomentDtoSchema.parse({
      ...publicMoment(),
      playbackStartSequence: 21,
      playbackEndSequence: 25,
    });

    const window = momentReplayWindow(replay, moment);

    expect(window.initialFrame).toBeNull();
    expect(window.coverFrame?.sequence).toBe(22);
  });
});
