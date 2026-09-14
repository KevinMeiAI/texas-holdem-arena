#!/usr/bin/env bash
# Idempotent repository bootstrap for the Cloud Agent environment.
# Installs system + Node dependencies and prepares a local dev .env file.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# PostgreSQL is the only external service the app needs. Install it once.
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  echo "==> Installing PostgreSQL"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib
else
  echo "==> PostgreSQL already installed"
fi

echo "==> Installing Node dependencies (npm ci)"
npm ci

# The app reads configuration from environment variables. Create a local .env
# with a freshly generated master key the first time only, so encrypted data
# stays decryptable across restarts. .env is gitignored and never committed.
if [ ! -f .env ]; then
  echo "==> Creating .env with a generated ARENA_MASTER_KEY"
  master_key="$(openssl rand -base64 32)"
  cat > .env <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=4100
DATABASE_URL=postgres://arena:arena-local@127.0.0.1:5432/arena
POSTGRES_PORT=5432
POSTGRES_USER=arena
POSTGRES_PASSWORD=arena-local
POSTGRES_DB=arena
ARENA_MASTER_KEY=${master_key}
ARENA_ADMIN_EMAIL=admin@localhost
ARENA_ADMIN_PASSWORD=change-me-now
ARENA_COOKIE_SECURE=false
EOF
else
  echo "==> .env already present; leaving it untouched"
fi

echo "==> install.sh complete"
