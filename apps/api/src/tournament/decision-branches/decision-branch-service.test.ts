import { describe, expect, it, vi } from "vitest";
import {
  DECISION_BRANCH_SNAPSHOT_VERSION,
  decisionBranchPublicationSchema,
  decisionBranchSnapshotV1Schema,
  type AdminHandFork,
  type DecisionBranchPublication,
  type StoredDecisionBranchSnapshot,
} from "../../../../../packages/contracts/src/index.js";
import {
  DecisionBranchProjectionError,
  type DecisionBranchIdentityContext,
} from "./decision-branch-projection.js";
import {
  DecisionBranchPublicationConflictError,
  DecisionBranchSlugConflictError,
  DecisionBranchSnapshotConflictError,
  DecisionBranchSourceUnavailableError,
  type DecisionBranchAuditEvent,
  type DecisionBranchPublicationMutation,
  type DecisionBranchRepository,
} from "./decision-branch-repository.js";
import {
  DecisionBranchService,
  DecisionBranchServiceError,
} from "./decision-branch-service.js";
import type {
  CompletedDecisionBranchSource,
  DecisionBranchSourceReader,
} from "./decision-branch-source.js";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const BRANCH_ID = uuid(1);
const HAND_FORK_ID = uuid(2);
const TOURNAMENT_ID = uuid(3);
const ADMIN_ID = uuid(4);
const CREATED_AT = "2026-08-20T01:00:00.000Z";
const PUBLISHED_AT = "2026-08-20T02:00:00.000Z";

