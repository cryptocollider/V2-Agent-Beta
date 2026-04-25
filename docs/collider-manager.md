# Collider Manager API and Supervision Guide

## Overview

Collider Agent 1 exposes a manager-first control surface through the local monitor server at `http://localhost:8787`. The human monitor and any Claw-compatible manager skill should read the same exact state, labels, diagnostics, and ranked candidate data.

The official supervisor UI is `monitor.html` at `http://localhost:8787`. It surfaces HPS commit/reveal supervision, the four-layer intuition lens, forecast coverage heatmaps, manager activity messages, and the main bank, game, and settled-throw views.

## Zero-flag beta startup

Agent 1 now ships with a starter `data/settings.json`. For a fresh beta launch, operators do not need to discover the old one-time flag set first.

After `npm run build`, the normal beta startup path is now just `npm start`. That default launch starts the live loop and the local monitor together; `--once` and `--no-monitor` are now advanced overrides, not first-contact requirements.

If `settings.user` is still blank when Agent 1 starts, bootstrap logic will:

- generate a random valid 32-byte beta user address
- keep beta USDC as the active starting asset
- request beta test tokens through `mirrorDeposit`
- persist that bootstrap state back into `data/settings.json`
- expose a concise onboarding summary through `GET /api/manager/state`

Managers should treat the returned `onboarding` object as the first-contact truth surface for startup status. It now includes the zero-flag startup mode, token-request state, the default human launch command, the starter strategy question, and the baseline/careful/stubborn/exploratory/hybrid style map. If the test-token request fails, report that exactly and tell the human to use the Bank page `Request Test Tokens` button instead of pretending the wallet is ready when it is not.

## Manager startup pack

The repo-local Claw skill includes a startup pack for fresh managers under `plugins/collider-agent-claw/skills/collider-agent-manager/references/`:

- `game-mechanics.md`: exact Collider rules, hole semantics, payout kinds, no-winner policies, and bonus families
- `blackhole-dynamics.md`: blackhole modes, teleport anchor logic, control-point behavior, and why those boards reward both early and late strategic depth
- `payout-mechanics.md`: settlement semantics, winner-share routing, no-winner policy behavior, and why throw-level PnL cannot be guessed from hole labels alone
- `strategy-implications.md`: how those rules change real decision-making
- `intuition-lens.md`: what the four HPS layers measure and how to use them
- `progression-map.md`: rough growth path from execution hygiene to strategy invention
- `persona-starter-packs.md`: baseline plus the four example persona/doctrine packs managers can start from or fork away from
- `doctrine-packs.md`: Agent 1 starting postures, goal mixes, and how they relate to custom strategy naming
- `manager-reporting.md`: how to keep humans involved through exact, concise strategy reporting

Use these references to shorten the manager's first-contact ramp without pretending the best strategy is already known.

## Settlement semantics

Read `references/payout-mechanics.md` whenever a manager is interpreting return, PnL, winner-share, or no-winner behavior. Tactical overlays and manager candidate sets are supervision surfaces, not alternate truth surfaces. They may bias ranking and experimentation, but they do not redefine settled payout truth.

## Settings audit

Read `GET /api/manager/settings-audit` or the `audit` object inside `GET /api/manager/state`.

State meanings:

- `implemented`: enforced in current runtime behavior
- `partial`: exposed and partly enforced, but not yet full strategic behavior
- `missing`: declared but not enforced

Current counts:

- `implemented`: 17
- `partial`: 5
- `missing`: 0

