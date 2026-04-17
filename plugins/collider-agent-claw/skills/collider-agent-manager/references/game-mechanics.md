# Collider V2 Game Mechanics

Use this reference when a manager needs the actual game rules, not just the API surface.

## Source of truth

The runtime truth is the live chain RPC:

- `colliderV2.getSimInput`
- `colliderV2.getGameReport`
- `colliderV2.getHoleRules`
- `colliderV2.getMap`

The default VM definitions live in:

- `engine/collider-vm/src/vm/mod.rs`
- `engine/collider-vm/src/payouts.rs`
- `engine/collider-vm/src/bonus.rs`
- `engine/collider-vm/src/types.rs`

Prefer live RPC data when there is a conflict. Use the VM source to understand semantics.

## Core properties

- Humans and AI play the same physics.
- The same input produces the same local sim output.
- Throw value at submission is stored on the throw itself and later used in payout and bonus logic.
- Current prediction commits are `current-known-board-only`. Unknown future external throws are explicitly out of scope in this first commit format.

## Hole-result rules

The default hole rules in `vm/mod.rs` are:

| Hole type | Label | Return | Losers pool | Prize | Collider fee | Creator fee |
| --- | --- | --- | --- | --- | --- | --- |
| `1` | `DRAW` | 100% | 0% | 0% | 0% | 0% |
| `2` | `-100%` | 0% | 99% | 0% | 1% | 0% |
| `3` | `WIN` | 100% | 0% | 0% | 0% | 0% |
| `4` | `-50%` | 50% | 49.5% | 0% | 0.5% | 0% |
| `5` | `-1%` | 99% | 0% | 0% | 0.5% | 0.5% |
| `6` | `T=1%` | 99% | 0% | 1% | 0% | 0% |
| `7` | `T=2%` | 98% | 0% | 2% | 0% | 0% |
| `8` | `T=5%` | 95% | 0% | 5% | 0% | 0% |
| `9` | `T=10%` | 90% | 0% | 10% | 0% | 0% |

Important details:

- Hole type `3` is the winner hole for winner-share routing.
- `Return` means the throw gets that percentage of its own amount back directly.
- `Losers pool` is collected globally and redistributed only if the game has at least one winner-hole throw.
- `Prize` routes to tournament or game prize accounting, not directly to the bot.
- Any unallocated remainder becomes fee in `payouts.rs`.

## Winner-share and no-winner behavior

If the game has at least one hole-type-`3` throw:

- loser-pool amounts are redistributed to winners
- redistribution weight is global winner stake value, normalized by stored USD value at submission time

If the game has no winners, the VM applies the game's `NoWinnerPolicy`:

- `Refund`: everyone gets fully refunded
- `BiggestLoser`: user with the largest total lost value becomes sole beneficiary
- `BiggestBalls`: user with the single largest-value throw becomes sole beneficiary
- `MostPlayed`: user with the largest total stake value becomes sole beneficiary

That policy changes strategy because `no winner` is not always neutral.

## Payout kinds exposed in reports

The settled report can contain these payout kinds:

- `Return`
- `WinnerShare`
- `Tournament`
- `ColliderFee`
- `Rounding`
- `CreatorFee`
- `Other`

Treat these exact labels as canonical.

## Bonus kinds

Finalize-time game bonuses currently include:

- `FirstEntry`
- `SecondEntry`
- `ThirdEntry`
- `BiggestBalls`
- `Slammer { streak }`
- `ValueTier`
- `DieHard`
- `RecordWeekly { record }`
- `RecordAllTime { record }`
- `TournamentFinal { record }`

Current point logic from `bonus.rs`:

- `FirstEntry`: `max(10, 2 x throw_usd_floor)`
- `SecondEntry`: `max(5, 1.5 x throw_usd_floor)`
- `ThirdEntry`: `max(2, throw_usd_floor)`
- `BiggestBalls`: `(2 x throw_usd_floor) + 20% of whole-game USD floor`
- `Slammer`: winner-hole throw that settles within `slammer_frames`; streak multiplier climbs `2x, 3x, ...` up to `10x`
- `ValueTier`: one highest tier only
- `DieHard`: last-outcome throw; ties split evenly, using `(2 x throw_usd_floor) + whole_game_usd_floor`

Current `ValueTier` thresholds:

- `>= $10`: round down to nearest `10`
- `>= $100`: `1.5x`, round down to nearest `100`
- `>= $1,000`: `2x`, round down to nearest `1,000`
- `>= $100,000`: `2.5x`, round down to nearest `1,000`
- `>= $1,000,000`: `4.2x`, round down to nearest `1,000`

## Teleport systems and special arena dynamics

Teleport in Collider is not one single mechanic:

- world X-wrap moves balls from one side of the arena to the other when they cross left or right bounds
- `last_frame_teleport` controls how unresolved balls are resolved at finalization
- blackhole-enabled maps can teleport balls from the blackhole core to a deterministic anchor

For the full blackhole and anchor-control model, read `blackhole-dynamics.md`.

## What is knowable at decision time

The manager can know exactly:

- current game state from `getSimInput`
- current known throws, assets, and stored price snapshots
- the local sim outcome of exact hypothetical next throws
- board-level forecasts for the current-known board

The manager cannot know exactly:

- future external throws not yet on the board
- future opponents or future stake that has not appeared yet

Treat that boundary as part of the game, not as a logging fault.