function snapshot(): StoredDecisionBranchSnapshot {
  return decisionBranchSnapshotV1Schema.parse({
    version: DECISION_BRANCH_SNAPSHOT_VERSION,
    source: {
      tournamentId: TOURNAMENT_ID,
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
          competitorId: uuid(5),
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
          competitorId: uuid(6),
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
      createdAt: CREATED_AT,
      completedAt: "2026-08-20T01:01:00.000Z",
    },
    targets: [{
      ordinal: 1,
      competitorId: uuid(7),
      competitorRevisionId: uuid(8),
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

function publication(
  status: DecisionBranchPublication["status"] = "DRAFT",
  overrides: Partial<DecisionBranchPublication> = {},
): DecisionBranchPublication {
  const previouslyPublished = status !== "DRAFT";
  return decisionBranchPublicationSchema.parse({
    id: BRANCH_ID,
    handForkId: HAND_FORK_ID,
    status,
    slug: previouslyPublished ? "stable-branch" : null,
    titleZh: previouslyPublished ? "稳定决策分叉" : null,
    titleEn: previouslyPublished ? "Stable decision branch" : null,
    summaryZh: null,
    summaryEn: null,
    snapshotVersion: DECISION_BRANCH_SNAPSHOT_VERSION,
    snapshotHash: "a".repeat(64),
    snapshot: snapshot(),
    revision: 1,
    createdByAdminUserId: ADMIN_ID,
    publishedAt: previouslyPublished ? PUBLISHED_AT : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

function completedSource(): CompletedDecisionBranchSource {
  return {
    fork: {
      source: { tournamentId: TOURNAMENT_ID },
    } as unknown as AdminHandFork,
    arenaState: { schema_version: "model-context-v4" },
  };
}

function identity(): DecisionBranchIdentityContext {
  return {
    tournament: { id: TOURNAMENT_ID, name: "Final Table" },
    players: [],
  };
}

function repositoryStub(
  overrides: Partial<DecisionBranchRepository> = {},
): DecisionBranchRepository {
  return {
    createDraft: vi.fn(async (input) => ({
      publication: publication("DRAFT", {
        id: input.id,
        handForkId: input.handForkId,
        snapshot: input.snapshot,
        createdByAdminUserId: input.createdByAdminUserId,
      }),
      created: true,
    })),
    getById: vi.fn(async () => null),
    getByHandForkId: vi.fn(async () => null),
    listAdmin: vi.fn(async () => []),
    updatePublication: vi.fn(async () => {
      throw new Error("Unexpected publication update");
    }),
    getPublishedBySlug: vi.fn(async () => null),
    listPublished: vi.fn(async () => []),
    listPublishedForTournamentHand: vi.fn(async () => []),
    listPublishedForCompetitor: vi.fn(async () => []),
    ...overrides,
  };
}

function sourceStub(
  value: CompletedDecisionBranchSource | null = completedSource(),
): DecisionBranchSourceReader {
  return { getCompletedSource: vi.fn(async () => value) };
}

function identityStub(
  value: DecisionBranchIdentityContext | null = identity(),
) {
  return { publicIdentityContext: vi.fn(async () => value) };
}

function serviceWith(input: {
  repository?: DecisionBranchRepository;
  sources?: DecisionBranchSourceReader;
  identities?: ReturnType<typeof identityStub>;
  project?: () => StoredDecisionBranchSnapshot;
} = {}) {
  const repository = input.repository ?? repositoryStub();
  const sources = input.sources ?? sourceStub();
  const identities = input.identities ?? identityStub();
  const project = vi.fn(input.project ?? (() => snapshot()));
  return {
    repository,
    sources,
    identities,
    project,
    service: new DecisionBranchService({
      repository,
      sources,
      identities,
      randomUUID: () => BRANCH_ID,
      project,
    }),
  };
}

async function expectServiceError(
  operation: Promise<unknown>,
  code: DecisionBranchServiceError["code"],
  message?: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "DecisionBranchServiceError",
    code,
    ...(message ? { message } : {}),
  });
}

describe("decision branch service", () => {
  it("returns an existing branch idempotently without rebuilding its frozen snapshot", async () => {
    const existing = publication();
    const repository = repositoryStub({
      getByHandForkId: vi.fn(async () => existing),
    });
    const harness = serviceWith({ repository });

    await expect(harness.service.createDraft(HAND_FORK_ID, ADMIN_ID)).resolves.toEqual({
      publication: existing,
      created: false,
    });
    expect(harness.sources.getCompletedSource).not.toHaveBeenCalled();
    expect(harness.identities.publicIdentityContext).not.toHaveBeenCalled();
    expect(harness.project).not.toHaveBeenCalled();
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it("creates one audited draft from the completed source and stable public identity", async () => {
    const frozen = snapshot();
    const source = completedSource();
    const publicIdentity = identity();
    const repository = repositoryStub();
    const sources = sourceStub(source);
    const identities = identityStub(publicIdentity);
    const harness = serviceWith({
      repository,
      sources,
      identities,
      project: () => frozen,
    });

    const result = await harness.service.createDraft(HAND_FORK_ID, ADMIN_ID);

    expect(result).toMatchObject({ created: true, publication: { id: BRANCH_ID, status: "DRAFT" } });
    expect(sources.getCompletedSource).toHaveBeenCalledWith(HAND_FORK_ID);
    expect(identities.publicIdentityContext).toHaveBeenCalledWith(TOURNAMENT_ID);
    expect(harness.project).toHaveBeenCalledWith({
      fork: source.fork,
      arenaState: source.arenaState,
      identity: publicIdentity,
    });
    expect(repository.createDraft).toHaveBeenCalledWith({
      id: BRANCH_ID,
      handForkId: HAND_FORK_ID,
      snapshot: frozen,
      createdByAdminUserId: ADMIN_ID,
    }, {
      adminUserId: ADMIN_ID,
      action: "decision_branch.create",
      targetId: BRANCH_ID,
      metadata: {
        sourceHandForkId: HAND_FORK_ID,
        tournamentId: TOURNAMENT_ID,
        handNo: 12,
      },
    });
  });

  it("fails closed when the completed source or its public identity is unavailable", async () => {
    const missingSource = serviceWith({ sources: sourceStub(null) });
    await expectServiceError(
      missingSource.service.createDraft(HAND_FORK_ID, ADMIN_ID),
      "SOURCE_UNAVAILABLE",
    );
    expect(missingSource.identities.publicIdentityContext).not.toHaveBeenCalled();
    expect(missingSource.repository.createDraft).not.toHaveBeenCalled();

    const missingIdentity = serviceWith({ identities: identityStub(null) });
    await expectServiceError(
      missingIdentity.service.createDraft(HAND_FORK_ID, ADMIN_ID),
      "IDENTITY_UNAVAILABLE",
    );
    expect(missingIdentity.project).not.toHaveBeenCalled();
    expect(missingIdentity.repository.createDraft).not.toHaveBeenCalled();
  });

  it("maps a rejected public projection to UNSAFE_SOURCE without persisting a draft", async () => {
    const repository = repositoryStub();
    const harness = serviceWith({
      repository,
      project: () => {
        throw new DecisionBranchProjectionError(
          "PRIVATE_DATA_PRESENT",
          "Opponent hole cards cannot enter the public snapshot",
        );
      },
    });

    await expectServiceError(
      harness.service.createDraft(HAND_FORK_ID, ADMIN_ID),
      "UNSAFE_SOURCE",
      "Opponent hole cards cannot enter the public snapshot",
    );
    expect(repository.createDraft).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new DecisionBranchSourceUnavailableError(),
      code: "SOURCE_UNAVAILABLE" as const,
    },
    {
      error: new DecisionBranchSnapshotConflictError(),
      code: "CONFLICT" as const,
    },
  ])("maps repository create failures to $code", async ({ error, code }) => {
    const repository = repositoryStub({
      createDraft: vi.fn(async () => { throw error; }),
    });
    const harness = serviceWith({ repository });

    await expectServiceError(harness.service.createDraft(HAND_FORK_ID, ADMIN_ID), code, error.message);
  });

  it("returns an editorial no-op without advancing the publication revision", async () => {
    const existing = publication("DRAFT", { titleEn: "Existing title", revision: 3 });
    const repository = repositoryStub({ getById: vi.fn(async () => existing) });
    const harness = serviceWith({ repository });

    await expect(harness.service.edit(BRANCH_ID, {
      titleEn: "Existing title",
    }, 3, ADMIN_ID)).resolves.toBe(existing);
    expect(repository.updatePublication).not.toHaveBeenCalled();
  });

  it("persists an editorial patch against exactly the expected revision and audits changed fields", async () => {
    const existing = publication("DRAFT", { revision: 2, summaryEn: "Old summary" });
    const updated = publication("DRAFT", {
      revision: 3,
      titleZh: "新的标题",
      summaryEn: null,
      updatedAt: "2026-08-20T03:00:00.000Z",
    });
    const repository = repositoryStub({
      getById: vi.fn(async () => existing),
      updatePublication: vi.fn(async () => updated),
    });
    const harness = serviceWith({ repository });

    await expect(harness.service.edit(BRANCH_ID, {
      titleZh: "新的标题",
      summaryEn: null,
    }, 2, ADMIN_ID)).resolves.toEqual(updated);
    expect(repository.updatePublication).toHaveBeenCalledWith({
      id: BRANCH_ID,
      status: "DRAFT",
      slug: null,
      titleZh: "新的标题",
      titleEn: null,
      summaryZh: null,
      summaryEn: null,
      createdByAdminUserId: ADMIN_ID,
    }, 2, {
      adminUserId: ADMIN_ID,
      action: "decision_branch.update",
      targetId: BRANCH_ID,
      metadata: {
        sourceHandForkId: HAND_FORK_ID,
        previousStatus: "DRAFT",
        status: "DRAFT",
        changedFields: ["titleZh", "summaryEn"],
      },
    });
  });

  it("rejects stale revisions before calling the repository mutation", async () => {
    const existing = publication("DRAFT", { revision: 4 });
    const repository = repositoryStub({ getById: vi.fn(async () => existing) });
    const harness = serviceWith({ repository });

    await expectServiceError(
      harness.service.edit(BRANCH_ID, { titleEn: "Stale" }, 3, ADMIN_ID),
      "CONFLICT",
    );
    expect(repository.updatePublication).not.toHaveBeenCalled();
  });

  it("publishes, hides, and republishes the same immutable branch identity", async () => {
    let current = publication();
    const updatePublication = vi.fn(async (
      input: DecisionBranchPublicationMutation,
      expectedRevision: number,
      _audit: DecisionBranchAuditEvent,
    ) => {
      if (expectedRevision !== current.revision) throw new DecisionBranchPublicationConflictError();
      current = publication(input.status, {
        ...current,
        ...input,
        revision: current.revision + 1,
        publishedAt: input.status === "PUBLISHED" ? current.publishedAt ?? PUBLISHED_AT : current.publishedAt,
        updatedAt: `2026-08-20T0${current.revision + 2}:00:00.000Z`,
      });
      return current;
    });
    const repository = repositoryStub({
      getById: vi.fn(async () => current),
      updatePublication,
    });
    const harness = serviceWith({ repository });

    await harness.service.publish(BRANCH_ID, {
      slug: "stable-branch",
      titleEn: "Stable decision branch",
    }, 1, ADMIN_ID);
    await harness.service.hide(BRANCH_ID, 2, ADMIN_ID);
    const republished = await harness.service.publish(BRANCH_ID, {}, 3, ADMIN_ID);

    expect(republished).toMatchObject({
      status: "PUBLISHED",
      slug: "stable-branch",
      revision: 4,
      publishedAt: PUBLISHED_AT,
    });
    expect(updatePublication.mock.calls.map(([, , audit]) => audit.action)).toEqual([
      "decision_branch.publish",
      "decision_branch.hide",
      "decision_branch.publish",
    ]);
    expect(updatePublication.mock.calls[2]?.[2]).toMatchObject({
      metadata: {
        previousStatus: "HIDDEN",
        status: "PUBLISHED",
        changedFields: [],
      },
    });
  });

  it("requires public metadata before publishing and a publication before hiding", async () => {
    const draft = publication();
    const repository = repositoryStub({ getById: vi.fn(async () => draft) });
    const harness = serviceWith({ repository });

    await expectServiceError(
      harness.service.publish(BRANCH_ID, { titleEn: "Missing slug" }, 1, ADMIN_ID),
      "CONFLICT",
    );
    await expectServiceError(harness.service.hide(BRANCH_ID, 1, ADMIN_ID), "CONFLICT");
    expect(repository.updatePublication).not.toHaveBeenCalled();
  });

  it("keeps the first published slug immutable, including while hidden", async () => {
    for (const existing of [publication("PUBLISHED"), publication("HIDDEN")]) {
      const repository = repositoryStub({ getById: vi.fn(async () => existing) });
      const harness = serviceWith({ repository });

      await expectServiceError(
        harness.service.edit(BRANCH_ID, { slug: "renamed-branch" }, 1, ADMIN_ID),
        "CONFLICT",
        "A published decision branch slug is immutable",
      );
      expect(repository.updatePublication).not.toHaveBeenCalled();
    }
  });

  it("maps revision conflicts while preserving the dedicated repository slug conflict", async () => {
    const existing = publication("PUBLISHED");
    const revisionRepository = repositoryStub({
      getById: vi.fn(async () => existing),
      updatePublication: vi.fn(async () => {
        throw new DecisionBranchPublicationConflictError("stale repository revision");
      }),
    });
    await expectServiceError(
      serviceWith({ repository: revisionRepository }).service.edit(
        BRANCH_ID,
        { titleEn: "Updated title" },
        1,
        ADMIN_ID,
      ),
      "CONFLICT",
      "stale repository revision",
    );

    const slugError = new DecisionBranchSlugConflictError();
    const slugRepository = repositoryStub({
      getById: vi.fn(async () => publication("DRAFT")),
      updatePublication: vi.fn(async () => { throw slugError; }),
    });
    await expect(serviceWith({ repository: slugRepository }).service.publish(
      BRANCH_ID,
      { slug: "occupied", titleEn: "Occupied" },
      1,
      ADMIN_ID,
    )).rejects.toBe(slugError);
  });

  it("maps missing admin records and leaves unrelated repository failures untouched", async () => {
    const missing = serviceWith();
    await expectServiceError(
      missing.service.edit(BRANCH_ID, { titleEn: "Unknown" }, 1, ADMIN_ID),
      "NOT_FOUND",
    );

    const unavailable = new Error("repository unavailable");
    const repository = repositoryStub({
      getById: vi.fn(async () => publication("PUBLISHED")),
      updatePublication: vi.fn(async () => { throw unavailable; }),
    });
    await expect(serviceWith({ repository }).service.edit(
      BRANCH_ID,
      { titleEn: "New title" },
      1,
      ADMIN_ID,
    )).rejects.toBe(unavailable);
  });

  it("loads an admin branch directly from its source decision rerun", async () => {
    const existing = publication("DRAFT");
    const repository = repositoryStub({
      getByHandForkId: vi.fn(async () => existing),
    });
    const harness = serviceWith({ repository });

    await expect(harness.service.getAdminByHandForkId(HAND_FORK_ID)).resolves.toBe(existing);
    expect(repository.getByHandForkId).toHaveBeenCalledWith(HAND_FORK_ID);
  });

  it("filters every non-published record out of public detail and list DTOs", async () => {
    const published = publication("PUBLISHED", { revision: 5 });
    const hidden = publication("HIDDEN", { revision: 6 });
    const repository = repositoryStub({
      getPublishedBySlug: vi.fn(async (slug) => slug === published.slug ? published : hidden),
      listPublished: vi.fn(async () => [hidden, published, publication("DRAFT")]),
    });
    const harness = serviceWith({ repository });

    const detail = await harness.service.getPublicBySlug("stable-branch");
    expect(detail).toMatchObject({
      id: BRANCH_ID,
      status: "PUBLISHED",
      slug: "stable-branch",
      publicationRevision: 5,
    });
    expect(detail).not.toHaveProperty("handForkId");
    expect(detail).not.toHaveProperty("snapshotHash");
    expect(detail).not.toHaveProperty("createdByAdminUserId");

    await expect(harness.service.getPublicBySlug("hidden-branch")).resolves.toBeNull();
    await expect(harness.service.listPublic(7)).resolves.toEqual([detail]);
    expect(repository.listPublished).toHaveBeenCalledWith(7);
  });

  it("projects lightweight hand discovery summaries without detailed evidence", async () => {
    const allInSnapshot = decisionBranchSnapshotV1Schema.parse({
      ...snapshot(),
      source: {
        ...snapshot().source,
        originalDecision: {
          action: "all_in",
          amountTo: null,
          decisionSummary: "Apply maximum pressure.",
          usedFallback: false,
        },
      },
    });
    const published = publication("PUBLISHED", { snapshot: allInSnapshot });
    const repository = repositoryStub({
      listPublishedForTournamentHand: vi.fn(async () => [published]),
    });
    const harness = serviceWith({ repository });

    const summaries = await harness.service.listPublicForTournamentHand(TOURNAMENT_ID, 12, 4);

    expect(repository.listPublishedForTournamentHand).toHaveBeenCalledWith(TOURNAMENT_ID, 12, 4);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      tournamentId: TOURNAMENT_ID,
      handNo: 12,
      actionSequence: 90,
      hero: { competitorId: uuid(5), displayName: "Hero", position: "BTN" },
      originalDecision: { action: "all_in", displayAmountTo: 4_000 },
      targetCount: 1,
      sampleCountPerModel: 1,
      relatedPlayerRoles: [],
      targets: [{
        competitorId: uuid(7),
        displayName: "Rerun Model",
        modelActionTrials: 1,
        fallbackTrials: 0,
        infrastructureErrorTrials: 0,
      }],
    });
    expect(summaries[0]).not.toHaveProperty("snapshot");
    expect(summaries[0]?.targets[0]).not.toHaveProperty("trials");
    expect(summaries[0]?.targets[0]).not.toHaveProperty("modelId");
    expect(summaries[0]?.targets[0]).not.toHaveProperty("competitorRevisionId");
  });

  it("reports and deduplicates only the queried competitor's decision roles", async () => {
    const dualRoleSnapshot = decisionBranchSnapshotV1Schema.parse({
      ...snapshot(),
      targets: [{
        ...snapshot().targets[0],
        competitorId: uuid(5),
      }],
    });
    const dualRole = publication("PUBLISHED", { snapshot: dualRoleSnapshot });
    const repository = repositoryStub({
      listPublishedForCompetitor: vi.fn(async () => [dualRole]),
    });
    const harness = serviceWith({ repository });

    await expect(harness.service.listPublicForCompetitor(uuid(5), 3)).resolves.toMatchObject([{
      relatedPlayerRoles: ["DECISION_MAKER", "COMPARED_MODEL"],
    }]);
    expect(repository.listPublishedForCompetitor).toHaveBeenCalledWith(uuid(5), 3);

    await expect(harness.service.listPublicForCompetitor(uuid(6), 3)).resolves.toEqual([]);
  });
});
