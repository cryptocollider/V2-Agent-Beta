import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);

function readFlag(name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return idx + 1 < argv.length ? argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return argv.includes(name);
}

function defaultSource() {
  if (process.platform === "win32") {
    return process.execPath;
  }
  return "/usr/bin/node";
}

function defaultTargetName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

async function main() {
  const source = path.resolve(readFlag("--source", defaultSource()));
  const targetName = readFlag("--target-name", defaultTargetName());
  const dryRun = hasFlag("--dry-run");
  const targetDir = path.join(repoRoot, "desktop-shell", "tauri", "src-tauri", "resources", "runtime");
  const targetPath = path.join(targetDir, targetName);

  await fs.access(source);

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, source, targetPath }, null, 2));
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(source, targetPath);
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o755);
  }

  console.log(`[desktop-shell] staged node runtime ${source} -> ${targetPath}`);
}

main().catch((error) => {
  console.error("[desktop-shell] stage node runtime failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
