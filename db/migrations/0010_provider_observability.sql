alter table decision_turns
  add column adapter_version text,
  add column rendered_user_text_hash text,
  add column redacted_wire_body_hash text,
  add column applied_output_mode text,
  add column applied_schema_hash text,
  add column finish_reason text,
  add column refusal text,
  add column response_model text,
  add column system_fingerprint text,
  add check (rendered_user_text_hash is null or rendered_user_text_hash ~ '^[a-f0-9]{64}$'),
  add check (redacted_wire_body_hash is null or redacted_wire_body_hash ~ '^[a-f0-9]{64}$'),
  add check (applied_schema_hash is null or applied_schema_hash ~ '^[a-f0-9]{64}$');

create table provider_preflight_cache (
  configuration_hash text not null,
  protocol_bundle_id text not null,
  preflight_level text not null check (preflight_level in ('quick', 'full')),
  result jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (configuration_hash, protocol_bundle_id, preflight_level),
  check (configuration_hash ~ '^[a-f0-9]{64}$')
);
