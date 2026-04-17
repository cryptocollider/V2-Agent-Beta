# Blackhole and Teleport Dynamics

Use this reference when a manager is operating a blackhole-enabled board or trying to understand why early and late throws can both carry unusual strategic weight.

## Source of truth

For blackhole and teleport behavior, use these sources in this order:

- live `colliderV2.getMap` and `colliderV2.getSimInput`
- `engine/collider-vm/src/maps/v2_alpha.rs`
- `engine/collider-vm/src/vm/mod.rs`
- `engine/sim_core/sim_core-src4-updated/src/core.rs`

The map config tells you whether the arena enables blackhole behavior. The sim core defines how that behavior actually resolves.

## Public blackhole surface

The VM already exposes blackhole control through `PhysicsConfig`:

- `black_hole_mode`
- `black_hole_strength`

The public map set currently includes `Classic Blackhole`, and the default public spawner registers that board with:

- `min_throws = 22`
- `idle_blocks = 11`
- `anti_snipe_window = 11`

That means blackhole boards are intentionally longer and give the dynamic control object time to matter.

## Implemented blackhole control model

The implemented mode table is:

- `0`: off
- `1`: teleport only
- `2`: teleport plus radius shrink
- `3`: teleport plus mass shrink
- `4`: teleport plus both mass and radius shrink

`black_hole_strength` is a live scalar, not a cosmetic label. In sim core it affects:

- effective pull power
- visible radius
- influence radius
- core radius
- shrink severity on teleport

## Anchor and control-point rules

Two different positions matter:

### Teleport anchor

The teleport destination is the weighted centroid of the first 3 accepted throws, using each throw's stored submission value as the weight.

Fallbacks are deterministic:

- 1 throw: first throw position
- 2 throws: weighted midpoint
- 3 throws: weighted centroid
- no usable weight: center of the legal input band

This is why the first three accepted throws matter more than simple participation timing. They define a durable structural point on the board.

### Blackhole position

The blackhole control point itself follows the entry position of the largest throw by effective mass seen so far.

In the current sim core that comparison uses `t.mass_usd`, so the board responds to physical leverage rather than prestige alone.

That separation matters:

- raw value still drives biggest-ball prestige and value-based bonus logic
- effective mass drives blackhole ownership and leverage

## Runtime behavior in sim core

In normal play, once a board enables blackhole mode and at least one throw has claimed ownership:

- balls inside the influence zone receive a softened capped gravity pull toward the blackhole
- balls that cross the core threshold teleport to the anchor
- teleported balls get a cooldown of `delta time / 1000`, which is 1 second of sim time before they can teleport again
- shrink behavior depends on mode

Preview behavior is intentionally stricter:

- previews and sims with fewer than 3 throws keep blackhole behavior disabled by default
- that protects early previews, single-throw previews, and pre-anchor reads from being distorted before the teleport anchor meaningfully exists

Current shrink logic is:

- shrink factor = `1 - 0.10 * black_hole_strength`
- clamped to `[0.35, 1.0]`

Mode-specific effects:

- `2`: shrink radius only
- `3`: shrink mass only
- `4`: shrink both radius and mass

The blackhole also derives its radii dynamically:

- visible radius grows with effective power mass
- influence radius is `2.5x` visible radius
- core radius is the inner teleport threshold

## Teleport in Collider is not one thing

Managers should keep three teleport-like behaviors separate:

1. X-wrap world bounds: balls that leave left or right wrap across the arena.
2. Blackhole core teleport: balls that hit the blackhole core jump to the anchor.
3. Final-frame resolution: unresolved balls can be assigned by nearest hole or forced hole type through `last_frame_teleport`.

Do not flatten those into one vague `teleport` idea. They affect strategy differently.

## Strategic consequences

Blackhole boards create a real control-point game:

- the first three accepted throws shape the teleport anchor
- the largest effective-mass throw controls the blackhole position
- a late heavy throw can still change the eventual settlement path of much older unresolved balls
- shrink modes make repeated BH traversal a trade between leverage and survival

This is why blackhole boards sharpen both early and late play at once:

- early throws matter because they define the anchor
- late throws matter because they can recapture the control point and change old trajectories

In long games, a late throw can materially change the fate of many earlier throws without violating fairness, because the rule is public, deterministic, symmetric, and risky to the player using it.

## Manager guidance

On blackhole-enabled boards, the manager should identify which role it is playing:

- anchor-setting
- control-point capture
- late reversal
- defensive stabilization

Useful manager tools on these boards are:

- `target-game` when one blackhole board is structurally attractive
- `customStrategy` names such as `bh_anchor_pressure` or `bh_late_reversal`
- manager candidate sets when the hypothesis depends on exact future branches
- HPS temporal and game layers, because blackhole boards reward mid-game belief updates

Treat the blackhole as a strategy object, not as spectacle. If a manager can imagine how it changes the board, it can be measured on whether that imagination was right.

