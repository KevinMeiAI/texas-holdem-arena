# Model protocol v3

Every seat receives the same effective system prompt bytes. The effective prompt
contains only the locked Arena rules prefix and locked output protocol. It has no
administrator-supplied strategy section. Its SHA-256 hash is frozen before the
tournament and stored with every decision request.

Provider adapters may translate transport fields, but they may not add strategy
instructions or change the model-visible state.

## Position context

Every decision includes canonical position metadata rather than requiring models
to infer positions from raw seats alone. It contains the button, blind and dead
button state, the hero's position, a position record for every active player,
and preflop/postflop action-order arrays. Order indexes are one-based. Live
`betting.current_actor_id` and `legal_actions` remain authoritative after folds
and all-ins.

The protocol is frozen per tournament. A tournament created under
`arena-system-v1` continues to receive `model-context-v1` after process recovery;
only newly created `arena-system-v2` tournaments receive this position context.

## Action response

Return exactly one JSON object:

```json
{
  "type": "action",
  "action": "raise",
  "amount_to": 1200,
  "decision_summary": "Use position and stack leverage."
}
```

- `action` must appear in the supplied `legal_actions` object.
- `amount_to` is required only for `bet` and `raise`. It is the total amount the
  player will have committed on the current street after acting.
- Calls and all-ins have engine-computed amounts and must not include
  `amount_to`.
- `decision_summary` is optional and limited to 300 Unicode characters. It is a
  short self-explanation, not hidden chain-of-thought. A malformed summary is
  discarded without invalidating an otherwise legal poker action.
- Unknown fields, code fences and surrounding prose are invalid.

## History query

Before taking an action, a model may request completed-hand public history:

```json
{
  "type": "history_query",
  "query": {
    "kind": "player_actions",
    "player_id": "player_3",
    "streets": ["FLOP", "TURN"],
    "actions": ["bet", "raise"],
    "limit": 40
  }
}
```

Supported kinds are `player_actions`, `hand`, `recent_hands` and
`public_stats`. Defaults are at most two queries per decision, 80 events per
query and about 4,000 cumulative input tokens. SQL results are deterministic and
contain only public events from hands strictly earlier than the current hand.

The complete query JSON shapes are part of the locked system prompt. A query is
not a poker action: the engine executes it and calls the same model again with
the unchanged `arena_state`, accumulated `history_results`, and an updated
`history_budget_remaining`. The model must eventually return an action.

The budget is identical for every seat and frozen with tournament configuration.
After the budget is exhausted, another query is a protocol error.

## Runout vote

When betting is locked by all-ins and community cards remain, return:

```json
{
  "type": "runout_vote",
  "accept_run_it_twice": true,
  "message": "Twice reduces single-board variance."
}
```

The optional message is at most 160 Unicode characters. It is untrusted data and
is visible only to later voters during that negotiation plus spectators/audit.
It cannot alter rules, reopen betting or enter later normal-decision prompts.

## Error policy

Protocol errors include invalid JSON, invalid schema, unavailable action,
out-of-range amount and excess history queries. The model receives one corrected
request using the same state. A second protocol failure executes `check` when
legal, otherwise `fold`. Invalid runout voting after correction means Run It
Once.

Infrastructure errors include timeouts, network failure, 429 and provider 5xx.
They retry against the same decision request and state up to the frozen limit.
Exhaustion pauses the tournament; it never spends a player's chips. Resume
reclaims the same decision ID from the PostgreSQL outbox.

## Provider transports

- OpenAI Responses API
- Anthropic Messages API
- Google Gemini `generateContent`
- OpenAI-compatible Chat Completions
- deterministic mock policy for local acceptance tests

All adapters normalize text, token usage, latency, request ID and error class.
Even when a provider offers native JSON mode, the canonical strict parser is the
final authority.
