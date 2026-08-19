alter table tournaments
  add column event_class text not null default 'RATED'
    check (event_class in ('RATED', 'EXHIBITION'));

alter table benchmark_series
  add column event_class text not null default 'RATED'
    check (event_class in ('RATED', 'EXHIBITION'));

-- Existing tournaments predate the explicit distinction. Preserve their
-- competitive record while making the public snapshot self-describing.
update tournaments
   set public_state = jsonb_set(public_state, '{eventClass}', '"RATED"'::jsonb, true)
 where not (public_state ? 'eventClass');

create index completed_rated_tournaments_by_cohort
  on tournaments (benchmark_cohort_id, created_at)
  where status = 'COMPLETED' and event_class = 'RATED';
