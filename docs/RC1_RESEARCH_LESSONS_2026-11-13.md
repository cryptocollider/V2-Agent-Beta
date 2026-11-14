# Recent Agent1 evidence and research lessons

These are scoped observations and software lessons, not a leaderboard of proven strategies. The [machine-readable checkpoints](qualification/doctrine-comparisons-20261113.json) contain exact base-unit results, timing, source-audit digests and limitations. Private profiles, wallet identities and signed journals are not release inputs.

## Earlier comparisons

The nominal eight-hour comparison stopped after roughly5h12m; a later four-hour test had an interruption, and another seeded test was cut short by a PC restart after about1h56m. Their recovered results belong to those observed windows, not to their planned duration. Peanut and Prof led different small cohorts. Deterministic doctrine scoring was active; these were not random-versus-LLM trials. A winner's overall profit cannot be attributed to a handful of manager interventions.

On13November, the accelerated30-minute comparison accepted100 throws per doctrine (400 total), all settled at its saved audit. Verified selection changes were2/4/9/1 for ToughNut/Peanut/NutJob/Prof. The later accelerated four-hour window completed800 per doctrine (3,200 total);3,192 were settled at the saved checkpoint, with eight pending. Selection changes were11/16/31/4. It stopped at the approved deadline, rather than halfway through. One earlier UI round-limit pause was repaired during that window; the originally linked older comparison page and its time axis were also corrected.

| Four-hour checkpoint | Settled throws | Settled net CLC | Throw-attributed points |
| --- | ---: | ---: | ---: |
| ToughNut | 799 | -91.375214 | 1083 |
| Peanut | 798 | +209.361143 | 1010 |
| NutJob | 797 | -214.228000 | 1123 |
| Prof DeezNutz | 798 | +45.142071 | 1050 |

Pending principal is excluded from realized net. Activity and board states differed, agents interacted, and future throws changed payoffs. This supports operational comparison, not a causal explanation of Peanut's profit lead.

## Two-hour research window

The13November19:22:31–21:22:31 Perth window added durable notebooks, outcome joins, broader16-control previews, real search choices and bounded new controls. Early pilots exposed quota polling overshoot, stale runtime settings and growing-context problems. They were paused and repaired; all accepted pilots remained inside the original400-per-wallet allowance, with no deadline extension. The last controller ran66.64 minutes without a pre-deadline fault. This was not two hours of uninterrupted play.

| Doctrine | Accepted | Settled at audit | Settled net CLC | Actual selection changes |
| --- | ---: | ---: | ---: | ---: |
| ToughNut | 54 | 53 | +8.394 | 3 |
| Peanut | 54 | 53 | +1.795 | 5 |
| NutJob | 95 | 90 | +20.869 | 7 |
| Prof DeezNutz | 55 | 54 | -38.718 | 8 |

All258 accepted throws were on Classic at4CLC. Of those,250 had matched local HPS results; eight remained in one independently confirmed Open native game. All four were paused, wallet nonces reconciled and pending signed-operation flags clear at the final check. Four late policy updates were rejected by the deadline guard; no late policy application or replay was authorized.

ToughNut consistently simulated240 candidates/480 scenarios per submitted plan, versus Peanut60/120. The other two managers varied their budgets. NutJob proposed27 unique bounded novel controls and selected seven in live throws. ToughNut and Prof revised some hypothesis confidence downward after disappointing comparisons. These were measured behavior changes, not proof of better profit or model probability calibration.

## Operational changes retained in RC1

1. **Advice must reach execution.** Bind candidate hashes to exact controls, reserve them in the next finite search, freshly simulate the current canonical board, and record proposed/eligible/simulated/scored/selected/accepted/settled separately. Changing a score is not the same as changing a shot.
2. **Memory must be scientific.** Retain a falsifiable hypothesis across several episodes; join actions to actual settled outcomes and preserve negative results. A pending result is unknown, not a zero return. Review older hypotheses when their late settlements arrive.
3. **Compute and activity must be real controls.** ToughNut searches harder inside the approved CPU/time budget. Peanut covers unplayed eligible allowed games, prioritizing higher value after explicit map priorities. The research harness lets managers choose0–4 entries and1x/2x/4x search; ordinary play retains normal user budgets.
4. **The signer enforces quotas.** Runtime per-window ceilings and an independent remaining process allowance prevent polling races from authorizing an extra entry. Re-read runtime settings after result reconciliation and check the control epoch/settings/remaining quota immediately before signed preparation. A clean reload accounts for already used allowance.
5. **Inference needs a bounded data contract.** Persist full evidence outside the prompt. Send recent joined cases, compact metrics and one copy of approved controls; bound growth as hypotheses accumulate. Do not solve context overflow by removing safety checks or silently dropping durable history.
6. **A completed inference gets an actual activity window.** In research mode, start the60-second action window after the decision is ready, bounded by the fixed deadline. Preview and inference time do not consume that action window. Therefore the full decision cycle can exceed60seconds.
7. **Cleanup is not a failed financial action.** A temporary-directory cleanup error must not trigger inference replay or wallet replay. Serialize settings writes, preserve stop semantics, restore temporary search/risk settings, and audit the latest controller generation rather than an earlier pilot's terminal event.
8. **Displayed games need durable related data.** Accepted per-game history must not be reconstructed only from the last100 throws. Preserve complete related records for displayed games, default the game window to100 with navigation, prioritize durable settlement, and refresh comparison totals after trading stops.
9. **Pricing and physics stay authoritative.** Use VM-compatible exact arithmetic/rounding and current usable oracle data. Missing decimal metadata may augment hypothetical planning from the authoritative asset catalog; never mutate a frozen confirmation input, revive stale prices from history or copy expected hashes.
10. **Track wallet operations correctly.** Throw counts are not the wallet nonce. Confirmed conversions, names and other signed operations need their own audit and reconciliation. Ambiguous signed work is a hold, never permission to reuse a nonce.
11. **Publishing has separate proof levels.** Durable delivery ACK, verified HPS and actual content retention are separate. Default-off activation and explicit bounded historical export avoid silent replay; pinning quotas are not the same as billing/global account quota.

## Experimental interpretation

Counterbalanced baseline/treatment windows share manager-chosen activity and compute. Baseline removes LLM ranking and novel controls, not all manager influence. Boards, opponents and accepted sample counts change; this is not a randomized complete LLM-off ablation. Confidence can be revised after at least four settled throws per arm, but remains a manager belief rather than statistical significance. Most deterministic choices remained unchanged. Per-candidate point forecasts are unavailable; use actual matched awards.

The fixed4CLC tests do not prove large-stake ValueTier behavior, generalize to every map, or establish a perfect shot. The Classic supply was often narrow, so Peanut's value-priority branch has stronger unit-test coverage than live comparative evidence. Repeat on held-out boards, matched activity/capital risk and several independent cohorts before promoting a strategy.

## Performance checkpoint

Instrumented player/preview RPC logs in the research window recorded51,015 requests with no recorded transport failures. Per-player p50 was about321ms, p95 about943–951ms and p99 about1.26–1.28s. Counts include idle polling and reconciliation; controller direct RPC reads are excluded. They are not pure per-throw efficiency measurements. Sampled local summaries were roughly3–40ms and notebook requests85–125ms. Deeper simulation cost several seconds and was measured separately from RPC latency.

No new optimized VM endpoint or backend/VPS change was deployed by these client refinements. The RPC optimization proposal remains a proposal; instrument, batch and reduce redundant reads before claiming a throughput or fairness improvement.
