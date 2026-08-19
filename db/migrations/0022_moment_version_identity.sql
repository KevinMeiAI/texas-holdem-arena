-- A new scoring, facts, broadcast, or equity version must be able to derive a
-- parallel immutable candidate instead of colliding with the detector-only
-- legacy uniqueness rule introduced in 0019.
do $$
declare
  legacy_constraint text;
begin
  select c.conname
    into legacy_constraint
    from pg_constraint c
    join unnest(c.conkey) with ordinality key_column(attnum, position) on true
    join pg_attribute a
      on a.attrelid = c.conrelid and a.attnum = key_column.attnum
   where c.conrelid = 'tournament_moments'::regclass
     and c.contype = 'u'
   group by c.oid, c.conname
  having array_agg(a.attname::text order by key_column.position) = array[
    'tournament_id', 'hand_no', 'detector_version', 'source_event_hash'
  ];

  if legacy_constraint is not null then
    execute format(
      'alter table tournament_moments drop constraint %I',
      legacy_constraint
    );
  end if;
end;
$$;

alter table tournament_moments
  add constraint tournament_moments_versioned_source_unique unique (
    tournament_id,
    hand_no,
    facts_version,
    detector_version,
    scoring_version,
    broadcast_view_version,
    equity_version,
    source_event_hash
  );
