-- Public Decision Branches are editorial publications of a completed Hand
-- Fork. They freeze one strictly allowlisted snapshot and never read or expose
-- the encrypted fork payload on a public request.
create table decision_branch_publications (
  id uuid primary key,
  source_hand_fork_id uuid not null unique references hand_forks(id) on delete restrict,
  status text not null check (status in ('DRAFT', 'PUBLISHED', 'HIDDEN')),
  slug text,
  title_zh text,
  title_en text,
  summary_zh text,
  summary_en text,
  snapshot_version text not null check (char_length(snapshot_version) between 1 and 120),
  public_snapshot jsonb not null check (jsonb_typeof(public_snapshot) = 'object'),
  public_snapshot_hash text not null check (public_snapshot_hash ~ '^[a-f0-9]{64}$'),
  publication_revision integer not null default 1 check (publication_revision >= 1),
  created_by_admin_user_id uuid references admin_users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (slug is null or (
    char_length(slug) between 1 and 120
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )),
  check (title_zh is null or char_length(title_zh) between 1 and 140),
  check (title_en is null or char_length(title_en) between 1 and 140),
  check (summary_zh is null or char_length(summary_zh) between 1 and 500),
  check (summary_en is null or char_length(summary_en) between 1 and 500),
  check (public_snapshot->>'version' = snapshot_version),
  -- A draft has never been public. Hidden branches retain their first publish
  -- timestamp so a hide/republish cycle cannot rewrite publication history.
  check ((status = 'DRAFT') = (published_at is null)),
  check (
    status <> 'PUBLISHED'
    or (
      slug is not null
      and (title_zh is not null or title_en is not null)
      and published_at is not null
    )
  )
);

create unique index decision_branch_publications_slug
  on decision_branch_publications (lower(slug))
  where slug is not null;

create index decision_branch_publications_recent
  on decision_branch_publications (created_at desc, id desc);

create index decision_branch_publications_public
  on decision_branch_publications (published_at desc, id desc)
  where status = 'PUBLISHED';
