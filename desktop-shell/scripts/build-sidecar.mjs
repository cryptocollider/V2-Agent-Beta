import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeDir = path.join(repoRoot, "desktop-shell", "runtime");
const tauriBinariesDir = path.join(repoRoot, "desktop-shell", "tauri", "src-tauri", "binaries");
const launcherPath = path.join(runtimeDir, "launcher.cjs");

const argv = process.argv.slice(2);

function readFlag(name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return idx + 1 < argv.length ? argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return argv.includes(name);
}

function hostPlatformTriple() {
  switch (process.platform) {
    case "win32":
      return "x86_64-pc-windows-msvc";
    case "darwin":
      return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    default:
      return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
}

function defaultPkgTarget(targetTriple) {
  if (targetTriple === "x86_64-pc-windows-msvc") return "node20-win-x64";
  if (targetTriple === "aarch64-apple-darwin") return "node20-macos-arm64";
  if (targetTriple === "x86_64-apple-darwin") return "node20-macos-x64";
  if (targetTriple === "aarch64-unknown-linux-gnu") return "node20-linux-arm64";
  return "node20-linux-x64";
}

function outputNameForTriple(targetTriple) {
  return `agent1-runtime-${targetTriple}${targetTriple.includes("windows") ? ".exe" : ""}`;
}

async function ensureExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const targetTriple = readFlag("--target-triple", hostPlatformTriple());
  const pkgTarget = readFlag("--pkg-target", defaultPkgTarget(targetTriple));
  const dryRun = hasFlag("--dry-run");
  const outputName = outputNameForTriple(targetTriple);
  const outputPath = path.join(tauriBinariesDir, outputName);
  const distEntry = path.join(repoRoot, "dist", "cli", "main.js");
  const wasmPath = path.join(repoRoot, "assets", "sim_core.wasm");
  const monitorPath = path.join(repoRoot, "monitor21.html");

  await ensureExists(launcherPath, "sidecar launcher");
  await ensureExists(distEntry, "compiled runtime entry");
  await ensureExists(wasmPath, "sim wasm");
  await ensureExists(monitorPath, "monitor21");
  await fs.mkdir(tauriBinariesDir, { recursive: true });

  const pkgBin = process.platform === "win32"
    ? path.join(runtimeDir, "node_modules", ".bin", "pkg.cmd")
    : path.join(runtimeDir, "node_modules", ".bin", "pkg");

  const pkgArgs = [launcherPath, "--targets", pkgTarget, "--output", outputPath];

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      runtimeDir,
      targetTriple,
      pkgTarget,
      outputPath,
      requiredFiles: [distEntry, wasmPath, monitorPath],
      pkgCommand: pkgBin,
      pkgArgs,
    }, null, 2));
    return;
  }

  await ensureExists(pkgBin, "pkg executable (run npm --prefix ./desktop-shell/runtime install first)");
  await run(pkgBin, pkgArgs, runtimeDir);
  console.log(`[desktop-shell] built sidecar ${outputPath}`);
}

main().catch((error) => {
  console.error("[desktop-shell] sidecar build failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
