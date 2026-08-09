alter table decision_requests
  add column lease_owner text,
  add column lease_expires_at timestamptz;

create index claimable_decision_requests
  on decision_requests (tournament_id, created_at)
  where status in ('PENDING', 'IN_FLIGHT', 'INFRA_FAILED');
