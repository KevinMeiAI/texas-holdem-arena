alter table provider_connections
  add column provider_profile text not null default 'auto'
    check (provider_profile in ('auto', 'openai', 'anthropic', 'gemini', 'deepseek', 'kimi', 'zhipu', 'generic')),
  add column default_output_mode text not null default 'auto'
    check (default_output_mode in ('auto', 'json_schema', 'json_object', 'prompt'));

alter table model_configs
  add column output_mode text not null default 'inherit'
    check (output_mode in ('inherit', 'auto', 'json_schema', 'json_object', 'prompt'));

-- Existing tournaments resolve their player providers through these model rows.
-- Preserve their pre-migration JSON Object behavior; newly created models inherit
-- the Provider policy and can opt into JSON Schema explicitly or automatically.
update model_configs set output_mode = 'json_object';
