## Agent 1 Desktop Shell

This folder contains the first standalone desktop wrapper for Agent 1.

Design goals:
- keep the current repo workflow untouched
- wrap the existing local agent + monitor instead of rewriting it
- stay open-source, minimal, and system-webview based
- preserve expert mode and plugin/startup paths outside the wrapper

Current shape:
- `tauri/` is a thin desktop shell
- the shell launches the existing Agent 1 runtime
- in packaged mode it expects a bundled `agent1-runtime` sidecar binary
- if the sidecar is unavailable, it can fall back to a bundled `node` runtime plus the packaged `dist/` app files
- in dev fallback mode it can launch `node dist/cli/main.js` from this repo

Important notes:
- the packaged shell passes absolute `--data-dir`, `--static-dir`, `--wasm`, and `--app-root` paths so Agent 1 does not depend on repo working-directory assumptions
- the runtime UI is still `monitor21.html`
- the packaged sidecar is a small Node launcher binary; the actual Agent 1 JS runtime stays bundled as Tauri resources on disk
- current monitor charts still rely on the existing remote Chart.js include, so fully offline hardening is a follow-up pass

Suggested next release tasks:
1. Vendor `Chart.js` locally so the shell is fully offline-safe.
2. Add tray/start-minimized behavior and clean sidecar shutdown.
3. Add code signing for Windows/macOS release artifacts.

## Build Flow

Development and expert mode remain unchanged at the repo root.

Standalone release flow:
1. Build the Agent 1 TypeScript runtime at the repo root:
   - `npm run build`
2. Stage a host `node` runtime into the shell resources:
   - `npm run desktop:runtime:stage-node`
3. Install sidecar packaging dependencies:
   - `npm --prefix ./desktop-shell/runtime install`
4. Build the packaged Node sidecar launcher for the target platform:
   - `npm run desktop:sidecar:build -- --target-triple x86_64-pc-windows-msvc --pkg-target node20-win-x64`
5. Install Tauri shell dependencies:
   - `npm --prefix ./desktop-shell/tauri install`
6. Build the native desktop bundle:
   - `npm --prefix ./desktop-shell/tauri run tauri:build`

## Output Shape

The public beta release should ship:
- Windows: installer (`setup.exe` and/or `.msi`)
- macOS: `.dmg`
- Linux: `AppImage` and optionally `deb`

The shell keeps the normal repo/npm workflow for advanced operators while giving end users a native install-and-run entrypoint.
