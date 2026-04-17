# Collider Manager Operating Boundaries

## Keep labels exact

- Use exact setting names, reason codes, compact eligibility labels, asset ids, and candidate hashes.
- Do not compress `NO-CAND/BAL`, `NO-CAND/MIN`, `NO-CAND/RISK`, `NO-CAND/SEARCH`, or `NO-CAND/FILTER` into a generic `NO-CAND` when the specific code exists.
- Do not describe a `partial` setting as fully implemented.

## Keep simulation honest

- Treat `basePrediction` as the canonical VM-aligned prediction view.
- Treat `managerAdjustedPrediction` as a tactical overlay view only.
- Do not overwrite or relabel base results with adjusted values.

## Keep manager authority bounded

- The manager may update tactical overlays.
- The manager may set a persistent named custom strategy such as `customStrategy=copy_slammers`.
- The manager may submit exact candidate sets and exact future throw scenarios for simulation.
- The manager may request a priority target game for the next cycle, but that target is still bounded by eligibility and deterministic planning.
- The manager may not bypass the deterministic sim path.
- The manager may not inject raw live throw payloads directly into execution.
- The manager may not claim a future scenario is the actual future; it is only a simulated continuation from the current game state forward.

## Prefer explicit gaps over fake fallbacks

- If price basis data is missing, say `missing_price_basis`.
- If known-balance USD cannot be derived, say so directly.
- If a setting has a gap, name the gap instead of hiding it behind a success label.
