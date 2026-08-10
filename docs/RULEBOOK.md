# Arena Ruleset v2

This document is the normative contract for the deterministic domain engine in
`packages/domain`. A model may choose only among legal actions supplied by the
engine. Models, provider adapters, the API and the UI never decide poker rules.

## Format

- Single-table no-limit Texas Hold'em tournament with 2–9 players.
- Fixed starting stacks, no rebuy, no add-on and no manual chip adjustment.
- Blinds rise after a configured number of completed hands.
- A player with zero chips is eliminated before the next hand.
- Play continues until one champion holds the entire tournament chip supply.
- Chip values are non-negative safe integers; fractional chips are impossible.

## Cards and hand strength

- One standard 52-card deck, no jokers. Suits never break ties.
- Each active player receives two private cards; five community cards may be
  dealt with one burn before each street.
- The best five-card combination from five to seven available cards plays.
- Categories, high to low: straight flush, four of a kind, full house, flush,
  straight, three of a kind, two pair, one pair and high card.
- An ace is high except in A-2-3-4-5, where the straight is five-high.
- The evaluator's category totals are tested across all 2,598,960 five-card
  combinations.

## Button, blinds and action order

- With three or more players the tournament uses a dead button. The physical
  button advances one seat per hand even when that seat is empty. The small and
  big blinds are the next active players clockwise.
- Heads-up, the button posts the small blind and acts first preflop; the other
  player posts the big blind. Postflop, the button acts last.
- The transition from three players to heads-up derives the next big blind from
  the previous big blind, then assigns the other survivor the button/small
  blind. This prevents a skipped big blind.
- Preflop action starts left of the big blind. The big blind retains its option
  when no raise occurs. Postflop action starts with the first actionable player
  left of the button.

## Big Blind Ante

- BBA is paid only when enabled by the current blind level.
- A short big blind pays the live big blind first and only then pays as much of
  the BBA as remains.
- BBA is dead contribution: it is never returned as an unmatched wager and does
  not enlarge that player's side-pot eligibility.
- Dead contribution is added to the main pot. Live wagers alone define unmatched
  returns and side-pot caps.

## Actions and amount semantics

- Legal actions are `fold`, `check`, `call`, `bet`, `raise` and `all_in`.
- `fold` is exposed only when chips are required to continue; otherwise the
  passive action is `check`.
- `call` has no model-supplied amount. The engine pays the smaller of the call
  requirement and the player's remaining stack.
- `amount_to` for `bet` and `raise` is the player's total contribution on the
  current street after the action, never an incremental amount.
- A non-all-in opening bet must be at least one big blind. A full raise must
  increase the current bet by at least the previous full raise size.
- The engine rejects out-of-range amounts and never silently clamps them.

## Short all-ins and reopening action

- An all-in below a full raise raises the amount to call but does not immediately
  reopen raising for a player who already acted against the prior full wager.
- A player who has not yet acted retains the right to make a full raise.
- Multiple short all-ins reopen raising when their cumulative increase faced by
  an already-acted player reaches the last full raise size.
- The reducer tracks each player's current-street contribution and whether they
  acted since the last full raise; UI state is never used to infer rights.

## Pot construction and settlement

- A unique unmatched live overage is returned before the remaining board is
  dealt or the hand is settled. Dead contribution is not returnable.
- Remaining live contributions are sliced at each distinct contribution cap to
  create the main pot and side pots.
- Folded chips stay in pots, but folded players are removed from every eligible
  winner set.
- Each pot is evaluated independently. Tied winners split integer chips evenly.
- Odd chips are distributed one at a time, clockwise from the first winner left
  of the button.
- At all times, player stacks plus unsettled contribution equal the fixed
  tournament chip supply. After settlement, unsettled contribution is zero.

## All-in runout

When at least two players remain, the board is incomplete and no future betting
is possible, the engine automatically deals the remaining streets once. There is
no runout negotiation and no second board. One card is burned before every
pending street, using the committed deck in order, then all non-folded players
proceed directly to showdown.

## Showdown, hidden cards and audit data

- All non-folded players at showdown are evaluated and revealed.
- Folded hole cards remain stored as authoritative private hand data.
- Live model projections never expose an opponent's unrevealed cards.
- Live spectator projections keep folded cards hidden until the hand completes.
- Replay analysis may expose every stored hole card only after `HAND_COMPLETED`.
- The event/persistence layer is responsible for encrypting private payloads and
  producing separate model, live spectator, replay and administrator views.

## Elimination and finishing positions

- Players reaching zero after settlement are eliminated together before the
  next hand.
- When several players bust in one hand, the player who began that hand with
  more chips receives the better finishing position.
- Equal starting stacks receive the same tied position and tie-group marker.
- A completed tournament has exactly one champion at position one, holding all
  chips originally issued to the table.

## Determinism and verification

- The domain reducer has no network, database, clock or implicit random access.
- A complete 52-card deck is supplied to each hand; the reducer verifies unique
  cards and consumes it in order.
- Commit–reveal randomness uses HMAC-SHA256 derived seeds, rejection-sampled
  random integers and Fisher–Yates shuffling.
- Every reducer transition validates card uniqueness, deck cursor integrity,
  player identity/seat uniqueness, non-negative chips and chip conservation.
