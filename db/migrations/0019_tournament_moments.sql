-- Moments are rebuildable, post-match read models. They intentionally live
-- outside arena_events so content generation can never mutate the authoritative
-- tournament chain.
create table tournament_moments (
  id uuid primary key,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  hand_no integer not null check (hand_no >= 1),
  start_sequence bigint not null check (start_sequence >= 1),
  focus_sequence bigint not null check (focus_sequence >= start_sequence),
  end_sequence bigint not null check (end_sequence >= focus_sequence),
  facts_version text not null,
  detector_version text not null,
  scoring_version text not null,
  broadcast_view_version text not null,
  equity_version text not null,
  source_event_hash text not null check (source_event_hash ~ '^[a-f0-9]{64}$'),
  source_event_count integer not null check (source_event_count >= 1),
  source_start_event_hash text not null check (source_start_event_hash ~ '^[a-f0-9]{64}$'),
  source_end_event_hash text not null check (source_end_event_hash ~ '^[a-f0-9]{64}$'),
  score integer not null check (score between 0 and 100),
  score_breakdown jsonb not null check (jsonb_typeof(score_breakdown) = 'object'),
  recommendation_rank integer check (recommendation_rank is null or recommendation_rank >= 1),
  primary_tag text not null check (primary_tag in (
    'FINAL_HAND', 'ELIMINATION', 'MULTI_ELIMINATION', 'HEADS_UP_REACHED',
    'ALL_IN', 'MULTIWAY_ALL_IN', 'LARGE_POT', 'LEAD_CHANGE',
    'SHORT_STACK_DOUBLE', 'FOUR_BET_PLUS', 'OVERBET', 'SIDE_POT',
    'SPLIT_POT', 'MULTIWAY_SHOWDOWN', 'EQUITY_REVERSAL',
    'ALL_IN_UNDERDOG_WIN', 'RARE_MADE_HAND', 'LONG_TANK'
  )),
  tags jsonb not null check (jsonb_typeof(tags) = 'array' and jsonb_array_length(tags) >= 1),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, hand_no, detector_version, source_event_hash)
);

create index tournament_moments_by_tournament
  on tournament_moments (tournament_id, score desc, hand_no);

create index tournament_moments_recommended
  on tournament_moments (tournament_id, recommendation_rank)
  where recommendation_rank is not null;

-- Editorial state is kept in a separate relation. Re-running a detector only
-- upserts tournament_moments and therefore cannot overwrite titles, playback
-- choices, slugs, or publication status.
create table moment_publications (
  moment_id uuid primary key references tournament_moments(id) on delete cascade,
  status text not null check (status in ('DRAFT', 'PUBLISHED', 'HIDDEN')),
  slug text,
  title_zh text,
  title_en text,
  summary_zh text,
  summary_en text,
  cover_sequence bigint,
  playback_start_sequence bigint,
  playback_end_sequence bigint,
  spoiler_mode text not null default 'SUSPENSE' check (spoiler_mode in ('SUSPENSE', 'RESULT')),
  is_primary boolean not null default false,
  publication_revision integer not null default 1 check (publication_revision >= 1),
  created_by_admin_user_id uuid references admin_users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (slug is null or (char_length(slug) between 1 and 120 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  check (title_zh is null or char_length(title_zh) between 1 and 140),
  check (title_en is null or char_length(title_en) between 1 and 140),
  check (summary_zh is null or char_length(summary_zh) between 1 and 500),
  check (summary_en is null or char_length(summary_en) between 1 and 500),
  check (cover_sequence is null or cover_sequence >= 1),
  check (playback_start_sequence is null or playback_start_sequence >= 1),
  check (playback_end_sequence is null or playback_end_sequence >= 1),
  check (
    playback_start_sequence is null
    or playback_end_sequence is null
    or playback_end_sequence >= playback_start_sequence
  ),
  check (
    status <> 'PUBLISHED'
    or (
      slug is not null
      and (title_zh is not null or title_en is not null)
      and cover_sequence is not null
      and playback_start_sequence is not null
      and playback_end_sequence is not null
      and published_at is not null
    )
  )
);

create unique index moment_publications_slug
  on moment_publications (lower(slug))
  where slug is not null;

create index moment_publications_public
  on moment_publications (published_at desc, moment_id)
  where status = 'PUBLISHED';
