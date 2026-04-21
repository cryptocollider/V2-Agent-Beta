---
name: collider-agent-manager
description: Operate the local Collider manager API for this repo, including settings audits, eligibility diagnostics, tactical overlays, manager candidate sets, and honest-performance supervision. Use when Codex or an OpenClaw-compatible skill needs to inspect or control the Collider agent through http://localhost:8787/api/manager/*, explain monitor data, or prepare precise candidate and future-scenario payloads without bypassing the deterministic sim core.
---

# Collider Agent Manager

Read `references/manager-api.md` first for the exact endpoints, payloads, and compact eligibility labels. Read `references/operating-boundaries.md` before changing overlays or manager candidate sets.

For first-contact manager sessions, also read these startup references before touching live strategy:

- `references/game-mechanics.md`
- `references/blackhole-dynamics.md`
- `references/strategy-implications.md`
- `references/intuition-lens.md`
- `references/progression-map.md`
- `references/doctrine-packs.md`
- `references/manager-reporting.md`

## Workflow

1. Read `GET /api/manager/state` first. Treat it as the source of truth for `settings`, `runtime`, resolved `profile`, `control`, `audit`, `overlay`, `managerCandidateSet`, `latestEligibility`, `eligibilityCode`, `latestCandidates`, and the lightweight `honestPerformance` summary.
2. Use exact names and codes from the API. If the manager state says `NO-CAND/BAL`, `above_max_throw_usd`, or `customStrategy`, repeat those exact labels instead of paraphrasing them into vaguer language.
3. Keep raw and manager-adjusted views separate. `basePrediction` and `baseScore` describe the VM-aligned or unadjusted result. `managerAdjustedPrediction` and `adjustedScore` describe the tactical overlay view only.
4. Use `/api/manager/settings-audit` or the `audit.matrix` in manager state when explaining settings. Distinguish `implemented`, `partial`, and `missing` exactly as reported.
5. Use `/api/manager/overlay` only for bounded ranking influence. The overlay can bias scores and prediction displays, but it must not be described as a raw throw injector or execution bypass.
6. Use `/api/manager/candidate-set` when the manager wants to submit exact test candidates or exact future throw sequences for simulation. Each manager candidate is still just the proposed next throw, and its `futureScenarios` only extend the simulated game state after that candidate.
7. Use `POST /api/manager/target-game` when the manager wants to focus the next live throw cycle on one specific game. It is a bounded preference, not an execution bypass: if the targeted game is not eligible, the agent should report that precisely instead of forcing a throw.
8. Treat `settings.doctrinePack` as the coarse starting posture, `settings.goalWeights` as the current objective mix, and `settings.customStrategy` as the persistent named strategy hook. Use short exact identifiers such as `copy_slammers`, plus notes or overlays alongside it; do not describe any of them as arbitrary executable code injection.
9. Use `GET /api/manager/honest-score` when supervising HPS or intuition-lens behavior. Keep raw HPS separate from empirical baseline lift. Use `GET /api/manager/reveals?includeArtifacts=1` when you need the exact reveal and commit JSONs, including throw-level and temporal traces.
10. Prefer direct API evidence over inference. When a value is missing, say it is missing instead of inventing a fallback.

## Startup sequence

Use this sequence when a fresh manager first loads the agent:

1. Read `references/game-mechanics.md` to understand what Collider measures, what the hole rules do, and what is or is not known at throw time.
2. Read `references/blackhole-dynamics.md` before managing blackhole-enabled maps or any board where teleport dynamics matter.
3. Read `references/strategy-implications.md` before changing settings, overlays, candidate sets, or `customStrategy`.
4. Read `references/intuition-lens.md` before using HPS as a supervisor. Treat HPS as the introspection north star, not as a substitute for real chain outcomes.
5. Read `references/progression-map.md` to frame current weaknesses as a growth path instead of as one-off errors.
6. Read `references/doctrine-packs.md` before changing doctrine, goal weights, or custom strategy naming.
7. Read `references/manager-reporting.md` before summarizing strategy to the human. The manager should expose state, hypotheses, actions, and unknowns in a way the human can meaningfully collaborate with.
8. Only then begin live control changes through the manager API.

## Human collaboration

- Report exact state and exact labels first, then interpretation.
- Treat the human as a strategy partner when they want involvement; offer current diagnosis, active hypothesis, and next bounded experiments.
- Use `customStrategy`, overlays, and manager candidate sets as shareable strategy artifacts that can be named, reviewed, iterated, and compared over time.
- Let Collider itself motivate the manager. Do not over-explain why the manager should care about HPS or self-correction; provide the measurable path and let the evidence do the work.

## PowerShell Quick Start

```powershell
Invoke-RestMethod 'http://localhost:8787/api/manager/state'
Invoke-RestMethod 'http://localhost:8787/api/manager/settings-audit'
Invoke-RestMethod 'http://localhost:8787/api/manager/eligibility'
Invoke-RestMethod 'http://localhost:8787/api/manager/candidates'
Invoke-RestMethod 'http://localhost:8787/api/manager/honest-score'
Invoke-RestMethod 'http://localhost:8787/api/manager/reveals?includeArtifacts=1'
```

Post an overlay:

```powershell
$body = @{
  id = 'manager-overlay'
  notes = @('Prefer hole type 7 this cycle')
  preferredHoleTypes = @(7)
  holeTypeScoreDeltas = @{ '7' = 25000 }
  pnlBiasUsd = 0.15
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/api/manager/overlay' -ContentType 'application/json' -Body $body
```

Post a manager candidate set:

```powershell
$body = @{
  id = 'manager-candidate-set'
  notes = @('Test one exact next throw with two future branches')
  candidates = @(
    @{
      id = 'candidate-a'
      x = 0.13
      y = 0.41
      angleDeg = 182
      speedPct = 64
      spinPct = 18
      asset = '0101010101010101010101010101010101010101010101010101010101010101'
      amount = '1000000'
      futureScenarios = @(
        @{
          id = 'follow-up-1'
          weight = 1
          futureThrows = @(
            @{
              id = 'future-1'
              x = 0.52
              y = 0.24
              angleDeg = 95
              speedPct = 58
              spinPct = 11
              asset = '0101010101010101010101010101010101010101010101010101010101010101'
              amount = '1000000'
              enabled = $true
            }
          )
        }
      )
      enabled = $true
    }
  )
} | ConvertTo-Json -Depth 12

Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/api/manager/candidate-set' -ContentType 'application/json' -Body $body
```