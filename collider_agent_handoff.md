# Collider V2 First Agent Handoff

## What this repo/agent is

This is the **first playable Collider V2 agent**. It is not the final intelligence layer. Right now it is the deterministic executor, planner, logger, and review stack that proves an agent can:

- discover live games from the Collider V2 RPC
- fetch canonical sim input
- append hypothetical throws locally
- run the same `sim_core.wasm`-based planning path as the frontend
- choose a throw
- submit it live
- match settled outcomes back to submitted decisions
- review itself through a local monitor

This is already important because Collider is not a normal game bot problem. The core thing being built is not just “a bot that plays” but a **live internal honesty / calibration machine** for agents. The local honest score is for internal self-review only. The **real benchmark is on-chain replay + actual pnl + leaderboard/ladder**. Local honest score can be lied about. The chain cannot.

## Deeper project purpose

Collider V2 is a deterministic, replayable, zero-RNG, zero-house-edge skill environment. That means:

- the same input always produces the same output
- humans and AI are playing the exact same physics and payoff structure
- performance is auditable from replays and chain results
- “prediction vs outcome” is not vague — it can be measured precisely

The long-term purpose of this agent is not to tweak a few filters. It is to become a genuine predictive player that develops map mastery, opponent modelling, bankroll control, and self-calibration. The settings panel is just the first shallow control surface. Do not stop there.

## Critical design rules from the user

1. **Do not guess.** If a field name or data shape is unclear, inspect the actual repo/logs and say what is missing.
2. **Do not hide errors with fallbacks.** The user prefers explicit errors on the dashboard over silent incorrect values.
3. **Production-ready minimalism.** Small exact fixes are preferred over bloated helper layers.
4. **Keep things deterministic.** Any prediction / review logic should derive from the same simulation / payout path as the VM whenever possible.
5. **Use live data for unsettled games.** Once a game is settled/final and won’t change, the logs become the canonical review source.
6. **Actual benchmark is chain performance, not local honesty score.** The local honesty score is useful only as a self-reflection tool.

## Very important domain truths about Collider

### 1. Profit is a game-level quantity
Profit cannot be judged per throw in isolation. It depends on **all throws in the game**, losers pool, fees, no-winner policy, winner-share distribution, and the agent’s proportion of winning value.

So:
- **Predicted profit** must be per game
- **Actual profit** must be per game
- per-throw review is still useful, but only as a sub-view

### 2. Hole/outcome prediction is throw-level
A throw can predict which hole / outcome type it will land in. That is meaningful per throw.

### 3. Win-rate KPI is value-weighted, not count-weighted
The key “win-hole %” on the honest score is **not throw count into winning holes**.
It is based on **USD throw value into Winner holes**.

Raw counts still matter and should be shown as sub-metrics:
- total throws
- total winning throws
- number of games

But the headline % is value-weighted.

### 4. The VM payout logic matters a lot
The predicted profit path must match the VM logic as closely as possible:
- refund rules
- fees
- creator fee / protocol fee
- losers pool
- total winner value
- proportional winner-share allocation
- no-winner policies

This was one of the biggest sources of earlier bugs because naive monitor math was wrong.

## Current architecture

### Agent layers

- `src/core/` basic settings, storage, runtime state
- `src/collider/` Collider-specific types/builders
- `src/sim/` wasm planner / decode path
- `src/agent/` loop, session, prediction logging, result matching
- `src/monitor/` local HTTP server
- `monitor12.html` / `monitor12b.html` local operator UI

### Live runtime model

The monitor writes settings to the local monitor server.
The monitor server updates in-memory runtime state.
The running session reads that runtime state each cycle.
So settings can be changed live without restart.

## Important patches already made in this chat

### Prediction logging
This was a major bug.

Problem:
- prediction summaries were not being logged because the code was trying to summarize from the wrong object shape
- `summarizePredictionFromWinner(...)` did not match the actual current repo shape

Fix direction:
- prediction must be derived from the **chosen plan / scenario outputs**, not from guessed winner wrappers
- synthetic local throws need deterministic ids so predicted synthetic throw/outcome can be found in decoded reports

Expected fresh log fields after the fix:
- in `runs.jsonl`
  - `prediction.pnlUsd`
