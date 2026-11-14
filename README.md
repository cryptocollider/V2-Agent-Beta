<img width="570" height="853" alt="image" src="https://github.com/user-attachments/assets/d711b298-9129-4947-83c3-10b786da1fe4" />

# Collider Agent 1 - Beta

Local Node-based agent player, monitor, and manager API for Collider V2.

**RC1 v0.2.0-rc1.1. Test tokens only.**

Agent 1 is the first baseline agent for the Collider Arena: a starting plate for many future agents, doctrines, managers, and human/AI teams.

It connects to the Collider V2 public Fuji RC1 chain, scans live games, fetches canonical `getSimInput`, simulates candidate throws through the local `sim_core.wasm` deterministic physics engine, submits live throws with prediction commits, and logs exact audit data for later review.

The goal of Agent 1 is not to create the finished intelligent Agent.

The goal is to create the baseline intelligence of pure deterministic brute force (zero predictive sense), and the first measurable loop that a human and/or AI manager may be inserted into (then improvements over baseline reveal manager performance). That measurable loop is:

1. observe the arena
2. simulate possible throws
3. choose a live action
4. commit a prediction
5. resolve the outcome
6. compare performance through replay and Honest Performance Score

Humans and AI are invited into the same challenge.

Who becomes the strongest Collider manager: a human, an AI, or a human+AI team?  
Who can turn physics, prediction, bankroll, doctrine, and replay/auditability into measurable edge?

Now is a good time to get a head start and collect early data.

## What it does

- scans live Collider V2 games
- fetches canonical `getSimInput`
- appends hypothetical throws locally for simulation
- runs the local `sim_core.wasm` planning path
- ranks candidate throws under queue scenarios
- submits live throws with prediction commits
- matches submitted throws back to resolved outcomes
- logs runs, throws, results, predictions, and manager supervision data to JSONL
- serves a local monitor UI and manager API

## Honest Performance Score

Honest Performance Score (HPS) compares what the agent predicted before resolution against what deterministic replay later proves happened. 

It is a replay-grounded, verifiable measure of prediction honesty and performance inside the Collider Arena.

It uses an on-chain commit, and off-chain reveal system, so predictions are immutable but still unknown until after outcomes (and reveal is off-chain). This is to isolate its influence from the points/profit motives (including main ladder ranking) and ensure it remains a separate and accurate measure - of the very hard-to-define edge of 'intuition'.

## Personas and doctrines

Agent 1 ships with early doctrine/persona presets designed to seed strategic diversity rather than declare a solved strategy.

Persona is the readable face.  
Doctrine is the operating posture.

Different human managers, model managers, and local runtime setups can adjust these doctrines over time, creating pressure toward better prediction/self-awareness, bankroll discipline/profits, and improving whole arena intuition.

- **ToughNut — profit:** search harder with more actual simulations; prefer well-researched entries and bounded repairs.
- **Peanut — points:** have a stake in every eligible affordable game, especially higher-value ones, with a planned backup allowance.
- **NutJob — discovery:** test specific new controls and keep both successful and failed experiments.
- **Prof DeezNutz — calibration:** compare forecasts with settled outcomes and revise beliefs.

Choose a seed for a new profile with `npm run start:rc1 -- --doctrine peanut`. These are starting priorities, not proven winners; explicit user limits take precedence. See [the doctrine starters](docs/DOCTRINE_STARTERS.md).

## Current operator surfaces

- Default human monitor: `monitor21.html` (served at `/`)
- Local manager API base: `http://localhost:8787`
- Honest-performance API surfaces: `/api/manager/honest-score` and `/api/manager/reveals`
- Explicit replay storyboard SVG export: `POST /api/manager/replay-svg`
- Agent profile, onboarding/bootstrap summary, and baseline-lift state: `/api/manager/state`
- Points & CLC and Bank: live quotes, balances, wallet security and on-chain agent names
- Optional Gamechain.info / HPS publishing: enable in Settings; off by default
- Full manager docs: `docs/collider-manager.md`
- Repo-local Claw wrapper plugin: `plugins/collider-agent-claw`

## Manager startup pack

Fresh managers should use the repo-local startup references under `plugins/collider-agent-claw/skills/collider-agent-manager/references/`:

- `game-mechanics.md`
- `blackhole-dynamics.md`
- `payout-mechanics.md`
- `strategy-implications.md`
- `intuition-lens.md`
- `progression-map.md`
- `persona-starter-packs.md`
- `doctrine-packs.md`
- `manager-reporting.md`

These are designed to accelerate first-contact managers without replacing self-discovery or bounded experimentation. Raw HPS remains the canonical honesty score; baseline lift is a local calibration overlay on top of that raw truth.

## Manager runtime compatibility

The public checkout includes the shared manager skill and references under
`plugins/collider-agent-claw/skills/collider-agent-manager`.
Point a compatible manager at that skill and the local API described in
`docs/collider-manager.md`. Separate Claude, NanoClaw, and Hermes adapter folders
are not included in this public checkout.

An AI manager is optional. Baseline play, the monitor, test-token funding, and
manual settings work without an API key or local model. Desktop installer
packaging is experimental; use the Node workflow below for public RC1.

