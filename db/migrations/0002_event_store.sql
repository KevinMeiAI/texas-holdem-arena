create table tournaments (
  id uuid primary key,
  name text not null,
  status text not null check (status in ('DRAFT', 'PREFLIGHT', 'READY', 'RUNNING', 'PAUSED_INFRA', 'COMPLETED', 'CANCELLED')),
  ruleset_version text not null,
  prompt_hash text,
  configuration jsonb not null default '{}'::jsonb,
  aggregate_version bigint not null default 0,
  next_event_sequence bigint not null default 1,
  last_event_hash text not null default repeat('0', 64),
  public_state jsonb not null default '{}'::jsonb,
  champion_player_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (aggregate_version >= 0),
  check (next_event_sequence >= 1),
  check (last_event_hash ~ '^[a-f0-9]{64}$')
);

create unique index one_active_tournament
  on tournaments ((true))
  where status in ('RUNNING', 'PAUSED_INFRA');

create table arena_events (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  sequence bigint not null,
  aggregate_version bigint not null,
  event_type text not null,
  actor_id text,
  hand_no integer,
  public_payload jsonb not null,
  encrypted_private_payload jsonb,
  private_visibility text not null check (private_visibility in ('NONE', 'PLAYER_HOLE_CARDS', 'ADMIN_AUDIT')),
  private_owner_id text,
  prev_hash text not null,
  event_hash text not null,
  created_at timestamptz not null default now(),
  primary key (tournament_id, sequence),
  unique (tournament_id, aggregate_version),
  check (sequence >= 1),
  check (aggregate_version >= 1),
  check (hand_no is null or hand_no >= 1),
  check (prev_hash ~ '^[a-f0-9]{64}$'),
  check (event_hash ~ '^[a-f0-9]{64}$'),
  check ((encrypted_private_payload is null and private_visibility = 'NONE') or encrypted_private_payload is not null),
  check (private_visibility <> 'PLAYER_HOLE_CARDS' or (private_owner_id is not null and hand_no is not null))
);

create index arena_events_by_hand
  on arena_events (tournament_id, hand_no, sequence)
  where hand_no is not null;

create table state_snapshots (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  event_sequence bigint not null,
  aggregate_version bigint not null,
  public_state jsonb not null,
  encrypted_private_state jsonb not null,
  checksum text not null,
  created_at timestamptz not null default now(),
  primary key (tournament_id, event_sequence),
  unique (tournament_id, aggregate_version),
  check (checksum ~ '^[a-f0-9]{64}$')
);

create table decision_requests (
  id uuid primary key,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  hand_no integer not null,
  player_id text not null,
  expected_aggregate_version bigint not null,
  request_kind text not null check (request_kind in ('ACTION', 'RUNOUT_VOTE')),
  status text not null check (status in ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'PROTOCOL_FAILED', 'INFRA_FAILED', 'CANCELLED')),
  prompt_hash text not null,
  idempotency_key text not null,
  attempt_count integer not null default 0,
  final_response jsonb,
  last_error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, idempotency_key),
  check (attempt_count >= 0)
);

create index pending_decision_requests
  on decision_requests (tournament_id, created_at)
  where status in ('PENDING', 'IN_FLIGHT', 'INFRA_FAILED');
