import {
  momentEditorialPatchSchema,
  momentPublicationMutationSchema,
  publicMomentDtoSchema,
  type AdminMomentRecord,
  type MomentEditorialPatch,
  type MomentPublicationMutation,
  type MomentPublicationStatus,
  type PublicMomentDto,
  type TournamentMomentFacts,
} from "../../../../../packages/contracts/src/moments.js";
import { detectTournamentMoments, type MomentDetectionInput } from "./moment-detector.js";
import {
  MomentPublicationRevisionConflictError,
  MomentSupersededPublicationError,
  type MomentAuditAction,
  type MomentAuditEvent,
  type MomentRepository,
} from "./moment-repository.js";

export function publicMomentFromRecord(record: AdminMomentRecord): PublicMomentDto | null {
  const publication = record.publication;
  if (publication?.status !== "PUBLISHED"
    || publication.slug === null
    || publication.coverSequence === null
    || publication.playbackStartSequence === null
    || publication.playbackEndSequence === null
    || publication.publishedAt === null) return null;
  if (!insideMomentWindow(publication.coverSequence, record.facts)
    || !insideMomentWindow(publication.playbackStartSequence, record.facts)
    || !insideMomentWindow(publication.playbackEndSequence, record.facts)
    || publication.playbackStartSequence > publication.playbackEndSequence) return null;
  return publicMomentDtoSchema.parse({
    id: record.facts.id,
    tournamentId: record.facts.tournamentId,
    handNo: record.facts.handNo,
    status: "PUBLISHED",
    slug: publication.slug,
    titleZh: publication.titleZh,
    titleEn: publication.titleEn,
    summaryZh: publication.summaryZh,
    summaryEn: publication.summaryEn,
    coverSequence: publication.coverSequence,
    playbackStartSequence: publication.playbackStartSequence,
    playbackEndSequence: publication.playbackEndSequence,
    spoilerMode: publication.spoilerMode,
    isPrimary: publication.isPrimary,
    publicationRevision: publication.revision,
    publishedAt: publication.publishedAt,
    primaryTag: record.facts.primaryTag,
    tags: record.facts.tags,
    score: record.facts.score,
    facts: record.facts,
  });
}

function insideMomentWindow(
  sequence: number,
  moment: { startSequence: number; endSequence: number },
): boolean {
  return sequence >= moment.startSequence && sequence <= moment.endSequence;
}

export class MomentServiceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "MomentServiceError";
  }
}

function hasOwn<K extends keyof MomentEditorialPatch>(
  patch: MomentEditorialPatch,
  key: K,
): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

export class MomentService {
  constructor(private readonly repository: MomentRepository) {}

  async rebuild(input: MomentDetectionInput, adminUserId: string): Promise<TournamentMomentFacts[]> {
    const moments = detectTournamentMoments(input);
    await this.repository.upsertDetectedMoments(input.tournamentId, moments, {
      adminUserId,
      action: "tournament_moments.generate",
      targetType: "tournament",
      targetId: input.tournamentId,
      metadata: {
        detectorVersion: moments[0]?.detectorVersion ?? null,
        scoringVersion: moments[0]?.scoringVersion ?? null,
        candidateCount: moments.length,
        recommendedCount: moments.filter((moment) => moment.recommendationRank !== null).length,
      },
    });
    return moments;
  }

  listAdmin(tournamentId: string): Promise<AdminMomentRecord[]> {
    return this.repository.listAdminMoments(tournamentId);
  }

  getAdmin(momentId: string): Promise<AdminMomentRecord | null> {
    return this.repository.getAdminMoment(momentId);
  }

