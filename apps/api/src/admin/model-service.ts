import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  FrozenModelConfig,
  ModelOutputMode,
  OutputMode,
  ProviderKind,
  ProviderProfile,
} from "../../../../packages/providers/src/provider.js";
import { inspectOutputPolicy } from "../../../../packages/providers/src/output-policy.js";
import { encryptedPayloadSchema } from "../../../../packages/contracts/src/events.js";
import { decryptJson, encryptJson } from "../security/encryption.js";
import { ARENA_DECISION_TIMEOUT_MS } from "../model-runtime.js";
import { canonicalJson } from "../../../../packages/fairness/src/canonical-json.js";

interface ProviderRow {
  id: string;
  label: string;
  provider_type: ProviderKind;
  provider_profile: ProviderProfile;
  default_output_mode: OutputMode;
  base_url: string | null;
  encrypted_api_key: unknown | null;
  key_last_four: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ModelRow {
  id: string;
  display_name: string;
  provider_connection_id: string;
  provider_label: string;
  provider_type: ProviderKind;
  provider_profile: ProviderProfile;
  default_output_mode: OutputMode;
  base_url: string | null;
  model_id: string;
  parameters: Record<string, unknown>;
  output_mode: ModelOutputMode;
  current_revision_id: string;
  revision_number: number;
  configuration_hash: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderConnectionInput {
  label: string;
  providerType: ProviderKind;
  providerProfile: ProviderProfile;
  defaultOutputMode: OutputMode;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface ProviderConnectionUpdate {
  label?: string | undefined;
  providerType?: ProviderKind | undefined;
  providerProfile?: ProviderProfile | undefined;
  defaultOutputMode?: OutputMode | undefined;
  baseUrl?: string | null | undefined;
  apiKey?: string | null | undefined;
}

export interface ModelConfigUpdate {
  displayName?: string | undefined;
  providerConnectionId?: string | undefined;
  modelId?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
  outputMode?: ModelOutputMode | undefined;
  enabled?: boolean | undefined;
}

export class ProviderConnectionNotFoundError extends Error {
  constructor() {
    super("Provider connection not found");
    this.name = "ProviderConnectionNotFoundError";
  }
}

async function requireActiveProvider(client: PoolClient, id: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    "select id from provider_connections where id = $1 and deleted_at is null",
    [id],
  );
  if (!result.rows[0]) throw new ProviderConnectionNotFoundError();
}

function providerAad(id: string): string {
  return `arena:provider:${id}:api-key`;
}

function publicProvider(row: ProviderRow) {
  return {
    id: row.id,
    label: row.label,
    providerType: row.provider_type,
    providerProfile: row.provider_profile,
    defaultOutputMode: row.default_output_mode,
    baseUrl: row.base_url,
    hasApiKey: row.encrypted_api_key !== null,
    keyLastFour: row.key_last_four,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function publicModel(row: ModelRow) {
  const policy = inspectOutputPolicy({
    provider: row.provider_type,
    providerProfile: row.provider_profile,
    providerDefaultOutputMode: row.default_output_mode,
    outputMode: row.output_mode,
    model: row.model_id,
    timeoutMs: ARENA_DECISION_TIMEOUT_MS,
    parameters: row.parameters,
  });
  return {
    id: row.id,
    revisionId: row.current_revision_id,
    revisionNumber: row.revision_number,
    configurationHash: row.configuration_hash,
    displayName: row.display_name,
    providerConnectionId: row.provider_connection_id,
    providerLabel: row.provider_label,
    providerType: row.provider_type,
    providerProfile: row.provider_profile,
    providerBaseUrl: row.base_url,
    providerDefaultOutputMode: row.default_output_mode,
    modelId: row.model_id,
    parameters: row.parameters,
    outputMode: row.output_mode,
    effectiveOutputMode: policy.effectiveMode,
    effectiveProviderProfile: policy.effectiveProviderProfile,
    outputModeSupported: policy.supported,
    outputModeMessage: policy.message,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface RevisionIdentity {
  providerConnectionId: string;
  providerType: ProviderKind;
  providerProfile: ProviderProfile;
  providerDefaultOutputMode: OutputMode;
  baseUrl: string | null;
  modelId: string;
  parameters: Record<string, unknown>;
  outputMode: ModelOutputMode;
}

function revisionHash(identity: RevisionIdentity): string {
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

async function createRevision(
  client: PoolClient,
  modelConfigId: string,
  revisionId: string,
): Promise<void> {
  const result = await client.query<ProviderRow & {
    model_id: string;
    parameters: Record<string, unknown>;
    output_mode: ModelOutputMode;
    provider_connection_id: string;
  }>(
    `select p.*, m.model_id, m.parameters, m.output_mode, m.provider_connection_id
       from model_configs m join provider_connections p on p.id = m.provider_connection_id
      where m.id = $1 and m.deleted_at is null and p.deleted_at is null`,
    [modelConfigId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Model configuration not found");
  const identity: RevisionIdentity = {
    providerConnectionId: row.provider_connection_id,
    providerType: row.provider_type,
    providerProfile: row.provider_profile,
    providerDefaultOutputMode: row.default_output_mode,
    baseUrl: row.base_url,
    modelId: row.model_id,
    parameters: row.parameters,
    outputMode: row.output_mode,
  };
  const configurationHash = revisionHash(identity);
  const existing = await client.query<{ id: string }>(
    `select id from competitor_revisions
      where model_config_id = $1 and configuration_hash = $2`,
    [modelConfigId, configurationHash],
  );
  if (existing.rows[0]) {
    await client.query(
      "update model_configs set current_revision_id = $2 where id = $1",
      [modelConfigId, existing.rows[0].id],
    );
    return;
  }
  await client.query(
    `insert into competitor_revisions
      (id, model_config_id, revision_number, provider_connection_id, provider_type,
       provider_profile, provider_default_output_mode, base_url, model_id, parameters,
       output_mode, configuration_hash)
     select $2, $1, coalesce(max(revision_number), 0) + 1, $3, $4, $5, $6, $7, $8,
            $9::jsonb, $10, $11
       from competitor_revisions where model_config_id = $1`,
    [
      modelConfigId,
      revisionId,
      identity.providerConnectionId,
      identity.providerType,
      identity.providerProfile,
      identity.providerDefaultOutputMode,
      identity.baseUrl,
      identity.modelId,
      JSON.stringify(identity.parameters),
      identity.outputMode,
      configurationHash,
    ],
  );
  await client.query(
    "update model_configs set current_revision_id = $2 where id = $1",
    [modelConfigId, revisionId],
  );
}

const MODEL_SELECT = `select m.*, p.label as provider_label, p.provider_type,
  p.provider_profile, p.default_output_mode, p.base_url, r.revision_number, r.configuration_hash
  from model_configs m join provider_connections p on p.id = m.provider_connection_id
  join competitor_revisions r on r.id = m.current_revision_id`;

export class ModelConfigService {
  constructor(private readonly pool: Pool, private readonly masterKey: Uint8Array) {}

  async listProviders() {
    const result = await this.pool.query<ProviderRow>(
      "select * from provider_connections where deleted_at is null order by created_at",
    );
    return result.rows.map(publicProvider);
  }

  async getProvider(id: string) {
    const result = await this.pool.query<ProviderRow>(
      "select * from provider_connections where id = $1 and deleted_at is null",
      [id],
    );
    return result.rows[0] ? publicProvider(result.rows[0]) : null;
  }

  async createProvider(input: ProviderConnectionInput) {
    const id = randomUUID();
    const encrypted = input.apiKey ? encryptJson(input.apiKey, this.masterKey, providerAad(id)) : null;
    const result = await this.pool.query<ProviderRow>(
      `insert into provider_connections
        (id, label, provider_type, provider_profile, default_output_mode, base_url, encrypted_api_key, key_last_four)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning *`,
      [
        id,
        input.label,
        input.providerType,
        input.providerProfile,
        input.defaultOutputMode,
        input.baseUrl ?? null,
        encrypted ? JSON.stringify(encrypted) : null,
        input.apiKey ? input.apiKey.slice(-4) : null,
      ],
    );
    return publicProvider(result.rows[0]!);
  }

  async updateProvider(id: string, input: ProviderConnectionUpdate) {
    const apiKeyWasProvided = Object.hasOwn(input, "apiKey");
    const apiKey = input.apiKey || null;
    const encrypted = apiKey ? encryptJson(apiKey, this.masterKey, providerAad(id)) : null;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ProviderRow>(
      `update provider_connections
          set label = coalesce($2, label),
              provider_type = coalesce($3, provider_type),
              provider_profile = coalesce($4, provider_profile),
              default_output_mode = coalesce($5, default_output_mode),
              base_url = case when $6::boolean then $7 else base_url end,
              encrypted_api_key = case when $8::boolean then $9::jsonb else encrypted_api_key end,
              key_last_four = case when $8::boolean then $10 else key_last_four end,
              updated_at = now()
        where id = $1 and deleted_at is null
        returning *`,
      [
        id,
        input.label ?? null,
        input.providerType ?? null,
        input.providerProfile ?? null,
        input.defaultOutputMode ?? null,
        Object.hasOwn(input, "baseUrl"),
        input.baseUrl ?? null,
        apiKeyWasProvided,
        encrypted ? JSON.stringify(encrypted) : null,
        apiKey ? apiKey.slice(-4) : null,
      ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("rollback");
        return null;
      }
      const identityChanged = input.providerType !== undefined
        || input.providerProfile !== undefined
        || input.defaultOutputMode !== undefined
        || input.baseUrl !== undefined;
      if (identityChanged) {
        const models = await client.query<{ id: string }>(
          `select id from model_configs
            where provider_connection_id = $1 and deleted_at is null
            order by id for update`,
          [id],
        );
        for (const model of models.rows) await createRevision(client, model.id, randomUUID());
      }
      if (apiKeyWasProvided) {
        await client.query(
          `delete from provider_preflight_cache
            where configuration_hash in (
              select configuration_hash from competitor_revisions
               where provider_connection_id = $1
            )`,
          [id],
        );
      }
      await client.query("commit");
      return publicProvider(row);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteProvider(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `update provider_connections p
          set deleted_at = now(), updated_at = now()
        where p.id = $1 and p.deleted_at is null
          and not exists (
            select 1 from model_configs m
             where m.provider_connection_id = p.id and m.deleted_at is null
          )`,
      [id],
    );
    return result.rowCount === 1;
  }

  async createModel(input: {
    displayName: string;
    providerConnectionId: string;
    modelId: string;
    parameters: Record<string, unknown>;
    outputMode: ModelOutputMode;
  }) {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await requireActiveProvider(client, input.providerConnectionId);
      await client.query(
        `insert into model_configs
          (id, display_name, provider_connection_id, model_id, parameters, output_mode, current_revision_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $1)`,
        [id, input.displayName, input.providerConnectionId, input.modelId, JSON.stringify(input.parameters), input.outputMode],
      );
      await createRevision(client, id, id);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return this.getModel(id);
  }

  async updateModel(id: string, input: ModelConfigUpdate) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (input.providerConnectionId !== undefined) {
        await requireActiveProvider(client, input.providerConnectionId);
      }
      const identityChanged = input.providerConnectionId !== undefined
        || input.modelId !== undefined
        || input.parameters !== undefined
        || input.outputMode !== undefined;
      const result = await client.query<ModelRow>(
      `update model_configs
          set display_name = coalesce($2, display_name),
              provider_connection_id = coalesce($3, provider_connection_id),
              model_id = coalesce($4, model_id),
              parameters = case when $5::boolean then $6::jsonb else parameters end,
              enabled = coalesce($7, enabled),
              output_mode = coalesce($8, output_mode),
              updated_at = now()
        where id = $1 and deleted_at is null
        returning *`,
      [
        id,
        input.displayName ?? null,
        input.providerConnectionId ?? null,
        input.modelId ?? null,
        Object.hasOwn(input, "parameters"),
        JSON.stringify(input.parameters ?? {}),
        input.enabled ?? null,
        input.outputMode ?? null,
      ],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return null;
      }
      if (identityChanged) await createRevision(client, id, randomUUID());
      await client.query("commit");
      return this.getModel(id);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listModels() {
    const result = await this.pool.query<ModelRow>(
      `${MODEL_SELECT}
        where m.deleted_at is null and p.deleted_at is null
        order by m.created_at`,
    );
    return result.rows.map(publicModel);
  }

  async getModel(id: string) {
    const result = await this.pool.query<ModelRow>(
      `${MODEL_SELECT}
        where m.id = $1 and m.deleted_at is null and p.deleted_at is null`,
      [id],
    );
    return result.rows[0] ? publicModel(result.rows[0]) : null;
  }

  async deleteModel(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `update model_configs
          set enabled = false, deleted_at = now(), updated_at = now()
        where id = $1 and deleted_at is null`,
      [id],
    );
    return result.rowCount === 1;
  }

  async runtimeConfig(modelConfigId: string): Promise<FrozenModelConfig> {
    const result = await this.pool.query<ProviderRow & {
      model_id: string;
      parameters: Record<string, unknown>;
      output_mode: ModelOutputMode;
    }>(
      `select p.*, m.model_id, m.parameters, m.output_mode
         from model_configs m join provider_connections p on p.id = m.provider_connection_id
        where m.id = $1 and m.enabled = true
          and m.deleted_at is null and p.deleted_at is null`,
      [modelConfigId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Model configuration not found or disabled");
    const apiKey = row.encrypted_api_key
      ? decryptJson(encryptedPayloadSchema.parse(row.encrypted_api_key), this.masterKey, providerAad(row.id))
      : undefined;
    return {
      provider: row.provider_type,
      providerProfile: row.provider_profile,
      providerDefaultOutputMode: row.default_output_mode,
      outputMode: row.output_mode,
      model: row.model_id,
      ...(typeof apiKey === "string" ? { apiKey } : {}),
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      timeoutMs: ARENA_DECISION_TIMEOUT_MS,
      parameters: row.parameters,
    };
  }

  async runtimeConfigForRevision(revisionId: string): Promise<FrozenModelConfig> {
    const result = await this.pool.query<ProviderRow & {
      model_id: string;
      parameters: Record<string, unknown>;
      output_mode: ModelOutputMode;
      revision_base_url: string | null;
      secret_provider_connection_id: string;
    }>(
      `select p.*, r.model_id, r.parameters, r.output_mode, r.base_url as revision_base_url,
              p.id as secret_provider_connection_id,
              r.provider_type, r.provider_profile,
              r.provider_default_output_mode as default_output_mode
         from competitor_revisions r
         join model_configs m on m.id = r.model_config_id
         join provider_connections p on p.id = r.provider_connection_id
        where r.id = $1`,
      [revisionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Competitor revision not found or disabled");
    const apiKey = row.encrypted_api_key
      ? decryptJson(encryptedPayloadSchema.parse(row.encrypted_api_key), this.masterKey, providerAad(row.secret_provider_connection_id))
      : undefined;
    return {
      provider: row.provider_type,
      providerProfile: row.provider_profile,
      providerDefaultOutputMode: row.default_output_mode,
      outputMode: row.output_mode,
      model: row.model_id,
      ...(typeof apiKey === "string" ? { apiKey } : {}),
      ...(row.revision_base_url ? { baseUrl: row.revision_base_url } : {}),
      timeoutMs: ARENA_DECISION_TIMEOUT_MS,
      parameters: row.parameters,
    };
  }

  async currentRevision(modelConfigId: string) {
    const result = await this.pool.query<ModelRow>(
      `${MODEL_SELECT} where m.id = $1 and m.enabled = true
        and m.deleted_at is null and p.deleted_at is null`,
      [modelConfigId],
    );
    return result.rows[0] ? publicModel(result.rows[0]) : null;
  }

  async revisionDetails(revisionIds: readonly string[]) {
    if (revisionIds.length === 0) return [];
    const result = await this.pool.query<ModelRow>(
      `select m.*, r.id as current_revision_id, p.label as provider_label,
              r.provider_type, r.provider_profile,
              r.provider_default_output_mode as default_output_mode,
              r.base_url,
              r.model_id, r.parameters, r.output_mode, r.revision_number,
              r.configuration_hash
         from competitor_revisions r
         join model_configs m on m.id = r.model_config_id
         join provider_connections p on p.id = r.provider_connection_id
        where r.id = any($1::uuid[])
        order by array_position($1::uuid[], r.id)`,
      [revisionIds],
    );
    return result.rows.map(publicModel);
  }

  async providerRuntimeConfig(
    providerConnectionId: string,
    modelId: string,
    parameters: Record<string, unknown> = {},
  ): Promise<FrozenModelConfig> {
    const result = await this.pool.query<ProviderRow>(
      "select * from provider_connections where id = $1 and deleted_at is null",
      [providerConnectionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Provider connection not found");
    const apiKey = row.encrypted_api_key
      ? decryptJson(encryptedPayloadSchema.parse(row.encrypted_api_key), this.masterKey, providerAad(row.id))
      : undefined;
    return {
      provider: row.provider_type,
      providerProfile: row.provider_profile,
      providerDefaultOutputMode: row.default_output_mode,
      outputMode: "inherit",
      model: modelId,
      ...(typeof apiKey === "string" ? { apiKey } : {}),
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      timeoutMs: ARENA_DECISION_TIMEOUT_MS,
      parameters,
    };
  }
}