| Setting | State | Current behavior | Gap |
| --- | --- | --- | --- |
| `asset` | `implemented` | Baseline candidate asset when `allowedAssets` is empty. | None. |
| `amount` | `implemented` | Baseline amount and fallback amount-generation anchor. | None. |
| `maxCandidates` | `implemented` | Caps candidates examined per cycle. | None. |
| `maxMs` | `implemented` | Caps time spent examining candidates per cycle. | None. |
| `pollMs` | `implemented` | Controls session polling loop. | None. |
| `maxThrowsPerGame` | `implemented` | Enforced before candidate search. | None. |
| `maxThrowsPerSession` | `implemented` | Auto-pauses live throwing when reached. | None. |
| `minMillisBetweenLiveThrows` | `implemented` | Cooldown gate between live submissions. | None. |
| `minGameStakeUsd` | `implemented` | Excludes low-stake games before selection. | None. |
| `maxSingleThrowUsd` | `implemented` | Rejects oversized single candidates. | None. |
| `maxGameExposureUsd` | `implemented` | Rejects games or candidates that would exceed total exposure. | None. |
| `minThrowUsd` | `implemented` | Rejects undersized candidates. | None. |
| `maxThrowUsd` | `partial` | Shapes generated target sizes and hard-rejects oversized candidates. | Still depends on available price basis data. |
| `riskMode` | `partial` | Changes generated USD target mix for `defensive`, `balanced`, or `aggressive`. | Does not yet change deeper search behavior. |
| `copySlammerWhenSameHoleType` | `partial` | Seeds historical winning trajectories into the candidate pool. | Does not clone current same-hole-type live slammers. |
| `allowedAssets` | `implemented` | Restricts which assets can enter planning. | None. |
| `blockedAssets` | `implemented` | Removes blocked assets before amount generation. | None. |
| `reserveBalanceBase` | `implemented` | Enforced during asset planning and candidate acceptance. | None. |
| `targetBalanceUsd` | `implemented` | Halts live play when known wallet USD reaches target. | Unknown-price balances do not contribute. |
| `targetProfitUsd` | `implemented` | Pauses after realized profit reaches target. | None. |
| `keepAssets` | `partial` | Soft priority boost in asset ordering. | No dedicated routing or retention logic yet. |
| `disposeAssets` | `partial` | Soft priority penalty in asset ordering. | No dedicated disposal or conversion flow yet. |

## Exact eligibility codes

The monitor and manager API use precise compact labels whenever possible.

| Compact label | Meaning |
| --- | --- |
| `TARGET/BAL` | `targetBalanceUsd` gate reached based on known-price wallet value. |
| `TARGET/PNL` | `targetProfitUsd` gate reached from realized profit. |
| `MAX/S` | Session throw cap reached. |
| `COOLDOWN` | Cooldown active globally or across every visible game. |
| `MAX/G` | Every visible game is at the per-game cap. |
| `NO-CAND/BAL` | Balance or reserve limits prevented usable candidate amounts. |
| `NO-CAND/MIN` | Game minimum or min/max sizing rules rejected candidates. |
| `NO-CAND/RISK` | Single-throw cap or game-exposure cap rejected candidates. |
| `NO-CAND/SEARCH` | Candidate search ended without a winner because the search budget stopped it. |
| `NO-CAND/FILTER` | Asset filters, missing price basis, or post-filter rejection removed all candidates. |
| `STAKE/MIN` | Game stake is below `minGameStakeUsd`. |
| `NO-CAND` | Fallback only when a more specific code is unavailable. |

Underlying stable reason codes currently emitted by the agent are:

- `cooldown`
- `per_game_cap`
- `session_cap`
- `target_profit`
- `target_balance`
- `asset_not_allowed`
- `asset_blocked`
- `reserve_balance`
- `no_balance_for_amounts`
- `missing_price_basis`
- `below_game_min_throw`
- `below_min_throw_usd`
- `above_max_throw_usd`
- `above_max_single_throw_usd`
- `above_game_exposure`
- `no_candidates_after_filter`
- `search_budget_stop`
- `below_min_game_stake`
- `no_game`

## Manager API

`GET /api/manager/state` returns the complete manager snapshot:

- `settings`
- `runtime`
- `onboarding`
- `profile`
- `control`
- `audit`
- `overlay`
- `managerCandidateSet`
- `latestEligibility`
- `eligibilityCode`
- `latestCandidates`
- `honestPerformance`

Additional endpoints:

