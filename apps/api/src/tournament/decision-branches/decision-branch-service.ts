import { randomUUID } from "node:crypto";
import {
  decisionBranchEditorialPatchSchema,
  publicDecisionBranchDtoSchema,
  type DecisionBranchEditorialPatch,
  type DecisionBranchPublication,
  type DecisionBranchPublicationStatus,
  type PublicDecisionBranchDto,
} from "../../../../../packages/contracts/src/index.js";
import {
  buildDecisionBranchSnapshot,
  DecisionBranchProjectionError,
  type DecisionBranchIdentityContext,
} from "./decision-branch-projection.js";
import {
  DecisionBranchPublicationConflictError,
  DecisionBranchSlugConflictError,
  DecisionBranchSnapshotConflictError,
  DecisionBranchSourceUnavailableError,
  type DecisionBranchAuditAction,
  type DecisionBranchPublicationMutation,
  type DecisionBranchRepository,
} from "./decision-branch-repository.js";
import type { DecisionBranchSourceReader } from "./decision-branch-source.js";

export interface DecisionBranchIdentityReader {
  publicIdentityContext(tournamentId: string): Promise<DecisionBranchIdentityContext | null>;
}

export interface DecisionBranchServiceDependencies {
  repository: DecisionBranchRepository;
  sources: DecisionBranchSourceReader;
  identities: DecisionBranchIdentityReader;
  randomUUID?: () => string;
  project?: typeof buildDecisionBranchSnapshot;
}

export class DecisionBranchServiceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "SOURCE_UNAVAILABLE" | "IDENTITY_UNAVAILABLE" | "UNSAFE_SOURCE",
    message: string,
  ) {
    super(message);
    this.name = "DecisionBranchServiceError";
  }
}

function hasOwn<K extends keyof DecisionBranchEditorialPatch>(
  patch: DecisionBranchEditorialPatch,
  key: K,
): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function publicBranch(publication: DecisionBranchPublication): PublicDecisionBranchDto | null {
  if (publication.status !== "PUBLISHED"
    || publication.slug === null
    || publication.publishedAt === null
    || (publication.titleZh === null && publication.titleEn === null)) return null;
  return publicDecisionBranchDtoSchema.parse({
    id: publication.id,
    status: "PUBLISHED",
    slug: publication.slug,
    titleZh: publication.titleZh,
    titleEn: publication.titleEn,
    summaryZh: publication.summaryZh,
    summaryEn: publication.summaryEn,
    publicationRevision: publication.revision,
    publishedAt: publication.publishedAt,
    snapshot: publication.snapshot,
  });
}

function editorialChanged(
  previous: DecisionBranchPublication,
  next: DecisionBranchPublicationMutation,
): boolean {
  return previous.status !== next.status
    || previous.slug !== next.slug
    || previous.titleZh !== next.titleZh
    || previous.titleEn !== next.titleEn
    || previous.summaryZh !== next.summaryZh
    || previous.summaryEn !== next.summaryEn;
}

export class DecisionBranchService {
  readonly #repository: DecisionBranchRepository;
  readonly #sources: DecisionBranchSourceReader;
  readonly #identities: DecisionBranchIdentityReader;
  readonly #randomUUID: () => string;
  readonly #project: typeof buildDecisionBranchSnapshot;

  constructor(dependencies: DecisionBranchServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#sources = dependencies.sources;
    this.#identities = dependencies.identities;
    this.#randomUUID = dependencies.randomUUID ?? randomUUID;
    this.#project = dependencies.project ?? buildDecisionBranchSnapshot;
  }

