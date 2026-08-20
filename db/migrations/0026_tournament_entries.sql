-- Tournament entries are a queryable identity snapshot. The authoritative
-- game state and immutable event chain still use competitor revision IDs;
-- this read model makes a stable competitor career page possible without
-- repeatedly scanning every tournament JSON document.
create table tournament_entries (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  competitor_revision_id uuid not null references competitor_revisions(id) on delete restrict,
  seat integer not null check (seat between 0 and 8),
  display_name_at_entry text not null check (char_length(display_name_at_entry) between 1 and 120),
  created_at timestamptz not null default now(),
  primary key (tournament_id, competitor_revision_id),
  unique (tournament_id, seat)
);

create index tournament_entries_by_revision
  on tournament_entries (competitor_revision_id, tournament_id);

-- Arena-managed historical tournaments froze the revision IDs and labels in
-- configuration. Revision 1 reused the original model UUID, so all production
-- records created before this migration can be mapped without guessing names.
insert into tournament_entries
  (tournament_id, competitor_revision_id, seat, display_name_at_entry, created_at)
select t.id,
       r.id,
       (player.value->>'seat')::integer,
       coalesce(
         nullif(t.configuration->'playerLabels'->>(player.value->>'id'), ''),
         r.competitor_display_name
       ),
       t.created_at
  from tournaments t
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(t.configuration->'tournament'->'players') = 'array'
        then t.configuration->'tournament'->'players'
      else '[]'::jsonb
    end
  ) player(value)
  join competitor_revisions r on r.id::text = player.value->>'id'
 where (player.value->>'seat') ~ '^[0-8]$'
on conflict do nothing;
