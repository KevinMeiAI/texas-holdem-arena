-- A detector rebuild establishes the current candidate generation without
-- deleting immutable facts or breaking already-shared publication URLs.
alter table tournament_moments
  add column superseded_at timestamptz;

alter table moment_publications
  add constraint moment_primary_requires_publication
  check (not is_primary or status = 'PUBLISHED');

create index tournament_moments_active_generation
  on tournament_moments (tournament_id, recommendation_rank, score desc)
  where superseded_at is null;
