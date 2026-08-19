import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  arenaOutputSchema,
  decisionProtocolBundle,
  type CanonicalModelRequest,
} from "../../../../../packages/contracts/src/index.js";
import {
  HandForkSourceCatalog,
  PgHandForkSourceCatalogStore,
  handForkSourcePayload,
  type HandForkSourceAnchor,
  type HandForkSourceCatalogStore,
  type HandForkSourceResolverLike,
} from "./hand-fork-source-catalog.js";
import {
  HandForkSourceError,
  type HandForkResolvedSource,
} from "./hand-fork-source.js";
import { validateHandForkSourcePayload } from "./hand-fork-repository.js";

const TOURNAMENT_ID = "11111111-1111-4111-8111-111111111111";
const DECISION_ONE = "22222222-2222-4222-8222-222222222222";
const DECISION_TWO = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);

function resolvedSource(
  decisionId = DECISION_ONE,
  playerId = "hero",
  expectedAggregateVersion = 10,
): HandForkResolvedSource {
  const protocolBundle = decisionProtocolBundle("arena-native-v11");
  const outputSchema = arenaOutputSchema("ACTION_OR_HISTORY", protocolBundle.outputSchemaVersion);
  const baseRequest: CanonicalModelRequest = {
    requestId: decisionId,
    expectedOutput: "ACTION_OR_HISTORY",
    systemPrompt: "Frozen source prompt",
    systemPromptHash: HASH,
    outputSchema,
    userPayload: { schema_version: protocolBundle.contextVersion },
    timeoutMs: 180_000,
    parserPolicy: protocolBundle.parserPolicyVersion,
    adapterProtocolVersion: protocolBundle.adapterProtocolVersion,
  };
  return {
    tournamentId: TOURNAMENT_ID,
    tournamentName: "Completed source tournament",
    handNo: 7,
    decisionId,
    expectedAggregateVersion,
    playerId,
    playerDisplayName: "Hero model",
    street: "TURN",
    heroPosition: "BTN",
    holeCards: ["Ah", "Kd"],
    legalActions: {
      allowed: ["fold", "call", "raise", "all_in"],
      call: { amount: 120, will_be_all_in: false },
      bet: null,
      raise: { min_amount_to: 360, max_amount_to: 1_800 },
      all_in: { resulting_street_commitment: 1_800, classification: "raise" },
    },
    originalAction: "call",
    originalAmountTo: null,
    originalDecisionSummary: "Continue with showdown value.",
    originalUsedFallback: false,
    decisionEventSequence: 98,
    actionEventSequence: 99,
    sourceEventHash: "b".repeat(64),
    requestHash: "c".repeat(64),
    visibleInputHash: "d".repeat(64),
    legalContractHash: "e".repeat(64),
    snapshotChecksum: "f".repeat(64),
    baseRequest,
    decisionConfig: {
      maxInfrastructureAttempts: 3,
      infrastructureRetryDelaysMs: [2_000, 8_000],
      history: { maxQueries: 2, maxRecordsPerQuery: 80, maxApproxTokens: 4_000 },
    },
    protocolBundle,
    historyProtocolVersion: protocolBundle.historyProtocolVersion,
    rulesetVersion: "arena-rules-v2",
  };
}

function catalogStore(
  anchors: HandForkSourceAnchor[] = [{
    decisionId: DECISION_ONE,
    playerId: "hero",
    expectedAggregateVersion: 10,
  }],
): HandForkSourceCatalogStore & {
  tournamentExists: ReturnType<typeof vi.fn>;
  handExists: ReturnType<typeof vi.fn>;
  listActionDecisionAnchors: ReturnType<typeof vi.fn>;
} {
  return {
    tournamentExists: vi.fn(async () => true),
    handExists: vi.fn(async () => true),
    listActionDecisionAnchors: vi.fn(async () => anchors),
  };
}

