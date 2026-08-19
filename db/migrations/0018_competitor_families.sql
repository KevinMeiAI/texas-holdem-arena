create table competitor_families (
  id uuid primary key,
  display_name text not null,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'RETIRED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index competitor_families_by_status
  on competitor_families (status, created_at);

-- Every pre-existing model configuration becomes its own stable competitor.
-- Reusing the model UUID makes this backfill deterministic and collision-free
-- without requiring a database UUID extension. A soft-deleted configuration is
-- represented by a retained, retired family rather than losing its history.
insert into competitor_families
  (id, display_name, status, created_at, updated_at)
select id,
       display_name,
       case when deleted_at is null then 'ACTIVE' else 'RETIRED' end,
       created_at,
       updated_at
  from model_configs;

alter table model_configs
  add column competitor_family_id uuid;

update model_configs
   set competitor_family_id = id;

alter table model_configs
  alter column competitor_family_id set not null,
  add constraint model_configs_competitor_family_fk
    foreign key (competitor_family_id)
    references competitor_families(id)
    on delete restrict;

create index model_configs_by_competitor_family
  on model_configs (competitor_family_id, created_at);

alter table competitor_revisions
  add column competitor_family_id uuid,
  add column competitor_display_name text;

-- A revision keeps the family identity and display name observed when the
-- revision existed. Later family renames therefore cannot rewrite history.
update competitor_revisions r
   set competitor_family_id = m.competitor_family_id,
       competitor_display_name = f.display_name
  from model_configs m
  join competitor_families f on f.id = m.competitor_family_id
 where m.id = r.model_config_id;

alter table competitor_revisions
  alter column competitor_family_id set not null,
  alter column competitor_display_name set not null,
  add constraint competitor_revisions_competitor_family_fk
    foreign key (competitor_family_id)
    references competitor_families(id)
    on delete restrict;

create index competitor_revisions_by_competitor_family
  on competitor_revisions (competitor_family_id, created_at desc);

-- Keep the migration backward compatible with an older application binary.
-- This matters for local rollback: a pre-family build can still create a model
-- or revision while the newer additive schema remains installed.
create function ensure_model_competitor_family()
returns trigger
language plpgsql
as $$
begin
  if new.competitor_family_id is null then
    insert into competitor_families (id, display_name, status, created_at, updated_at)
    values (
      new.id,
      new.display_name,
      case when new.deleted_at is null then 'ACTIVE' else 'RETIRED' end,
      coalesce(new.created_at, now()),
      coalesce(new.updated_at, now())
    )
    on conflict (id) do nothing;
    new.competitor_family_id := new.id;
  end if;
  return new;
end;
$$;

create trigger model_configs_ensure_competitor_family
before insert on model_configs
for each row execute function ensure_model_competitor_family();

create function snapshot_revision_competitor_identity()
returns trigger
language plpgsql
as $$
begin
  if new.competitor_family_id is null or new.competitor_display_name is null then
    select m.competitor_family_id, m.display_name
      into new.competitor_family_id, new.competitor_display_name
      from model_configs m
     where m.id = new.model_config_id;
  end if;
  return new;
end;
$$;

create trigger competitor_revisions_snapshot_identity
before insert on competitor_revisions
for each row execute function snapshot_revision_competitor_identity();
