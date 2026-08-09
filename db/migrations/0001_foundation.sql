create table if not exists arena_metadata (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into arena_metadata (key, value)
values ('application', '{"name":"Texas Holdem Arena","schemaVersion":1}'::jsonb)
on conflict (key) do nothing;
