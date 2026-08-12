create table benchmark_series (
  id uuid primary key,
  name text not null,
  status text not null check (status in ('READY', 'RUNNING', 'COMPLETED', 'CANCELLED')),
  protocol_bundle_id text not null,
  ruleset_version text not null,
  benchmark_track_id text not null,
  benchmark_cohort_id text not null,
  benchmark_track jsonb not null,
  competitor_revision_ids jsonb not null,
  competitor_labels jsonb not null,
  tournament_configuration jsonb not null,
  deal_schedule_id text not null,
  deal_schedule_version text not null,
  deal_schedule_commitment text not null,
  encrypted_deal_schedule jsonb not null,
  rotation_policy_version text not null,
  rotation_count integer not null,
  next_rotation integer not null default 0,
  revealed_deal_schedule_seed text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (rotation_count between 2 and 9),
  check (next_rotation between 0 and rotation_count)
);

create unique index one_open_benchmark_series
  on benchmark_series ((true))
  where status in ('READY', 'RUNNING');

alter table tournaments
  add column benchmark_series_id uuid references benchmark_series(id) on delete set null,
  add column benchmark_rotation integer;

create unique index benchmark_series_rotation
  on tournaments (benchmark_series_id, benchmark_rotation)
  where benchmark_series_id is not null;

drop index one_active_tournament;

create unique index one_active_tournament
  on tournaments ((true))
  where status in ('READY', 'RUNNING', 'PAUSED_INFRA');
