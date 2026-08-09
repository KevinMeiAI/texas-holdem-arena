create table admin_users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  csrf_token_hash text not null,
  expires_at timestamptz not null,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index sessions_by_admin on sessions (admin_user_id, expires_at);

create table provider_connections (
  id uuid primary key,
  label text not null,
  provider_type text not null check (provider_type in ('openai-responses', 'anthropic-messages', 'google-gemini', 'openai-compatible', 'mock-scripted')),
  base_url text,
  encrypted_api_key jsonb,
  key_last_four text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table model_configs (
  id uuid primary key,
  display_name text not null,
  provider_connection_id uuid not null references provider_connections(id) on delete restrict,
  model_id text not null,
  parameters jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index model_configs_by_provider on model_configs (provider_connection_id);

create table audit_events (
  id uuid primary key,
  admin_user_id uuid references admin_users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_recent on audit_events (created_at desc);
