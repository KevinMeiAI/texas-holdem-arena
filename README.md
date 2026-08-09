# Texas Hold'em Arena

A verifiable, event-sourced single-table Texas Hold'em tournament arena for 2–9 AI models.

## Status

Phase 2 rules core: the runnable TypeScript API/React/PostgreSQL foundation now includes a pure deterministic poker and single-table tournament reducer. Five-card evaluation is exhaustively checked against all 2,598,960 combinations, and scripted acceptance runs 10,000 complete tournaments. Persistence, model orchestration and the product UI remain subsequent checkpoints; the visual shell is not presented as a completed game.

## Local development

Requirements: Node.js 22+, npm and Docker.

```bash
cp .env.example .env
npm install
npm run dev
```

- Web: http://127.0.0.1:5173
- API health: http://127.0.0.1:4100/health
- API readiness: http://127.0.0.1:4100/ready

## Docker

Set a strong database password, administrator password and a 32-byte base64 `ARENA_MASTER_KEY` in `.env`, then run:

```bash
docker compose up --build
```

The application is served at http://127.0.0.1:4100.

## Architecture

The authoritative poker engine is a pure deterministic package. PostgreSQL stores an append-only event stream and snapshots. Provider adapters receive role-filtered state; the UI and replay consume the same events. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The implemented rules contract is documented in [docs/RULEBOOK.md](docs/RULEBOOK.md).
