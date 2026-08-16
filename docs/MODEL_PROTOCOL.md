# Model protocol v10

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

## Professional decision context

New tournaments use `model-context-v3`. It provides the current and next blind
levels, hands until the next level, players remaining, total and average stacks,
single-board runout policy, exact pot totals before an action and after a call,
provisional side-pot layers, uncalled-return preview, effective stacks and SPR by
opponent. Raw audit envelopes are replaced with a compact action history containing
only forced bets, public board cards, poker actions, paid amounts, amount-to values,
pot-after and stack-after values.

Legacy tournaments retain their frozen prompt/context version.

The protocol is frozen per tournament. Legacy tournaments retain the exact
prompt and context version in their recovery snapshot. Newly created
`arena-system-v10` tournaments use the fixed nullable structured-output envelope,
`model-context-v3`, and a frozen output-schema snapshot.

## Action response

Return exactly one JSON object:

```json
{
  "type": "action",
  "action": "raise",
  "amount_to": 1200,
  "decision_summary": "Use position and stack leverage.",
  "query": null
}
```

- `action` must appear in the supplied `legal_actions` object.
- Every root field is required in the v10 wire envelope. `amount_to` is an integer
  only for `bet` and `raise`; otherwise it is `null`. It is the total amount the
  player will have committed on the current street after acting.
- Calls and all-ins have engine-computed amounts and use `amount_to: null`.
- Portable provider schemas cannot express every cross-field condition. If a
  structured-output provider fills `amount_to` for fold, check, call or all-in
  inside the complete fixed envelope, Arena discards that redundant value before
  validation. The deterministic engine still computes the paid amount. Bet and
  raise amounts remain mandatory and strictly validated.
- `decision_summary` is a string or `null` and limited to 300 Unicode characters. It is a
  short self-explanation, not hidden chain-of-thought. A malformed summary is
  discarded without invalidating an otherwise legal poker action.
- Unknown fields, code fences and surrounding prose are invalid.

## History query

Before taking an action, a model may request completed-hand public history:

```json
{
  "type": "history_query",
  "action": null,
  "amount_to": null,
  "decision_summary": null,
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
`public_stats`. Defaults are at most two queries per decision, 80 normalized
records per query and about 4,000 cumulative input tokens. Results are
deterministic and contain only public information from hands strictly earlier
than the current hand.

The spectator-only broadcast projection is outside this protocol. Real-time
opponent hole cards and broadcast equity are never included in `arena_state`,
`history_results`, correction requests or any later decision turn.

`hand` and `recent_hands` return normalized hand summaries with explicit
completion and action-truncation metadata while retaining board, showdown and
result information; recent hands are wrapped with requested and returned hand
counts. `player_actions` returns contextual actions with the board,
pot and prior street actions. `public_stats` reports sample sizes, VPIP/PFR,
street classifications, facing-bet decisions and separate all-in call/aggression
counts. Legacy all-ins without an engine classification are marked unknown.

The complete query JSON shapes are part of the locked system prompt. A query is
not a poker action: the engine executes it and calls the same model again with
the unchanged `arena_state`, accumulated `history_results`, and an updated
`history_budget_remaining`. The model must eventually return an action.

The budget is identical for every seat and frozen with tournament configuration.
After the budget is exhausted, another query is a protocol error.

## All-in runout

There is no model decision after betting is locked by all-ins. The deterministic
engine deals the remaining streets once and proceeds directly to showdown.

## Error policy

Protocol errors include invalid JSON, invalid schema, unavailable action,
out-of-range amount and excess history queries. The model receives one corrected
request using the same state. A second protocol failure executes `check` when
legal, otherwise `fold`.

Infrastructure errors include timeouts, network failure, 429 and provider 5xx.
Tournament decisions allow 120 seconds per attempt and retry against the same
decision request and state at most three times, waiting 2 seconds after the
first failure and 8 seconds after the second. Model preflight allows 60 seconds
per check. Authentication and configuration errors still pause immediately;
they are not retried. Exhaustion pauses the tournament; it never spends a
player's chips. Resume reclaims the same decision ID from the PostgreSQL outbox.

For new tournaments, the effective prompt, output schema, decision policy, model,
provider transport, output mode, timeout and generation parameters are frozen in
the encrypted recovery snapshot. Provider API keys never enter public events or
replay responses. Public configuration events contain only non-secret SHA-256
commitments.

Each provider turn is also encrypted and persisted with the exact canonical
request, raw and parsed response when available, usage, latency, error class,
prompt/schema commitment and non-secret model-configuration commitment. These
records restore history-query and correction state after an infrastructure pause.
They are withheld during the live hand and become readable in spectator replay
only after `HAND_COMPLETED`.

## Provider transports

- OpenAI Responses API
- Anthropic Messages API
- Google Gemini `generateContent`
- OpenAI-compatible Chat Completions
- deterministic mock policy for local acceptance tests

Provider and model settings resolve to `json_schema`, `json_object`, or `prompt`.
OpenAI Responses uses `text.format`, Claude uses `output_config.format`, Gemini
`generateContent` uses `generationConfig.responseMimeType` plus `responseSchema`,
and compatible Chat Completions uses `response_format`. DeepSeek and GLM default
to JSON Object; Kimi K3 defaults to JSON Schema. All adapters normalize text,
token usage, latency, request ID and error class. The canonical strict parser and
deterministic poker referee remain the final authority.
