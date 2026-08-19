import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type CompetitorFamilyStatus = "ACTIVE" | "RETIRED";

interface CompetitorFamilyRow {
  id: string;
  display_name: string;
  status: CompetitorFamilyStatus;
  linked_model_config_count: string;
  available_model_config_count: string;
  revision_count: string;
  created_at: Date;
  updated_at: Date;
}

interface CompetitorRevisionIdentityRow {
  revision_id: string;
  revision_number: number;
  model_config_id: string;
  competitor_family_id: string;
  competitor_display_name: string;
  current_family_display_name: string;
  family_status: CompetitorFamilyStatus;
  is_current_revision: boolean;
  model_config_archived: boolean;
  created_at: Date;
}

export interface CompetitorFamilyDto {
  id: string;
  displayName: string;
  status: CompetitorFamilyStatus;
  linkedModelConfigCount: number;
  availableModelConfigCount: number;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompetitorRevisionIdentityDto {
  revisionId: string;
  revisionNumber: number;
  modelConfigId: string;
  familyId: string;
  displayNameAtRevision: string;
  currentFamilyDisplayName: string;
  familyStatus: CompetitorFamilyStatus;
  isCurrentRevision: boolean;
  modelConfigArchived: boolean;
  createdAt: string;
}

function publicFamily(row: CompetitorFamilyRow): CompetitorFamilyDto {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    linkedModelConfigCount: Number(row.linked_model_config_count),
    availableModelConfigCount: Number(row.available_model_config_count),
    revisionCount: Number(row.revision_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function publicRevisionIdentity(
  row: CompetitorRevisionIdentityRow,
): CompetitorRevisionIdentityDto {
  return {
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    modelConfigId: row.model_config_id,
    familyId: row.competitor_family_id,
    displayNameAtRevision: row.competitor_display_name,
    currentFamilyDisplayName: row.current_family_display_name,
    familyStatus: row.family_status,
    isCurrentRevision: row.is_current_revision,
    modelConfigArchived: row.model_config_archived,
    createdAt: row.created_at.toISOString(),
  };
}

function normalizedDisplayName(value: string): string {
  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > 120) {
    throw new Error("Competitor family display name must contain 1 to 120 characters");
  }
  return displayName;
}

const FAMILY_SELECT = `select f.*,
  count(distinct m.id)::text as linked_model_config_count,
  count(distinct m.id) filter (
    where m.deleted_at is null and m.enabled = true
  )::text as available_model_config_count,
  count(distinct r.id)::text as revision_count
  from competitor_families f
  left join model_configs m on m.competitor_family_id = f.id
  left join competitor_revisions r on r.competitor_family_id = f.id`;

/**
 * Maintains stable competitor identities separately from mutable runtime model
 * configuration. Public callers receive identity metadata only: provider
 * credentials, endpoints, parameters, and decision payloads are never selected.
 */
export class CompetitorIdentityService {
  constructor(private readonly pool: Pool) {}

  async createFamily(displayName: string): Promise<CompetitorFamilyDto> {
    const id = randomUUID();
    await this.pool.query(
      `insert into competitor_families (id, display_name)
       values ($1, $2)`,
      [id, normalizedDisplayName(displayName)],
    );
    const family = await this.getFamily(id);
    if (!family) throw new Error("Created competitor family could not be read back");
    return family;
  }

  async renameFamily(id: string, displayName: string): Promise<CompetitorFamilyDto | null> {
    const result = await this.pool.query<{ id: string }>(
      `update competitor_families
          set display_name = $2, updated_at = now()
        where id = $1
        returning id`,
      [id, normalizedDisplayName(displayName)],
    );
    return result.rows[0] ? this.getFamily(id) : null;
  }

  async setFamilyStatus(
    id: string,
    status: CompetitorFamilyStatus,
  ): Promise<CompetitorFamilyDto | null> {
    const result = await this.pool.query<{ id: string }>(
      `update competitor_families
          set status = $2, updated_at = now()
        where id = $1
        returning id`,
      [id, status],
    );
    return result.rows[0] ? this.getFamily(id) : null;
  }

  async getFamily(id: string): Promise<CompetitorFamilyDto | null> {
    const result = await this.pool.query<CompetitorFamilyRow>(
      `${FAMILY_SELECT}
        where f.id = $1
        group by f.id`,
      [id],
    );
    return result.rows[0] ? publicFamily(result.rows[0]) : null;
  }

  async getRevisionIdentity(
    revisionId: string,
  ): Promise<CompetitorRevisionIdentityDto | null> {
    const result = await this.pool.query<CompetitorRevisionIdentityRow>(
      `select r.id as revision_id,
              r.revision_number,
              r.model_config_id,
              r.competitor_family_id,
              r.competitor_display_name,
              f.display_name as current_family_display_name,
              f.status as family_status,
              (m.current_revision_id = r.id) as is_current_revision,
              (m.deleted_at is not null) as model_config_archived,
              r.created_at
         from competitor_revisions r
         join competitor_families f on f.id = r.competitor_family_id
         join model_configs m on m.id = r.model_config_id
        where r.id = $1`,
      [revisionId],
    );
    return result.rows[0] ? publicRevisionIdentity(result.rows[0]) : null;
  }
}
