#!/usr/bin/env node

const path = require("node:path");
const { pathToFileURL } = require("node:url");

function consumeArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const value = idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
  process.argv.splice(idx, value == null ? 1 : 2);
  return value;
}

async function main() {
  const explicitAppRoot = consumeArg("--app-root");
  const appRoot = explicitAppRoot
    ? path.resolve(explicitAppRoot)
    : path.resolve(path.dirname(process.execPath), "..");
  const runtimeEntry = path.join(appRoot, "dist", "cli", "main.js");

  process.env.COLLIDER_APP_ROOT = process.env.COLLIDER_APP_ROOT || appRoot;
  process.env.COLLIDER_STATIC_DIR = process.env.COLLIDER_STATIC_DIR || appRoot;
  process.env.COLLIDER_SIM_WASM = process.env.COLLIDER_SIM_WASM || path.join(appRoot, "assets", "sim_core.wasm");

  await import(pathToFileURL(runtimeEntry).href);
}

main().catch((error) => {
  console.error("[agent1-runtime-sidecar]", error);
  process.exitCode = 1;
});