describe("HandForkSourceCatalog", () => {
  it("discovers legacy-compatible decision anchors and safely marks resolver failures", async () => {
    const store = catalogStore([
      { decisionId: DECISION_ONE, playerId: "hero", expectedAggregateVersion: 10 },
      { decisionId: DECISION_TWO, playerId: "villain", expectedAggregateVersion: 12 },
    ]);
    const resolver: HandForkSourceResolverLike = {
      resolve: vi.fn(async (decisionId) => {
        if (decisionId === DECISION_TWO) {
          throw new HandForkSourceError(
            "SOURCE_PROTOCOL_UNSUPPORTED",
            "Sensitive internal protocol detail",
          );
        }
        return resolvedSource();
      }),
    };

    const candidates = await new HandForkSourceCatalog(store, resolver).list(TOURNAMENT_ID, 7);

    expect(resolver.resolve).toHaveBeenNthCalledWith(1, DECISION_ONE, {
      tournamentId: TOURNAMENT_ID,
      handNo: 7,
    });
    expect(resolver.resolve).toHaveBeenNthCalledWith(2, DECISION_TWO, {
      tournamentId: TOURNAMENT_ID,
      handNo: 7,
    });
    expect(candidates[0]).toMatchObject({
      availability: "AVAILABLE",
      decisionId: DECISION_ONE,
      source: {
        playerDisplayName: "Hero model",
        holeCards: ["Ah", "Kd"],
        originalAction: "call",
      },
      sourceIntegrity: {
        expectedAggregateVersion: 10,
        protocolBundleId: "arena-native-v11",
      },
    });
    expect(candidates[1]).toEqual({
      availability: "UNAVAILABLE",
      decisionId: DECISION_TWO,
      playerId: "villain",
      expectedAggregateVersion: 12,
      reasonCode: "SOURCE_PROTOCOL_UNSUPPORTED",
    });
    expect(candidates[1]).not.toHaveProperty("message");
  });

  it("builds the exact allowlisted payload used by persistence without hidden table state", () => {
    const payload = handForkSourcePayload(resolvedSource());

    expect(validateHandForkSourcePayload(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      version: "hand-fork-source-v1",
      source: {
        tournamentName: "Completed source tournament",
        decisionEventSequence: 98,
        snapshotChecksum: "f".repeat(64),
      },
      baseRequest: { requestId: DECISION_ONE },
    });
    expect(payload).not.toHaveProperty("handState");
    expect(payload).not.toHaveProperty("deck");
    expect(JSON.stringify(payload)).not.toContain("masterSeed");
  });

  it("distinguishes a missing tournament from a missing hand before resolving anchors", async () => {
    const missingTournament = catalogStore();
    missingTournament.tournamentExists.mockResolvedValue(false);
    const resolver = { resolve: vi.fn() } as unknown as HandForkSourceResolverLike;

    await expect(new HandForkSourceCatalog(missingTournament, resolver).list(TOURNAMENT_ID, 7))
      .rejects.toMatchObject({
        name: "HandForkSourceCatalogError",
        code: "TOURNAMENT_NOT_FOUND",
      });
    expect(missingTournament.handExists).not.toHaveBeenCalled();

    const missingHand = catalogStore();
    missingHand.handExists.mockResolvedValue(false);
    await expect(new HandForkSourceCatalog(missingHand, resolver).list(TOURNAMENT_ID, 7))
      .rejects.toMatchObject({
        name: "HandForkSourceCatalogError",
        code: "HAND_NOT_FOUND",
      });
    expect(missingHand.listActionDecisionAnchors).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("does not disguise an unexpected resolver or database failure as source unavailability", async () => {
    const resolver: HandForkSourceResolverLike = {
      resolve: vi.fn(async () => { throw new Error("database unavailable"); }),
    };

    await expect(new HandForkSourceCatalog(catalogStore(), resolver).list(TOURNAMENT_ID, 7))
      .rejects.toThrow("database unavailable");
  });
});

describe("PgHandForkSourceCatalogStore", () => {
  it("queries ACTION decision rows directly, so old events need no decisionId payload", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ one: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ one: 1 }] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { id: DECISION_ONE, player_id: "hero", expected_aggregate_version: "10" },
          { id: DECISION_TWO, player_id: "villain", expected_aggregate_version: 12 },
        ],
      });
    const store = new PgHandForkSourceCatalogStore({ query } as unknown as Pool);

    expect(await store.tournamentExists(TOURNAMENT_ID)).toBe(true);
    expect(await store.handExists(TOURNAMENT_ID, 7)).toBe(true);
    expect(await store.listActionDecisionAnchors(TOURNAMENT_ID, 7)).toEqual([
      { decisionId: DECISION_ONE, playerId: "hero", expectedAggregateVersion: 10 },
      { decisionId: DECISION_TWO, playerId: "villain", expectedAggregateVersion: 12 },
    ]);

    const decisionSql = String(query.mock.calls[2]?.[0]);
    expect(decisionSql).toContain("from decision_requests");
    expect(decisionSql).toContain("request_kind = 'ACTION'");
    expect(decisionSql).not.toContain("MODEL_DECISION_RECORDED");
  });
});
