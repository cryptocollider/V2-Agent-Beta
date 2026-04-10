<img width="1738" height="939" alt="image" src="https://github.com/user-attachments/assets/406d61b9-e9c5-4ab3-9092-0d2eafd33643" />
<img width="1688" height="981" alt="image" src="https://github.com/user-attachments/assets/158d429c-68aa-4e73-8ed9-734e9cc7ed10" />
<img width="1674" height="985" alt="image" src="https://github.com/user-attachments/assets/6a9ca7e8-29e7-4e54-85d9-30e82fcdba24" />



# Collider Agent 1 - Beta
## Introduces Honest Performance Score

Local Node-based agent player and monitor for Collider V2.

Connects to the Collider V2 Beta blockchain, scans games, simulates possible throws and submits the best candiate. There are no real tokens at stake and no wallet connections are required to use/test - Agent at this stage is primarily testing of inferstructure and data gathering for enhanced strategy development with LLM integration. 

## What it does

- scans live Collider V2 games
- fetches canonical `getSimInput`
- appends hypothetical throws locally
- runs the same `sim_core.wasm` planning path as the frontend
- ranks candidate throws under queue scenarios
- submits live throws (with prediction hash)
- matches submitted throws back to resolved outcomes
- logs runs / throws / results to JSONL
- serves a local neon monitor UI with live settings
- COMPUTES HONEST PERFORMANCE SCORE

## Project layout

- `src/core/` basic RPC, storage, settings, runtime state
- `src/collider/` Collider-specific types and throw building
- `src/sim/` wasm loader, planner, decode
- `src/strategy/` candidate generation, scoring, choosing, bankroll hooks
- `src/agent/` loop, session, report matching
- `src/monitor/` tiny local HTTP server for the monitor UI
- `monitor.html` browser UI

## Install

```bash
npm install
npm run build


## First run

Use flags once, then the monitor UI can save settings to ./data/settings.json and future restarts can rely on that.

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

* In V2 Beta Test USDC = 0x0101010101010101010101010101010101010101010101010101010101010101

## Then open:

http://localhost:8787
