create table decision_resume_states (
  decision_id uuid primary key references decision_requests(id) on delete cascade,
  encrypted_state jsonb not null,
  state_hash text not null,
  updated_at timestamptz not null default now(),
  check (state_hash ~ '^[a-f0-9]{64}$')
);

create table decision_turns (
  decision_id uuid not null references decision_requests(id) on delete cascade,
  turn_index integer not null,
  request_hash text not null,
  encrypted_request jsonb not null,
  response_hash text,
  encrypted_response jsonb,
  outcome text not null check (outcome in ('SUCCESS', 'PROTOCOL_ERROR', 'INFRA_ERROR')),
  error_kind text,
  provider_config_hash text not null,
  output_schema_version text not null,
  output_schema_hash text not null,
  latency_ms integer,
  usage jsonb,
  created_at timestamptz not null default now(),
  primary key (decision_id, turn_index),
  check (turn_index >= 1),
  check (request_hash ~ '^[a-f0-9]{64}$'),
  check (response_hash is null or response_hash ~ '^[a-f0-9]{64}$'),
  check (provider_config_hash ~ '^[a-f0-9]{64}$'),
  check (output_schema_hash ~ '^[a-f0-9]{64}$'),
  check (latency_ms is null or latency_ms >= 0),
  check ((response_hash is null) = (encrypted_response is null))
);

create index decision_turns_by_decision
  on decision_turns (decision_id, turn_index);
