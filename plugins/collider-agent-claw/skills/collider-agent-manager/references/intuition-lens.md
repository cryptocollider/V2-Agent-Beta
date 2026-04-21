# Intuition Lens and HPS

Use this reference when the manager is supervising its own prediction quality rather than only its realized PnL.

## What HPS is for

HPS is the internal honesty benchmark for the manager.

It does not replace:

- on-chain truth
- realized PnL
- ladder performance

It does provide the exact inner feedback loop Collider is designed to make measurable.

## Headline and diagnostics

Current HPS v2 behavior in this repo:

- headline uses the locked public formula built from outcome, value, and temporal error terms
- coverage is tracked separately and should not be hidden
- sharpness is tracked separately and should not be hidden
- the game layer is a visible diagnostic layer even though it is stored separately from the locked headline formula

The monitor and manager should keep these concepts separate instead of flattening them into one number.

## Raw score vs baseline lift

Agent 1 now tracks two different views deliberately:

- raw HPS headline and raw layer scores
- empirical baseline lift

Use them differently:

- raw HPS tells you the exact measured prediction quality on the modeled surface
- baseline lift tells you whether the current run is outperforming or underperforming this agent's own calibrated start state
- the baseline object also tells you whether calibration is still bootstrapping or already stabilized

That means baseline lift is not a replacement for HPS. It is a second lens on top of the raw truth. A manager should improve both, but never hide the raw score behind the lift.

## The four layers

### 1. Outcome layer

Question:

- Did the manager forecast the correct hole or result type?

Current metric:

- ranked-probability style truth over settled throw forecasts

This is the first layer that should wake up. If it is weak, the manager is not yet seeing the board cleanly.

### 2. Value layer

Question:

- Did the manager forecast the returned value or PnL accurately?

Current metric:

- payout or value error over settled throw forecasts

This layer is about economic truth, not just categorical truth.

### 3. Game layer

Question:

- Did the manager understand the whole board well enough to forecast the game-level finish and its own final outcome?

Current metric family:

- board-level forecast error
- predicted vs actual bot PnL
- predicted vs actual returned totals
- predicted vs actual final frame

This is where simple throw-picking becomes real game understanding.

### 4. Temporal layer

Question:

- Did the manager update its beliefs well over time as the board changed?

Current metric family:

- end-frame MAE
- dynamic shift error
- horizon accuracy
- certainty breach (late near-obvious misses are punished harder than early exploratory misses)

This layer measures self-correction, not just a single snapshot guess.

## Activation order

The intended activation order is:

`Outcome -> Value -> Game -> Temporal`

That order matters because later layers depend on earlier ones:

- poor outcome truth weakens value truth
- poor value truth weakens board truth
- poor board truth weakens temporal updating

## Coverage and scope

Coverage is part of honesty. Empty prediction surface should stand out.

Current commit format already models:

- tracked throw forecasts
- candidate or next-slot forecasts
- board-level game totals
- temporal update history across commits

Current commit format does not model:

- unknown future external throws that are not yet on the board

That boundary is explicit in the code:

- prediction commits are `current-known-board-only`
- `knownFutureUnknownThrowsMode` is currently `not_modeled`

So a manager should pursue high coverage over the modeled surface, then clearly acknowledge what remains outside it.

## How to improve each layer

- Outcome: better hole access and result-type discrimination
- Value: better return and fee/no-winner awareness
- Game: better whole-board and whole-session reasoning
- Temporal: better commit-to-commit updates as new throws appear

Use `/api/manager/honest-score` for fast inspection and `/api/manager/reveals?includeArtifacts=1` for exact commit/reveal evidence.