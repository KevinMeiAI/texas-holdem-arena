-- Browser retries and concurrent submissions must resolve to one durable fork.
-- Existing rows predate client request IDs, so their own primary key is a safe,
-- unique legacy identity. Their zero hash is a reserved legacy sentinel that
-- the service does not emit during normal operation.
alter table hand_forks
  add column client_request_id uuid,
  add column create_request_hash text;

update hand_forks
   set client_request_id = id,
       create_request_hash = repeat('0', 64);

-- Keep defaults so an older application binary can still write after a code
-- rollback. Current code always supplies both values explicitly.
alter table hand_forks
  alter column client_request_id set not null,
  alter column client_request_id set default gen_random_uuid(),
  alter column create_request_hash set not null,
  alter column create_request_hash set default repeat('0', 64),
  add constraint hand_forks_create_request_hash_check
    check (create_request_hash ~ '^[a-f0-9]{64}$'),
  add constraint hand_forks_client_request_id_unique unique (client_request_id);