  async editPublication(
    momentId: string,
    rawPatch: unknown,
    expectedRevision: number | null,
    adminUserId: string,
  ): Promise<AdminMomentRecord> {
    const patch = momentEditorialPatchSchema.parse(rawPatch);
    const existing = await this.#requiredMoment(momentId);
    return this.#persistPublication(
      existing,
      existing.publication?.status ?? "DRAFT",
      patch,
      expectedRevision,
      adminUserId,
      "moment_publication.update",
    );
  }

  async publish(
    momentId: string,
    rawPatch: unknown,
    expectedRevision: number | null,
    adminUserId: string,
  ): Promise<AdminMomentRecord> {
    const patch = momentEditorialPatchSchema.parse(rawPatch);
    const existing = await this.#requiredMoment(momentId);
    if (existing.supersededAt !== null && existing.publication?.publishedAt == null) {
      throw new MomentServiceError(
        "CONFLICT",
        "A superseded candidate cannot be published for the first time",
      );
    }
    return this.#persistPublication(
      existing,
      "PUBLISHED",
      patch,
      expectedRevision,
      adminUserId,
      "moment_publication.publish",
    );
  }

  async hide(
    momentId: string,
    expectedRevision: number | null,
    adminUserId: string,
  ): Promise<AdminMomentRecord> {
    const existing = await this.#requiredMoment(momentId);
    if (!existing.publication || existing.publication.publishedAt === null) {
      throw new MomentServiceError("CONFLICT", "Only a previously published moment can be hidden");
    }
    return this.#persistPublication(
      existing,
      "HIDDEN",
      {},
      expectedRevision,
      adminUserId,
      "moment_publication.hide",
    );
  }

  async listPublic(tournamentId: string): Promise<PublicMomentDto[]> {
    const records = await this.repository.listPublishedRecords(tournamentId);
    return records.flatMap((record) => {
      const moment = publicMomentFromRecord(record);
      return moment ? [moment] : [];
    });
  }

  async getPublicBySlug(slug: string): Promise<PublicMomentDto | null> {
    const record = await this.repository.getPublishedRecordBySlug(slug);
    return record ? publicMomentFromRecord(record) : null;
  }

  async #requiredMoment(momentId: string): Promise<AdminMomentRecord> {
    const existing = await this.repository.getAdminMoment(momentId);
    if (!existing) throw new MomentServiceError("NOT_FOUND", `Unknown moment: ${momentId}`);
    return existing;
  }

  async #persistPublication(
    existing: AdminMomentRecord,
    status: MomentPublicationStatus,
    patch: MomentEditorialPatch,
    expectedRevision: number | null,
    adminUserId: string,
    auditAction: MomentAuditAction,
  ): Promise<AdminMomentRecord> {
    const previous = existing.publication;
    const facts = existing.facts;
    if ((previous?.revision ?? null) !== expectedRevision) {
      throw new MomentServiceError("CONFLICT", "Moment publication changed; refresh before saving again");
    }
    const normalized = momentPublicationMutationSchema.parse({
      momentId: facts.id,
      status,
      slug: hasOwn(patch, "slug") ? patch.slug ?? null : previous?.slug ?? null,
      titleZh: hasOwn(patch, "titleZh") ? patch.titleZh ?? null : previous?.titleZh ?? null,
      titleEn: hasOwn(patch, "titleEn") ? patch.titleEn ?? null : previous?.titleEn ?? null,
      summaryZh: hasOwn(patch, "summaryZh") ? patch.summaryZh ?? null : previous?.summaryZh ?? null,
      summaryEn: hasOwn(patch, "summaryEn") ? patch.summaryEn ?? null : previous?.summaryEn ?? null,
      coverSequence: hasOwn(patch, "coverSequence")
        ? patch.coverSequence ?? null
        : previous?.coverSequence ?? facts.focusSequence,
      playbackStartSequence: hasOwn(patch, "playbackStartSequence")
        ? patch.playbackStartSequence ?? null
        : previous?.playbackStartSequence ?? facts.startSequence,
      playbackEndSequence: hasOwn(patch, "playbackEndSequence")
        ? patch.playbackEndSequence ?? null
        : previous?.playbackEndSequence ?? facts.endSequence,
      spoilerMode: patch.spoilerMode ?? previous?.spoilerMode ?? "SUSPENSE",
      // A primary card is a public designation. Drafts cannot displace the
      // current public primary, and hiding one relinquishes the designation.
      isPrimary: status === "PUBLISHED"
        ? patch.isPrimary ?? previous?.isPrimary ?? false
        : false,
      createdByAdminUserId: adminUserId,
    } satisfies MomentPublicationMutation);

    const sequences = [
      normalized.coverSequence,
      normalized.playbackStartSequence,
      normalized.playbackEndSequence,
    ].filter((sequence): sequence is number => sequence !== null);
    if (sequences.some((sequence) => !insideMomentWindow(sequence, facts))) {
      throw new MomentServiceError(
        "CONFLICT",
        "Moment cover and playback sequences must stay inside the authoritative event window",
      );
    }
    if (normalized.playbackStartSequence !== null
      && normalized.playbackEndSequence !== null
      && normalized.playbackStartSequence > normalized.playbackEndSequence) {
      throw new MomentServiceError("CONFLICT", "Moment playback start must not follow its end");
    }
    if (status === "PUBLISHED" && (
      !normalized.slug
      || (!normalized.titleZh && !normalized.titleEn)
      || normalized.coverSequence === null
      || normalized.playbackStartSequence === null
      || normalized.playbackEndSequence === null
    )) {
      throw new MomentServiceError(
        "CONFLICT",
        "A published moment requires a slug, a localized title, a cover, and a playback window",
      );
    }
    try {
      const audit: MomentAuditEvent = {
        adminUserId,
        action: auditAction,
        targetType: "tournament_moment",
        targetId: facts.id,
        metadata: {
          tournamentId: facts.tournamentId,
          status,
          publicationRevision: (previous?.revision ?? 0) + 1,
          slug: normalized.slug,
          changedFields: Object.keys(patch).sort(),
        },
      };
      return await this.repository.upsertPublication(normalized, expectedRevision, audit);
    } catch (error) {
      if (error instanceof MomentPublicationRevisionConflictError) {
        throw new MomentServiceError("CONFLICT", error.message);
      }
      if (error instanceof MomentSupersededPublicationError) {
        throw new MomentServiceError("CONFLICT", error.message);
      }
      throw error;
    }
  }
}
