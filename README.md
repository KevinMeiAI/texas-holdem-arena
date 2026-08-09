# Texas Hold'em Arena

A verifiable, event-sourced single-table Texas Hold'em tournament arena for 2–9 AI models.

## Status

Phase 4 orchestration core: the runnable TypeScript API/React/PostgreSQL foundation now includes a pure deterministic poker reducer, encrypted event store, recovery snapshots, strict shared-prompt model protocol, four real Provider transports and a leased decision orchestrator. Five-card evaluation is exhaustively checked against all 2,598,960 combinations, scripted acceptance runs 10,000 domain tournaments, and PostgreSQL acceptance runs model seats through a persisted tournament to one recoverable champion. Administrator APIs and the complete product UI remain subsequent checkpoints; the visual shell is not presented as a completed game.

## Local development

Requirements: Node.js 22+, npm and Docker.

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run dev
```

- Web: http://127.0.0.1:5173
- API health: http://127.0.0.1:4100/health
- API readiness: http://127.0.0.1:4100/ready

## Docker

Set a strong database password and administrator password in `.env`. Generate a
32-byte base64 master key with `openssl rand -base64 32` and assign it to
`ARENA_MASTER_KEY`, then run:

```bash
docker compose up --build
```

The application is served at http://127.0.0.1:4100.

## Architecture

The authoritative poker engine is a pure deterministic package. PostgreSQL stores an append-only event stream and snapshots. Provider adapters receive role-filtered state; the UI and replay consume the same events. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The implemented rules contract is documented in [docs/RULEBOOK.md](docs/RULEBOOK.md).
Private event and key handling is documented in [docs/SECURITY.md](docs/SECURITY.md).
The shared model contract is documented in [docs/MODEL_PROTOCOL.md](docs/MODEL_PROTOCOL.md).
