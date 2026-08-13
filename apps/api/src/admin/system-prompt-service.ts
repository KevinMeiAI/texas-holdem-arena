import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  buildEffectiveSystemPrompt,
  CURRENT_DECISION_PROTOCOL_BUNDLE_ID,
  decisionProtocolBundle,
  type EffectiveSystemPrompt,
} from "../../../../packages/contracts/src/index.js";
import { PgEventStore } from "../persistence/event-store.js";

export type SystemPromptSource = "BUNDLED" | "CUSTOM" | "HISTORICAL";
export type SystemPromptStatus = "ACTIVE" | "ARCHIVED";

interface SystemPromptRow {
  id: string;
  name: string;
  runtime_version: string;
  protocol_bundle_id: string;
  system_prompt: string;
  system_prompt_sha256: string;
  source: SystemPromptSource;
  status: SystemPromptStatus;
  created_by_admin_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  tournament_count?: string;
  series_count?: string;
}

export interface SystemPromptVersion {
  id: string;
  name: string;
  runtimeVersion: string;
  protocolBundleId: string;
  systemPrompt: string;
  sha256: string;
  source: SystemPromptSource;
  status: SystemPromptStatus;
  isDefault: boolean;
  tournamentCount: number;
  seriesCount: number;
  createdByAdminUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function systemPromptVersionIdentity(
  systemPrompt: string,
  protocolBundleId: string,
): { sha256: string; id: string } {
  const hash = sha256(systemPrompt);
  const identityHash = sha256(`${protocolBundleId}\0${systemPrompt}`);
  const hex = identityHash.slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return {
    sha256: hash,
    id: `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`,
  };
}

function publicVersion(row: SystemPromptRow): SystemPromptVersion {
  return {
    id: row.id,
    name: row.name,
    runtimeVersion: row.runtime_version,
    protocolBundleId: row.protocol_bundle_id,
    systemPrompt: row.system_prompt,
    sha256: row.system_prompt_sha256,
    source: row.source,
    status: row.status,
    isDefault: row.protocol_bundle_id === CURRENT_DECISION_PROTOCOL_BUNDLE_ID
      && row.runtime_version === decisionProtocolBundle().systemPromptVersion
      && row.source === "BUNDLED",
    tournamentCount: Number(row.tournament_count ?? 0),
    seriesCount: Number(row.series_count ?? 0),
    createdByAdminUserId: row.created_by_admin_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function frozenPrompt(version: SystemPromptVersion): EffectiveSystemPrompt {
  const calculated = sha256(version.systemPrompt);
  if (calculated !== version.sha256) throw new Error("Stored system prompt hash does not match its content");
  return { version: version.runtimeVersion, text: version.systemPrompt, sha256: version.sha256 };
}

export class SystemPromptVersionService {
  readonly #store: PgEventStore;

  constructor(
    private readonly pool: Pool,
    masterKey: Uint8Array,
  ) {
    this.#store = new PgEventStore(pool, masterKey);
  }

  async syncCatalog(): Promise<void> {
    await this.#ensureBundledVersions();
    await this.#linkKnownTournamentHashes();
    await this.#importHistoricalTournamentPrompts();
    await this.#linkSeriesVersions();
  }

  async list(): Promise<SystemPromptVersion[]> {
    await this.#ensureBundledVersions();
    const result = await this.pool.query<SystemPromptRow>(
      `select p.*,
              (select count(*)::text from tournaments t where t.system_prompt_version_id = p.id) as tournament_count,
              (select count(*)::text from benchmark_series s where s.system_prompt_version_id = p.id) as series_count
         from system_prompt_versions p
        order by (p.status = 'ACTIVE') desc,
                 (p.source = 'BUNDLED' and p.runtime_version = $1) desc,
                 p.created_at desc`,
      [decisionProtocolBundle().systemPromptVersion],
    );
    return result.rows.map(publicVersion);
  }

  async get(id: string): Promise<SystemPromptVersion | null> {
    await this.#ensureBundledVersions();
    const result = await this.pool.query<SystemPromptRow>(
      `select p.*,
              (select count(*)::text from tournaments t where t.system_prompt_version_id = p.id) as tournament_count,
              (select count(*)::text from benchmark_series s where s.system_prompt_version_id = p.id) as series_count
         from system_prompt_versions p where p.id = $1`,
      [id],
    );
    return result.rows[0] ? publicVersion(result.rows[0]) : null;
  }

  async resolve(id?: string): Promise<{ version: SystemPromptVersion; prompt: EffectiveSystemPrompt }> {
    await this.#ensureBundledVersions();
    const selected = id
      ? await this.get(id)
      : (await this.list()).find((version) => version.isDefault) ?? null;
    if (!selected) throw new Error("System prompt version not found");
    return { version: selected, prompt: frozenPrompt(selected) };
  }

  async create(input: {
    name: string;
    systemPrompt: string;
    protocolBundleId?: string | undefined;
    adminUserId: string;
  }): Promise<SystemPromptVersion> {
    const name = input.name.trim();
    const systemPrompt = input.systemPrompt;
    if (name.length < 1 || name.length > 120) throw new Error("System prompt version name must contain 1 to 120 characters");
    if (systemPrompt.trim().length < 1 || systemPrompt.length > 100_000) throw new Error("System prompt must contain 1 to 100,000 characters");
    const protocolBundleId = input.protocolBundleId ?? CURRENT_DECISION_PROTOCOL_BUNDLE_ID;
    decisionProtocolBundle(protocolBundleId);
    const hash = sha256(systemPrompt);
    const existing = await this.pool.query<{ id: string }>(
      `select id from system_prompt_versions
        where system_prompt_sha256 = $1 and protocol_bundle_id = $2`,
      [hash, protocolBundleId],
    );
    if (existing.rows[0]) throw new Error(`This exact system prompt is already saved as version ${existing.rows[0].id}`);
    const id = randomUUID();
    await this.pool.query(
      `insert into system_prompt_versions
        (id, name, runtime_version, protocol_bundle_id, system_prompt,
         system_prompt_sha256, source, status, created_by_admin_user_id)
       values ($1, $2, $3, $4, $5, $6, 'CUSTOM', 'ACTIVE', $7)`,
      [id, name, `arena-system-custom/${id}`, protocolBundleId, systemPrompt, hash, input.adminUserId],
    );
    return (await this.get(id))!;
  }

  async setArchived(id: string, archived: boolean): Promise<SystemPromptVersion | null> {
    const result = await this.pool.query<{ source: SystemPromptSource }>(
      "select source from system_prompt_versions where id = $1",
      [id],
    );
    if (!result.rows[0]) return null;
    if (result.rows[0].source !== "CUSTOM") throw new Error("Bundled and historical prompt versions are read-only");
    await this.pool.query(
      "update system_prompt_versions set status = $2, updated_at = now() where id = $1",
      [id, archived ? "ARCHIVED" : "ACTIVE"],
    );
    return this.get(id);
  }

  async #ensureBundledVersions(): Promise<void> {
    const bundled = [
      { bundleId: "arena-native-v10", name: "Arena System v10", status: "ACTIVE" as const },
      { bundleId: CURRENT_DECISION_PROTOCOL_BUNDLE_ID, name: "Arena System v11", status: "ACTIVE" as const },
    ];
    for (const item of bundled) {
      const bundle = decisionProtocolBundle(item.bundleId);
      const prompt = buildEffectiveSystemPrompt(bundle.systemPromptVersion);
      await this.pool.query(
        `insert into system_prompt_versions
          (id, name, runtime_version, protocol_bundle_id, system_prompt,
           system_prompt_sha256, source, status)
         values ($1, $2, $3, $4, $5, $6, 'BUNDLED', $7)
         on conflict (system_prompt_sha256, protocol_bundle_id) do nothing`,
        [systemPromptVersionIdentity(prompt.text, bundle.id).id, item.name, prompt.version, bundle.id, prompt.text, prompt.sha256, item.status],
      );
    }
  }

  async #linkKnownTournamentHashes(): Promise<void> {
    await this.pool.query(
      `update tournaments t
          set system_prompt_version_id = p.id
         from system_prompt_versions p
        where t.system_prompt_version_id is null
          and t.prompt_hash = p.system_prompt_sha256
          and t.protocol_bundle_id = p.protocol_bundle_id`,
    );
  }

  async #importHistoricalTournamentPrompts(): Promise<void> {
    const result = await this.pool.query<{ id: string; prompt_hash: string | null; protocol_bundle_id: string }>(
      `select id, prompt_hash, protocol_bundle_id from tournaments
        where system_prompt_version_id is null and prompt_hash is not null
        order by created_at`,
    );
    for (const tournament of result.rows) {
      const snapshot = await this.#store.loadLatestSnapshot(tournament.id);
      const privateState = snapshot?.privateState as {
        effectivePrompt?: unknown;
        protocolBundle?: { id?: unknown } | undefined;
      } | undefined;
      const effective = privateState?.effectivePrompt;
      if (!effective || typeof effective !== "object") continue;
      const prompt = effective as { version?: unknown; text?: unknown; sha256?: unknown };
      if (typeof prompt.text !== "string" || typeof prompt.sha256 !== "string"
        || sha256(prompt.text) !== prompt.sha256 || prompt.sha256 !== tournament.prompt_hash) continue;
      const snapshotProtocolBundleId = privateState?.protocolBundle?.id;
      const protocolBundleId = typeof snapshotProtocolBundleId === "string"
        ? snapshotProtocolBundleId
        : tournament.protocol_bundle_id;
      const id = systemPromptVersionIdentity(prompt.text, protocolBundleId).id;
      await this.pool.query(
        `insert into system_prompt_versions
          (id, name, runtime_version, protocol_bundle_id, system_prompt,
           system_prompt_sha256, source, status)
         values ($1, $2, $3, $4, $5, $6, 'HISTORICAL', 'ARCHIVED')
         on conflict (system_prompt_sha256, protocol_bundle_id) do nothing`,
        [
          id,
          `Historical Prompt · ${prompt.sha256.slice(0, 8)}`,
          typeof prompt.version === "string" ? prompt.version : `historical/${prompt.sha256.slice(0, 16)}`,
          protocolBundleId,
          prompt.text,
          prompt.sha256,
        ],
      );
      await this.pool.query(
        `update tournaments set system_prompt_version_id =
           (select id from system_prompt_versions
             where system_prompt_sha256 = $2 and protocol_bundle_id = $3)
          where id = $1 and system_prompt_version_id is null`,
        [tournament.id, prompt.sha256, protocolBundleId],
      );
    }
  }

  async #linkSeriesVersions(): Promise<void> {
    await this.pool.query(
      `update benchmark_series s
          set system_prompt_version_id = (
            select t.system_prompt_version_id
              from tournaments t
             where t.benchmark_series_id = s.id and t.system_prompt_version_id is not null
             order by t.benchmark_rotation limit 1
          )
        where s.system_prompt_version_id is null
          and exists (
            select 1 from tournaments t
             where t.benchmark_series_id = s.id and t.system_prompt_version_id is not null
          )`,
    );
  }
}
