import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  adminMomentRecordSchema,
  momentPublicationSchema,
  storedTournamentMomentFactsSchema,
  tournamentMomentFactsSchema,
  type AdminMomentRecord,
  type MomentPublication,
  type MomentPublicationMutation,
  type MomentTag,
  type TournamentMomentFacts,
} from "../../../../../packages/contracts/src/moments.js";

interface MomentJoinRow {
  facts: unknown;
  superseded_at: Date | string | null;
  publication_status: MomentPublication["status"] | null;
  slug: string | null;
  title_zh: string | null;
  title_en: string | null;
  summary_zh: string | null;
  summary_en: string | null;
  cover_sequence: string | null;
  playback_start_sequence: string | null;
  playback_end_sequence: string | null;
  spoiler_mode: MomentPublication["spoilerMode"] | null;
  is_primary: boolean | null;
  publication_revision: number | null;
  created_by_admin_user_id: string | null;
  published_at: Date | string | null;
  publication_created_at: Date | string | null;
  publication_updated_at: Date | string | null;
}

export interface MomentRepository {
  upsertDetectedMoments(
    tournamentId: string,
    moments: readonly TournamentMomentFacts[],
    audit: MomentAuditEvent,
  ): Promise<boolean>;
  listCompletedTournamentIdsMissingGeneration(
    versions: MomentGenerationVersions,
  ): Promise<string[]>;
  getAdminMoment(momentId: string): Promise<AdminMomentRecord | null>;
  listAdminMoments(tournamentId: string): Promise<AdminMomentRecord[]>;
  upsertPublication(
    input: MomentPublicationMutation,
    expectedRevision: number | null,
    audit: MomentAuditEvent,
  ): Promise<AdminMomentRecord>;
  listPublishedRecords(tournamentId: string): Promise<AdminMomentRecord[]>;
  listPublishedRecordsForPlayers(
    playerIds: readonly string[],
    limit: number,
  ): Promise<AdminMomentRecord[]>;
  publishedIndexCursorExists(momentId: string): Promise<boolean>;
  listPublishedIndexRecords(input: PublishedMomentIndexQuery): Promise<AdminMomentRecord[]>;
  getPublishedRecordBySlug(slug: string): Promise<AdminMomentRecord | null>;
}

export interface MomentGenerationVersions {
  factsVersion: string;
  detectorVersion: string;
  scoringVersion: string;
  broadcastViewVersion: string;
  equityVersion: string;
}

export interface PublishedMomentIndexCursor {
  momentId: string;
}

export interface PublishedMomentIndexQuery {
  limit: number;
  tag: MomentTag | null;
  cursor: PublishedMomentIndexCursor | null;
}

export type MomentAuditAction =
  | "tournament_moments.generate"
  | "moment_publication.update"
  | "moment_publication.publish"
  | "moment_publication.hide";

export interface MomentAuditEvent {
  adminUserId: string | null;
  action: MomentAuditAction;
  targetType: "tournament" | "tournament_moment";
  targetId: string;
  metadata: Record<string, unknown>;
}

function generationVersionsFromAudit(audit: MomentAuditEvent): MomentGenerationVersions {
  const versions = audit.metadata;
  const keys = [
    "factsVersion",
    "detectorVersion",
    "scoringVersion",
    "broadcastViewVersion",
    "equityVersion",
  ] as const;
  for (const key of keys) {
    if (typeof versions[key] !== "string" || versions[key].length === 0) {
      throw new Error(`Moment generation audit is missing ${key}`);
    }
  }
  return {
    factsVersion: versions.factsVersion as string,
    detectorVersion: versions.detectorVersion as string,
    scoringVersion: versions.scoringVersion as string,
    broadcastViewVersion: versions.broadcastViewVersion as string,
    equityVersion: versions.equityVersion as string,
  };
}

const CURRENT_GENERATION_PREDICATE = `(
  exists (
    select 1
      from tournament_moments current_moment
     where current_moment.tournament_id = $1::uuid
       and current_moment.superseded_at is null
       and current_moment.facts_version = $2
       and current_moment.detector_version = $3
       and current_moment.scoring_version = $4
       and current_moment.broadcast_view_version = $5
       and current_moment.equity_version = $6
  )
  or exists (
    select 1
      from audit_events generation_audit
     where generation_audit.action = 'tournament_moments.generate'
       and generation_audit.target_type = 'tournament'
       and generation_audit.target_id = $1::text
       and generation_audit.metadata->>'factsVersion' = $2
       and generation_audit.metadata->>'detectorVersion' = $3
       and generation_audit.metadata->>'scoringVersion' = $4
       and generation_audit.metadata->>'broadcastViewVersion' = $5
       and generation_audit.metadata->>'equityVersion' = $6
  )
)`;

