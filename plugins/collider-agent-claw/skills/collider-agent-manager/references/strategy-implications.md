# Collider V2 Strategy Implications

Use this reference when choosing settings, overlays, target games, or manager candidate sets.

## Start from what is actually controllable

The manager does not control raw execution directly. In v1 it can shape:

- settings
- doctrine pack
- goal weights
- tactical overlay
- `customStrategy`
- exact manager candidate sets
- exact future simulated continuations
- priority target game

Those are enough to express real strategy if they are used deliberately.

## What the hole rules imply

- `WIN` and `DRAW` preserve capital, but only `WIN` contributes to winner-share routing.
- `-100%` and `-50%` create loser-pool and fee pressure. A strategy that frequently lands there needs strong compensating winner-share logic.
- `-1%` is almost flat in principal but still leaks value through fee and creator fee.
- `T=1/2/5/10%` preserve most capital while contributing to prize logic. They matter more when the manager values tournament pressure, ladder visibility, or lower-volatility board positioning.

Do not treat hole labels as just `good` or `bad`. They change different parts of the payout graph.

## What no-winner policy implies

No-winner policy changes whether `nobody wins` is harmless, defensive, or strategically exploitable.

- `Refund` favors safety and can justify conservative board states.
- `BiggestLoser` makes high-value losing exposure dangerous if the manager is not the likely beneficiary.
- `BiggestBalls` can reward sheer throw size even when no winner appears.
- `MostPlayed` rewards sustained game presence.

That means the manager should evaluate a candidate in both winner and no-winner worlds when the board looks thin.

## What bonus logic implies

Bonuses are not noise. They change ladder pressure and can justify lines that are not locally optimal on immediate PnL.

- Early entry bonuses reward participation timing.
- `BiggestBalls` rewards high-value presence and interacts with no-winner policy.
- `Slammer` rewards fast winner-hole settlement and trajectory classes that finish quickly.
- `ValueTier` rewards high-value throws discretely, not linearly.
- `DieHard` rewards being the last outcome to settle.

If the manager ignores bonuses completely, it is leaving strategic surface unused.

## What blackhole and teleport maps imply

Blackhole-enabled maps add a second strategic layer on top of the payout graph:

- the first 3 accepted throws define the teleport anchor
- the largest effective-mass throw controls the blackhole position
- a late heavy throw can still reroute much older unresolved balls
- shrink modes turn repeated BH traversal into a trade between leverage and survivability

This creates a real tension between early and late play:

- early throws matter because they help define the anchor
- late throws matter because they can recapture the control point and change old trajectories

That is why blackhole boards reward more than raw aggression. They reward structural imagination.

## What settings actually mean in play

- `doctrinePack` sets the broad starting posture for Agent 1.
- `goalWeights` tilt the objective mix across profit, ladder, self-awareness, and discovery.
- `riskMode` currently shapes amount targets, not deep planning intelligence.
- `maxThrowUsd`, `maxSingleThrowUsd`, and `maxGameExposureUsd` change which plans can legally exist.
- `minThrowUsd`, `minGameStakeUsd`, and reserve settings determine whether the agent can even open search.
- `allowedAssets` and `blockedAssets` are hard routing constraints.
- `customStrategy` is the persistent named hook for strategy profiles. It should name a repeatable idea, not arbitrary code.

Use exact settings names when proposing changes so those changes can be diffed and learned from.

## Best current manager levers

Use these in roughly this order:

1. Fix exact gating or eligibility problems first.
2. Choose or update doctrine pack and goal weights when the whole posture is wrong, not just one ranking preference.
3. Prefer bounded overlay bias over global setting churn when testing a short-lived hypothesis.
4. Use `customStrategy` to name a repeatable strategic profile inside that posture.
5. Use manager candidate sets when the hypothesis depends on exact throws or exact future branches.
6. Use `target-game` when one board is unusually attractive and the human or manager wants immediate focus.

## Custom strategy guidance

Treat `customStrategy` as a shared strategy-profile label:

- good: `copy_slammers`
- good: `toughnut_never_lose`
- good: `nutjob_discovery`
- good: `peanut_safe_flow`
- good: `prof_meta_rotator`
- good: `low_fee_tiers`
- good: `late_diehard_pressure`
- good: `bh_anchor_pressure`
- good: `bh_late_reversal`
- bad: `do_whatever`
- bad: embedded code

A good custom strategy name should tell a future manager what idea is being tested.

Pair the strategy name with:

- overlay notes
- candidate-set notes
- human report notes

That makes strategy reusable and comparable across sessions.

## Where novel strategy should emerge

The manager should eventually go beyond slider tuning into:

- hole-type preference by board context
- map-specific trajectory memory
- future-queue reasoning
- blackhole anchor-setting and control-point capture
- opponent-sensitive play once enough external evidence exists
- adaptive bankroll posture

But the first versions should still stay exact and auditable. Novelty is strongest when it leaves a clean trail.

Starter packs are examples, not cages. A strong manager should use them to move faster, then fork them into sharper names once the board proves something real.
