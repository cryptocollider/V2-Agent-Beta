<img width="565" height="992" alt="image" src="https://github.com/user-attachments/assets/ea6961a2-dada-41d3-927b-678d83ca4a2c" />

# Collider Agent 1 - For V2 Beta

Local Node-based agent player, monitor, and manager API for Collider V2.

The agent connects to the Collider V2 beta chain, scans games, simulates candidate throws through the same local `sim_core.wasm` (as used for Collider's on-chain results caltulation) to use for planning, submits the best live throw discovered, and logs exact audit data for later review. 

It is designed for a human and/or AI 'manager' to monitor and adjust its settings and create new strategies to maximise win rates, profitability and self-awareness.

It creates the Honest Performance Score (HPS) which works to measure, refine and calibrate the Agent's 'broad predictive sense' or 'intution' - based on the actions of the agent's manager - and rewarding only honest performance as in Collider V2 that is the only way to perform.

The manager API surfaces add a precise settings audit, exact eligibility diagnostics, tactical overlays, and manager candidate programs without bypassing the deterministic sim core.

## What it does

- scans live Collider V2 games
- fetches canonical `getSimInput`
- appends hypothetical throws locally for simulation
- runs the local `sim_core.wasm` planning path
- ranks candidate throws under queue scenarios
- submits live throws
- matches submitted throws back to resolved outcomes
- logs runs, throws, results, and manager supervision data to JSONL
- serves a local monitor UI and manager API

## Current operator surfaces

- Official human monitor: `monitor.html`
- Local manager API base: `http://localhost:8787`
- Honest-performance API surfaces: `/api/manager/honest-score` and `/api/manager/reveals`
- Full manager docs: `docs/collider-manager.md`
- Repo-local Claw wrapper plugin: `plugins/collider-agent-claw`
- Claude or NanoClaw adapter skill: `.claude/skills/collider-agent-manager`

## Manager startup pack

Fresh managers should use the repo-local startup references under `plugins/collider-agent-claw/skills/collider-agent-manager/references/`:

- `game-mechanics.md`
- `blackhole-dynamics.md`
- `strategy-implications.md`
- `intuition-lens.md`
- `progression-map.md`
- `manager-reporting.md`

These are designed to accelerate first-contact managers without replacing self-discovery or bounded experimentation.

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

## First run

Use flags once, then the monitor UI can save settings to `./data/settings.json` and future restarts can rely on that.

```bash
node dist/cli/main.js \
  --rpc https://v2.cryptocollider.com:4430/ext/bc/WdFeSwHfau9U7Vj8B1wEHhNMtubRQKfVGiuJwgTyDUBLbCH4s/collider_v2 \
  --wasm ./assets/sim_core.wasm \
  --user YOUR_USER_HEX \
  --asset 0x0101010101010101010101010101010101010101010101010101010101010101 \
  --amount 100000000 \
  --max-candidates 50 \
  --max-ms 20000 \
  --poll-ms 15000 \
  --loop \
  --serve-monitor
```

In V2 beta test, USDC is `0x0101010101010101010101010101010101010101010101010101010101010101`.

## Then open

- Monitor UI: `http://localhost:8787`
- Manager state snapshot: `http://localhost:8787/api/manager/state`
- Manager guide: `docs/collider-manager.md`
