create table competitor_revisions (
  id uuid primary key,
  model_config_id uuid not null references model_configs(id) on delete restrict,
  revision_number integer not null,
  provider_connection_id uuid not null references provider_connections(id) on delete restrict,
  provider_type text not null,
  provider_profile text not null,
  provider_default_output_mode text not null,
  base_url text,
  model_id text not null,
  parameters jsonb not null,
  output_mode text not null,
  configuration_hash text not null,
  created_at timestamptz not null default now(),
  unique (model_config_id, revision_number),
  unique (model_config_id, configuration_hash),
  check (revision_number >= 1),
  check (configuration_hash ~ '^[a-f0-9]{64}$')
);

create index competitor_revisions_by_model
  on competitor_revisions (model_config_id, revision_number desc);

alter table model_configs
  add column current_revision_id uuid;

-- Existing rows are intentionally backfilled as immutable revision 1. Historical
-- tournaments remain legacy/unclassified until their stored frozen configuration
-- can be matched without guessing.
insert into competitor_revisions
  (id, model_config_id, revision_number, provider_connection_id, provider_type,
   provider_profile, provider_default_output_mode, base_url, model_id, parameters,
   output_mode, configuration_hash, created_at)
select m.id, m.id, 1, m.provider_connection_id, p.provider_type,
       p.provider_profile, p.default_output_mode, p.base_url, m.model_id, m.parameters,
       m.output_mode,
       md5(identity.value::text) || md5('arena:' || identity.value::text),
       m.created_at
  from model_configs m
  join provider_connections p on p.id = m.provider_connection_id
  cross join lateral (select jsonb_build_object(
         'providerConnectionId', m.provider_connection_id,
         'providerType', p.provider_type,
         'providerProfile', p.provider_profile,
         'providerDefaultOutputMode', p.default_output_mode,
         'baseUrl', p.base_url,
         'modelId', m.model_id,
         'parameters', m.parameters,
         'outputMode', m.output_mode
       ) as value) identity;

update model_configs m
   set current_revision_id = r.id
  from competitor_revisions r
 where r.model_config_id = m.id and r.revision_number = 1;

alter table model_configs alter column current_revision_id set not null;

alter table model_configs
  add constraint model_configs_current_revision_fk
  foreign key (current_revision_id) references competitor_revisions(id) on delete restrict
  deferrable initially deferred;

alter table tournaments
  add column protocol_bundle_id text,
  add column benchmark_track_id text,
  add column benchmark_cohort_id text;

update tournaments
   set protocol_bundle_id = 'legacy/native-unclassified',
       benchmark_track_id = 'legacy/native-unclassified',
       benchmark_cohort_id = 'legacy/native-unclassified'
 where protocol_bundle_id is null;

alter table tournaments
  alter column protocol_bundle_id set not null,
  alter column benchmark_track_id set not null,
  alter column benchmark_cohort_id set not null;

create index completed_tournaments_by_cohort
  on tournaments (benchmark_cohort_id, created_at)
  where status = 'COMPLETED';