- `GET /api/manager/settings-audit`
- `GET /api/manager/eligibility`
- `GET /api/manager/candidates`
- `GET /api/manager/honest-score`
- `GET /api/manager/reveals`
- `GET /api/manager/overlay`
- `POST /api/manager/overlay`
- `DELETE /api/manager/overlay`
- `GET /api/manager/candidate-set`
- `POST /api/manager/candidate-set`
- `DELETE /api/manager/candidate-set`
- `POST /api/manager/target-game`
- `POST /api/manager/replay-svg`
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/runtime-settings`
- `GET /api/control/status`
- `POST /api/control/action`


## Replay storyboard export

`POST /api/manager/replay-svg` is an explicit on-demand export only. It does not run during normal scan, ranking, or throw submission loops.

Request shape:

```json
{
  "gameId": "<hex>",
  "frames": [0, 240, 960]
}
```

Response highlights:

- `mode: "forecast_storyboard_v1"`
- `exactPhysics: false`
- `finalFrame`
- `selectedFrames[]`
- `frames[]` with inline `svg` payloads

Interpretation:

- this is a storyboard surface for human review or vision-capable managers
- it is built only for the requested frames
- it is not a hidden always-on renderer
- it is not a byte-for-byte raw engine replay stream

## Strategy hooks

Use these manager-visible controls when shaping behavior without bypassing the deterministic planner:

- `settings.doctrinePack`: coarse strategic starting posture for Agent 1. Current packs are `baseline`, `nutjob`, `tough_nut`, `peanut`, and `prof_deez_nutz`.
- `settings.goalWeights`: relative weights for `profitMaxing`, `ladderMaxing`, `selfAwarenessMaxing`, and `discoveryMapping`. They are normalized internally.
- `settings.customStrategy`: persistent named strategy hook stored in settings and runtime state. Use exact short identifiers such as `copy_slammers`, `toughnut_never_lose`, `nutjob_discovery`, `peanut_safe_flow`, or `prof_meta_rotator`.
- `settings.copySlammerWhenSameHoleType`: compatibility alias for the built-in `copy_slammers` behavior.
- `settings.humanLearning.enabled`: turns manual-example learning on or off.
- `settings.humanLearning.learnOwnManualThrows`: when true, recent throws from the agent's own address with missing `data_commit` are treated as human/manual examples instead of standard committed bot throws.
- `settings.humanLearning.addresses`: extra addresses the manager wants Agent 1 to watch for manual-example seeds.
- `settings.humanLearning.maxSeedsPerCycle`: cap on how many recent manual-example seeds are injected into one planning cycle.
- manual examples are candidate seeds, not blind imitation; the deterministic planner still decides whether those lines survive simulation.
- `POST /api/manager/target-game` with `{ "gameId": "<hex>" }`: requests that the next live cycle prefer one exact game if it is eligible.
- `POST /api/manager/target-game` with `{ "clear": true }`: clears the active priority target.

Treat doctrine, goal weights, and `customStrategy` as three different layers:

- doctrine pack: the starting posture
- goal weights: the current objective mix
- custom strategy: the shareable named idea being tested

Treat `customStrategy` as a shareable strategy-profile name, not as raw code injection. Pair it with overlays, candidate sets, manual-example learning, and human-readable notes when you want richer manager behavior.

Built-in starter-pack strategy ids:

- `tough_nut` -> `toughnut_never_lose`
- `nutjob` -> `nutjob_discovery`
- `peanut` -> `peanut_safe_flow`
- `prof_deez_nutz` -> `prof_meta_rotator`
- compatibility hook -> `copy_slammers`

## Doctrine packs and goal weights

Agent 1 now resolves a profile object for both humans and managers. Read `profile` from `GET /api/manager/state` or `GET /api/manager/honest-score`.

Resolved profile fields:

- `doctrinePack`
- `doctrineLabel`
- `doctrineSummary`
- `goalWeights`
- `goalWeightsPct`
- `effective.riskMode`
- `effective.customStrategy`
- `effective.copySlammerWhenSameHoleType`
- `defaultsApplied.*`
- `notes[]`

Current doctrine packs:

- `baseline`: neutral starting posture for establishing empirical truth before stronger doctrine takes over
- `nutjob`: novelty, weird lines, and discovery pressure
- `tough_nut`: stubborn anti-loss posture that keeps pressing live boards that can still be saved
- `peanut`: survivability, smaller posture, and cleaner calibration
- `prof_deez_nutz`: meta-doctrine that watches styles and composes hybrids

Practical reading of those packs:

- `baseline` is the clean lab coat. Use it when you want trustworthy baseline truth more than personality.
- `nutjob` is the mapper. Use it when the board is teaching something new and you want the agent to go find it.
- `tough_nut` is the stubborn non-loser. Use it when a live board might still be repaired and you want recovery pressure.
- `peanut` is the conservative calibrator. Use it when bankroll protection and cleaner signal matter more than bravado.
- `prof_deez_nutz` is the meta-operator. Use it when you want to compare styles, compose hybrids, or supervise the whole table as one system.

If you are a human reading this directly, that is already a strong sign you will probably help your manager well. Use doctrine as a starting posture, not as a cage.

Resolution rules:

- doctrine pack supplies defaults for `riskMode`, `customStrategy`, `copySlammerWhenSameHoleType`, and default goal weights
- explicit settings override doctrine defaults
- goal weights are normalized internally before use
- raw doctrine is not the same thing as live behavior; always inspect `profile.effective.*`

Settings patch example:

```json
{
  "doctrinePack": "peanut",
  "goalWeights": {
    "profitMaxing": 40,
    "ladderMaxing": 15,
    "selfAwarenessMaxing": 30,
    "discoveryMapping": 15
  },
  "customStrategy": "late_diehard_pressure"
}
```

Use doctrine packs as starting positions, not as hard identity locks. The manager should still evolve, rename strategies, and fork its own direction when the evidence supports it.

## Tactical overlay contract

`ManagerTacticalOverlay` supports these exact fields:

- `id`
- `updatedAt`
- `preferredHoleTypes`
- `blockedHoleTypes`
- `preferredHoleTypeBonus`
- `blockedHoleTypePenalty`
- `holeTypeScoreDeltas`
- `assetScoreDeltas`
- `candidateSourceScoreDeltas`
- `pnlBiasUsd`
- `winnerValuePctBias`
- `candidateScoreDeltas`
- `expiresAt`
- `notes`

Example:

```json
{
  "id": "manager-overlay",
  "preferredHoleTypes": [7],
  "blockedHoleTypes": [1],
  "holeTypeScoreDeltas": { "7": 25000 },
  "assetScoreDeltas": {
    "0101010101010101010101010101010101010101010101010101010101010101": 5000
  },
  "candidateSourceScoreDeltas": { "manager": 1500 },
  "pnlBiasUsd": 0.15,
  "winnerValuePctBias": 2.5,
  "candidateScoreDeltas": { "8f7f6e5d4c3b2a19": 12000 },
  "notes": ["Prefer hole type 7 while still preserving raw predictions."]
}
```

Overlay application is bounded:

- `basePrediction` remains the canonical raw prediction view.
- `managerAdjustedPrediction` is an overlay view only.
- `baseScore` remains the raw score.
- `adjustedScore` is used only for tactical ranking after overlay application.

## Manager candidate-set contract

`ManagerCandidateSet` lets the manager submit exact next-throw candidates and exact future simulated continuations from the current game state onward.

Top-level fields:

- `id`
- `updatedAt`
- `expiresAt`
- `notes`
- `candidates[]`

Each `ManagerCandidateSpec` supports:

- `id`
- `label`
- `x`
- `y`
- `angleDeg`
- `speedPct`
- `spinPct`
- `asset`
- `amount`
- `enabled`
- `tags`
- `notes`
- `futureScenarios[]`

Each `ManagerFutureScenario` supports:

- `id`
- `label`
- `weight`
- `futureThrows[]`
- `notes`

Each `ManagerFutureThrowSpec` supports:

- `id`
- `label`
- `user`
- `x`
- `y`
- `angleDeg`
- `speedPct`
- `spinPct`
- `asset`
- `amount`
- `enterFrameOffset`
- `acceptedAtHeightOffset`
- `enabled`
- `tags`
- `notes`

Example:

```json
{
  "id": "manager-candidate-set",
  "notes": ["Test one exact next throw with one exact continuation branch."],
  "candidates": [
    {
      "id": "candidate-a",
      "label": "Manager next throw",
      "x": 0.13,
      "y": 0.41,
      "angleDeg": 182,
      "speedPct": 64,
      "spinPct": 18,
      "asset": "0101010101010101010101010101010101010101010101010101010101010101",
      "amount": "1000000",
      "enabled": true,
      "futureScenarios": [
        {
          "id": "follow-up-1",
          "weight": 1,
          "futureThrows": [
            {
              "id": "future-1",
              "x": 0.52,
              "y": 0.24,
              "angleDeg": 95,
              "speedPct": 58,
              "spinPct": 11,
              "asset": "0101010101010101010101010101010101010101010101010101010101010101",
              "amount": "1000000",
              "enabled": true
            }
          ]
        }
      ]
    }
  ]
}
```

Important behavior:

- The manager candidate is still the proposed next throw being evaluated.
- Future throws are appended only inside planner simulation.
- The candidate hash is derived from exact candidate fields and is used for logging and optional overlay deltas.
- Manager candidate sets create simulated candidate inputs only. They do not bypass the deterministic sim or execution path.

## Logging and monitor visibility

Runs and throws now preserve manager-visible audit data so later analysis can use the exact same evidence:

- `eligibilityCode`
- `eligibility`
- `basePrediction`
- `managerAdjustedPrediction`
- `baseScore`
- `adjustedScore`
- `overlay`
- `candidateHash`
- `topDetailed`

The official `monitor.html` uses these exact values to improve supervision:

- precise eligibility column labels such as `NO-CAND/BAL` and `NO-CAND/SEARCH`
- clearer manager and action feed wording
- manager overlay and manager candidate-set visibility
- HPS commit/reveal supervision through the intuition lens and coverage views
- selected-game analytics for board context, payouts, and throw history

## Claw wrapper locations

Repo-local wrapper paths:

- Codex or OpenClaw-style plugin bundle: `plugins/collider-agent-claw`
- Core skill: `plugins/collider-agent-claw/skills/collider-agent-manager`
- NanoClaw or Claude-style adapter: `.claude/skills/collider-agent-manager`
- Hermes-native skill: `.hermes/skills/productivity/collider-agent-manager`
- Hermes project plugin: `.hermes/plugins/collider-agent-hermes`
- Marketplace entry: `.agents/plugins/marketplace.json`

Use the core plugin skill as the canonical workflow. The Claude-style and Hermes-style adapters are intentionally thin and point back to the same shared references.

Practical runtime mapping:

- NanoClaw and Claude should load the Claude-style adapter.
- IronClaw should load the existing OpenClaw-family plugin bundle.
- Hermes should load the repo-local project plugin and use its bundled `collider-agent-manager` skill.

Hermes note:

- project-local plugins under `./.hermes/plugins/` require `HERMES_ENABLE_PROJECT_PLUGINS=true`
- Hermes plugins are opt-in, so `collider-agent-hermes` still needs to be enabled in Hermes config or through the Hermes plugin UI or CLI
- the project plugin registers the same repo-local skill file instead of duplicating Collider workflow logic

## Operating boundary

The manager can do these things in v1:

- inspect state, settings, and diagnostics through the manager API
- bias candidate ranking through tactical overlays
- inject exact simulated next-throw candidates
- inject exact simulated future throw sequences after a candidate

The manager cannot do these things in v1:

- overwrite `basePrediction`
- relabel overlay data as canonical VM output
- inject raw live throw payloads directly into execution
- bypass the deterministic sim path

## Honest-performance supervision

Reasoning-model managers should use the same exact commit/reveal evidence as the human monitor:

- `GET /api/manager/honest-score` returns the latest and recent HPS rows, including headline/layer metrics, resolved `profile`, empirical `baseline`, and artifact references.
- `GET /api/manager/reveals?includeArtifacts=1` returns the exact reveal and commit JSON payloads for model-side analysis, replay, or ladder construction.
- `honestPerformance` inside `GET /api/manager/state` gives a lightweight summary for first-pass inspection before deeper artifact reads.

Important distinction:

- raw HPS headline and raw layer scores are the canonical truth surface
- `baseline` is an agent-local calibration overlay derived from this agent's own earliest scored rows until the start state stabilizes
- baseline includes explicit calibration status, rows consumed, and stabilized-metric counts so the manager can see when Agent 1's start state is actually locked
- baseline lift should be interpreted as `outperforming or underperforming the calibrated start state`, never as a replacement for the raw score

This keeps the manager path exact: models can start from `/api/manager/state`, inspect HPS status immediately, then pull full reveal artifacts only when they need the underlying temporal or throw-level detail.
