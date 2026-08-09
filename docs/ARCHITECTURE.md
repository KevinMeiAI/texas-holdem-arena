# Architecture checkpoints

## Invariants

- The deterministic domain engine is the only poker referee.
- Cards, chips and action rights are never inferred from the UI.
- Model, spectator and administrator views are separate server-side projections.
- External model calls never occur inside a database transaction.
- Every meaningful checkpoint is tested, committed and pushed before the next layer begins.

## Delivery checkpoints

1. Runnable TypeScript/PostgreSQL/React/Docker foundation.
2. Poker rules engine, verifiable RNG and exhaustive rule tests.
3. Event persistence, recovery and scripted full tournaments.
4. Provider protocol, preflight and real adapter smoke paths.
5. Administrator control room, live arena, replay and leaderboard.
6. Docker, browser, recovery and information-leak acceptance.

The detailed product and implementation plan is maintained outside the source tree at `/Users/kevin/Documents/Codex/.omx/plans/texas-holdem-arena-v1.md` during local development.
