-- Hand forks are isolated counterfactual decision experiments. They reference
-- an audited tournament decision but never write to the authoritative event
-- stream, tournament state, ratings, or leaderboard inputs.
create table hand_forks (
  id uuid primary key,
  source_tournament_id uuid not null references tournaments(id) on delete restrict,
  source_decision_id uuid not null references decision_requests(id) on delete restrict,
  source_hand_no integer not null check (source_hand_no >= 1),
  source_player_id text not null check (char_length(source_player_id) between 1 and 200),
  source_expected_aggregate_version bigint not null check (source_expected_aggregate_version >= 1),
  source_action_event_sequence bigint not null check (source_action_event_sequence >= 1),
  source_event_hash text not null check (source_event_hash ~ '^[a-f0-9]{64}$'),
  source_request_hash text not null check (source_request_hash ~ '^[a-f0-9]{64}$'),
  source_payload_hash text not null check (source_payload_hash ~ '^[a-f0-9]{64}$'),
  encrypted_source_payload jsonb not null,
  visible_input_hash text not null check (visible_input_hash ~ '^[a-f0-9]{64}$'),
  legal_contract_hash text not null check (legal_contract_hash ~ '^[a-f0-9]{64}$'),
  protocol_bundle_id text not null check (char_length(protocol_bundle_id) between 1 and 160),
  ruleset_version text not null check (char_length(ruleset_version) between 1 and 160),
  context_version text not null check (char_length(context_version) between 1 and 160),
  system_prompt_hash text not null check (system_prompt_hash ~ '^[a-f0-9]{64}$'),
  output_schema_hash text not null check (output_schema_hash ~ '^[a-f0-9]{64}$'),
  parser_policy_version text not null check (char_length(parser_policy_version) between 1 and 160),
  adapter_protocol_version text not null check (char_length(adapter_protocol_version) between 1 and 160),
  history_protocol_version text not null check (char_length(history_protocol_version) between 1 and 160),
  correction_protocol_version text not null check (char_length(correction_protocol_version) between 1 and 160),
  history_budget jsonb not null check (jsonb_typeof(history_budget) = 'object'),
  status text not null check (status in (
    'QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'
  )),
  sample_count integer not null check (sample_count between 1 and 20),
  timeout_ms integer not null check (timeout_ms between 30000 and 600000),
  max_parallel_targets integer not null default 3 check (max_parallel_targets between 1 and 3),
  target_count integer not null check (target_count between 1 and 9),
  summary jsonb,
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  created_by_admin_user_id uuid references admin_users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(encrypted_source_payload) = 'object'),
  check (summary is null or jsonb_typeof(summary) = 'object'),
  check ((status in ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')) = (completed_at is not null)),
  check (status not in ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED') or summary is not null),
  check (status <> 'RUNNING' or started_at is not null),
  check (status <> 'QUEUED' or started_at is null)
);

create index hand_forks_recent on hand_forks (created_at desc);
create index hand_forks_by_source on hand_forks (source_tournament_id, source_hand_no, created_at desc);
create index hand_forks_runnable on hand_forks (created_at, id)
  where status in ('QUEUED', 'RUNNING');

create table hand_fork_targets (
  id uuid primary key,
  fork_id uuid not null references hand_forks(id) on delete restrict,
  ordinal integer not null check (ordinal between 1 and 9),
  model_config_id uuid not null references model_configs(id) on delete restrict,
  competitor_revision_id uuid not null references competitor_revisions(id) on delete restrict,
  sample_count integer not null check (sample_count between 1 and 20),
  model_configuration_hash text not null check (model_configuration_hash ~ '^[a-f0-9]{64}$'),
  effective_output_mode text not null check (char_length(effective_output_mode) between 1 and 80),
  status text not null check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  terminal_trials integer not null default 0 check (terminal_trials between 0 and sample_count),
  summary jsonb,
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  worker_id text check (worker_id is null or char_length(worker_id) between 1 and 200),
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fork_id, id),
  unique (fork_id, ordinal),
  unique (fork_id, model_config_id),
  unique (fork_id, competitor_revision_id),
  check (summary is null or jsonb_typeof(summary) = 'object'),
  check ((status = 'RUNNING') = (
    worker_id is not null and lease_token is not null and lease_expires_at is not null
  )),
  check (status = 'RUNNING' or (
    worker_id is null and lease_token is null and lease_expires_at is null
  )),
  check (status <> 'RUNNING' or started_at is not null),
  check ((status in ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at is not null)),
  check (status not in ('COMPLETED', 'FAILED', 'CANCELLED') or summary is not null),
  check (status <> 'COMPLETED' or terminal_trials = sample_count)
);

create index hand_fork_targets_by_fork on hand_fork_targets (fork_id, ordinal);
create index hand_fork_targets_claimable on hand_fork_targets (created_at, fork_id, ordinal)
  where status = 'QUEUED';
create index hand_fork_targets_expired_leases on hand_fork_targets (lease_expires_at)
  where status = 'RUNNING';

create table hand_fork_trials (
  id uuid primary key,
  fork_id uuid not null,
  target_id uuid not null,
  sample_index integer not null check (sample_index between 1 and 20),
  status text not null check (status in ('RUNNING', 'COMPLETED', 'CANCELLED')),
  outcome text check (outcome is null or outcome in (
    'MODEL_ACTION', 'PROTOCOL_FALLBACK', 'INFRA_ERROR', 'CANCELLED'
  )),
  action text check (action is null or action in ('fold', 'check', 'call', 'bet', 'raise', 'all_in')),
  amount_to integer check (amount_to is null or amount_to > 0),
  decision_summary text check (decision_summary is null or char_length(decision_summary) <= 300),
  used_fallback boolean not null default false,
  first_turn_valid boolean not null default false,
  history_query_count integer not null default 0 check (history_query_count >= 0),
  protocol_failures integer not null default 0 check (protocol_failures >= 0),
  infrastructure_failures integer not null default 0 check (infrastructure_failures >= 0),
  call_count integer not null default 0 check (call_count >= 0),
  total_latency_ms integer check (total_latency_ms is null or total_latency_ms >= 0),
  usage jsonb,
  visible_input_hash text not null check (visible_input_hash ~ '^[a-f0-9]{64}$'),
  error_kind text check (error_kind is null or char_length(error_kind) <= 120),
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  encrypted_resume_state jsonb,
  resume_state_hash text,
  encrypted_result jsonb,
  result_hash text,
  completion_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (fork_id, target_id, id),
  unique (target_id, sample_index),
  foreign key (fork_id, target_id) references hand_fork_targets(fork_id, id) on delete restrict,
  check (usage is null or jsonb_typeof(usage) = 'object'),
  check ((resume_state_hash is null) = (encrypted_resume_state is null)),
  check (encrypted_resume_state is null or jsonb_typeof(encrypted_resume_state) = 'object'),
  check (resume_state_hash is null or resume_state_hash ~ '^[a-f0-9]{64}$'),
  check ((result_hash is null) = (encrypted_result is null)),
  check (encrypted_result is null or jsonb_typeof(encrypted_result) = 'object'),
  check (result_hash is null or result_hash ~ '^[a-f0-9]{64}$'),
  check (completion_hash is null or completion_hash ~ '^[a-f0-9]{64}$'),
  check (coalesce(action in ('bet', 'raise'), false) = (amount_to is not null)),
  check ((status in ('COMPLETED', 'CANCELLED')) = (completed_at is not null)),
  check (status <> 'RUNNING' or outcome is null),
  check ((status = 'COMPLETED') = (completion_hash is not null)),
  check (status <> 'COMPLETED' or (outcome is not null and encrypted_result is not null)),
  check (status <> 'CANCELLED' or (
    outcome = 'CANCELLED' and encrypted_result is null and completion_hash is null
  )),
  check (outcome <> 'MODEL_ACTION' or (action is not null and used_fallback = false)),
  check (outcome <> 'PROTOCOL_FALLBACK' or (action is not null and used_fallback = true)),
  check (outcome not in ('INFRA_ERROR', 'CANCELLED') or (action is null and used_fallback = false)),
  check (coalesce(outcome in ('MODEL_ACTION', 'PROTOCOL_FALLBACK'), false) = (action is not null)),
  check (coalesce(outcome = 'PROTOCOL_FALLBACK', false) = used_fallback)
);

create index hand_fork_trials_by_target on hand_fork_trials (target_id, sample_index);
create index hand_fork_trials_running on hand_fork_trials (target_id, sample_index)
  where status = 'RUNNING';

create table hand_fork_turns (
  fork_id uuid not null,
  target_id uuid not null,
  trial_id uuid not null,
  turn_index integer not null check (turn_index >= 1),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  encrypted_request jsonb not null,
  response_hash text,
  encrypted_response jsonb,
  outcome text not null check (outcome in ('SUCCESS', 'PROTOCOL_ERROR', 'INFRA_ERROR')),
  error_kind text check (error_kind is null or char_length(error_kind) <= 120),
  provider_config_hash text not null check (provider_config_hash ~ '^[a-f0-9]{64}$'),
  output_schema_version text not null check (char_length(output_schema_version) between 1 and 160),
  output_schema_hash text not null check (output_schema_hash ~ '^[a-f0-9]{64}$'),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  usage jsonb,
  adapter_version text check (adapter_version is null or char_length(adapter_version) <= 160),
  rendered_user_text_hash text,
  redacted_wire_body_hash text,
  applied_output_mode text check (applied_output_mode is null or char_length(applied_output_mode) <= 80),
  applied_schema_hash text,
  finish_reason text check (finish_reason is null or char_length(finish_reason) <= 160),
  refusal_hash text,
  encrypted_refusal jsonb,
  response_model text check (response_model is null or char_length(response_model) <= 200),
  system_fingerprint text check (system_fingerprint is null or char_length(system_fingerprint) <= 200),
  created_at timestamptz not null default now(),
  primary key (trial_id, turn_index),
  foreign key (fork_id, target_id, trial_id)
    references hand_fork_trials(fork_id, target_id, id) on delete restrict,
  check ((response_hash is null) = (encrypted_response is null)),
  check (response_hash is null or response_hash ~ '^[a-f0-9]{64}$'),
  check (jsonb_typeof(encrypted_request) = 'object'),
  check (encrypted_response is null or jsonb_typeof(encrypted_response) = 'object'),
  check ((refusal_hash is null) = (encrypted_refusal is null)),
  check (refusal_hash is null or refusal_hash ~ '^[a-f0-9]{64}$'),
  check (encrypted_refusal is null or jsonb_typeof(encrypted_refusal) = 'object'),
  check (usage is null or jsonb_typeof(usage) = 'object'),
  check (rendered_user_text_hash is null or rendered_user_text_hash ~ '^[a-f0-9]{64}$'),
  check (redacted_wire_body_hash is null or redacted_wire_body_hash ~ '^[a-f0-9]{64}$'),
  check (applied_schema_hash is null or applied_schema_hash ~ '^[a-f0-9]{64}$')
);

create index hand_fork_turns_by_target on hand_fork_turns (target_id, trial_id, turn_index);