  async createDraft(
    handForkId: string,
    adminUserId: string,
  ): Promise<{ publication: DecisionBranchPublication; created: boolean }> {
    const existing = await this.#repository.getByHandForkId(handForkId);
    if (existing) return { publication: existing, created: false };
    const source = await this.#sources.getCompletedSource(handForkId);
    if (!source) {
      throw new DecisionBranchServiceError(
        "SOURCE_UNAVAILABLE",
        "Only a completed decision rerun can become a public decision branch",
      );
    }
    const identity = await this.#identities.publicIdentityContext(source.fork.source.tournamentId);
    if (!identity) {
      throw new DecisionBranchServiceError(
        "IDENTITY_UNAVAILABLE",
        "The source tournament has no stable public identity context",
      );
    }
    let snapshot;
    try {
      snapshot = this.#project({ fork: source.fork, arenaState: source.arenaState, identity });
    } catch (error) {
      if (error instanceof DecisionBranchProjectionError) {
        throw new DecisionBranchServiceError("UNSAFE_SOURCE", error.message);
      }
      throw error;
    }
    const id = this.#randomUUID();
    try {
      return await this.#repository.createDraft({
        id,
        handForkId,
        snapshot,
        createdByAdminUserId: adminUserId,
      }, {
        adminUserId,
        action: "decision_branch.create",
        targetId: id,
        metadata: {
          sourceHandForkId: handForkId,
          tournamentId: snapshot.source.tournamentId,
          handNo: snapshot.source.handNo,
        },
      });
    } catch (error) {
      if (error instanceof DecisionBranchSourceUnavailableError) {
        throw new DecisionBranchServiceError("SOURCE_UNAVAILABLE", error.message);
      }
      if (error instanceof DecisionBranchSnapshotConflictError) {
        throw new DecisionBranchServiceError("CONFLICT", error.message);
      }
      throw error;
    }
  }

  listAdmin(limit = 50): Promise<DecisionBranchPublication[]> {
    return this.#repository.listAdmin(limit);
  }

  getAdmin(id: string): Promise<DecisionBranchPublication | null> {
    return this.#repository.getById(id);
  }

  getAdminByHandForkId(handForkId: string): Promise<DecisionBranchPublication | null> {
    return this.#repository.getByHandForkId(handForkId);
  }

  async edit(
    id: string,
    rawPatch: unknown,
    expectedRevision: number,
    adminUserId: string,
  ): Promise<DecisionBranchPublication> {
    return this.#persist(
      await this.#required(id),
      decisionBranchEditorialPatchSchema.parse(rawPatch),
      null,
      expectedRevision,
      adminUserId,
      "decision_branch.update",
    );
  }

  async publish(
    id: string,
    rawPatch: unknown,
    expectedRevision: number,
    adminUserId: string,
  ): Promise<DecisionBranchPublication> {
    return this.#persist(
      await this.#required(id),
      decisionBranchEditorialPatchSchema.parse(rawPatch),
      "PUBLISHED",
      expectedRevision,
      adminUserId,
      "decision_branch.publish",
    );
  }

  async hide(
    id: string,
    expectedRevision: number,
    adminUserId: string,
  ): Promise<DecisionBranchPublication> {
    const existing = await this.#required(id);
    if (existing.status !== "PUBLISHED") {
      throw new DecisionBranchServiceError("CONFLICT", "Only a published decision branch can be hidden");
    }
    return this.#persist(
      existing,
      {},
      "HIDDEN",
      expectedRevision,
      adminUserId,
      "decision_branch.hide",
    );
  }

  async getPublicBySlug(slug: string): Promise<PublicDecisionBranchDto | null> {
    const publication = await this.#repository.getPublishedBySlug(slug);
    return publication ? publicBranch(publication) : null;
  }

  async listPublic(limit = 24): Promise<PublicDecisionBranchDto[]> {
    const publications = await this.#repository.listPublished(limit);
    return publications.flatMap((publication) => {
      const branch = publicBranch(publication);
      return branch ? [branch] : [];
    });
  }

  async #required(id: string): Promise<DecisionBranchPublication> {
    const publication = await this.#repository.getById(id);
    if (!publication) throw new DecisionBranchServiceError("NOT_FOUND", `Unknown decision branch: ${id}`);
    return publication;
  }

  async #persist(
    existing: DecisionBranchPublication,
    patch: DecisionBranchEditorialPatch,
    requestedStatus: DecisionBranchPublicationStatus | null,
    expectedRevision: number,
    adminUserId: string,
    action: DecisionBranchAuditAction,
  ): Promise<DecisionBranchPublication> {
    if (existing.revision !== expectedRevision) {
      throw new DecisionBranchServiceError("CONFLICT", "Decision branch changed; refresh before saving again");
    }
    if (existing.publishedAt !== null
      && hasOwn(patch, "slug")
      && (patch.slug ?? null) !== existing.slug) {
      throw new DecisionBranchServiceError("CONFLICT", "A published decision branch slug is immutable");
    }
    const status = requestedStatus ?? existing.status;
    if (status === "DRAFT" && existing.publishedAt !== null) {
      throw new DecisionBranchServiceError("CONFLICT", "A published decision branch cannot return to draft");
    }
    const mutation: DecisionBranchPublicationMutation = {
      id: existing.id,
      status,
      slug: hasOwn(patch, "slug") ? patch.slug ?? null : existing.slug,
      titleZh: hasOwn(patch, "titleZh") ? patch.titleZh ?? null : existing.titleZh,
      titleEn: hasOwn(patch, "titleEn") ? patch.titleEn ?? null : existing.titleEn,
      summaryZh: hasOwn(patch, "summaryZh") ? patch.summaryZh ?? null : existing.summaryZh,
      summaryEn: hasOwn(patch, "summaryEn") ? patch.summaryEn ?? null : existing.summaryEn,
      createdByAdminUserId: adminUserId,
    };
    if (status === "PUBLISHED" && (
      mutation.slug === null || (mutation.titleZh === null && mutation.titleEn === null)
    )) {
      throw new DecisionBranchServiceError(
        "CONFLICT",
        "A published decision branch requires a slug and at least one localized title",
      );
    }
    if (!editorialChanged(existing, mutation)) return existing;
    const changedFields = (["slug", "titleZh", "titleEn", "summaryZh", "summaryEn"] as const)
      .filter((key) => hasOwn(patch, key));
    try {
      return await this.#repository.updatePublication(mutation, expectedRevision, {
        adminUserId,
        action,
        targetId: existing.id,
        metadata: {
          sourceHandForkId: existing.handForkId,
          previousStatus: existing.status,
          status,
          changedFields,
        },
      });
    } catch (error) {
      if (error instanceof DecisionBranchPublicationConflictError) {
        throw new DecisionBranchServiceError("CONFLICT", error.message);
      }
      if (error instanceof DecisionBranchSlugConflictError) throw error;
      throw error;
    }
  }
}
