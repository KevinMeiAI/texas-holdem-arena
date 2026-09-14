#!/usr/bin/env bash
# Per-boot startup: bring up PostgreSQL and ensure the arena role/database
# exist. Must be idempotent and tolerate an already-running cluster.
set -euo pipefail

# Start the default PostgreSQL cluster if it is not already online.
if ! sudo pg_lsclusters -h 2>/dev/null | grep -qw online; then
  echo "==> Starting PostgreSQL cluster"
  sudo pg_ctlcluster 16 main start || true
else
  echo "==> PostgreSQL cluster already online"
fi

# Wait until the server accepts connections.
ready=""
for _ in $(seq 1 30); do
  if sudo -u postgres psql -tAc "select 1" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "!! PostgreSQL did not become ready in time" >&2
  exit 1
fi

# Ensure the arena role and database exist (idempotent).
if ! sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='arena'" | grep -q 1; then
  echo "==> Creating role 'arena'"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "create role arena login password 'arena-local'"
fi
if ! sudo -u postgres psql -tAc "select 1 from pg_database where datname='arena'" | grep -q 1; then
  echo "==> Creating database 'arena'"
  sudo -u postgres createdb -O arena arena
fi

echo "==> PostgreSQL ready on 127.0.0.1:5432 (database: arena)"
