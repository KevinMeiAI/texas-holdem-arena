-- A first-turn validity result exists only after the provider produced an
-- observable first response. Pure infrastructure failures therefore remain
-- NULL and are excluded from the metric denominator.
alter table hand_fork_trials
  alter column first_turn_valid drop default,
  alter column first_turn_valid drop not null;

-- Rows written before this migration used FALSE as the column default, so an
-- infrastructure-only trial was indistinguishable from an observed invalid
-- first response. Exclude those legacy infrastructure rows conservatively.
update hand_fork_trials
   set first_turn_valid = null
 where outcome = 'INFRA_ERROR';

-- Effective modes are resolved values. Configuration-only values such as
-- "auto" and "inherit" must never be persisted as an executed target mode.
alter table hand_fork_targets
  add constraint hand_fork_targets_effective_output_mode_allowed_check
  check (effective_output_mode in ('json_schema', 'json_object', 'prompt'));
