import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  DECISION_BRANCH_SNAPSHOT_VERSION,
  decisionBranchSnapshotV1Schema,
  type StoredDecisionBranchSnapshot,
} from "../../../../../packages/contracts/src/index.js";
import {
  DecisionBranchPublicationConflictError,
  PgDecisionBranchRepository,
  decisionBranchSnapshotHash,
} from "./decision-branch-repository.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function snapshot(): StoredDecisionBranchSnapshot {
  return decisionBranchSnapshotV1Schema.parse({
    version: DECISION_BRANCH_SNAPSHOT_VERSION,
    source: {
      tournamentId: uuid(1),
      tournamentName: "Final Table",
      handNo: 12,
      actionSequence: 90,
      street: "FLOP",
      heroPlayerId: "hero",
      heroDisplayName: "Hero",
      heroPosition: "BTN",
      heroHoleCards: ["Ah", "Kd"],
      board: ["Ac", "7d", "2s"],
      blinds: { smallBlind: 50, bigBlind: 100, bigBlindAnte: 100 },
      potBeforeAction: 900,
      potBigBlinds: 9,
      currentBet: 0,
      callAmount: 0,
      legalActions: {
        allowed: ["check", "bet", "all_in"],
        call: null,
        bet: { min_amount_to: 100, max_amount_to: 4_000 },
        raise: null,
        all_in: { resulting_street_commitment: 4_000, classification: "bet" },
      },
      players: [
        {
          playerId: "hero",
          displayName: "Hero",
          seat: 0,
          position: "BTN",
          stack: 4_000,
          stackBigBlinds: 40,
          streetCommitted: 0,
          totalCommitted: 450,
          folded: false,
          allIn: false,
          competitorId: uuid(2),
          providerBrand: "chatgpt",
        },
        {
          playerId: "villain",
          displayName: "Villain",
          seat: 1,
          position: "BB",
          stack: 4_000,
          stackBigBlinds: 40,
          streetCommitted: 0,
          totalCommitted: 450,
          folded: false,
          allIn: false,
          competitorId: uuid(3),
          providerBrand: "claude",
        },
      ],
      actionHistory: [],
      originalDecision: {
        action: "check",
        amountTo: null,
        decisionSummary: "Control the pot.",
        usedFallback: false,
      },
    },
    methodology: {
      scope: "DECISION_ONLY",
      continuationSimulated: false,
      sameVisibleInput: true,
      sampleCountPerModel: 1,
      targetCount: 1,
      createdAt: "2026-08-20T01:00:00.000Z",
      completedAt: "2026-08-20T01:01:00.000Z",
    },
    targets: [{
      ordinal: 1,
      competitorId: uuid(4),
      competitorRevisionId: uuid(5),
      displayName: "Rerun Model",
      modelId: "model-v1",
      providerBrand: "deepseek",
      effectiveOutputMode: "json_schema",
      requestedSamples: 1,
      completedTrials: 1,
      modelActionTrials: 1,
      fallbackTrials: 0,
      infrastructureErrorTrials: 0,
      modalAction: "bet",
      modalShare: 1,
      pairwiseAgreement: null,
      firstTurnValidRate: 1,
      historyQueryRate: 0,
      correctionRate: 0,
      averageLatencyMs: 900,
      p95LatencyMs: 900,
      actionDistribution: [{ action: "bet", count: 1, share: 1 }],
      sizing: [{ action: "bet", count: 1, median: 500, min: 500, max: 500 }],
      trials: [{
        sampleIndex: 1,
        outcome: "MODEL_ACTION",
        action: "bet",
        amountTo: 500,
        decisionSummary: "Bet for value.",
        usedFallback: false,
      }],
    }],
  });
}

