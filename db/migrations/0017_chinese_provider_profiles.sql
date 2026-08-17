alter table provider_connections
  drop constraint if exists provider_connections_provider_profile_check;

alter table provider_connections
  add constraint provider_connections_provider_profile_check
  check (provider_profile in (
    'auto', 'openai', 'anthropic', 'gemini', 'deepseek', 'kimi', 'zhipu',
    'qwen', 'doubao', 'wenxin', 'hunyuan', 'minimax', 'xai', 'generic'
  ));
