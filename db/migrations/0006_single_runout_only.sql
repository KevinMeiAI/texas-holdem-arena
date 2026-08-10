-- Preserve historical runout-vote decision rows while preventing any new ones.
alter table decision_requests
  drop constraint if exists decision_requests_request_kind_check;

alter table decision_requests
  add constraint decision_requests_request_kind_action_only
  check (request_kind = 'ACTION') not valid;
