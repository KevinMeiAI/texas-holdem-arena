import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  MOMENT_DETECTOR_VERSION,
  tournamentMomentFactsSchema,
  type AdminMomentRecord,
  type MomentPublicationMutation,
  type MomentTag,
  type TournamentMomentFacts,
} from "../../../../../packages/contracts/src/moments.js";
import { BROADCAST_EQUITY_VERSION } from "../broadcast-equity.js";
import { BROADCAST_VIEW_VERSION } from "../broadcast-view.js";
import {
  PgMomentRepository,
  type MomentAuditEvent,
  type MomentRepository,
} from "./moment-repository.js";
import { CURRENT_MOMENT_GENERATION, MomentService } from "./moment-service.js";

const MOMENT_ID = "00000000-0000-5000-8000-000000000001";
const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const acceptSuspenseCover = () => true;

function facts(): TournamentMomentFacts {
  return tournamentMomentFactsSchema.parse({
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 12,
    startSequence: 100,
    focusSequence: 105,
    endSequence: 110,
    factsVersion: "arena-moment-facts-v1",
    detectorVersion: MOMENT_DETECTOR_VERSION,
    scoringVersion: "arena-moment-scoring-v1",
    broadcastViewVersion: "arena-broadcast-view-v1",
    equityVersion: "arena-broadcast-equity-v1",
    source: {
      eventHash: "1".repeat(64),
      eventCount: 11,
      startEventHash: "2".repeat(64),
      endEventHash: "3".repeat(64),
    },
    score: 60,
    scoreBreakdown: { potImpact: 20, tournamentImpact: 24, actionDrama: 8, equityDrama: 8, rarity: 0 },
    recommendationRank: 1,
    primaryTag: "FINAL_HAND",
    tags: ["FINAL_HAND", "ELIMINATION"],
    participantPlayerIds: ["a", "b"],
    featuredPlayerIds: ["a", "b"],
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

class FakeMomentRepository implements MomentRepository {
  record: AdminMomentRecord = { facts: facts(), publication: null, supersededAt: null };
  audits: MomentAuditEvent[] = [];
  missingTournamentIds: string[] = [];
  persistDetected = true;
  indexRecordCopies = 1;
  indexCursorExists = true;
  beforeDetectedPersist: Promise<void> | null = null;

  async upsertDetectedMoments(
    _tournamentId: string,
    moments: readonly TournamentMomentFacts[],
    audit: MomentAuditEvent,
  ): Promise<boolean> {
    await this.beforeDetectedPersist;
    const next = moments.find((moment) => moment.id === this.record.facts.id);
    if (next) this.record = { ...this.record, facts: next };
    this.audits.push(structuredClone(audit));
    return this.persistDetected;
  }

  async listCompletedTournamentIdsMissingGeneration(): Promise<string[]> {
    return [...this.missingTournamentIds];
  }

  async getAdminMoment(momentId: string): Promise<AdminMomentRecord | null> {
    return momentId === this.record.facts.id ? structuredClone(this.record) : null;
  }

  async listAdminMoments(tournamentId: string): Promise<AdminMomentRecord[]> {
    return tournamentId === this.record.facts.tournamentId ? [structuredClone(this.record)] : [];
  }

  async upsertPublication(
    input: MomentPublicationMutation,
    expectedRevision: number | null,
    audit: MomentAuditEvent,
  ): Promise<AdminMomentRecord> {
    const now = "2026-08-19T00:00:00.000Z";
    const previous = this.record.publication;
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error("stale test mutation");
    this.record = {
      supersededAt: this.record.supersededAt,
      facts: this.record.facts,
      publication: {
        momentId: input.momentId,
        status: input.status,
        slug: input.slug,
        titleZh: input.titleZh,
        titleEn: input.titleEn,
        summaryZh: input.summaryZh,
        summaryEn: input.summaryEn,
        coverSequence: input.coverSequence,
        playbackStartSequence: input.playbackStartSequence,
        playbackEndSequence: input.playbackEndSequence,
        spoilerMode: input.spoilerMode,
        isPrimary: input.isPrimary,
        revision: (previous?.revision ?? 0) + 1,
        createdByAdminUserId: previous?.createdByAdminUserId ?? input.createdByAdminUserId,
        publishedAt: input.status === "PUBLISHED" ? previous?.publishedAt ?? now : previous?.publishedAt ?? null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      },
    };
    this.audits.push(structuredClone(audit));
    return structuredClone(this.record);
  }

  async listPublishedRecords(tournamentId: string): Promise<AdminMomentRecord[]> {
    // Deliberately behave like a faulty adapter: the service must still keep a
    // draft out of the public DTO boundary.
    return tournamentId === this.record.facts.tournamentId ? [structuredClone(this.record)] : [];
  }

  async listPublishedRecordsForPlayers(
    playerIds: readonly string[],
    _limit: number,
  ): Promise<AdminMomentRecord[]> {
    return this.record.facts.featuredPlayerIds.some((playerId) => playerIds.includes(playerId))
      ? [structuredClone(this.record)]
      : [];
  }

  async listPublishedIndexRecords(_input: {
    limit: number;
    tag: MomentTag | null;
    cursor: { momentId: string } | null;
  }): Promise<AdminMomentRecord[]> {
    return Array.from({ length: this.indexRecordCopies }, () => structuredClone(this.record));
  }

  async publishedIndexCursorExists(_momentId: string): Promise<boolean> {
    return this.indexCursorExists;
  }

  async getPublishedRecordBySlug(_slug: string): Promise<AdminMomentRecord | null> {
    return structuredClone(this.record);
  }
}

describe("moment service", () => {
  it("records automatic detection as a system-generated draft-only candidate run", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);

    const generated = await service.rebuildAutomatically({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events: [],
      broadcastFrames: [],
    });

    expect(generated).toBe(true);
    expect(repository.record.publication).toBeNull();
    expect(repository.audits).toEqual([expect.objectContaining({
      adminUserId: null,
      action: "tournament_moments.generate",
      metadata: expect.objectContaining({
        trigger: "AUTO",
        ...CURRENT_MOMENT_GENERATION,
        candidateCount: 0,
      }),
    })]);
  });

  it("waits for in-flight automatic generation before shutdown can close persistence", async () => {
    const repository = new FakeMomentRepository();
    let releasePersist!: () => void;
    repository.beforeDetectedPersist = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const service = new MomentService(repository, acceptSuspenseCover);
    const generation = service.rebuildAutomatically({
      tournamentId: TOURNAMENT_ID,
      tournamentStatus: "COMPLETED",
      events: [],
      broadcastFrames: [],
    });
    let idle = false;
    const waiting = service.waitForAutomaticRuns().then(() => { idle = true; });

    await Promise.resolve();
    expect(idle).toBe(false);
    releasePersist();
    await expect(Promise.all([generation, waiting])).resolves.toEqual([true, undefined]);
    expect(idle).toBe(true);
  });

  it("makes an AUTO generation a database-locked no-op when the current generation exists", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
      if (sql.includes("select id from tournaments")) return { rows: [{ id: TOURNAMENT_ID }], rowCount: 1 };
      if (sql.includes("as generated")) return { rows: [{ generated: true }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const repository = new PgMomentRepository({
      connect: vi.fn(async () => ({ query: clientQuery, release })),
    } as unknown as Pool);

    const persisted = await repository.upsertDetectedMoments(TOURNAMENT_ID, [], {
      adminUserId: null,
      action: "tournament_moments.generate",
      targetType: "tournament",
      targetId: TOURNAMENT_ID,
      metadata: { trigger: "AUTO", ...CURRENT_MOMENT_GENERATION },
    });

    expect(persisted).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("insert into tournament_moments"))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("insert into audit_events"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an editorial persistence audit without administrator provenance", async () => {
    const repository = new PgMomentRepository({} as Pool);

    await expect(repository.upsertPublication({
      momentId: MOMENT_ID,
      status: "DRAFT",
      slug: null,
      titleZh: null,
      titleEn: null,
      summaryZh: null,
      summaryEn: null,
      coverSequence: null,
      playbackStartSequence: null,
      playbackEndSequence: null,
      spoilerMode: "SUSPENSE",
      isPrimary: false,
      createdByAdminUserId: null,
    }, null, {
      adminUserId: null,
      action: "moment_publication.update",
      targetType: "tournament_moment",
      targetId: MOMENT_ID,
      metadata: {},
    })).rejects.toThrow("requires administrator provenance");
  });

  it("isolates backlog failures and requests only current generation gaps", async () => {
    const repository = new FakeMomentRepository();
    const missingTwo = "00000000-0000-4000-8000-000000000003";
    repository.missingTournamentIds = [TOURNAMENT_ID, missingTwo];
    const service = new MomentService(repository, acceptSuspenseCover);
    const onError = vi.fn();

    const summary = await service.restoreMissingCompletedTournaments(async (tournamentId) => {
      if (tournamentId === missingTwo) throw new Error("bad legacy projection");
      return {
        tournamentId,
        tournamentStatus: "COMPLETED",
        events: [],
        broadcastFrames: [],
      };
    }, onError);

    expect(summary).toEqual({ scanned: 2, generated: 1, failed: 1 });
    expect(onError).toHaveBeenCalledWith(missingTwo, expect.any(Error));
    expect(repository.audits).toHaveLength(1);
  });

  it("continues the backlog when its failure observer also throws", async () => {
    const repository = new FakeMomentRepository();
    const brokenTournament = "00000000-0000-4000-8000-000000000003";
    const laterTournament = "00000000-0000-4000-8000-000000000004";
    repository.missingTournamentIds = [TOURNAMENT_ID, brokenTournament, laterTournament];
    const service = new MomentService(repository, acceptSuspenseCover);

    const summary = await service.restoreMissingCompletedTournaments(async (tournamentId) => {
      if (tournamentId === brokenTournament) throw new Error("bad legacy projection");
      return {
        tournamentId,
        tournamentStatus: "COMPLETED",
        events: [],
        broadcastFrames: [],
      };
    }, () => {
      throw new Error("broken logger");
    });

    expect(summary).toEqual({ scanned: 3, generated: 2, failed: 1 });
    expect(repository.audits).toHaveLength(2);
  });

  it("uses all current algorithm versions when finding the startup backlog", async () => {
    const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const repository = new PgMomentRepository({ query } as unknown as Pool);

    await repository.listCompletedTournamentIdsMissingGeneration(CURRENT_MOMENT_GENERATION);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("current_moment.broadcast_view_version = $4"),
      [
        "arena-moment-facts-v1",
        MOMENT_DETECTOR_VERSION,
        "arena-moment-scoring-v1",
        BROADCAST_VIEW_VERSION,
        BROADCAST_EQUITY_VERSION,
      ],
    );
    expect(String(query.mock.calls[0]?.[0])).toContain("generation_audit.metadata->>'equityVersion' = $5");
  });

  it("keeps a draft out of the paginated public index", async () => {
    const service = new MomentService(new FakeMomentRepository(), acceptSuspenseCover);

    await expect(service.listPublicIndex(12, null, null)).resolves.toEqual({
      moments: [],
      nextCursor: null,
    });
  });

  it("rejects malformed cursors and cursors created for a different tag", async () => {
    const repository = new FakeMomentRepository();
    repository.indexRecordCopies = 2;
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.publish(MOMENT_ID, {
      slug: "cursor-source",
      titleEn: "Cursor source",
    }, null, ADMIN_ID);

    await expect(service.listPublicIndex(1, null, "not-a-cursor")).rejects.toThrow(
      "Invalid moment index cursor",
    );
    const firstPage = await service.listPublicIndex(1, "FINAL_HAND", null);
    expect(firstPage.nextCursor).not.toBeNull();
    await expect(service.listPublicIndex(1, null, firstPage.nextCursor)).rejects.toThrow(
      "Invalid moment index cursor",
    );
    repository.indexCursorExists = false;
    await expect(service.listPublicIndex(1, "FINAL_HAND", firstPage.nextCursor)).rejects.toThrow(
      "Invalid moment index cursor",
    );
  });

  it("selects profile moments by editorial prominence rather than table participation", async () => {
    const query = vi.fn(async (_sql: string, _parameters?: unknown[]) => ({
      rows: [],
      rowCount: 0,
    }));
    const repository = new PgMomentRepository({ query } as unknown as Pool);

    await repository.listPublishedRecordsForPlayers(["featured-player"], 6);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("m.facts->'featuredPlayerIds'"),
      [["featured-player"], 6],
    );
    expect(String(query.mock.calls[0]?.[0])).not.toContain("participantPlayerIds");
  });

  it("keeps drafts out of public DTOs and publishes a complete localized record", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.editPublication(MOMENT_ID, {
      titleZh: "河牌逆转",
    }, null, ADMIN_ID);

    expect(repository.record.publication).toMatchObject({
      status: "DRAFT",
      coverSequence: 105,
      playbackStartSequence: 100,
      playbackEndSequence: 110,
    });
    expect(await service.listPublic(TOURNAMENT_ID)).toEqual([]);
    expect(await service.getPublicBySlug("anything")).toBeNull();

    await service.publish(MOMENT_ID, {
      slug: "river-reversal-h12",
      titleZh: "河牌逆转",
      titleEn: "River reversal",
    }, 1, ADMIN_ID);
    const publicMoments = await service.listPublic(TOURNAMENT_ID);
    expect(publicMoments).toHaveLength(1);
    expect(publicMoments[0]).toMatchObject({
      id: MOMENT_ID,
      status: "PUBLISHED",
      slug: "river-reversal-h12",
      publicationRevision: 2,
      primaryTag: "FINAL_HAND",
    });
    expect(publicMoments[0]).not.toHaveProperty("createdByAdminUserId");
    expect(repository.audits).toMatchObject([
      {
        action: "moment_publication.update",
        metadata: { status: "DRAFT", publicationRevision: 1, changedFields: ["titleZh"] },
      },
      {
        action: "moment_publication.publish",
        metadata: {
          status: "PUBLISHED",
          publicationRevision: 2,
          slug: "river-reversal-h12",
          changedFields: ["slug", "titleEn", "titleZh"],
        },
      },
    ]);
  });

  it("never lets editorial playback escape the authoritative hand window", async () => {
    const service = new MomentService(new FakeMomentRepository(), acceptSuspenseCover);
    await expect(service.editPublication(MOMENT_ID, {
      coverSequence: 111,
    }, null, ADMIN_ID)).rejects.toThrow("inside the authoritative event window");
  });

  it("blocks an unsafe suspense cover before persistence with a dedicated conflict", async () => {
    const repository = new FakeMomentRepository();
    const validateCover = vi.fn(async () => false);
    const service = new MomentService(repository, validateCover);

    await expect(service.publish(MOMENT_ID, {
      slug: "spoiling-cover",
      titleEn: "Spoiling cover",
      coverSequence: 109,
    }, null, ADMIN_ID)).rejects.toMatchObject({
      code: "UNSAFE_SUSPENSE_COVER",
      message: "The selected suspense cover reveals the hand result",
    });
    expect(validateCover).toHaveBeenCalledWith({
      tournamentId: TOURNAMENT_ID,
      handNo: 12,
      coverSequence: 109,
    });
    expect(repository.record.publication).toBeNull();
    expect(repository.audits).toEqual([]);
  });

  it("does not apply suspense-cover validation to an explicit result card", async () => {
    const repository = new FakeMomentRepository();
    const validateCover = vi.fn(async () => false);
    const service = new MomentService(repository, validateCover);

    await service.publish(MOMENT_ID, {
      slug: "result-cover",
      titleEn: "Result cover",
      spoilerMode: "RESULT",
    }, null, ADMIN_ID);

    expect(validateCover).not.toHaveBeenCalled();
    expect(repository.record.publication?.status).toBe("PUBLISHED");
  });

  it("preserves omitted editorial settings and honors explicit null", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.publish(MOMENT_ID, {
      slug: "final-hand-h12",
      titleEn: "The final hand",
      summaryEn: "An old summary",
      spoilerMode: "RESULT",
      isPrimary: true,
    }, null, ADMIN_ID);
    await service.editPublication(MOMENT_ID, {
      titleZh: "最后一手",
      summaryEn: null,
    }, 1, ADMIN_ID);

    expect(repository.record.publication).toMatchObject({
      status: "PUBLISHED",
      titleZh: "最后一手",
      summaryEn: null,
      spoilerMode: "RESULT",
      isPrimary: true,
    });
  });

  it("keeps the first published slug immutable without advancing its revision", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.publish(MOMENT_ID, {
      slug: "stable-highlight",
      titleEn: "Stable highlight",
    }, null, ADMIN_ID);

    await expect(service.editPublication(MOMENT_ID, {
      slug: "renamed-highlight",
    }, 1, ADMIN_ID)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A published moment slug is immutable",
    });
    expect(repository.record.publication).toMatchObject({
      slug: "stable-highlight",
      revision: 1,
    });
    expect(repository.audits).toHaveLength(1);
  });

  it("keeps the same slug when a hidden historical publication returns", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.publish(MOMENT_ID, {
      slug: "returning-highlight",
      titleEn: "Returning highlight",
    }, null, ADMIN_ID);
    await service.hide(MOMENT_ID, 1, ADMIN_ID);

    await expect(service.publish(MOMENT_ID, {
      slug: "renamed-after-hide",
    }, 2, ADMIN_ID)).rejects.toThrow("slug is immutable");
    const republished = await service.publish(MOMENT_ID, {
      slug: "returning-highlight",
    }, 2, ADMIN_ID);

    expect(republished.publication).toMatchObject({
      status: "PUBLISHED",
      slug: "returning-highlight",
      revision: 3,
    });
  });

  it("requires a prior publication before hiding", async () => {
    const service = new MomentService(new FakeMomentRepository(), acceptSuspenseCover);
    await expect(service.hide(MOMENT_ID, null, ADMIN_ID)).rejects.toThrow("previously published");
  });

  it("never lets a draft displace the public primary and clears primary when hidden", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.editPublication(MOMENT_ID, { titleEn: "Draft", isPrimary: true }, null, ADMIN_ID);
    expect(repository.record.publication).toMatchObject({ status: "DRAFT", isPrimary: false });

    await service.publish(MOMENT_ID, { slug: "primary-hand", isPrimary: true }, 1, ADMIN_ID);
    expect(repository.record.publication).toMatchObject({ status: "PUBLISHED", isPrimary: true });

    await service.hide(MOMENT_ID, 2, ADMIN_ID);
    expect(repository.record.publication).toMatchObject({ status: "HIDDEN", isPrimary: false });
  });

  it("does not publish a superseded candidate unless it already owns a historical publication", async () => {
    const repository = new FakeMomentRepository();
    repository.record.supersededAt = "2026-08-20T00:00:00.000Z";
    const service = new MomentService(repository, acceptSuspenseCover);
    await expect(service.publish(MOMENT_ID, {
      slug: "stale-candidate",
      titleEn: "Stale candidate",
    }, null, ADMIN_ID)).rejects.toThrow("superseded candidate");
  });

  it("rejects a stale editorial revision before it can overwrite newer state", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository, acceptSuspenseCover);
    await service.publish(MOMENT_ID, {
      slug: "revision-guard",
      titleEn: "Revision guard",
    }, null, ADMIN_ID);

    await expect(service.editPublication(MOMENT_ID, {
      titleEn: "Stale title",
    }, null, ADMIN_ID)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repository.record.publication).toMatchObject({
      revision: 1,
      titleEn: "Revision guard",
    });
  });
});