function row(overrides: Record<string, unknown> = {}) {
  const publicSnapshot = snapshot();
  return {
    id: uuid(10),
    source_hand_fork_id: uuid(11),
    status: "DRAFT",
    slug: null,
    title_zh: null,
    title_en: null,
    summary_zh: null,
    summary_en: null,
    snapshot_version: publicSnapshot.version,
    public_snapshot: publicSnapshot,
    public_snapshot_hash: decisionBranchSnapshotHash(publicSnapshot),
    publication_revision: 1,
    created_by_admin_user_id: uuid(12),
    published_at: null,
    created_at: "2026-08-20T01:00:00.000Z",
    updated_at: "2026-08-20T01:00:00.000Z",
    ...overrides,
  };
}

describe("decision branch repository", () => {
  it("hashes canonical snapshots deterministically", () => {
    const first = snapshot();
    const reordered = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
    reordered.methodology = { ...(reordered.methodology as Record<string, unknown>) };
    expect(decisionBranchSnapshotHash(first))
      .toBe(decisionBranchSnapshotHash(decisionBranchSnapshotV1Schema.parse(reordered)));
  });

  it("creates the draft and audit record in one transaction", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
        if (sql.includes("insert into decision_branch_publications")) return { rows: [row()], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => calls.push("release"),
    } as unknown as PoolClient;
    const repository = new PgDecisionBranchRepository({
      connect: async () => client,
    } as unknown as Pool);
    const result = await repository.createDraft({
      id: uuid(10),
      handForkId: uuid(11),
      snapshot: snapshot(),
      createdByAdminUserId: uuid(12),
    }, {
      adminUserId: uuid(12),
      action: "decision_branch.create",
      targetId: uuid(10),
      metadata: {},
    });
    expect(result).toMatchObject({ created: true, publication: { status: "DRAFT", revision: 1 } });
    expect(calls.some((call) => call.startsWith("insert into audit_events"))).toBe(true);
    expect(calls).toContain("commit");
    expect(calls).not.toContain("rollback");
  });

  it("rolls back the draft if its audit record cannot be written", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        const command = sql.trim().split(/\s+/).slice(0, 4).join(" ");
        calls.push(command);
        if (sql.includes("insert into decision_branch_publications")) return { rows: [row()], rowCount: 1 };
        if (sql.includes("insert into audit_events")) throw new Error("audit unavailable");
        return { rows: [], rowCount: 1 };
      },
      release: () => calls.push("release"),
    } as unknown as PoolClient;
    const repository = new PgDecisionBranchRepository({ connect: async () => client } as unknown as Pool);
    await expect(repository.createDraft({
      id: uuid(10),
      handForkId: uuid(11),
      snapshot: snapshot(),
      createdByAdminUserId: uuid(12),
    }, {
      adminUserId: uuid(12),
      action: "decision_branch.create",
      targetId: uuid(10),
      metadata: {},
    })).rejects.toThrow("audit unavailable");
    expect(calls).toContain("rollback");
    expect(calls).not.toContain("commit");
  });

  it("fails closed on stale revisions and filters public reads in SQL", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const repository = new PgDecisionBranchRepository(pool);
    await expect(repository.updatePublication({
      id: uuid(10),
      status: "DRAFT",
      slug: null,
      titleZh: "标题",
      titleEn: null,
      summaryZh: null,
      summaryEn: null,
      createdByAdminUserId: uuid(12),
    }, 1, {
      adminUserId: uuid(12),
      action: "decision_branch.update",
      targetId: uuid(10),
      metadata: {},
    })).rejects.toBeInstanceOf(DecisionBranchPublicationConflictError);
    await repository.getPublishedBySlug("final-hand");
    expect(statements.some((sql) => sql.includes("status = 'PUBLISHED'"))).toBe(true);
    expect(statements.some((sql) => sql.trim() === "rollback")).toBe(true);
  });

  it("detects a tampered public snapshot before returning it", async () => {
    const repository = new PgDecisionBranchRepository({
      query: async () => ({ rows: [row({ public_snapshot_hash: "0".repeat(64) })], rowCount: 1 }),
    } as unknown as Pool);
    await expect(repository.getById(uuid(10))).rejects.toThrow(/snapshot hash mismatch/i);
  });
});
