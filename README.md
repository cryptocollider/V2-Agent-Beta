<img width="570" height="853" alt="image" src="https://github.com/user-attachments/assets/d711b298-9129-4947-83c3-10b786da1fe4" />

# Collider Agent 1 - Beta

Local Node-based agent player, monitor, and manager API for Collider V2.

**Beta mode only. Test tokens only.**

Agent 1 is the first baseline agent for the Collider Arena: a starting plate for many future agents, doctrines, managers, and human/AI teams.

It connects to the Collider V2 beta chain, scans live games, fetches canonical `getSimInput`, simulates candidate throws through the local `sim_core.wasm` deterministic physics engine, submits live throws with prediction commits, and logs exact audit data for later review.

The goal of Agent 1 is not to create the finished intelligent Agent.

The goal is to create the baseline intelligence of pure deterministic brute force (zero predictive sense), and the first measurable loop that a human and/or AI manager may be inserted into (then shift from baseline reveals performance). That loop is:

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

> **Human reader note:** this repo is written mostly for agent managers and technical operators. If you are a human who found your way here early, good — you are exactly who Agent 1 needs. Start with `npm start`, watch the monitor, then decide whether to manage the baseline agent, modify its doctrine, or play alongside it.

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

It is a replay-grounded, verifyable measure of prediction honesty and performance inside the Collider Arena.

It uses an on-chain commit, and off-chain reveal system, so predictions are immuitable but still unknown until after outcomes (and reveal is off-chain). This is to isolate its influence from the points/profit motives (including main ladder ranking) and ensure it remains a seperate and accurate measure - of the undefinable edge of 'intuition'.

## Personas and doctrines

Agent 1 ships with early doctrine/persona presets designed to seed strategic diversity rather than declare a solved strategy.

Persona is the readable face.  
Doctrine is the operating posture.

Different human managers, model managers, and local runtime setups can adjust these doctrines over time, creating pressure toward better prediction/self-awareness, bankroll discipline/profits, and improving whole arena intuition.

## Current operator surfaces

- Official human monitor: `monitor.html`
- Local manager API base: `http://localhost:8787`
- Honest-performance API surfaces: `/api/manager/honest-score` and `/api/manager/reveals`
- Explicit replay storyboard SVG export: `POST /api/manager/replay-svg`
- Agent profile, onboarding/bootstrap summary, and baseline-lift state: `/api/manager/state`
- Full manager docs: `docs/collider-manager.md`
- Repo-local Claw wrapper plugin: `plugins/collider-agent-claw`
- Claude or NanoClaw adapter skill: `.claude/skills/collider-agent-manager`
- Hermes adapter skill: `.hermes/skills/productivity/collider-agent-manager`
- Hermes project plugin wrapper: `.hermes/plugins/collider-agent-hermes`

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

Agent 1 now ships three repo-local manager surfaces that all point back to the same Collider workflow and references:

- NanoClaw or Claude-compatible skill: `.claude/skills/collider-agent-manager`
- IronClaw or OpenClaw-family bundle: `plugins/collider-agent-claw`
- Hermes-native skill and project plugin: `.hermes/skills/productivity/collider-agent-manager` and `.hermes/plugins/collider-agent-hermes`

Practical reading:

- NanoClaw and Claude should use the Claude-style adapter.
- IronClaw should use the existing OpenClaw-family plugin bundle.
- Hermes can use the repo-local project plugin path directly when project plugins are enabled, while still exposing the same shared Collider manager skill.

The goal is that the manager runtime changes, but the Collider supervision surface does not.

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

```bash
npm install
npm run build
```

## First start

Agent 1 now ships with a starter `data/settings.json`, so beta users do not need to discover a flag set before the first run.

Leave `data/settings.json` in its starter state and run:

```bash
npm start
```

That now defaults to the live loop plus the local monitor. If the committed starter settings are still unset, Agent 1 will bootstrap itself automatically on first launch:

- generate a random valid 32-byte beta user address
- keep beta USDC as the active starting asset
- request beta test tokens through `mirrorDeposit`
- persist the resulting bootstrap state back into `data/settings.json`
- expose that onboarding state to both the monitor and `/api/manager/state`

Then open:

- Monitor UI: `http://localhost:8787`
- Manager state snapshot: `http://localhost:8787/api/manager/state`
- Manager guide: `docs/collider-manager.md`

The monitor welcome screen explains what was auto-configured, what the app is for, and what to do next. If the automatic token request fails, use the Bank page `Request Test Tokens` button.

## Human + manager collaboration from day one

Agent 1 can now learn from manual examples without pretending those examples are already solved strategy. The `humanLearning` settings block allows managers to:

- learn from the agent operator's own manual throws when those throws have no `data_commit`
- track one or more additional addresses as manual-example sources
- seed recent manual throws into candidate search as bounded example trajectories

This keeps the release flow simple:

1. clone or download the repo
2. install dependencies and build
3. run `npm start`
4. watch the baseline agent begin playing on beta
5. decide whether to keep the baseline doctrine or move into Peanut, ToughNut, NutJob, or Prof DeezNutz
6. optionally bring in a Claw manager or play alongside the agent manually from the same address so Agent 1 can study those examples

## Optional advanced overrides

Zero-flag startup is now the default path. Advanced operators can still override it when needed:

- `npm run start:once`: one live cycle, no monitor
- `npm run start:headless`: live loop without the local monitor server
- direct CLI flags still work for exact overrides such as `--rpc`, `--asset`, `--amount`, `--once`, or `--no-monitor`

The settings file and monitor are now the primary operator surface for beta startup. Persona is the human-readable face. Doctrine is the exact operating posture.
