import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfigService } from "../admin/model-service.js";
import {
  ArenaService,
  assertDistinctCompetitorFamilies,
  dispatchDetachedTournamentCompletion,
  TournamentMomentInputError,
} from "./arena-service.js";

describe("arena completion side effects", () => {
  it("contains synchronous and asynchronous index failures outside the arena driver", async () => {
    const onError = vi.fn();
    const tournamentId = "33333333-3333-4333-8333-333333333333";

    expect(() => dispatchDetachedTournamentCompletion(tournamentId, () => {
      throw new Error("sync index failure");
    }, onError)).not.toThrow();
    const asynchronousRun = dispatchDetachedTournamentCompletion(
      tournamentId,
      async () => { throw new Error("async index failure"); },
      onError,
    );
    await asynchronousRun;
    expect(onError).toHaveBeenCalledTimes(2);

    expect(() => dispatchDetachedTournamentCompletion(
      tournamentId,
      () => { throw new Error("index failure"); },
      () => { throw new Error("logger failure"); },
    )).not.toThrow();
  });
});

describe("arena competitor seats", () => {
  it("rejects two runtime configurations that represent the same competitor", () => {
    expect(() => assertDistinctCompetitorFamilies([
      { competitorFamilyId: "family-a", displayName: "Alpha high" },
      { competitorFamilyId: "family-a", displayName: "Alpha low" },
    ])).toThrow("A competitor can occupy only one seat");

    expect(() => assertDistinctCompetitorFamilies([
      { competitorFamilyId: "family-a", displayName: "Alpha" },
      { competitorFamilyId: "family-b", displayName: "Beta" },
    ])).not.toThrow();
  });
});