const MISSING_CURRENT_GENERATION_PREDICATE = `not (
  exists (
    select 1
      from tournament_moments current_moment
     where current_moment.tournament_id = t.id
       and current_moment.superseded_at is null
       and current_moment.facts_version = $1
       and current_moment.detector_version = $2
       and current_moment.scoring_version = $3
       and current_moment.broadcast_view_version = $4
       and current_moment.equity_version = $5
  )
  or exists (
    select 1
      from audit_events generation_audit
     where generation_audit.action = 'tournament_moments.generate'
       and generation_audit.target_type = 'tournament'
       and generation_audit.target_id = t.id::text
       and generation_audit.metadata->>'factsVersion' = $1
       and generation_audit.metadata->>'detectorVersion' = $2
       and generation_audit.metadata->>'scoringVersion' = $3
       and generation_audit.metadata->>'broadcastViewVersion' = $4
       and generation_audit.metadata->>'equityVersion' = $5
  )
)`;

function generationParameters(
  tournamentId: string,
  versions: MomentGenerationVersions,
): string[] {
  return [
    tournamentId,
    versions.factsVersion,
    versions.detectorVersion,
    versions.scoringVersion,
    versions.broadcastViewVersion,
    versions.equityVersion,
  ];
}

export class MomentPublicationRevisionConflictError extends Error {
  constructor() {
    super("Moment publication changed; refresh before saving again");
    this.name = "MomentPublicationRevisionConflictError";
  }
}

