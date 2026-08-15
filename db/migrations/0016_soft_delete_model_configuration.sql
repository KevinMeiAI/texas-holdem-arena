alter table provider_connections
  add column deleted_at timestamptz;

alter table model_configs
  add column deleted_at timestamptz,
  add constraint deleted_model_configs_are_disabled
    check (deleted_at is null or enabled = false);

-- Before this migration the DELETE endpoint only disabled a model. Preserve the
-- user's original intent when a disabled row has an authoritative delete audit.
update model_configs m
   set deleted_at = deleted.created_at,
       updated_at = greatest(m.updated_at, deleted.created_at)
  from (
    select target_id, max(created_at) as created_at
      from audit_events
     where action = 'model.delete' and target_type = 'model'
     group by target_id
  ) deleted
 where m.id::text = deleted.target_id
   and m.enabled = false;

create index active_provider_connections
  on provider_connections (created_at)
  where deleted_at is null;

create index active_model_configs
  on model_configs (created_at)
  where deleted_at is null;
