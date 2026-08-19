import { describe, expect, it } from "vitest";
import {
  tournamentMomentFactsSchema,
  type AdminMomentRecord,
  type MomentPublicationMutation,
  type TournamentMomentFacts,
} from "../../../../../packages/contracts/src/moments.js";
import type { MomentAuditEvent, MomentRepository } from "./moment-repository.js";
import { MomentService } from "./moment-service.js";

const MOMENT_ID = "00000000-0000-5000-8000-000000000001";
const TOURNAMENT_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";

function facts(): TournamentMomentFacts {
  return tournamentMomentFactsSchema.parse({
    id: MOMENT_ID,
    tournamentId: TOURNAMENT_ID,
    handNo: 12,
    startSequence: 100,
    focusSequence: 105,
    endSequence: 110,
    factsVersion: "arena-moment-facts-v1",
    detectorVersion: "arena-moment-detector-v1",
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

  async upsertDetectedMoments(
    _tournamentId: string,
    moments: readonly TournamentMomentFacts[],
    audit: MomentAuditEvent,
  ): Promise<void> {
    const next = moments.find((moment) => moment.id === this.record.facts.id);
    if (next) this.record = { ...this.record, facts: next };
    this.audits.push(structuredClone(audit));
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

  async getPublishedRecordBySlug(_slug: string): Promise<AdminMomentRecord | null> {
    return structuredClone(this.record);
  }
}

describe("moment service", () => {
  it("keeps drafts out of public DTOs and publishes a complete localized record", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository);
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
    const service = new MomentService(new FakeMomentRepository());
    await expect(service.editPublication(MOMENT_ID, {
      coverSequence: 111,
    }, null, ADMIN_ID)).rejects.toThrow("inside the authoritative event window");
  });

  it("preserves omitted editorial settings and honors explicit null", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository);
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
    const service = new MomentService(repository);
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
    const service = new MomentService(repository);
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
    const service = new MomentService(new FakeMomentRepository());
    await expect(service.hide(MOMENT_ID, null, ADMIN_ID)).rejects.toThrow("previously published");
  });

  it("never lets a draft displace the public primary and clears primary when hidden", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository);
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
    const service = new MomentService(repository);
    await expect(service.publish(MOMENT_ID, {
      slug: "stale-candidate",
      titleEn: "Stale candidate",
    }, null, ADMIN_ID)).rejects.toThrow("superseded candidate");
  });

  it("rejects a stale editorial revision before it can overwrite newer state", async () => {
    const repository = new FakeMomentRepository();
    const service = new MomentService(repository);
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
