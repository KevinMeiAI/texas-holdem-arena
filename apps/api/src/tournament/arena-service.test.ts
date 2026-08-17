import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfigService } from "../admin/model-service.js";
import { ArenaService } from "./arena-service.js";

describe("arena tournament statistics report", () => {
  it("returns frozen player brands with the calculated statistics", async () => {
    const claudeRevisionId = "11111111-1111-4111-8111-111111111111";
    const deepseekRevisionId = "22222222-2222-4222-8222-222222222222";
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
        providerProfile: "anthropic",
        providerType: "anthropic-messages",
        providerLabel: "Anthropic",
        providerBaseUrl: null,
        modelId: "claude-opus-5",
      },
      {
        revisionId: deepseekRevisionId,
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
    expect(revisionDetails).toHaveBeenCalledWith([claudeRevisionId, deepseekRevisionId]);
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
});
