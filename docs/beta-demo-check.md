# Public beta demo verification

Verified on 28 September 2026 against the public beta backend, from commit `e0885ed` plus the local fixes in this checkout. This is the source/Node release, not RC1.

## Start the demo

Use Node.js 22 or newer with npm. From the repository root:

```sh
npm ci
npm start
```

Open http://localhost:8787. Startup compiles automatically. No wallet setup, AI model, or AI API key is required for baseline beta play. The starter address remains blank in the release; first launch creates the operator identity and requests 1,000 beta USDC. Allow a few seconds for funding to settle and the next scan to run.

If another agent owns port 8787:

```sh
npm start -- --monitor-port 8788
```

Use `--data-dir ./data-demo` as well if the demo should have its own identity and logs. Keep that directory to reuse the identity on the next launch. A normal launch starts live beta play; `--dry-run` prevents throw submission but first-run funding still happens.

## Verified

- Fresh `npm ci`, TypeScript build, and all 47 regression tests on Windows using portable Node 22.23.3 / npm 10.9.9.
- Dependency audit: zero reported vulnerabilities after compatible lockfile updates.
- Public beta asset metadata, live game discovery, canonical simulation input, balances, token request, throw submission, and game-report RPCs.
- A new isolated identity received 1,000 beta USDC. One 11.5-USDC test throw with a prediction commit was accepted and confirmed in canonical game input. Remaining wallet balance: 988.5 USDC.
- The live loop automatically paused at the one-throw session limit. No further live test throws were sent.
- The bundled, unchanged `sim_core.wasm` reproduced all 11 throw outcomes in resolved game `0xfbc8c8e146f3dea1000000000000000000000000000000000000000000000000` exactly: throw IDs, hole types, hole indices, and end frames matched the backend report.
- Headless Chromium rendered onboarding, Honest Score, Games Review, Bank, Settings, and Throws Resolved without JavaScript errors or failed requests. The bank showed the funded balance and the submitted throw appeared in Games Review.
- Monitor fallback when the agent bridge stalls, saved settings with pending runtime sync, and occupied-port startup are covered by regression tests.

## Fixes in this revision

- Replaced the dead starter RPC chain URL (404) with the already-existing, verified built-in beta endpoint: `https://v2.cryptocollider.com:4430/ext/bc/2H2YX6uB4sMcu9iXARdL7erKU278Z564bYNWDCMJHyB1pK54Fo/collider_v2`.
- Aligned the starter base amount to the built-in 11-USDC beta default.
- Excluded archived backup TypeScript files that broke clean compilation; retained the historical source files.
- Added a cross-platform test command, Node prerequisite, and automatic builds for once/headless startup.
- Updated compatible `ws` and `tsx`/`esbuild` lockfile versions.
- Bounded monitor read fallbacks and settings-save synchronization; stale local runtime state no longer overrides file-backed settings after a bridge timeout.
- Made occupied-port startup reject cleanly.
- Synchronized welcome-dialog dismissal with the running agent so it stays dismissed after a browser reload.
- Clarified the expected waiting state before the first settled game and corrected README references to adapter directories absent from this public checkout.
- Corrected an HPS test fixture whose layer drift exceeded its claimed stability threshold, and added a separate drifting-layer test. HPS scoring and calibration behavior were not changed.

## Limits for the presenter

The new test throw's game remains open. Its eventual settlement, payout, and live HPS reveal were not observed; historical replay parity and the settlement/HPS regression tests passed. Fresh accounts legitimately show pending scores until games settle.

The monitor still loads Chart.js from its existing CDN. Public RPC and CDN access are required. Optional AI providers were tested through existing mocked tests, not with paid API calls or a newly installed local model.

Native desktop installers were not built or validated; this public checkout lacks the Tauri `src-tauri` project. Use the verified Node workflow for the demo.

All smoke-test identities, logs, and browser screenshots are isolated under ignored `.demo-check/`; release `data/settings.json` remains a fresh starter. No RC1 source or backend changes were made, and verification did not modify the remote repository.
