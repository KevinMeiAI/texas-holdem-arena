create or replace function restrict_system_prompt_version_status()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and old.source <> 'CUSTOM' then
    raise exception 'only custom system prompt versions can change archive status';
  end if;
  return new;
end;
$$;

create trigger only_custom_system_prompt_versions_can_change_status
before update on system_prompt_versions
for each row execute function restrict_system_prompt_version_status();
