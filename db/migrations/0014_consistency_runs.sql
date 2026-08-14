create table consistency_runs (
  id uuid primary key,
  model_config_id uuid not null references model_configs(id) on delete restrict,
  competitor_revision_id uuid not null references competitor_revisions(id) on delete restrict,
  system_prompt_version_id uuid not null references system_prompt_versions(id) on delete restrict,
  created_by_admin_user_id uuid references admin_users(id) on delete set null,
  status text not null check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED')),
  tier text not null check (tier in ('single', 'quick', 'standard', 'full')),
  scenario_registry_version text not null,
  scenario_ids jsonb not null,
  scenario_snapshots jsonb not null,
  sample_count integer not null check (sample_count between 1 and 30),
  total_samples integer not null check (total_samples between 1 and 600),
  completed_samples integer not null default 0 check (completed_samples between 0 and total_samples),
  protocol_bundle_id text not null,
  model_configuration_hash text not null,
  system_prompt_hash text not null,
  output_schema_hash text not null,
  effective_output_mode text not null,
  timeout_ms integer not null check (timeout_ms between 30000 and 600000),
  execution_mode text not null default 'serial' check (execution_mode = 'serial'),
  summary jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(scenario_ids) = 'array'),
  check (jsonb_array_length(scenario_ids) >= 1),
  check (jsonb_typeof(scenario_snapshots) = 'array'),
  check (model_configuration_hash ~ '^[a-f0-9]{64}$'),
  check (system_prompt_hash ~ '^[a-f0-9]{64}$'),
  check (output_schema_hash ~ '^[a-f0-9]{64}$')
);

create unique index one_open_consistency_run_per_model
  on consistency_runs (model_config_id)
  where status in ('QUEUED', 'RUNNING');

create index consistency_runs_recent
  on consistency_runs (created_at desc);

create index consistency_runs_by_model
  on consistency_runs (model_config_id, created_at desc);

create table consistency_samples (
  id uuid primary key,
  run_id uuid not null references consistency_runs(id) on delete restrict,
  scenario_id text not null,
  sample_index integer not null check (sample_index between 1 and 30),
  outcome text not null check (outcome in ('VALID_ACTION', 'INVALID_DECISION', 'PROTOCOL_ERROR', 'INFRA_ERROR')),
  action text check (action is null or action in ('fold', 'check', 'call', 'bet', 'raise', 'all_in')),
  amount_to integer,
  decision_summary text,
  parsed_output jsonb,
  raw_text text,
  error_kind text,
  error_message text,
  latency_ms integer not null check (latency_ms >= 0),
  usage jsonb,
  transport_audit jsonb,
  visible_input_hash text not null,
  created_at timestamptz not null default now(),
  unique (run_id, scenario_id, sample_index),
  check (visible_input_hash ~ '^[a-f0-9]{64}$'),
  check (amount_to is null or amount_to >= 0)
);

create index consistency_samples_by_run
  on consistency_samples (run_id, scenario_id, sample_index);
