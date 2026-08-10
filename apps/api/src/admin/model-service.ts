import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
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
  model_id: string;
  parameters: Record<string, unknown>;
  output_mode: ModelOutputMode;
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
    timeoutMs: 90_000,
    parameters: row.parameters,
  });
  return {
    id: row.id,
    displayName: row.display_name,
    providerConnectionId: row.provider_connection_id,
    providerLabel: row.provider_label,
    providerType: row.provider_type,
    providerProfile: row.provider_profile,
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

export class ModelConfigService {
  constructor(private readonly pool: Pool, private readonly masterKey: Uint8Array) {}

  async listProviders() {
    const result = await this.pool.query<ProviderRow>("select * from provider_connections order by created_at");
    return result.rows.map(publicProvider);
  }

  async getProvider(id: string) {
    const result = await this.pool.query<ProviderRow>(
      "select * from provider_connections where id = $1",
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
    const result = await this.pool.query<ProviderRow>(
      `update provider_connections
          set label = coalesce($2, label),
              provider_type = coalesce($3, provider_type),
              provider_profile = coalesce($4, provider_profile),
              default_output_mode = coalesce($5, default_output_mode),
              base_url = case when $6::boolean then $7 else base_url end,
              encrypted_api_key = case when $8::boolean then $9::jsonb else encrypted_api_key end,
              key_last_four = case when $8::boolean then $10 else key_last_four end,
              updated_at = now()
        where id = $1
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
    return result.rows[0] ? publicProvider(result.rows[0]) : null;
  }

  async deleteProvider(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from provider_connections where id = $1", [id]);
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
    await this.pool.query(
      `insert into model_configs
        (id, display_name, provider_connection_id, model_id, parameters, output_mode)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [id, input.displayName, input.providerConnectionId, input.modelId, JSON.stringify(input.parameters), input.outputMode],
    );
    return this.getModel(id);
  }

  async updateModel(id: string, input: ModelConfigUpdate) {
    const result = await this.pool.query<ModelRow>(
      `update model_configs
          set display_name = coalesce($2, display_name),
              provider_connection_id = coalesce($3, provider_connection_id),
              model_id = coalesce($4, model_id),
              parameters = case when $5::boolean then $6::jsonb else parameters end,
              enabled = coalesce($7, enabled),
              output_mode = coalesce($8, output_mode),
              updated_at = now()
        where id = $1
        returning *,
          (select label from provider_connections where id = model_configs.provider_connection_id) as provider_label,
          (select provider_type from provider_connections where id = model_configs.provider_connection_id) as provider_type,
          (select provider_profile from provider_connections where id = model_configs.provider_connection_id) as provider_profile,
          (select default_output_mode from provider_connections where id = model_configs.provider_connection_id) as default_output_mode`,
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
    return result.rows[0] ? publicModel(result.rows[0]) : null;
  }

  async listModels() {
    const result = await this.pool.query<ModelRow>(
      `select m.*, p.label as provider_label, p.provider_type, p.provider_profile, p.default_output_mode
         from model_configs m join provider_connections p on p.id = m.provider_connection_id
        order by m.created_at`,
    );
    return result.rows.map(publicModel);
  }

  async getModel(id: string) {
    const result = await this.pool.query<ModelRow>(
      `select m.*, p.label as provider_label, p.provider_type, p.provider_profile, p.default_output_mode
         from model_configs m join provider_connections p on p.id = m.provider_connection_id
        where m.id = $1`,
      [id],
    );
    return result.rows[0] ? publicModel(result.rows[0]) : null;
  }

  async deleteModel(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from model_configs where id = $1", [id]);
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
        where m.id = $1 and m.enabled = true`,
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
      timeoutMs: 90_000,
      parameters: row.parameters,
    };
  }

  async providerRuntimeConfig(
    providerConnectionId: string,
    modelId: string,
    parameters: Record<string, unknown> = {},
  ): Promise<FrozenModelConfig> {
    const result = await this.pool.query<ProviderRow>(
      "select * from provider_connections where id = $1",
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
      timeoutMs: 90_000,
      parameters,
    };
  }
}