export class MomentSupersededPublicationError extends Error {
  constructor() {
    super("A superseded candidate cannot be published for the first time");
    this.name = "MomentSupersededPublicationError";
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: MomentJoinRow): AdminMomentRecord {
  const facts = storedTournamentMomentFactsSchema.parse(row.facts);
  const publication = row.publication_status === null
    ? null
    : momentPublicationSchema.parse({
      momentId: facts.id,
      status: row.publication_status,
      slug: row.slug,
      titleZh: row.title_zh,
      titleEn: row.title_en,
      summaryZh: row.summary_zh,
      summaryEn: row.summary_en,
      coverSequence: row.cover_sequence === null ? null : Number(row.cover_sequence),
      playbackStartSequence: row.playback_start_sequence === null ? null : Number(row.playback_start_sequence),
      playbackEndSequence: row.playback_end_sequence === null ? null : Number(row.playback_end_sequence),
      spoilerMode: row.spoiler_mode,
      isPrimary: row.is_primary,
      revision: row.publication_revision,
      createdByAdminUserId: row.created_by_admin_user_id,
      publishedAt: row.published_at === null ? null : iso(row.published_at),
      createdAt: iso(row.publication_created_at!),
      updatedAt: iso(row.publication_updated_at!),
    });
  return adminMomentRecordSchema.parse({
    facts,
    publication,
    supersededAt: row.superseded_at === null ? null : iso(row.superseded_at),
  });
}

async function appendAudit(client: PoolClient, audit: MomentAuditEvent): Promise<void> {
  await client.query(
    `insert into audit_events (id, admin_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      randomUUID(),
      audit.adminUserId,
      audit.action,
      audit.targetType,
      audit.targetId,
      JSON.stringify(audit.metadata),
    ],
  );
}

const JOIN_SELECT = `
  select m.facts, m.superseded_at,
         p.status as publication_status, p.slug, p.title_zh, p.title_en,
         p.summary_zh, p.summary_en, p.cover_sequence,
         p.playback_start_sequence, p.playback_end_sequence,
         p.spoiler_mode, p.is_primary, p.publication_revision,
         p.created_by_admin_user_id, p.published_at,
         p.created_at as publication_created_at,
         p.updated_at as publication_updated_at
    from tournament_moments m
    left join moment_publications p on p.moment_id = m.id`;

async function upsertMoment(client: PoolClient, moment: TournamentMomentFacts): Promise<void> {
  await client.query(
    `insert into tournament_moments
       (id, tournament_id, hand_no, start_sequence, focus_sequence, end_sequence,
        facts_version, detector_version, scoring_version, broadcast_view_version,
        equity_version, source_event_hash, source_event_count,
        source_start_event_hash, source_end_event_hash, score, score_breakdown,
        recommendation_rank, primary_tag, tags, facts)
     values
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20::jsonb, $21::jsonb)
     on conflict (id) do update
       set start_sequence = excluded.start_sequence,
           focus_sequence = excluded.focus_sequence,
           end_sequence = excluded.end_sequence,
           facts_version = excluded.facts_version,
           detector_version = excluded.detector_version,
           scoring_version = excluded.scoring_version,
           broadcast_view_version = excluded.broadcast_view_version,
           equity_version = excluded.equity_version,
           source_event_hash = excluded.source_event_hash,
           source_event_count = excluded.source_event_count,
           source_start_event_hash = excluded.source_start_event_hash,
           source_end_event_hash = excluded.source_end_event_hash,
           score = excluded.score,
           score_breakdown = excluded.score_breakdown,
           recommendation_rank = excluded.recommendation_rank,
           primary_tag = excluded.primary_tag,
           tags = excluded.tags,
           facts = excluded.facts,
           superseded_at = null,
           updated_at = now()
       where tournament_moments.tournament_id = excluded.tournament_id
         and tournament_moments.hand_no = excluded.hand_no
         and tournament_moments.detector_version = excluded.detector_version
         and not exists (
           select 1 from moment_publications p
            where p.moment_id = tournament_moments.id
              and p.published_at is not null
         )`,
    [
      moment.id,
      moment.tournamentId,
      moment.handNo,
      moment.startSequence,
      moment.focusSequence,
      moment.endSequence,
      moment.factsVersion,
      moment.detectorVersion,
      moment.scoringVersion,
      moment.broadcastViewVersion,
      moment.equityVersion,
      moment.source.eventHash,
      moment.source.eventCount,
      moment.source.startEventHash,
      moment.source.endEventHash,
      moment.score,
      JSON.stringify(moment.scoreBreakdown),
      moment.recommendationRank,
      moment.primaryTag,
      JSON.stringify(moment.tags),
      JSON.stringify(moment),
    ],
  );
}

export class PgMomentRepository implements MomentRepository {
  constructor(private readonly pool: Pool) {}

  async upsertDetectedMoments(
    tournamentId: string,
    moments: readonly TournamentMomentFacts[],
    audit: MomentAuditEvent,
  ): Promise<boolean> {
    if (audit.action !== "tournament_moments.generate"
      || audit.targetType !== "tournament"
      || audit.targetId !== tournamentId) {
      throw new Error("Moment generation audit target does not match its tournament");
    }
    if (audit.metadata.trigger === "AUTO" ? audit.adminUserId !== null : (
      audit.metadata.trigger !== "ADMIN" || audit.adminUserId === null
    )) {
      throw new Error("Moment generation audit provenance does not match its trigger");
    }
    const parsed = moments.map((moment) => tournamentMomentFactsSchema.parse(moment));
    const versions = generationVersionsFromAudit(audit);
    if (parsed.some((moment) => (
      moment.factsVersion !== versions.factsVersion
      || moment.detectorVersion !== versions.detectorVersion
      || moment.scoringVersion !== versions.scoringVersion
      || moment.broadcastViewVersion !== versions.broadcastViewVersion
      || moment.equityVersion !== versions.equityVersion
    ))) {
      throw new Error("Moment generation audit versions do not match its candidates");
    }
    const tournamentIds = new Set(parsed.map((moment) => moment.tournamentId));
    if (tournamentIds.size > 1 || (tournamentIds.size === 1 && !tournamentIds.has(tournamentId))) {
      throw new Error("A moment upsert batch must belong to the requested tournament");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const tournament = await client.query(
        "select id from tournaments where id = $1 for update",
        [tournamentId],
      );
      if (tournament.rowCount !== 1) throw new Error(`Unknown tournament: ${tournamentId}`);
      if (audit.metadata.trigger === "AUTO") {
        const existing = await client.query<{ generated: boolean }>(
          `select ${CURRENT_GENERATION_PREDICATE} as generated`,
          generationParameters(tournamentId, versions),
        );
        if (existing.rows[0]?.generated === true) {
          await client.query("commit");
          return false;
        }
      }
      for (const moment of parsed) await upsertMoment(client, moment);
      await client.query(
        `update tournament_moments
            set superseded_at = now(), updated_at = now()
          where tournament_id = $1
            and superseded_at is null
            and id <> all($2::uuid[])`,
        [tournamentId, parsed.map((moment) => moment.id)],
      );
      await appendAudit(client, {
        ...audit,
        metadata: {
          ...audit.metadata,
          factsVersion: versions.factsVersion,
          detectorVersion: versions.detectorVersion,
          scoringVersion: versions.scoringVersion,
          broadcastViewVersion: versions.broadcastViewVersion,
          equityVersion: versions.equityVersion,
          candidateCount: parsed.length,
          recommendedCount: parsed.filter((moment) => moment.recommendationRank !== null).length,
        },
      });
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listCompletedTournamentIdsMissingGeneration(
    versions: MomentGenerationVersions,
  ): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `select t.id
         from tournaments t
        where t.status = 'COMPLETED'
          and ${MISSING_CURRENT_GENERATION_PREDICATE}
        order by t.created_at, t.id`,
      [
        versions.factsVersion,
        versions.detectorVersion,
        versions.scoringVersion,
        versions.broadcastViewVersion,
        versions.equityVersion,
      ],
    );
    return result.rows.map((row) => row.id);
  }

  async getAdminMoment(momentId: string): Promise<AdminMomentRecord | null> {
    const result = await this.pool.query<MomentJoinRow>(
      `${JOIN_SELECT} where m.id = $1`,
      [momentId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listAdminMoments(tournamentId: string): Promise<AdminMomentRecord[]> {
    const result = await this.pool.query<MomentJoinRow>(
      `${JOIN_SELECT}
        where m.tournament_id = $1
          and (m.superseded_at is null or p.moment_id is not null)
        order by (m.superseded_at is not null),
                 m.recommendation_rank nulls last, m.score desc, m.hand_no`,
      [tournamentId],
    );
    return result.rows.map(mapRow);
  }

  async upsertPublication(
    input: MomentPublicationMutation,
    expectedRevision: number | null,
    audit: MomentAuditEvent,
  ): Promise<AdminMomentRecord> {
    if (audit.action === "tournament_moments.generate"
      || audit.targetType !== "tournament_moment"
      || audit.targetId !== input.momentId) {
      throw new Error("Moment publication audit target does not match its moment");
    }
    if (audit.adminUserId === null) {
      throw new Error("Moment publication audit requires administrator provenance");
    }
    const client = await this.pool.connect();
    let saved: AdminMomentRecord | null = null;
    let displacedPrimaryMomentIds: string[] = [];
    try {
      await client.query("begin");
      const tournament = await client.query(
        `select t.id
           from tournaments t
           join tournament_moments m on m.tournament_id = t.id
          where m.id = $1
          for update of t`,
        [input.momentId],
      );
      if (tournament.rowCount !== 1) throw new Error(`Unknown moment: ${input.momentId}`);
      // This must be a separate statement. Under READ COMMITTED a publisher
      // may wait on the tournament lock while a rebuild supersedes the
      // candidate; a fresh statement snapshot is required after that wait.
      const candidate = await client.query<{
        superseded_at: Date | null;
        published_at: Date | null;
      }>(
        `select m.superseded_at, p.published_at
           from tournament_moments m
           left join moment_publications p on p.moment_id = m.id
          where m.id = $1`,
        [input.momentId],
      );
      if (candidate.rowCount !== 1) throw new Error(`Unknown moment: ${input.momentId}`);
      if (input.status === "PUBLISHED"
        && candidate.rows[0]?.superseded_at !== null
        && candidate.rows[0]?.published_at == null) {
        throw new MomentSupersededPublicationError();
      }
      if (input.status === "PUBLISHED" && input.isPrimary) {
        // Lock the parent tournament so concurrent administrators cannot leave
        // two primary publications behind. The later committed choice wins.
        const displaced = await client.query<{ moment_id: string }>(
          `update moment_publications p
              set is_primary = false,
                  publication_revision = p.publication_revision + 1,
                  updated_at = now()
             from tournament_moments selected, tournament_moments sibling
            where selected.id = $1
              and sibling.tournament_id = selected.tournament_id
              and p.moment_id = sibling.id
              and p.moment_id <> selected.id
              and p.is_primary = true
          returning p.moment_id`,
          [input.momentId],
        );
        displacedPrimaryMomentIds = displaced.rows.map((row) => row.moment_id).sort();
      }
      const persisted = await client.query(
        `insert into moment_publications
           (moment_id, status, slug, title_zh, title_en, summary_zh, summary_en,
            cover_sequence, playback_start_sequence, playback_end_sequence,
            spoiler_mode, is_primary, created_by_admin_user_id, published_at)
         values
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            case when $2 = 'PUBLISHED' then now() else null end)
         on conflict (moment_id) do update
           set status = excluded.status,
               slug = excluded.slug,
               title_zh = excluded.title_zh,
               title_en = excluded.title_en,
               summary_zh = excluded.summary_zh,
               summary_en = excluded.summary_en,
               cover_sequence = excluded.cover_sequence,
               playback_start_sequence = excluded.playback_start_sequence,
               playback_end_sequence = excluded.playback_end_sequence,
               spoiler_mode = excluded.spoiler_mode,
               is_primary = excluded.is_primary,
               publication_revision = moment_publications.publication_revision + 1,
               published_at = case
                 when excluded.status = 'PUBLISHED' then coalesce(moment_publications.published_at, now())
                 else moment_publications.published_at
               end,
               updated_at = now()
         where moment_publications.publication_revision = $14
         returning moment_id`,
        [
          input.momentId,
          input.status,
          input.slug,
          input.titleZh,
          input.titleEn,
          input.summaryZh,
          input.summaryEn,
          input.coverSequence,
          input.playbackStartSequence,
          input.playbackEndSequence,
          input.spoilerMode,
          input.isPrimary,
          input.createdByAdminUserId,
          expectedRevision,
        ],
      );
      if (persisted.rowCount !== 1) throw new MomentPublicationRevisionConflictError();
      const selected = await client.query<MomentJoinRow>(
        `${JOIN_SELECT} where m.id = $1`,
        [input.momentId],
      );
      saved = selected.rows[0] ? mapRow(selected.rows[0]) : null;
      if (!saved?.publication) {
        throw new Error(`Moment publication was not persisted: ${input.momentId}`);
      }
      await appendAudit(client, {
        ...audit,
        metadata: {
          ...audit.metadata,
          tournamentId: saved.facts.tournamentId,
          status: saved.publication.status,
          publicationRevision: saved.publication.revision,
          slug: saved.publication.slug,
          ...(displacedPrimaryMomentIds.length > 0 ? { displacedPrimaryMomentIds } : {}),
        },
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    if (!saved?.publication) throw new Error(`Moment publication was not persisted: ${input.momentId}`);
    return saved;
  }

  async listPublishedRecords(tournamentId: string): Promise<AdminMomentRecord[]> {
    const result = await this.pool.query<MomentJoinRow>(
      `${JOIN_SELECT}
        where m.tournament_id = $1 and p.status = 'PUBLISHED'
        order by p.is_primary desc, m.recommendation_rank nulls last,
                 p.published_at desc, m.hand_no`,
      [tournamentId],
    );
    return result.rows.map(mapRow);
  }

  async listPublishedRecordsForPlayers(
    playerIds: readonly string[],
    limit: number,
  ): Promise<AdminMomentRecord[]> {
    if (playerIds.length === 0) return [];
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 12);
    const result = await this.pool.query<MomentJoinRow>(
      `${JOIN_SELECT}
        where p.status = 'PUBLISHED'
          and (m.facts->'featuredPlayerIds') ?| $1::text[]
        order by p.published_at desc, m.score desc, m.hand_no
        limit $2`,
      [[...new Set(playerIds)], boundedLimit],
    );
    return result.rows.map(mapRow);
  }

  async listPublishedIndexRecords(input: PublishedMomentIndexQuery): Promise<AdminMomentRecord[]> {
    const result = await this.pool.query<MomentJoinRow>(
      `${JOIN_SELECT}
        where p.status = 'PUBLISHED'
          and ($1::text is null or m.tags ? ($1::text))
          and (
            $2::uuid is null
            or (p.published_at, m.id) < (
              select boundary.published_at, boundary.moment_id
                from moment_publications boundary
               where boundary.moment_id = $2::uuid
            )
          )
        order by p.published_at desc, m.id desc
        limit $3`,
      [
        input.tag,
        input.cursor?.momentId ?? null,
        input.limit,
      ],
    );
    return result.rows.map(mapRow);
  }

  async publishedIndexCursorExists(momentId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `select exists (
         select 1
           from moment_publications
          where moment_id = $1 and published_at is not null
       ) as exists`,
      [momentId],
    );
    return result.rows[0]?.exists === true;
  }

  async getPublishedRecordBySlug(slug: string): Promise<AdminMomentRecord | null> {
    const result = await this.pool.query<MomentJoinRow>(
      `${JOIN_SELECT} where lower(p.slug) = lower($1) and p.status = 'PUBLISHED'`,
      [slug],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}
