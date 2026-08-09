# Security boundary

## Master key

`ARENA_MASTER_KEY` must be a base64-encoded 32-byte value. Generate one with:

```bash
openssl rand -base64 32
```

The application validates the exact decoded length at startup. `/ready` stays
unready when the key is absent, and invalid key material aborts startup. The key
must never be committed, logged, returned by an API or copied into a browser.

Losing the key makes encrypted provider credentials, hole cards, raw model
responses, random seeds and snapshots unrecoverable. Backups therefore require
both the PostgreSQL data and the separately protected environment key.

## Encrypted fields

Private payloads use AES-256-GCM with a fresh 96-bit nonce per record. The
authenticated additional data binds ciphertext to its tournament, event
sequence, aggregate version and event type. Moving ciphertext to another event
causes authentication failure.

The encrypted representation, not plaintext, participates in the event hash.
Snapshots use a separate AAD namespace and a checksum covering public state,
encrypted private state, tournament ID, event sequence and aggregate version.

## Event integrity

Each tournament starts from a fixed zero genesis hash. Every event hash covers
canonical JSON for its identity, sequence, version, type, actor, hand, public
payload, encrypted private payload and visibility policy, plus the previous
hash. Verification rejects sequence gaps, version gaps, broken links and any
payload modification.

## Visibility projections

The API must project from the server-side event representation. It must never
send a complete private object and rely on frontend code or CSS to hide fields.

- `MODEL_SELF` may decrypt only that player's hole-card events. Opponent folded
  cards remain unavailable to models even after the hand.
- `SPECTATOR_LIVE` does not receive folded hole cards before hand completion.
- `SPECTATOR_REPLAY` receives stored hole cards only for completed hands.
- `ADMIN_AUDIT` may decrypt authorized records and must create an audit event.
- Burn cards and raw provider records are administrator-audit data, never public
  live state.

Normal showdown cards are separate public events. This allows models and live
spectators to see only information revealed by poker rules without granting
access to the original private deal event.

## Transaction and worker boundary

An authoritative transition appends events, updates aggregate version/state,
writes an encrypted snapshot and creates the next model-decision outbox row in
one PostgreSQL transaction. Provider calls happen only after commit.

Workers claim a request with an expiring lease. Completion requires the same
worker lease, while a crash leaves the request reclaimable after expiry. The
expected aggregate version and idempotency key prevent a late or duplicate
response from advancing the tournament twice.
