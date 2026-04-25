# Collider Manager API Quick Reference

Use this alongside the startup references when the manager is ready to inspect or control the live agent.

## Canonical endpoints

Start with `GET /api/manager/state`. It returns the full manager snapshot:

- `settings`: persisted settings from `data/settings.json`
- `runtime`: live runtime settings snapshot
- `onboarding`: bootstrap summary for zero-flag beta startup, test-token request state, and manual-learning defaults
- `profile`: resolved doctrine, goal mix, and effective strategy posture
- `control`: live control state
- `audit`: settings audit report with `counts` and `matrix`
- `overlay`: active `ManagerTacticalOverlay` or `null`
- `managerCandidateSet`: active `ManagerCandidateSet` or `null`
- `latestEligibility`: latest eligibility snapshot
- `eligibilityCode`: compact label derived from `latestEligibility`
- `latestCandidates`: latest ranked candidate context
- `honestPerformance`: lightweight latest HPS/reveal summary

Additional routes:

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
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/runtime-settings`
- `GET /api/control/status`
- `POST /api/control/action`

## Compact eligibility labels

Use these labels exactly as written:

- `TARGET/BAL`: target wallet value reached
- `TARGET/PNL`: target realized profit reached
- `MAX/S`: session throw cap reached
- `COOLDOWN`: cooldown active
- `MAX/G`: every visible game is at the per-game session cap
- `NO-CAND/BAL`: reserve or balance limits blocked candidate construction
- `NO-CAND/MIN`: game minimum or min/max throw sizing blocked candidates
- `NO-CAND/RISK`: single-throw cap or total exposure cap blocked candidates
- `NO-CAND/SEARCH`: candidate search stopped before a winner was chosen
- `NO-CAND/FILTER`: asset filters, missing price basis, or post-filter rejection blocked candidates
- `STAKE/MIN`: game stake below configured minimum
- `NO-CAND`: fallback when a more specific label is unavailable

## Settings audit states

- `implemented`: enforced in current runtime behavior
- `partial`: exposed and partly enforced, but not yet full strategic behavior
- `missing`: declared but not enforced

Current audit counts:

- `implemented`: 17
- `partial`: 5
- `missing`: 0

## Tactical overlay fields

`ManagerTacticalOverlay` supports:

- `id`, `updatedAt`, `expiresAt`, `notes`
- `preferredHoleTypes`, `blockedHoleTypes`
- `preferredHoleTypeBonus`, `blockedHoleTypePenalty`
- `holeTypeScoreDeltas`
- `assetScoreDeltas`
- `candidateSourceScoreDeltas`
- `pnlBiasUsd`
- `winnerValuePctBias`
- `candidateScoreDeltas`

Overlay effects are applied after base scoring and before winner selection. They change `adjustedScore` and `adjustedPrediction`, never `baseScore` or `basePrediction`.

## Manager candidate set fields

`ManagerCandidateSet` supports:

- `id`, `updatedAt`, `expiresAt`, `notes`
- `candidates[]`

Each `ManagerCandidateSpec` supports:

- `id`, `label`, `x`, `y`, `angleDeg`, `speedPct`, `spinPct`
- `asset`, `amount`, `enabled`, `tags`, `notes`
- `futureScenarios[]`

Each `ManagerFutureScenario` supports:

- `id`, `label`, `weight`, `futureThrows[]`, `notes`

Each `ManagerFutureThrowSpec` supports:

- `id`, `label`, `user`
- `x`, `y`, `angleDeg`, `speedPct`, `spinPct`
- `asset`, `amount`
- `enterFrameOffset`, `acceptedAtHeightOffset`
- `enabled`, `tags`, `notes`

Manager candidates are tagged with `source: "manager"` and hashed from exact candidate fields. Future throws are appended after the candidate when planner scenarios are simulated, but the candidate remains the proposed next throw being evaluated.

## Manager strategy hooks and priority targeting

Use these controls when the manager wants to shape execution without bypassing the deterministic planner:

- `settings.customStrategy`: persistent named strategy hook stored in settings/runtime state. Use exact short identifiers such as `copy_slammers`, `toughnut_never_lose`, `nutjob_discovery`, `peanut_safe_flow`, or `prof_meta_rotator`.
- `settings.copySlammerWhenSameHoleType`: compatibility alias for the built-in `copy_slammers` behavior.
- `settings.humanLearning.enabled`: turns manual-example learning on or off.
- `settings.humanLearning.learnOwnManualThrows`: lets the agent mine its own manual throws with missing `data_commit` as example seeds.
- `settings.humanLearning.addresses`: additional addresses to watch for manual-example seeds.
- `settings.humanLearning.maxSeedsPerCycle`: cap on injected manual-example seeds per planning cycle.
- `POST /api/manager/target-game` with `{ gameId: <hex> }`: requests that the next live cycle prefer one exact game if it is eligible.
- `POST /api/manager/target-game` with `{ clear: true }`: clears the active priority target.

Treat `customStrategy` as a shareable strategy-profile name, not as raw code injection. Pair it with overlays, candidate sets, and notes when you need richer manager behavior.

Built-in starter-pack strategy ids:

- `tough_nut` -> `toughnut_never_lose`
- `nutjob` -> `nutjob_discovery`
- `peanut` -> `peanut_safe_flow`
- `prof_deez_nutz` -> `prof_meta_rotator`
- compatibility hook -> `copy_slammers`

## Doctrine packs and goal weights

Use these exact settings fields when shaping Agent 1 posture:

- `settings.doctrinePack`
- `settings.goalWeights.profitMaxing`
- `settings.goalWeights.ladderMaxing`
- `settings.goalWeights.selfAwarenessMaxing`
- `settings.goalWeights.discoveryMapping`

Use `profile` when you want the resolved answer after defaults and overrides are applied.

Current doctrine ids:

- `baseline`
- `nutjob`
- `tough_nut`
- `peanut`
- `prof_deez_nutz`

Interpretation:

- doctrine pack = coarse strategic posture
- goal weights = objective vector
- custom strategy = shareable named idea

Persist settings changes through `POST /api/settings`. Example:

```json
{
  "doctrinePack": "tough_nut",
  "goalWeights": {
    "profitMaxing": 55,
    "ladderMaxing": 15,
    "selfAwarenessMaxing": 20,
    "discoveryMapping": 10
  },
  "customStrategy": "toughnut_never_lose"
}
```

## Honest-performance and reveal endpoints

Use these when supervising the HPS commit/reveal system directly:

- `GET /api/manager/honest-score`: latest and recent HPS rows with headline score, layer metrics, resolved `profile`, empirical `baseline`, and artifact references.
- `GET /api/manager/honest-score?includeArtifacts=1`: also includes the exact `revealPayload` and `commitPayload` JSON bodies for the latest and recent rows.
- `GET /api/manager/reveals?gameId=<hex>&includeArtifacts=1`: filters to one game and returns the exact reveal/commit JSON payloads for model-side replay or ladder construction.
- `GET /api/manager/reveals?decisionId=<hex>&includeArtifacts=1`: isolates one decision and its associated reveal artifacts.
- `POST /api/manager/replay-svg` with `{ "gameId": "<hex>", "frames": [0, 240, 960] }`: explicit on-demand storyboard SVG export for selected replay frames only. It returns inline SVG strings and never runs during normal scan or throw-selection cycles. The response includes `mode: "forecast_storyboard_v1"`, `exactPhysics: false`, `finalFrame`, `selectedFrames`, and a `frames[]` array of inline SVG payloads for exactly the requested frames.

Treat these endpoints as the canonical model-facing supervision path for HPS. Keep raw HPS separate from empirical baseline lift: raw scores are the canonical truth surface, while baseline lift only answers whether this agent is outperforming or underperforming its own calibrated start state. The returned baseline object now also exposes calibration status, rows consumed, and stabilized-metric counts so the manager can tell whether Agent 1 is still bootstrapping or already locked. They expose the same evidence the monitor uses, but in API form rather than UI form.
## Zero-flag startup and manual-example learning

For fresh beta operators, start by reading `onboarding` from `GET /api/manager/state`. That object tells you:

- whether Agent 1 auto-generated the beta user
- which zero-flag startup mode is active
- the default human launch command
- which asset and amount became the startup default
- whether test tokens were already requested
- the exact token-request state: pending, requested, or failed
- whether the welcome guide is still pending in the monitor
- the starter question for baseline/careful/stubborn/exploratory/hybrid posture selection
- the exact doctrine mapping for those starter styles
- whether manual-example learning is enabled and which addresses are being watched

If onboarding says the token request failed, report that plainly and guide the human to the Bank page `Request Test Tokens` button.

If human/manual-example learning is enabled, recent throws with missing `data_commit` can be treated as bounded candidate seeds rather than ignored noise. This is the simplest human + AI co-play surface in Agent 1: the human can demonstrate, the manager can inspect, and the deterministic planner can decide whether that example survives simulation. The manager should describe this as supervised learning from examples, not as copy-the-human mode.
