# Collider Manager API Quick Reference

Use this alongside the startup references when the manager is ready to inspect or control the live agent.

## Canonical endpoints

Start with `GET /api/manager/state`. It returns the full manager snapshot:

- `settings`: persisted settings from `data/settings.json`
- `runtime`: live runtime settings snapshot
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

- `settings.customStrategy`: persistent named strategy hook stored in settings/runtime state. Use exact short identifiers such as `copy_slammers`.
- `settings.copySlammerWhenSameHoleType`: compatibility alias for the built-in `copy_slammers` behavior.
- `POST /api/manager/target-game` with `{ gameId: <hex> }`: requests that the next live cycle prefer one exact game if it is eligible.
- `POST /api/manager/target-game` with `{ clear: true }`: clears the active priority target.

Treat `customStrategy` as a shareable strategy-profile name, not as raw code injection. Pair it with overlays, candidate sets, and notes when you need richer manager behavior.

## Honest-performance and reveal endpoints

Use these when supervising the HPS commit/reveal system directly:

- `GET /api/manager/honest-score`: latest and recent HPS rows with headline score, layer metrics, and artifact references.
- `GET /api/manager/honest-score?includeArtifacts=1`: also includes the exact `revealPayload` and `commitPayload` JSON bodies for the latest and recent rows.
- `GET /api/manager/reveals?gameId=<hex>&includeArtifacts=1`: filters to one game and returns the exact reveal/commit JSON payloads for model-side replay or ladder construction.
- `GET /api/manager/reveals?decisionId=<hex>&includeArtifacts=1`: isolates one decision and its associated reveal artifacts.

Treat these endpoints as the canonical model-facing supervision path for HPS. They expose the same evidence the monitor uses, but in API form rather than UI form.