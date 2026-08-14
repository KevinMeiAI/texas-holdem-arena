create table consistency_batches (
  id uuid primary key,
  system_prompt_version_id uuid not null references system_prompt_versions(id) on delete restrict,
  created_by_admin_user_id uuid references admin_users(id) on delete set null,
  tier text not null check (tier in ('single', 'quick', 'standard', 'full')),
  scenario_registry_version text not null,
  scenario_ids jsonb not null,
  scenario_snapshots jsonb not null,
  model_config_ids jsonb not null,
  sample_count integer not null check (sample_count between 1 and 30),
  timeout_ms integer not null check (timeout_ms between 30000 and 600000),
  max_parallel_models integer not null default 3 check (max_parallel_models between 1 and 3),
  protocol_bundle_id text not null,
  system_prompt_hash text not null,
  output_schema_hash text not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(scenario_ids) = 'array'),
  check (jsonb_array_length(scenario_ids) >= 1),
  check (jsonb_typeof(scenario_snapshots) = 'array'),
  check (jsonb_typeof(model_config_ids) = 'array'),
  check (jsonb_array_length(model_config_ids) between 2 and 9),
  check (system_prompt_hash ~ '^[a-f0-9]{64}$'),
  check (output_schema_hash ~ '^[a-f0-9]{64}$')
);

alter table consistency_runs
  add column batch_id uuid references consistency_batches(id) on delete restrict;

create index consistency_batches_recent
  on consistency_batches (created_at desc);

create index consistency_runs_by_batch
  on consistency_runs (batch_id, created_at)
  where batch_id is not null;