describe("arena tournament statistics report", () => {
  it("falls back to tournament entry snapshots when an old public state lacks player identity fields", async () => {
    const tournamentId = "33333333-3333-4333-8333-333333333333";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select name, public_state from tournaments")) {
        return {
          rows: [{
            name: "Old final",
            public_state: { tournamentId, status: "COMPLETED" },
          }],
        };
      }
      if (sql.includes("from tournament_entries")) {
        return { rows: [{ id: "legacy-player", display_name: "Legacy", seat: 3 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails: vi.fn(async () => []) } as unknown as ModelConfigService,
      0,
    );

    await expect(service.publicIdentityContext(tournamentId)).resolves.toEqual({
      tournament: { id: tournamentId, name: "Old final" },
      players: [{
        id: "legacy-player",
        displayName: "Legacy",
        seat: 3,
        competitorId: null,
        providerBrand: null,
      }],
    });
  });

  it("keeps old revision identities linkable and unknown legacy identities nullable", async () => {
    const tournamentId = "33333333-3333-4333-8333-333333333333";
    const currentRevisionId = "11111111-1111-4111-8111-111111111111";
    const legacyRevisionId = "22222222-2222-4222-8222-222222222222";
    const unknownRevisionId = "66666666-6666-4666-8666-666666666666";
    const currentCompetitorId = "44444444-4444-4444-8444-444444444444";
    const legacyCompetitorId = "55555555-5555-4555-8555-555555555555";
    const state = {
      tournamentId,
      name: "Legacy final",
      players: [
        { id: currentRevisionId, displayName: "Current", seat: 2 },
        { id: legacyRevisionId, displayName: "Legacy", seat: 0 },
        { id: unknownRevisionId, displayName: "Unknown", seat: 1 },
      ],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tournaments")) return { rows: [{ public_state: state }] };
      if (sql.includes("from unnest($1::uuid[])")) {
        return { rows: [{ player_id: legacyRevisionId, competitor_family_id: legacyCompetitorId }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const revisionDetails = vi.fn(async () => [{
      revisionId: currentRevisionId,
      competitorFamilyId: currentCompetitorId,
      providerProfile: "anthropic",
      providerType: "anthropic-messages",
      providerLabel: "Anthropic",
      providerBaseUrl: null,
      modelId: "claude-opus-5",
    }]);
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails } as unknown as ModelConfigService,
      0,
    );

    const context = await service.publicIdentityContext(tournamentId);

    expect(context).toEqual({
      tournament: { id: tournamentId, name: "Legacy final" },
      players: [
        { id: legacyRevisionId, displayName: "Legacy", seat: 0, competitorId: legacyCompetitorId, providerBrand: null },
        { id: unknownRevisionId, displayName: "Unknown", seat: 1, competitorId: null, providerBrand: null },
        { id: currentRevisionId, displayName: "Current", seat: 2, competitorId: currentCompetitorId, providerBrand: "claude" },
      ],
    });
  });

  it("returns frozen player brands with the calculated statistics", async () => {
    const claudeRevisionId = "11111111-1111-4111-8111-111111111111";
    const deepseekRevisionId = "22222222-2222-4222-8222-222222222222";
    const claudeCompetitorId = "44444444-4444-4444-8444-444444444444";
    const deepseekCompetitorId = "55555555-5555-4555-8555-555555555555";
    const state = {
      tournamentId: "33333333-3333-4333-8333-333333333333",
      status: "COMPLETED",
      completedHands: 0,
      championPlayerId: claudeRevisionId,
      players: [
        { id: claudeRevisionId, displayName: "Claude", seat: 0, stack: 100, finishingPosition: 1 },
        { id: deepseekRevisionId, displayName: "DeepSeek", seat: 1, stack: 100, finishingPosition: 2 },
      ],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tournaments")) return { rows: [{ public_state: state }] };
      if (sql.includes("from arena_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const revisionDetails = vi.fn(async () => [
      {
        revisionId: claudeRevisionId,
        competitorFamilyId: claudeCompetitorId,
        providerProfile: "anthropic",
        providerType: "anthropic-messages",
        providerLabel: "Anthropic",
        providerBaseUrl: null,
        modelId: "claude-opus-5",
      },
      {
        revisionId: deepseekRevisionId,
        competitorFamilyId: deepseekCompetitorId,
        providerProfile: "deepseek",
        providerType: "openai-compatible",
        providerLabel: "DeepSeek",
        providerBaseUrl: "https://api.deepseek.com",
        modelId: "deepseek-v4",
      },
    ]);
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails } as unknown as ModelConfigService,
      0,
    );

    const report = await service.tournamentStatistics(state.tournamentId);

    expect(report?.statistics.tournamentId).toBe(state.tournamentId);
    expect(report?.playerBrands).toEqual({
      [claudeRevisionId]: "claude",
      [deepseekRevisionId]: "deepseek",
    });
    expect(report?.playerCompetitorIds).toEqual({
      [claudeRevisionId]: claudeCompetitorId,
      [deepseekRevisionId]: deepseekCompetitorId,
    });
    expect(revisionDetails).toHaveBeenCalledWith([claudeRevisionId, deepseekRevisionId]);
  });

  it("deduplicates completed light and full calculations without mixing their caches", async () => {
    const tournamentId = "33333333-3333-4333-8333-333333333333";
    const state = {
      tournamentId,
      status: "COMPLETED",
      completedHands: 0,
      championPlayerId: null,
      players: [],
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tournaments")) return { rows: [{ public_state: state }] };
      if (sql.includes("from arena_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails: vi.fn(async () => []) } as unknown as ModelConfigService,
      0,
    );

    await Promise.all([
      service.tournamentStatistics(tournamentId, false),
      service.tournamentStatistics(tournamentId, false),
    ]);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("from arena_events"))).toHaveLength(1);

    await Promise.all([
      service.tournamentStatistics(tournamentId, true),
      service.tournamentStatistics(tournamentId, true),
    ]);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("from arena_events"))).toHaveLength(2);

    await service.tournamentStatistics(tournamentId, false);
    await service.tournamentStatistics(tournamentId, true);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("from arena_events"))).toHaveLength(2);
  });

  it("does not cache a partial broadcast replay before the tournament ends", async () => {
    const tournamentId = "33333333-3333-4333-8333-333333333333";
    let state = {
      tournamentId,
      status: "RUNNING",
      completedHands: 0,
      players: [],
      hand: null,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tournaments")) return { rows: [{ public_state: state }] };
      if (sql.includes("from arena_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails: vi.fn(async () => []) } as unknown as ModelConfigService,
      0,
    );

    const unfinished = await service.broadcastReplayState(tournamentId);
    expect(unfinished).toMatchObject({
      state: { status: "RUNNING", completedHands: 0 },
      timeline: [],
      events: [],
      playerBrands: {},
    });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("from arena_events"))).toHaveLength(0);

    state = { ...state, status: "COMPLETED", completedHands: 1 };
    const completed = await service.broadcastReplayState(tournamentId);
    expect(completed?.state).toMatchObject({ status: "COMPLETED", completedHands: 1 });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("from arena_events"))).toHaveLength(1);

    await service.broadcastReplayState(tournamentId);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("from arena_events"))).toHaveLength(1);
  });

  it("pushes an SSE cursor into the event-store query", async () => {
    const tournamentId = "33333333-3333-4333-8333-333333333333";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from arena_events")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails: vi.fn(async () => []) } as unknown as ModelConfigService,
      0,
    );

    await service.projectedEvents(tournamentId, "SPECTATOR_LIVE", 42);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("sequence > $2"),
      [tournamentId, 42],
    );
  });

  it("builds moment input only from a completed tournament replay projection", async () => {
    const tournamentId = "33333333-3333-4333-8333-333333333333";
    let state = {
      tournamentId,
      status: "RUNNING",
      completedHands: 0,
      players: [],
      hand: null,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tournaments")) return { rows: [{ public_state: state }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const service = new ArenaService(
      { query } as unknown as Pool,
      new Uint8Array(32),
      { revisionDetails: vi.fn(async () => []) } as unknown as ModelConfigService,
      0,
    );
    const projectedEvents = vi.spyOn(service, "projectedEvents").mockResolvedValue([]);

    await expect(service.momentDetectionInput(tournamentId)).rejects.toBeInstanceOf(TournamentMomentInputError);
    expect(projectedEvents).not.toHaveBeenCalled();

    state = { ...state, status: "COMPLETED", completedHands: 1 };
    const input = await service.momentDetectionInput(tournamentId);
    expect(projectedEvents).toHaveBeenCalledWith(tournamentId, "SPECTATOR_REPLAY");
    expect(input).toMatchObject({
      tournamentId,
      tournamentStatus: "COMPLETED",
      events: [],
      broadcastFrames: [],
    });
  });
});
