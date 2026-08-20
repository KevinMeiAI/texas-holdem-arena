import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  decisionBranchPublicationSchema,
  decisionBranchPublicationStatusSchema,
  storedDecisionBranchSnapshotSchema,
  type DecisionBranchPublication,
  type DecisionBranchPublicationStatus,
  type StoredDecisionBranchSnapshot,
} from "../../../../../packages/contracts/src/index.js";
import { canonicalJson } from "../../../../../packages/fairness/src/canonical-json.js";

interface DecisionBranchPublicationRow {
  id: string;
  source_hand_fork_id: string;
  status: DecisionBranchPublicationStatus;
  slug: string | null;
  title_zh: string | null;
  title_en: string | null;
  summary_zh: string | null;
  summary_en: string | null;
  snapshot_version: string;
  public_snapshot: unknown;
  public_snapshot_hash: string;
  publication_revision: number;
  created_by_admin_user_id: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateDecisionBranchDraftInput {
  id: string;
  handForkId: string;
  snapshot: StoredDecisionBranchSnapshot;
  createdByAdminUserId: string;
}

export interface DecisionBranchPublicationMutation {
  id: string;
  status: DecisionBranchPublicationStatus;
  slug: string | null;
  titleZh: string | null;
  titleEn: string | null;
  summaryZh: string | null;
  summaryEn: string | null;
  createdByAdminUserId: string;
}

export type DecisionBranchAuditAction =
  | "decision_branch.create"
  | "decision_branch.update"
  | "decision_branch.publish"
  | "decision_branch.hide";

export interface DecisionBranchAuditEvent {
  adminUserId: string;
  action: DecisionBranchAuditAction;
  targetId: string;
  metadata: Record<string, unknown>;
}

export interface DecisionBranchRepository {
  createDraft(
    input: CreateDecisionBranchDraftInput,
    audit: DecisionBranchAuditEvent,
  ): Promise<{ publication: DecisionBranchPublication; created: boolean }>;
  getById(id: string): Promise<DecisionBranchPublication | null>;
  getByHandForkId(handForkId: string): Promise<DecisionBranchPublication | null>;
  listAdmin(limit: number): Promise<DecisionBranchPublication[]>;
  updatePublication(
    input: DecisionBranchPublicationMutation,
    expectedRevision: number,
    audit: DecisionBranchAuditEvent,
  ): Promise<DecisionBranchPublication>;
  getPublishedBySlug(slug: string): Promise<DecisionBranchPublication | null>;
  listPublished(limit: number): Promise<DecisionBranchPublication[]>;
}

export class DecisionBranchSourceUnavailableError extends Error {
  constructor() {
    super("Decision branches require a completed source hand fork");
    this.name = "DecisionBranchSourceUnavailableError";
  }
}

export class DecisionBranchPublicationConflictError extends Error {
  constructor(message = "Decision branch publication revision conflict") {
    super(message);
    this.name = "DecisionBranchPublicationConflictError";
  }
}

export class DecisionBranchSlugConflictError extends Error {
  constructor() {
    super("Decision branch slug is already in use");
    this.name = "DecisionBranchSlugConflictError";
  }
}

export class DecisionBranchSnapshotConflictError extends Error {
  constructor() {
    super("Existing decision branch uses another frozen snapshot");
    this.name = "DecisionBranchSnapshotConflictError";
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function decisionBranchSnapshotHash(snapshot: StoredDecisionBranchSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}

function mapRow(row: DecisionBranchPublicationRow): DecisionBranchPublication {
  const snapshot = storedDecisionBranchSnapshotSchema.parse(row.public_snapshot);
  const expectedHash = decisionBranchSnapshotHash(snapshot);
  if (expectedHash !== row.public_snapshot_hash) {
    throw new Error(`Decision branch snapshot hash mismatch: ${row.id}`);
  }
  return decisionBranchPublicationSchema.parse({
    id: row.id,
    handForkId: row.source_hand_fork_id,
    status: decisionBranchPublicationStatusSchema.parse(row.status),
    slug: row.slug,
    titleZh: row.title_zh,
    titleEn: row.title_en,
    summaryZh: row.summary_zh,
    summaryEn: row.summary_en,
    snapshotVersion: row.snapshot_version,
    snapshotHash: row.public_snapshot_hash,
    snapshot,
    revision: row.publication_revision,
    createdByAdminUserId: row.created_by_admin_user_id,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function pgError(error: unknown): { code?: string; constraint?: string } {
  return error !== null && typeof error === "object"
    ? error as { code?: string; constraint?: string }
    : {};
}

async function appendAudit(
  client: Pick<PoolClient, "query">,
  audit: DecisionBranchAuditEvent,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into audit_events
      (id, admin_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'decision_branch', $4, $5::jsonb)`,
    [
      randomUUID(),
      audit.adminUserId,
      audit.action,
      audit.targetId,
      JSON.stringify({ ...audit.metadata, ...metadata }),
    ],
  );
}

export class PgDecisionBranchRepository implements DecisionBranchRepository {
  constructor(private readonly pool: Pool) {}

  async createDraft(
    input: CreateDecisionBranchDraftInput,
    audit: DecisionBranchAuditEvent,
  ): Promise<{ publication: DecisionBranchPublication; created: boolean }> {
    const snapshot = storedDecisionBranchSnapshotSchema.parse(input.snapshot);
    const snapshotHash = decisionBranchSnapshotHash(snapshot);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query<DecisionBranchPublicationRow>(
        `insert into decision_branch_publications
          (id, source_hand_fork_id, status, snapshot_version, public_snapshot,
           public_snapshot_hash, created_by_admin_user_id)
         select $1, f.id, 'DRAFT', $3, $4::jsonb, $5, $6
           from hand_forks f
          where f.id = $2 and f.status = 'COMPLETED'
         on conflict (source_hand_fork_id) do nothing
         returning *`,
        [
          input.id,
          input.handForkId,
          snapshot.version,
          JSON.stringify(snapshot),
          snapshotHash,
          input.createdByAdminUserId,
        ],
      );
      let publication: DecisionBranchPublication;
      let created = false;
      if (inserted.rows[0]) {
        publication = mapRow(inserted.rows[0]);
        created = true;
        await appendAudit(client, audit, {
          sourceHandForkId: input.handForkId,
          status: publication.status,
          publicationRevision: publication.revision,
          snapshotVersion: publication.snapshotVersion,
          snapshotHash: publication.snapshotHash,
        });
      } else {
        const existing = await client.query<DecisionBranchPublicationRow>(
          "select * from decision_branch_publications where source_hand_fork_id = $1",
          [input.handForkId],
        );
        if (!existing.rows[0]) throw new DecisionBranchSourceUnavailableError();
        publication = mapRow(existing.rows[0]);
        if (publication.snapshotHash !== snapshotHash) throw new DecisionBranchSnapshotConflictError();
      }
      await client.query("commit");
      return { publication, created };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<DecisionBranchPublication | null> {
    const result = await this.pool.query<DecisionBranchPublicationRow>(
      "select * from decision_branch_publications where id = $1",
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async getByHandForkId(handForkId: string): Promise<DecisionBranchPublication | null> {
    const result = await this.pool.query<DecisionBranchPublicationRow>(
      "select * from decision_branch_publications where source_hand_fork_id = $1",
      [handForkId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listAdmin(limit: number): Promise<DecisionBranchPublication[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const result = await this.pool.query<DecisionBranchPublicationRow>(
      "select * from decision_branch_publications order by created_at desc, id desc limit $1",
      [bounded],
    );
    return result.rows.map(mapRow);
  }

  async updatePublication(
    input: DecisionBranchPublicationMutation,
    expectedRevision: number,
    audit: DecisionBranchAuditEvent,
  ): Promise<DecisionBranchPublication> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query<DecisionBranchPublicationRow>(
        `update decision_branch_publications
            set status = $2,
                slug = $3,
                title_zh = $4,
                title_en = $5,
                summary_zh = $6,
                summary_en = $7,
                created_by_admin_user_id = coalesce(created_by_admin_user_id, $8),
                published_at = case
                  when $2 = 'PUBLISHED' then coalesce(published_at, now())
                  else published_at
                end,
                publication_revision = publication_revision + 1,
                updated_at = now()
          where id = $1 and publication_revision = $9
          returning *`,
        [
          input.id,
          input.status,
          input.slug,
          input.titleZh,
          input.titleEn,
          input.summaryZh,
          input.summaryEn,
          input.createdByAdminUserId,
          expectedRevision,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new DecisionBranchPublicationConflictError();
      const publication = mapRow(row);
      await appendAudit(client, audit, {
        sourceHandForkId: publication.handForkId,
        status: publication.status,
        publicationRevision: publication.revision,
        slug: publication.slug,
      });
      await client.query("commit");
      return publication;
    } catch (error) {
      await client.query("rollback");
      const pg = pgError(error);
      if (pg.code === "23505" && pg.constraint === "decision_branch_publications_slug") {
        throw new DecisionBranchSlugConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getPublishedBySlug(slug: string): Promise<DecisionBranchPublication | null> {
    const result = await this.pool.query<DecisionBranchPublicationRow>(
      `select * from decision_branch_publications
        where lower(slug) = lower($1) and status = 'PUBLISHED'`,
      [slug],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listPublished(limit: number): Promise<DecisionBranchPublication[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.pool.query<DecisionBranchPublicationRow>(
      `select * from decision_branch_publications
        where status = 'PUBLISHED'
        order by published_at desc, id desc
        limit $1`,
      [bounded],
    );
    return result.rows.map(mapRow);
  }
}
