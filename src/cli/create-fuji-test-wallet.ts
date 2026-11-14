#!/usr/bin/env node

import process from "node:process";
import { loadOrCreateFujiTestWallet } from "../core/fuji-test-wallet.js";

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]).trim() : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  if (!hasFlag("--acknowledge-test-only-raw-key")) {
    throw new Error("refusing to create a raw test key without --acknowledge-test-only-raw-key");
  }
  const requested = arg("--out");
  if (!requested) throw new Error("missing --out path for the owner-only test key");
  console.log(JSON.stringify(await loadOrCreateFujiTestWallet(requested)));
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
