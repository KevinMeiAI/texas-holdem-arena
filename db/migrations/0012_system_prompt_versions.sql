create table system_prompt_versions (
  id uuid primary key,
  name text not null,
  runtime_version text not null,
  protocol_bundle_id text not null,
  system_prompt text not null,
  system_prompt_sha256 text not null,
  source text not null check (source in ('BUNDLED', 'CUSTOM', 'HISTORICAL')),
  status text not null check (status in ('ACTIVE', 'ARCHIVED')),
  created_by_admin_user_id uuid references admin_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(name) between 1 and 120),
  check (char_length(runtime_version) between 1 and 200),
  check (char_length(system_prompt) between 1 and 100000),
  check (system_prompt_sha256 ~ '^[a-f0-9]{64}$')
);

create unique index system_prompt_versions_content_bundle
  on system_prompt_versions (system_prompt_sha256, protocol_bundle_id);

create index system_prompt_versions_recent
  on system_prompt_versions (status, created_at desc);

alter table tournaments
  add column system_prompt_version_id uuid references system_prompt_versions(id) on delete restrict;

alter table benchmark_series
  add column system_prompt_version_id uuid references system_prompt_versions(id) on delete restrict;

create index tournaments_by_system_prompt_version
  on tournaments (system_prompt_version_id, created_at desc)
  where system_prompt_version_id is not null;

create or replace function protect_system_prompt_version_content()
returns trigger language plpgsql as $$
begin
  if new.name is distinct from old.name
     or new.runtime_version is distinct from old.runtime_version
     or new.protocol_bundle_id is distinct from old.protocol_bundle_id
     or new.system_prompt is distinct from old.system_prompt
     or new.system_prompt_sha256 is distinct from old.system_prompt_sha256
     or new.source is distinct from old.source
     or new.created_by_admin_user_id is distinct from old.created_by_admin_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'system prompt version content is immutable';
  end if;
  return new;
end;
$$;

create trigger system_prompt_version_content_is_immutable
before update on system_prompt_versions
for each row execute function protect_system_prompt_version_content();

create or replace function prevent_system_prompt_version_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'system prompt versions cannot be deleted; archive custom versions instead';
end;
$$;

create trigger system_prompt_versions_are_never_deleted
before delete on system_prompt_versions
for each row execute function prevent_system_prompt_version_delete();
