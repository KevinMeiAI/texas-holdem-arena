import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { PgEventStore } from "../persistence/event-store.js";
import { TournamentOrchestrator, type OrchestratorRuntime } from "./orchestrator.js";

describe("tournament orchestrator operational failures", () => {
  it("persists an unexpected arena driver failure as an infrastructure pause", async () => {
    const append = vi.fn(async (input: { expectedVersion: number; events: unknown[] }) => ({
      aggregateVersion: input.expectedVersion + input.events.length,
    }));
    const orchestrator = new TournamentOrchestrator({
      eventStore: { append } as unknown as PgEventStore,
      pool: {} as Pool,
      providers: new Map(),
    });
    const runtime = {
      tournamentId: "33333333-3333-4333-8333-333333333333",
      name: "Driver fault fixture",
      rulesetVersion: "test-rules",
      protocolBundle: { id: "test-protocol" },
      operationalStatus: "RUNNING",
      aggregateVersion: 4,
      effectivePrompt: { sha256: "0".repeat(64), text: "test prompt" },
      domain: {
        completedHands: 0,
        championPlayerId: null,
        players: [],
        currentHand: null,
      },
      playerLabels: {},
      pendingDecisionId: "44444444-4444-4444-8444-444444444444",
      decisionTimeoutMs: 180_000,
    } as unknown as OrchestratorRuntime;

    const paused = await orchestrator.pauseForDriverFailure(runtime, "TypeError");

    expect(paused.operationalStatus).toBe("PAUSED_INFRA");
    expect(paused.aggregateVersion).toBe(5);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: "PAUSED_INFRA",
      events: [expect.objectContaining({
        type: "TOURNAMENT_PAUSED_INFRA",
        publicPayload: {
          decisionId: runtime.pendingDecisionId,
          errorKind: "TypeError",
          source: "ARENA_DRIVER",
          attempts: 0,
        },
      })],
    }));
  });

  it("resumes a driver pause without a pending decision through the ready state", async () => {
    const append = vi.fn(async (input: { expectedVersion: number; events: unknown[] }) => ({
      aggregateVersion: input.expectedVersion + input.events.length,
    }));
    const orchestrator = new TournamentOrchestrator({
      eventStore: { append } as unknown as PgEventStore,
      pool: {} as Pool,
      providers: new Map(),
    });
    const runtime = {
      tournamentId: "33333333-3333-4333-8333-333333333333",
      name: "Driver fault fixture",
      rulesetVersion: "test-rules",
      protocolBundle: { id: "test-protocol" },
      operationalStatus: "PAUSED_INFRA",
      aggregateVersion: 5,
      effectivePrompt: { sha256: "0".repeat(64), text: "test prompt" },
      domain: {
        completedHands: 0,
        championPlayerId: null,
        players: [],
        currentHand: null,
      },
      playerLabels: {},
      pendingDecisionId: null,
      decisionTimeoutMs: 180_000,
    } as unknown as OrchestratorRuntime;

    const resumed = await orchestrator.resume(runtime);

    expect(resumed.operationalStatus).toBe("READY");
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      nextStatus: "READY",
      events: [expect.objectContaining({
        type: "TOURNAMENT_RESUMED",
        publicPayload: expect.objectContaining({ decisionId: null }),
      })],
    }));
  });
});