## Project layout

- `src/core/` basic RPC, storage, settings, runtime state, manager state
- `src/collider/` Collider-specific types and throw building
- `src/sim/` wasm loader, planner, decode
- `src/strategy/` candidate generation, scoring, tactical overlay, choosing
- `src/agent/` loop, eligibility, settings audit, session, report matching
- `src/monitor/` local HTTP server for the monitor UI and manager API
- `docs/` human-facing manager and supervision docs
- `plugins/collider-agent-claw/` repo-local Claw-compatible plugin bundle

## Install

Install **Node.js 22 or newer with npm**, then open a terminal in this repository. Verify `node --version` and `npm --version` before continuing.

`npm ci` installs the exact dependency versions in the lockfile. Keep development dependencies installed: startup compiles the TypeScript source.

On Linux/macOS, securely set `COLLIDER_AGENT_KEY_PASSWORD` (12–256 characters) before first start and when unlocking. Windows can create its independent encrypted wallet using CurrentUser protection. See [wallet setup and recovery](docs/RC1_QUICKSTART.md).

```bash
npm ci
npm run start:rc1
```

Startup builds automatically. Open **http://localhost:8787** after the terminal prints the monitor address. On Windows, if PowerShell blocks npm's script, use `npm.cmd ci` and `npm.cmd run start:rc1`.

For offline regression checks after dependency installation:

```bash
npm run check
npm test
npm run verify:rc1
```

See [the RC1 release notes](docs/RC1_RELEASE_2026-11-13.md) for verified behavior and remaining qualification gates.

## First start

Run the public RC1 entry point:

```bash
npm run start:rc1
```

For a genuinely new `data-rc1` profile, this explicitly opts into testnet onboarding:

- generate an independent signing wallet and encrypt it outside the repository; no shared wallet or key is bundled
- validate the pinned public Fuji chain, custody route and simulator
- request the external faucet's one-use grant of 4,000 mock CLC plus 0.005 Fuji AVAX
- verify the grant receipts, then approve/deposit the exact CLC grant into the same wallet's Collider L1 account
- preserve the funding and signed-operation journals and begin bounded play when readiness passes
- expose onboarding state to the monitor and `/api/manager/state`

Then open:

- Monitor UI: `http://localhost:8787`
- Manager state snapshot: `http://localhost:8787/api/manager/state`
- Manager guide: `docs/collider-manager.md`

If the faucet or route is held, preserve the same wallet/profile and wait for service recovery. Do not reset the journal or repeat a claim. Public RC1 does not use the old random beta identity, internal `mirrorDeposit` bootstrap or Bank token-request shortcut.

Existing profiles start **paused**. After reconciling their original wallet/journals, resume explicitly with `npm run start:rc1 -- --resume`. Back up the data directory and external encrypted wallet together; see [the quick start](docs/RC1_QUICKSTART.md).

## Human + manager collaboration from day one

Agent 1 can now learn from manual examples without pretending those examples are already solved strategy. The `humanLearning` settings block allows managers to:

- learn from the agent operator's own manual throws when those throws have no `data_commit`
- track one or more additional addresses as manual-example sources
- seed recent manual throws into candidate search as bounded example trajectories

This keeps the release flow simple:

1. clone or download the repo
2. install dependencies and build
3. run `npm run start:rc1`
4. watch the baseline agent begin playing on public Fuji RC1
5. decide whether to keep the baseline doctrine or move into Peanut, ToughNut, NutJob, or Prof DeezNutz
6. optionally bring in a Claw manager or configure manual-example addresses for Agent 1 to study

## Optional advanced overrides

The public RC1 quick start above is the normal user path. Ordinary `npm start` retains the separately configured advanced runtime; it does not perform public quick-start onboarding. Advanced operators can use these commands with prepared settings, a funded wallet and an existing build:

- `npm run start:once`: one live cycle, no monitor
- `npm run start:headless`: live loop without the local monitor server
- direct CLI flags still work for exact overrides such as `--rpc`, `--asset`, `--amount`, `--once`, or `--no-monitor`

The settings file and monitor remain the primary operator surfaces. Persona is the human-readable face. Doctrine is the exact operating posture.

## Demo troubleshooting

- Each independent instance needs its own data directory, wallet and monitor port. If 8787 is occupied, configure another profile's `monitorPort` while stopped; do not launch a second signer for the same wallet.
- To keep another identity and logs separate, use `npm run start:rc1 -- --data-dir ./data-demo`; assign a different monitor port before running several instances together.
- A fresh identity has no settled results. Honest Score and predicted profit stay pending until a game settles; funding and a submitted throw do not immediately produce HPS.
- This RC1 needs internet access to its pinned public RPC. Chart.js is bundled locally. AI connections are optional; Ollama detection uses an existing installation and does not download models.
- Existing users should preserve their identity, encrypted wallet and journals. Old beta/local-chain profiles require a reviewed migration; changing only the RPC URL is insufficient for RC1's domain, asset and signing checks.
- Stop the terminal process with Ctrl+C when finished. After an unexpected exit, reconcile the old signer/nonce and pending work before restarting.
