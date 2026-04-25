# Collider V2 Payout Mechanics

Use this reference when a manager needs settlement truth, not just hole labels.

## Core principle

Collider settlement is deterministic and compositional.

Each resolved throw is split into payout components, then those components are routed through game-wide settlement rules. The important split terms are:

- `return_pct`
- `prize_pct`
- `losers_pct`
- `fee_pct`
- `creator_fee_pct`

These are the settlement machine, not decorative labels.

## What the payout buckets mean

Treat these report labels as exact:

- `Return`: direct credit back to the throw owner
- `WinnerShare`: redistributed losers-pool value awarded to winner users
- `Tournament`: prize-oriented output, not ordinary game return
- `ColliderFee`: protocol fee
- `CreatorFee`: map or creator fee
- `Rounding`: deterministic residue handling
- `Other`: reserved catch-all

Do not casually mix fee or tournament buckets into player return.

## Winner-share is global by user

This is the payout detail most managers miss first.

If at least one winner-hole throw exists:

1. each throw still gets its direct split
2. losers-pool value accumulates per asset
3. each asset pool is redistributed across winner users by global winner weight

That redistribution is:

- global across the game
- user-weighted, not throw-local
- asset-specific, but not restricted to the single winning throw that happened to hit first

So a throw-level `WIN` tag alone is not enough to know the final per-throw return.

## No-winner policy is also global

If the board closes with no winner-hole throw, Collider applies the game's configured no-winner policy:

- `Refund`
- `BiggestLoser`
- `BiggestBalls`
- `MostPlayed`

That policy is game-wide, not throw-local.

A manager should never assume `no winner` means neutral refund unless the policy explicitly says so.

## Returned value, PnL, and bonus points are different truths

Keep these separate:

- submission value: what the throw put in
- returned value: what the throw or user got back
- PnL: returned minus submitted
- bonus points: ladder or score effects, not payout

Bonus points matter competitively, but they are not profit.

## Why per-throw profit is hard

A correct throw-level return view must respect the full settlement path:

1. resolve actual hole rule
2. split return, prize, losers pool, fee, and creator fee
3. accumulate losers pools by asset
4. determine whether winners exist
5. if winners exist, redistribute losers pools globally by winner user weight
6. otherwise apply the configured no-winner policy
7. only then aggregate per throw, per user, and to USD views

Anything simpler will drift on some maps or game states.

## Manager doctrine

Use payout mechanics as a prediction and supervision surface, not just as a scoreboard explanation.

A strong manager should ask:

- which holes return direct value versus only shaping the losers pool
- whether no-winner policy changes the expected edge
- whether a candidate improves game-level payout state even if its local hole looks modest
- whether the current board already implies a likely winner-share concentration

This is why the value layer and game layer exist in HPS.