- in `throws.jsonl`
  - `prediction.holeType`
  - `prediction.winnerValuePct`
  - ideally also `prediction.valueUsd`, `prediction.valueUsdE8`, `prediction.massUsd`

If these fields are missing, the monitor should show explicit “missing field” errors, not infer fake values.

### Session result logging timing
Earlier the session was logging results too early.

Problem:
- `getGameReport(...)` was being accepted before true settlement
- so resolved rows were incomplete / misleading

Fix direction:
- only record final resolved rows once the game is actually settled/final
- if required fields are missing, keep waiting rather than writing bad data

### Monitor philosophy change
Earlier monitor versions were full of guessed fallbacks.
This was explicitly rejected by the user.

Current accepted direction:
- strict monitor
- explicit field errors in-place
- no “pretend” hole type or pnl logic when the backend does not yet provide the exact field

That made the real backend gaps obvious and was the right move.

## Current monitor state

`monitor12.html` is the current locked-in good base.
`monitor12b.html` is a small follow-up patch that replaces `Pending A` in the Games table with **Eligibility**.

### What monitor12/12b already do well

- large honest performance section
- predicted vs actual KPI boxes
- mini charts in KPI boxes
- control panel with start/stop/calibrate/full clean/use all data/reset
- modal settings panel
- games review table
- selected game review
- bank page
- explicit missing-field diagnostics

### monitor12b specific tweak
Games table column:
- `Throws A/T`
- `Eligibility`

Eligibility is currently a lightweight signal based on latest run state, using exact known stop reasons where possible, such as:
- `PLAYED`
- `CLOSED`
- `NO-CAND`
- `NO-BAL`
- `COOLDOWN`
- `MAX/G`
- `MAX/S`

This is not the final eligibility explanation system, but it is much better than a redundant pending-agent-throws column.

## Why the agent may stop throwing

A recent observed case:
- after ~63 throws it starts saying effectively “no games found eligible”
- feedback says `empty` / `empty_no_eligible_candidates`

Possible real causes to inspect in current repo and logs:
- `maxThrowsPerGame`
- `maxThrowsPerSession`
- `minGameStakeUsd`
- `minThrowUsd`
- `maxThrowUsd`
- `maxSingleThrowUsd`
- `maxGameExposureUsd`
- blocked assets / allowed assets
- reserve balance
- no candidates surviving ranking/filtering
- bankroll constraints
- all current games are settled/closed or below min value

Do **not** guess here. The next agent should make the exact rejection cause visible per game and per cycle.

## Settings / strategy layer currently exposed

These are now represented in the UI and partially/fully wired through runtime state:

- primary asset
- amount
- max candidates
- max ms
- poll ms
- max throws per game
- max throws per session
- min ms between live throws
- min game value USD
- max single throw USD
- max game exposure USD
- min throw USD
- max throw USD
- risk mode (`balanced`, `defensive`, `aggressive`)
- copy slammers / winning trajectories toggle
- allowed assets
- blocked assets
- reserve balance
- target balance USD
- target profit USD
- keep assets
- dispose assets

### Important warning
The UI exposure is ahead of the true strategic depth.
Some of these settings are currently shallow policy gates, not full intelligence.
That is fine as a first layer, but the next work should go far beyond “LLM tweaks settings.”

## User’s explicit strategic direction for the next agent

The next agent must become much more advanced than a settings-tweaker.
The user explicitly does **not** want the future frontier LLM layer to be reduced to just moving sliders.

The next level should include:
- opponent modelling
- map and hole-type mastery
- trajectory reuse / cloning of strong historical throws
- local replay analysis
- reasoning over future queue states
- search beyond one-throw horizon
- stronger bankroll sizing and asset management
- strategic use of multiple assets
- calibration and self-audit

### Very important nuance from the user
The local honest score is **internal only**.
The agent could lie to itself or the user locally.
That is not the real benchmark.
The real benchmark is:
- on-chain replay
- actual pnl
- actual ladder / leaderboard performance

So do not let “keeping the honest score stable” become a reason to cripple agent intelligence. The honest score should remain as an introspection tool, but not as the outer truth.

## Recommended future architecture with a frontier model

Do **not** just hand the whole repo to a claw-style wrapper and say “go.”
That would blur control, safety, and evaluation.

Recommended structure:

### Layer 1 — deterministic executor (this repo)
Responsible for:
- live game fetch
- sim input fetch
- local planning
- candidate scoring
- throw placement
- logging
- bankroll / policy gates

### Layer 2 — strategy/planning brain (frontier LLM or multi-model stack)
Responsible for:
- reading recent logs and monitor state
- proposing structured strategy changes
- selecting planning modes
- requesting deeper search / map studies / opponent studies
- generating hypotheses and experiments

### Layer 3 — review / reflection layer
Responsible for:
- analysing calibration gaps
- clustering failure modes
- updating map-specific strategy memory
- deciding when to run calibration / full clean

This way the LLM cannot bypass the deterministic core, but it can become much smarter than “change risk mode.”

## Strong options for frontier integration

### Option A — policy supervisor (lowest risk, easiest first)
LLM reads logs + state and outputs strict JSON settings deltas.

Pros:
- easy to ship
- safe
- auditable

Cons:
- not enough on its own for strong play

### Option B — plan critic / reranker (recommended next)
LLM sees candidate summaries and critiques / reranks them before final selection.

Pros:
- still inside deterministic rails
- much more expressive than settings-only

Cons:
- needs careful prompt / schema design

### Option C — multi-step tactical planner
LLM can request deeper search modes, trajectory memory lookup, opponent response simulation, and bankroll adjustment together.

Pros:
- closer to what real high-level Collider play needs

Cons:
- more moving parts

### Option D — full skill/plugin wrapper
Needed for OpenClaw-style ecosystems, but should wrap the deterministic core, not replace it.

## What still needs to be completed for the “full testable loop”

The user explicitly wants the next stage to include:

### 1. Plugin / skill wrapper
For OpenClaw-style variants and other agent runtimes.

Needs:
- a clean skill manifest / wrapper
- input/output schema
- docs
- commands / actions
- safe local configuration

### 2. Instructions / docs
Need a polished repo-level README and usage docs covering:
- setup
- wallet / balances
- sim_core.wasm usage
- monitor
- runtime settings
- calibration modes
- plugin usage

### 3. Built-in wallet and deposit automation
Needed for actual usability once moving beyond dev testing.

Should include:
- local wallet handling
- funding flow
- deposit / conversion helpers
- asset routing / rebalance helpers

## Important UI / collaboration preferences from the user

- prefer exact small patches, not sprawling abstractions
- prefer visible failures over silent defaults
- do not bloat the repo with helpers that hide the real bug
- high-performance, clean, neon/TRON style
- JS-friendly, practical, direct
- if information is missing, stop and ask rather than invent

## Common failure pattern to avoid

The big failure mode in this chat was:
1. field mismatch occurs
2. monitor guesses a fallback
3. fallback hides the true missing field
4. more logic is added on top of wrong assumptions
5. repo becomes bloated and harder to repair

The user explicitly called this out and wants the opposite behavior.

So for future work:
- inspect the actual logs / repo / API
- if field missing, surface it
- patch the producing backend
- then patch the monitor

## Immediate next priorities for the next chat / Codex session

### 1. Eligibility explanations per game
The monitor now has an eligibility signal slot. The next step is making it exact and rich.
Need per-game reasons like:
- too small game value
- blocked asset
- insufficient balance
- exceeds game exposure
- exceeds per-throw limit
- no eligible candidates
- score below threshold
- closed / settled
- cooldown
- session cap reached

### 2. Verify all strategy settings are actually affecting behavior
UI is ahead of enforcement in some places.
Need exact backend audit for every setting.

### 3. Deepen agent intelligence beyond settings
This is probably the most important conceptual handoff item.
The next agent should not just tune settings. It should:
- build map-specific strategy memory
- reason over trajectory classes
- identify strong hole access paths
- learn opponent-sensitive play
- consider future queue states
- distinguish calibration mode from profit mode

### 4. Full plugin/skill wrapper + docs + wallet/deposit helpers
This completes the full usable loop in Claw-style ecosystems.

## Final reminder for the next agent / Codex

Push harder.
Do not stop at settings.
Collider is a deterministic environment rich enough to demand real mastery. Even weak humans will beat a strategy-slider bot. The next agent must move toward:
- planning
- memory
- opponent modelling
- calibration
- deeper search
- asset/bankroll intelligence

And keep the benchmark honest:
- local honest score is for reflection
- chain results are the truth

