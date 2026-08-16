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
});
