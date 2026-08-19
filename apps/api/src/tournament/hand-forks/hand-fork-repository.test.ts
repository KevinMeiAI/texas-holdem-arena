import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handForkTrialSchema, type HandForkTarget, type HandForkTrial } from "../../../../../packages/contracts/src/index.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";
import { runMigrations } from "../../../../../db/migrate.js";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "../../../../../tests/integration/postgres-test-schema.js";
import {
  HandForkPersistenceConflictError,
  PgHandForkRepository,
  summarizeHandForkTargets,
  summarizeHandForkTrials,
  validateHandForkSourcePayload,
  type CompleteHandForkTrialInput,
  type CreateHandForkPersistenceInput,
  type HandForkSourcePayloadV1,
  type HandForkTurnAuditInput,
} from "./hand-fork-repository.js";

const UUID_FORK = "00000000-0000-4000-8000-000000000901";
const UUID_TARGET = "00000000-0000-4000-8000-000000000902";
const UUID_TRIAL = "00000000-0000-4000-8000-000000000903";
const UUID_LEASE = "00000000-0000-4000-8000-000000000904";

function trial(
  sampleIndex: number,
  outcome: HandForkTrial["outcome"],
  action: HandForkTrial["action"],
  overrides: Partial<HandForkTrial> = {},
): HandForkTrial {
  return handForkTrialSchema.parse({
    id: `00000000-0000-4000-8000-${String(sampleIndex).padStart(12, "0")}`,
    sampleIndex,
    status: outcome === "CANCELLED" ? "CANCELLED" : "COMPLETED",
    outcome,
    action,
    amountTo: action === "raise" ? 800 : null,
    decisionSummary: outcome === "MODEL_ACTION" ? "Public decision summary" : null,
    usedFallback: outcome === "PROTOCOL_FALLBACK",
    firstTurnValid: outcome === "INFRA_ERROR" || outcome === "CANCELLED"
      ? null
      : outcome === "MODEL_ACTION",
    historyQueryCount: sampleIndex % 3 === 0 ? 1 : 0,
    protocolFailures: outcome === "PROTOCOL_FALLBACK" ? 2 : 0,
    infrastructureFailures: outcome === "INFRA_ERROR" ? 3 : 0,
    callCount: outcome === "INFRA_ERROR" ? 3 : 1,
    totalLatencyMs: outcome === "CANCELLED" || outcome === "INFRA_ERROR" ? null : sampleIndex * 100,
    usage: outcome === "CANCELLED" ? null : {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    visibleInputHash: "a".repeat(64),
    errorKind: outcome === "INFRA_ERROR" ? "TIMEOUT" : null,
    errorMessage: outcome === "INFRA_ERROR" ? "Timed out" : null,
    createdAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
    ...overrides,
  });
}

describe("hand fork summaries", () => {
  it("uses only non-fallback model actions as the action-distribution denominator", () => {
    const trials = [
      ...Array.from({ length: 8 }, (_, index) => trial(index + 1, "MODEL_ACTION", "call")),
      trial(9, "MODEL_ACTION", "fold"),
      trial(10, "MODEL_ACTION", "fold"),
      trial(11, "PROTOCOL_FALLBACK", "fold"),
      trial(12, "INFRA_ERROR", null),
    ];
    const summary = summarizeHandForkTrials(12, trials);

    expect(summary.actionDistribution).toEqual({ call: 8, fold: 2 });
    expect(summary.modalAction).toBe("call");
    expect(summary.modalShare).toBe(0.8);
    expect(summary.pairwiseAgreement).toBeCloseTo(58 / 90);
    expect(summary.fallbackTrials).toBe(1);
    expect(summary.infrastructureErrorTrials).toBe(1);
    expect(summary.modelActionTrials).toBe(10);
    expect(summary.actionDistributionTrials).toBe(10);
    expect(summary.reliabilityEligibleTrials).toBe(12);
    expect(summary.firstTurnObservedTrials).toBe(11);
    expect(summary.terminalTrials).toBe(12);
    expect(summary.terminalCoverage).toBe(1);
    expect(summary.pairwiseComparisonPairs).toBe(45);
    expect(summary.firstTurnValidRate).toBeCloseTo(10 / 11);
    expect(summary.latencyObservedTrials).toBe(11);
    expect(summary.tokenObservedTrials).toBe(12);
    expect(summary.totalTokens).toBe(12 * 120);
  });

  it("excludes unobserved infrastructure failures from first-turn validity", () => {
    const unobserved = summarizeHandForkTrials(2, [
      trial(1, "INFRA_ERROR", null),
      trial(2, "INFRA_ERROR", null),
    ]);
    expect(unobserved).toMatchObject({
      reliabilityEligibleTrials: 2,
      firstTurnObservedTrials: 0,
      firstTurnValidRate: null,
    });

    const partiallyObserved = summarizeHandForkTrials(2, [
      trial(1, "INFRA_ERROR", null),
      trial(2, "INFRA_ERROR", null, { firstTurnValid: false }),
    ]);
    expect(partiallyObserved).toMatchObject({
      firstTurnObservedTrials: 1,
      firstTurnValidRate: 0,
    });
  });

  it("reports bet and raise sizing without mixing engine-computed actions", () => {
    const summary = summarizeHandForkTrials(4, [
      trial(1, "MODEL_ACTION", "raise", { amountTo: 600 }),
      trial(2, "MODEL_ACTION", "raise", { amountTo: 800 }),
      trial(3, "MODEL_ACTION", "raise", { amountTo: 1_200 }),
      trial(4, "MODEL_ACTION", "call"),
    ]);
    expect(summary.sizing.raise).toEqual({ count: 3, median: 800, min: 600, max: 1_200 });
    expect(summary.sizing.call).toBeUndefined();
  });

  it("separates terminal coverage from completed reliability denominators", () => {
    const summary = summarizeHandForkTrials(4, [
      trial(1, "MODEL_ACTION", "call"),
      trial(2, "CANCELLED", null),
    ]);
    expect(summary).toMatchObject({
      requestedSamples: 4,
      terminalTrials: 2,
      terminalCoverage: 0.5,
      completedTrials: 1,
      reliabilityEligibleTrials: 1,
      cancelledTrials: 1,
      modelActionTrials: 1,
      actionDistributionTrials: 1,
      modelActionCoverage: 0.25,
    });
  });

  it("aggregates target progress without inventing missing target summaries", () => {
    const completeSummary = summarizeHandForkTrials(2, [
      trial(1, "MODEL_ACTION", "call"),
      trial(2, "PROTOCOL_FALLBACK", "fold"),
    ]);
    const baseTarget = {
      id: "00000000-0000-4000-8000-000000000101",
      ordinal: 1,
      modelConfigId: "00000000-0000-4000-8000-000000000102",
      competitorRevisionId: "00000000-0000-4000-8000-000000000103",
      competitorFamilyId: "00000000-0000-4000-8000-000000000104",
      modelDisplayName: "Model A",
      modelId: "model-a",
      providerProfile: "openai",
      modelConfigurationHash: "b".repeat(64),
      effectiveOutputMode: "json_schema",
      sampleCount: 2,
      terminalTrials: 2,
      errorMessage: null,
      startedAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-20T00:01:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:01:00.000Z",
    } satisfies Omit<HandForkTarget, "status" | "summary">;
    const failedSummary = summarizeHandForkTrials(2, []);
    const targets: HandForkTarget[] = [
      { ...baseTarget, status: "COMPLETED", summary: completeSummary },
      {
        ...baseTarget,
        id: "00000000-0000-4000-8000-000000000201",
        ordinal: 2,
        status: "FAILED",
        terminalTrials: 0,
        summary: failedSummary,
      },
    ];
    expect(summarizeHandForkTargets(targets)).toEqual({
      totalTargets: 2,
      terminalTargets: 2,
      targetTerminalCoverage: 1,
      completedTargets: 1,
      failedTargets: 1,
      cancelledTargets: 0,
      requestedTrials: 4,
      terminalTrials: 2,
      trialTerminalCoverage: 0.5,
      completedTrials: 2,
      cancelledTrials: 0,
      modelActionTrials: 1,
      fallbackTrials: 1,
      infrastructureErrorTrials: 0,
    });
  });
});

function turnInput(): HandForkTurnAuditInput {
  return {
    forkId: UUID_FORK,
    targetId: UUID_TARGET,
    trialId: UUID_TRIAL,
    workerId: "worker-a",
    leaseToken: UUID_LEASE,
    turnIndex: 1,
    request: {
      requestId: UUID_TRIAL,
      expectedOutput: "ACTION_OR_HISTORY",
      systemPrompt: "Return JSON.",
      systemPromptHash: "a".repeat(64),
      userPayload: { hand_no: 1 },
      timeoutMs: 180_000,
      parserPolicy: "arena-parser-strict-v1",
      adapterProtocolVersion: "arena-adapters-v2",
    },
    response: {
      rawText: "{\"type\":\"action\"}",
      providerRequestId: "provider-1",
      transportAudit: {
        adapterVersion: "adapter-v1",
        renderedUserTextSha256: "b".repeat(64),
        redactedWireBodySha256: "c".repeat(64),
        appliedOutputMode: "json_schema",
        appliedSchemaSha256: "d".repeat(64),
        finishReason: "stop",
        refusal: "PRIVATE-REFUSAL-MARKER",
        responseModel: "model-v1",
        systemFingerprint: "fingerprint-v1",
      },
    },
    outcome: "SUCCESS",
    errorKind: null,
    providerConfigHash: "e".repeat(64),
    outputSchemaVersion: "arena-output-v3",
    outputSchemaHash: "f".repeat(64),
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

describe("hand fork persistence fencing", () => {
  it("allowlists source DTO fields and rejects hidden engine/opponent state", () => {
    const payload: HandForkSourcePayloadV1 = {
      version: "hand-fork-source-v1" as const,
      source: {
        tournamentName: "Final",
        playerDisplayName: "Model",
        street: "PREFLOP" as const,
        heroPosition: "BTN",
        holeCards: ["Ah", "Kd"] as [string, string],
        legalActions: {
          allowed: ["fold", "call", "raise", "all_in"],
          call: { amount: 100, will_be_all_in: false },
          bet: null,
          raise: { min_amount_to: 300, max_amount_to: 2_000 },
          all_in: { resulting_street_commitment: 2_000, classification: "raise" as const },
        },
        originalAction: "call" as const,
        originalAmountTo: null,
        originalDecisionSummary: null,
        originalUsedFallback: false,
        decisionEventSequence: 10,
        snapshotChecksum: "1".repeat(64),
      },
      baseRequest: {
        requestId: UUID_TRIAL,
        expectedOutput: "ACTION_OR_HISTORY" as const,
        systemPrompt: "Return JSON.",
        systemPromptHash: "a".repeat(64),
        userPayload: {
          hero: { player_id: "hero", hole_cards: ["Ah", "Kd"] },
          opponents: [{ player_id: "villain" }],
        },
        timeoutMs: 180_000,
      },
      decisionConfig: {
        maxInfrastructureAttempts: 3,
        infrastructureRetryDelaysMs: [100, 200],
        history: { maxQueries: 2, maxRecordsPerQuery: 40, maxApproxTokens: 4_000 },
      },
    };
    expect(validateHandForkSourcePayload(payload)).toMatchObject({ version: "hand-fork-source-v1" });
    expect(() => validateHandForkSourcePayload({
      ...payload,
      validationHand: { deck: ["2c"] },
    } as unknown as HandForkSourcePayloadV1)).toThrow();
    for (const forbidden of [
      { deck: ["2c"] },
      { burn_cards: ["3d"] },
      { opponents: [{ player_id: "villain", hole_cards: ["Qs", "Qh"] }] },
    ]) {
      expect(() => validateHandForkSourcePayload({
        ...payload,
        baseRequest: { ...payload.baseRequest, userPayload: forbidden },
      })).toThrow(/hidden poker state|non-hero hole cards/i);
    }
    for (const envelopeKey of [
      "arena_state", "arena_control", "history_results", "protocol_correction",
    ]) {
      expect(() => validateHandForkSourcePayload({
        ...payload,
        baseRequest: {
          ...payload.baseRequest,
          userPayload: {
            ...payload.baseRequest.userPayload as Record<string, unknown>,
            [envelopeKey]: {},
          },
        },
      })).toThrow(/bare arena_state/i);
    }
  });

  it("claims through a fork-row lock, enforces per-fork capacity, and can reclaim expiry", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("with candidate_fork")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: null };
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() } as unknown as PoolClient)),
    } as unknown as Pool;
    const repository = new PgHandForkRepository(pool, Buffer.alloc(32, 7));
    expect(await repository.claimNextTarget("worker-a", 60_000)).toBeNull();
    const claimSql = statements.find((sql) => sql.includes("with candidate_fork"))!;
    expect(claimSql).toContain("for update of f skip locked");
    expect(claimSql).toContain("< f.max_parallel_targets");
    expect(claimSql).toContain("available.lease_expires_at <= now()");
    expect(claimSql).toContain("serial_target.competitor_revision_id = ft.competitor_revision_id");
    expect(claimSql).toContain("for update of ft, cr skip locked");
    expect(claimSql).toContain("lease_token = $4");
  });

  it("never renews an expired lease and restores only expired workers", async () => {
    const statements: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 1 };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          statements.push(sql);
          return sql.includes("select distinct") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: null };
        }),
        release: vi.fn(),
      } as unknown as PoolClient)),
    } as unknown as Pool;
    const repository = new PgHandForkRepository(pool, Buffer.alloc(32, 8));
    expect(await repository.renewTargetLease(UUID_TARGET, "worker-a", UUID_LEASE, 60_000)).toBe(true);
    await repository.restorePending();
    const renewSql = statements.find((sql) => sql.includes("set lease_expires_at"))!;
    expect(renewSql).toContain("lease_token = $3");
    expect(renewSql).toContain("lease_expires_at > now()");
    const restoreSql = statements.find((sql) => sql.includes("set status = 'QUEUED'"))!;
    expect(restoreSql).toContain("lease_expires_at <= now()");
    expect(statements.some((sql) => sql.includes("update hand_forks") && sql.includes("set status = 'QUEUED'"))).toBe(false);
  });

  it("uses a full turn hash for idempotency and never writes raw refusals in plaintext", async () => {
    let storedHash: string | null = null;
    let firstInsertParameters: unknown[] = [];
    const pool = {
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        if (sql.includes("insert into hand_fork_turns")) {
          if (storedHash === null) {
            storedHash = String(parameters?.[4]);
            firstInsertParameters = parameters ?? [];
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("select turn.content_hash")) {
          return { rows: [{ content_hash: storedHash }], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as unknown as Pool;
    const repository = new PgHandForkRepository(pool, Buffer.alloc(32, 9));
    const input = turnInput();
    await repository.appendTurn(input);
    await repository.appendTurn(input);
    expect(JSON.stringify(firstInsertParameters)).not.toContain("PRIVATE-REFUSAL-MARKER");
    await expect(repository.appendTurn({
      ...input,
      response: {
        ...input.response!,
        transportAudit: { ...input.response!.transportAudit!, finishReason: "length" },
      },
    })).rejects.toBeInstanceOf(HandForkPersistenceConflictError);
    expect(String((pool.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain("ft.lease_expires_at > now()");
  });

  it("rejects unknown request fields and credential-bearing nested payloads before SQL", async () => {
    const query = vi.fn();
    const repository = new PgHandForkRepository({ query } as unknown as Pool, Buffer.alloc(32, 10));
    const input = turnInput();
    await expect(repository.appendTurn({
      ...input,
      request: { ...input.request, apiKey: "secret" } as typeof input.request,
    })).rejects.toThrow();
    await expect(repository.appendTurn({
      ...input,
      request: { ...input.request, userPayload: { api_key: "secret" } },
    })).rejects.toThrow(/credential field/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("fences and idempotently compares every trial-completion field", async () => {
    let completionHash: string | null = null;
    const completedRow = (hash: string) => ({
      id: UUID_TRIAL,
      fork_id: UUID_FORK,
      target_id: UUID_TARGET,
      sample_index: 1,
      status: "COMPLETED",
      outcome: "MODEL_ACTION",
      action: "call",
      amount_to: null,
      decision_summary: "Call.",
      used_fallback: false,
      first_turn_valid: true,
      history_query_count: 0,
      protocol_failures: 0,
      infrastructure_failures: 0,
      call_count: 1,
      total_latency_ms: 100,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      visible_input_hash: "a".repeat(64),
      error_kind: null,
      error_message: null,
      completion_hash: hash,
      created_at: "2026-08-20T00:00:00.000Z",
      completed_at: "2026-08-20T00:00:01.000Z",
    });
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: null };
      if (sql.includes("update hand_fork_trials tr")) {
        const nextHash = String(parameters?.[17]);
        if (completionHash === null) {
          completionHash = nextHash;
          return { rows: [completedRow(nextHash)], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("select tr.*") && sql.includes("join hand_fork_targets")) {
        return { rows: [completedRow(completionHash!)], rowCount: 1 };
      }
      if (sql.includes("update hand_fork_targets")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() } as unknown as PoolClient)),
    } as unknown as Pool;
    const repository = new PgHandForkRepository(pool, Buffer.alloc(32, 11));
    const completion: CompleteHandForkTrialInput = {
      forkId: UUID_FORK,
      targetId: UUID_TARGET,
      trialId: UUID_TRIAL,
      workerId: "worker-a",
      leaseToken: UUID_LEASE,
      outcome: "MODEL_ACTION",
      action: "call",
      amountTo: null,
      decisionSummary: "Call.",
      usedFallback: false,
      firstTurnValid: true,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 0,
      callCount: 1,
      totalLatencyMs: 100,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      errorKind: null,
      errorMessage: null,
      privateResult: {
        version: "hand-fork-trial-result-v1",
        requestId: UUID_TRIAL,
        status: "ACTION",
        action: { action: "call" },
        response: { type: "action", action: "call" },
        usedFallback: false,
        protocolFailures: 0,
        historyResults: [],
        calls: [{
          attempt: 1,
          outcome: "SUCCESS",
          errorKind: null,
          latencyMs: 100,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }],
        error: null,
      },
    };
    await repository.completeTrial(completion);
    await repository.completeTrial(completion);
    await expect(repository.completeTrial({ ...completion, decisionSummary: "Different." }))
      .rejects.toBeInstanceOf(HandForkPersistenceConflictError);
    const updateSql = String(query.mock.calls.find(([sql]) => String(sql).includes("update hand_fork_trials tr"))?.[0]);
    expect(updateSql).toContain("ft.lease_token = $22");
    expect(updateSql).toContain("ft.lease_expires_at > now()");
  });

  it("persists an infrastructure-only completion without invented first-turn or latency observations", async () => {
    let updateParameters: unknown[] = [];
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: null };
      if (sql.includes("update hand_fork_trials tr")) {
        updateParameters = parameters ?? [];
        return {
          rows: [{
            id: UUID_TRIAL,
            fork_id: UUID_FORK,
            target_id: UUID_TARGET,
            sample_index: 1,
            status: "COMPLETED",
            outcome: "INFRA_ERROR",
            action: null,
            amount_to: null,
            decision_summary: null,
            used_fallback: false,
            first_turn_valid: null,
            history_query_count: 0,
            protocol_failures: 0,
            infrastructure_failures: 1,
            call_count: 1,
            total_latency_ms: null,
            usage: null,
            visible_input_hash: "a".repeat(64),
            error_kind: "TIMEOUT",
            error_message: "Timed out",
            completion_hash: parameters?.[17],
            created_at: "2026-08-20T00:00:00.000Z",
            completed_at: "2026-08-20T00:00:01.000Z",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("update hand_fork_targets")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PgHandForkRepository({
      connect: vi.fn(async () => ({ query, release: vi.fn() } as unknown as PoolClient)),
    } as unknown as Pool, Buffer.alloc(32, 12));
    const completed = await repository.completeTrial({
      forkId: UUID_FORK,
      targetId: UUID_TARGET,
      trialId: UUID_TRIAL,
      workerId: "worker-a",
      leaseToken: UUID_LEASE,
      outcome: "INFRA_ERROR",
      action: null,
      amountTo: null,
      decisionSummary: null,
      usedFallback: false,
      firstTurnValid: null,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 1,
      callCount: 1,
      totalLatencyMs: null,
      usage: null,
      errorKind: "TIMEOUT",
      errorMessage: "Timed out",
      privateResult: {
        version: "hand-fork-trial-result-v1",
        requestId: UUID_TRIAL,
        status: "PAUSED_INFRA",
        action: null,
        response: null,
        usedFallback: false,
        protocolFailures: 0,
        historyResults: [],
        calls: [{
          attempt: 1,
          outcome: "INFRA_ERROR",
          errorKind: "TIMEOUT",
          latencyMs: null,
          usage: null,
        }],
        error: { kind: "TIMEOUT", message: "Timed out" },
      },
    });

    expect(completed).toMatchObject({
      outcome: "INFRA_ERROR",
      firstTurnValid: null,
      totalLatencyMs: null,
    });
    expect(updateParameters[6]).toBeNull();
    expect(updateParameters[11]).toBeNull();
  });
});

const postgresUrl = process.env.TEST_DATABASE_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres("hand fork PostgreSQL lifecycle", () => {
  let schema: IsolatedPostgresSchema | null = null;
  let repository: PgHandForkRepository;
  const masterKey = Buffer.alloc(32, 19);

  beforeAll(async () => {
    schema = await createIsolatedPostgresSchema(postgresUrl!, "hand_fork_repository", 6);
    await runMigrations(schema.pool);
    repository = new PgHandForkRepository(schema.pool, masterKey);
  });

  afterAll(async () => {
    await schema?.dispose();
  });

  it("fences reclaimed workers, caps concurrent targets, checkpoints atomically, and preserves completed results on cancel", async () => {
    const tournamentId = randomUUID();
    const decisionId = randomUUID();
    const providerId = randomUUID();
    const targetIds = [randomUUID(), randomUUID()];
    const revisionIds = [randomUUID(), randomUUID()];
    const configurationHashes = ["1".repeat(64), "2".repeat(64)];
    const pool = schema!.pool;
    const seed = await pool.connect();
    try {
      await seed.query("begin");
      await seed.query("set constraints all deferred");
      await seed.query(
        `insert into provider_connections (id, label, provider_type)
         values ($1, 'Fork test', 'mock-scripted')`,
        [providerId],
      );
      for (const [index, modelId] of targetIds.entries()) {
        const familyId = randomUUID();
        await seed.query(
          "insert into competitor_families (id, display_name) values ($1, $2)",
          [familyId, `Model ${index + 1}`],
        );
        await seed.query(
          `insert into model_configs
            (id, display_name, provider_connection_id, model_id, current_revision_id, competitor_family_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [modelId, `Model ${index + 1}`, providerId, `model-${index + 1}`, revisionIds[index], familyId],
        );
        await seed.query(
          `insert into competitor_revisions
            (id, model_config_id, revision_number, provider_connection_id,
             provider_type, provider_profile, provider_default_output_mode,
             model_id, parameters, output_mode, configuration_hash,
             competitor_family_id, competitor_display_name)
           values ($1, $2, 1, $3, 'mock-scripted', 'auto', 'auto', $4,
                   '{}'::jsonb, 'inherit', $5, $6, $7)`,
          [
            revisionIds[index], modelId, providerId, `model-${index + 1}`,
            configurationHashes[index], familyId, `Model ${index + 1}`,
          ],
        );
      }
      await seed.query(
        `insert into tournaments
          (id, name, status, ruleset_version, configuration,
           aggregate_version, protocol_bundle_id, benchmark_track_id, benchmark_cohort_id)
         values ($1, 'Fork source', 'COMPLETED', 'rules-v1', '{}'::jsonb,
                 20, 'arena-native-v11', 'track', 'cohort')`,
        [tournamentId],
      );
      await seed.query(
        `insert into decision_requests
          (id, tournament_id, hand_no, player_id, expected_aggregate_version,
           request_kind, status, prompt_hash, idempotency_key)
         values ($1, $2, 9, 'hero', 10, 'ACTION', 'SUCCEEDED', $3, 'fork-source')`,
        [decisionId, tournamentId, "a".repeat(64)],
      );
      await seed.query(
        `insert into decision_turns
          (decision_id, turn_index, request_hash, encrypted_request, outcome,
           provider_config_hash, output_schema_version, output_schema_hash)
         values ($1, 1, $2, '{}'::jsonb, 'SUCCESS', $3, 'arena-output-v3', $4)`,
        [decisionId, "c".repeat(64), "9".repeat(64), "8".repeat(64)],
      );
      await seed.query(
        `insert into arena_events
          (tournament_id, sequence, aggregate_version, event_type, actor_id,
           hand_no, public_payload, private_visibility, prev_hash, event_hash)
         values ($1, 12, 12, 'ACTION_APPLIED', 'hero', 9, '{}'::jsonb,
                 'NONE', $2, $3)`,
        [tournamentId, "0".repeat(64), "b".repeat(64)],
      );
      await seed.query(
        `insert into state_snapshots
          (tournament_id, event_sequence, aggregate_version, public_state,
           encrypted_private_state, checksum)
         values ($1, 10, 10, '{}'::jsonb, '{}'::jsonb, $2)`,
        [tournamentId, "d".repeat(64)],
      );
      await seed.query("commit");
    } catch (error) {
      await seed.query("rollback");
      throw error;
    } finally {
      seed.release();
    }

    const visibleState = {
      hand_no: 9,
      hero: { player_id: "hero", hole_cards: ["Ah", "Kd"] },
      opponents: [{ player_id: "villain" }],
    };
    const legalActions = {
      allowed: ["fold", "call", "raise", "all_in"] as ("fold" | "call" | "raise" | "all_in")[],
      call: { amount: 100, will_be_all_in: false },
      bet: null,
      raise: { min_amount_to: 300, max_amount_to: 2_000 },
      all_in: { resulting_street_commitment: 2_000, classification: "raise" as const },
    };
    const outputSchema = { type: "object" };
    const outputSchemaHash = createHash("sha256").update(JSON.stringify(outputSchema)).digest("hex");
    const systemPrompt = "Return one Arena JSON object.";
    const systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex");
    const canonicalHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
    const clientRequestId = randomUUID();
    const forkInput: CreateHandForkPersistenceInput = {
      clientRequestId,
      createRequestHash: canonicalHash({
        sourceDecisionId: decisionId,
        modelConfigIds: targetIds,
        sampleCount: 1,
        timeoutMs: 180_000,
        maxParallelTargets: 1,
      }),
      source: {
        tournamentId,
        decisionId,
        handNo: 9,
        playerId: "hero",
        expectedAggregateVersion: 10,
        actionEventSequence: 12,
        sourceEventHash: "b".repeat(64),
        sourceRequestHash: "c".repeat(64),
        visibleInputHash: canonicalHash(visibleState),
        legalContractHash: canonicalHash(legalActions),
        protocolBundleId: "arena-native-v11",
        rulesetVersion: "rules-v1",
        contextVersion: "model-context-v4",
        systemPromptHash,
        outputSchemaHash,
        parserPolicyVersion: "arena-parser-strict-v1",
        adapterProtocolVersion: "arena-adapters-v2",
        historyProtocolVersion: "arena-history-v2",
        correctionProtocolVersion: "arena-correction-v1",
        historyBudget: { maxQueries: 2, maxRecordsPerQuery: 40, maxApproxTokens: 4_000 },
        privatePayload: {
          version: "hand-fork-source-v1",
          source: {
            tournamentName: "Fork source",
            playerDisplayName: "Hero",
            street: "PREFLOP",
            heroPosition: "BTN",
            holeCards: ["Ah", "Kd"],
            legalActions,
            originalAction: "call",
            originalAmountTo: null,
            originalDecisionSummary: "Original call.",
            originalUsedFallback: false,
            decisionEventSequence: 11,
            snapshotChecksum: "d".repeat(64),
          },
          baseRequest: {
            requestId: decisionId,
            expectedOutput: "ACTION_OR_HISTORY",
            systemPrompt,
            systemPromptHash,
            outputSchema: {
              version: "arena-output-v3",
              name: "arena_action",
              schema: outputSchema,
              sha256: outputSchemaHash,
            },
            userPayload: visibleState,
            timeoutMs: 180_000,
            parserPolicy: "arena-parser-strict-v1",
            adapterProtocolVersion: "arena-adapters-v2",
          },
          decisionConfig: {
            maxInfrastructureAttempts: 3,
            infrastructureRetryDelaysMs: [100, 200],
            history: { maxQueries: 2, maxRecordsPerQuery: 40, maxApproxTokens: 4_000 },
          },
        },
      },
      targets: targetIds.map((modelConfigId, index) => ({
        modelConfigId,
        competitorRevisionId: revisionIds[index]!,
        modelConfigurationHash: configurationHashes[index]!,
        effectiveOutputMode: "prompt",
      })),
      sampleCount: 1,
      timeoutMs: 180_000,
      maxParallelTargets: 1,
      createdByAdminUserId: null,
    };
    const [fork, concurrentRetry] = await Promise.all([
      repository.createFork(forkInput),
      repository.createFork(forkInput),
    ]);
    expect(concurrentRetry.id).toBe(fork.id);
    expect((await repository.createFork(forkInput)).id).toBe(fork.id);
    expect((await repository.findForkByCreateRequest(
      clientRequestId,
      forkInput.createRequestHash,
    ))?.id).toBe(fork.id);
    await expect(repository.findForkByCreateRequest(clientRequestId, "f".repeat(64)))
      .rejects.toBeInstanceOf(HandForkPersistenceConflictError);
    expect(fork.targets).toHaveLength(2);
    const persistedCounts = await pool.query<{ forks: string; targets: string }>(
      `select count(distinct f.id)::text as forks, count(ft.id)::text as targets
         from hand_forks f
         left join hand_fork_targets ft on ft.fork_id = f.id
        where f.client_request_id = $1`,
      [clientRequestId],
    );
    expect(persistedCounts.rows[0]).toEqual({ forks: "1", targets: "2" });
    await expect(repository.createFork({
      ...forkInput,
      sampleCount: 2,
      createRequestHash: "f".repeat(64),
    })).rejects.toBeInstanceOf(HandForkPersistenceConflictError);
    await expect(pool.query(
      "update hand_fork_targets set effective_output_mode = 'auto' where id = $1",
      [fork.targets[0]!.id],
    )).rejects.toThrow(/effective_output_mode/i);

    for (const tamper of [
      {
        breakSql: "update decision_turns set request_hash = $2 where decision_id = $1 and turn_index = 1",
        restoreSql: "update decision_turns set request_hash = $2 where decision_id = $1 and turn_index = 1",
        identity: decisionId,
        broken: "7".repeat(64),
        restored: "c".repeat(64),
      },
      {
        breakSql: "update arena_events set event_hash = $2 where tournament_id = $1 and sequence = 12",
        restoreSql: "update arena_events set event_hash = $2 where tournament_id = $1 and sequence = 12",
        identity: tournamentId,
        broken: "7".repeat(64),
        restored: "b".repeat(64),
      },
      {
        breakSql: "update state_snapshots set checksum = $2 where tournament_id = $1 and aggregate_version = 10",
        restoreSql: "update state_snapshots set checksum = $2 where tournament_id = $1 and aggregate_version = 10",
        identity: tournamentId,
        broken: "7".repeat(64),
        restored: "d".repeat(64),
      },
    ]) {
      await pool.query(tamper.breakSql, [tamper.identity, tamper.broken]);
      await expect(repository.createFork({
        ...forkInput,
        clientRequestId: randomUUID(),
      })).rejects.toBeInstanceOf(HandForkPersistenceConflictError);
      await pool.query(tamper.restoreSql, [tamper.identity, tamper.restored]);
    }

    const claims = await Promise.all([
      repository.claimNextTarget("worker-1", 60_000, fork.id),
      repository.claimNextTarget("worker-2", 60_000, fork.id),
    ]);
    const first = claims.find((claim) => claim !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    const serialFork = await repository.createFork({
      ...forkInput,
      clientRequestId: randomUUID(),
      createRequestHash: canonicalHash({
        sourceDecisionId: decisionId,
        modelConfigIds: [first.modelConfigId],
        sampleCount: 1,
        timeoutMs: 180_000,
        maxParallelTargets: 1,
      }),
      targets: [forkInput.targets.find((target) => (
        target.competitorRevisionId === first.competitorRevisionId
      ))!],
    });
    expect(await repository.claimNextTarget("worker-serial", 60_000, serialFork.id)).toBeNull();
    await pool.query(
      "update hand_fork_targets set lease_expires_at = now() - interval '1 second' where id = $1",
      [first.id],
    );
    const reclaimed = await repository.claimNextTarget("worker-3", 60_000, fork.id);
    expect(reclaimed).toMatchObject({ id: first.id, workerId: "worker-3" });
    expect(reclaimed!.leaseToken).not.toBe(first.leaseToken);
    expect(await repository.renewTargetLease(first.id, first.workerId, first.leaseToken, 60_000)).toBe(false);
    expect(await repository.beginTrial({
      targetId: first.id,
      workerId: first.workerId,
      leaseToken: first.leaseToken,
      sampleIndex: 1,
      visibleInputHash: canonicalHash(visibleState),
    })).toBeNull();
    const trialRecord = await repository.beginTrial({
      targetId: reclaimed!.id,
      workerId: reclaimed!.workerId,
      leaseToken: reclaimed!.leaseToken,
      sampleIndex: 1,
      visibleInputHash: canonicalHash(visibleState),
    });
    expect(trialRecord).toMatchObject({ status: "RUNNING", firstTurnValid: null });

    const refusalMarker = `REFUSAL-${randomUUID()}`;
    const request = {
      requestId: trialRecord!.id,
      expectedOutput: "ACTION_OR_HISTORY" as const,
      systemPrompt,
      systemPromptHash,
      outputSchema: {
        version: "arena-output-v3",
        name: "arena_action",
        schema: outputSchema,
        sha256: outputSchemaHash,
      },
      userPayload: visibleState,
      timeoutMs: 180_000,
      parserPolicy: "arena-parser-strict-v1" as const,
      adapterProtocolVersion: "arena-adapters-v2",
    };
    const transportAudit = {
      adapterVersion: "adapter-v1",
      renderedUserTextSha256: "e".repeat(64),
      redactedWireBodySha256: "f".repeat(64),
      appliedOutputMode: "prompt" as const,
      appliedSchemaSha256: null,
      finishReason: "stop",
      refusal: refusalMarker,
      responseModel: "mock-v1",
      systemFingerprint: null,
    };
    const call = {
      attempt: 1,
      outcome: "SUCCESS" as const,
      errorKind: null,
      latencyMs: 50,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    await repository.checkpointTrialTurn({
      forkId: fork.id,
      targetId: reclaimed!.id,
      trialId: trialRecord!.id,
      workerId: reclaimed!.workerId,
      leaseToken: reclaimed!.leaseToken,
      turnIndex: 1,
      request,
      response: {
        rawText: '{"type":"action","action":"call"}',
        parsed: { type: "action", action: "call" },
        providerRequestId: "provider-1",
        transportAudit,
      },
      outcome: "SUCCESS",
      errorKind: null,
      providerConfigHash: "9".repeat(64),
      outputSchemaVersion: "arena-output-v3",
      outputSchemaHash,
      latencyMs: 50,
      usage: call.usage,
      resumeState: {
        historyResults: [],
        protocolFailures: 0,
        correction: null,
        calls: [call],
        pendingOutput: {
          turnIndex: 1,
          parsed: { type: "action", action: "call" },
          rawText: '{"type":"action","action":"call"}',
          latencyMs: 50,
          usage: call.usage,
          providerRequestId: "provider-1",
          transportAudit,
        },
        infrastructureAttempts: 0,
      },
    });
    await repository.completeTrial({
      forkId: fork.id,
      targetId: reclaimed!.id,
      trialId: trialRecord!.id,
      workerId: reclaimed!.workerId,
      leaseToken: reclaimed!.leaseToken,
      outcome: "MODEL_ACTION",
      action: "call",
      amountTo: null,
      decisionSummary: "Call.",
      usedFallback: false,
      firstTurnValid: true,
      historyQueryCount: 0,
      protocolFailures: 0,
      infrastructureFailures: 0,
      callCount: 1,
      totalLatencyMs: 50,
      usage: call.usage,
      errorKind: null,
      errorMessage: null,
      privateResult: {
        version: "hand-fork-trial-result-v1",
        requestId: trialRecord!.id,
        status: "ACTION",
        action: { action: "call" },
        response: { type: "action", action: "call" },
        usedFallback: false,
        protocolFailures: 0,
        historyResults: [],
        calls: [call],
        error: null,
      },
    });
    await repository.finishTarget(
      reclaimed!.id,
      reclaimed!.workerId,
      reclaimed!.leaseToken,
      "COMPLETED",
    );
    const second = await repository.claimNextTarget("worker-4", 60_000, fork.id);
    expect(second).not.toBeNull();
    const cancelled = await repository.cancelFork(fork.id);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.summary).toMatchObject({
      completedTargets: 1,
      cancelledTargets: 1,
      completedTrials: 1,
      cancelledTrials: 0,
    });
    const detail = await repository.getFork(fork.id, true);
    const completedTarget = detail!.targets.find((target) => target.status === "COMPLETED")!;
    expect(completedTarget.trials?.[0]).toMatchObject({ outcome: "MODEL_ACTION", action: "call" });
    const persistedTurn = await pool.query<{ body: string }>(
      "select to_jsonb(turn_row)::text as body from hand_fork_turns turn_row where trial_id = $1",
      [trialRecord!.id],
    );
    expect(persistedTurn.rows[0]!.body).not.toContain(refusalMarker);
    expect(persistedTurn.rows[0]!.body).not.toContain('"refusal"');
  });
});
