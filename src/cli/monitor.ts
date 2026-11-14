import path from "node:path";

import { startMonitorServer } from "../monitor/server.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

async function main(): Promise<void> {
  const dataDir = path.resolve(arg("--data-dir", process.env.COLLIDER_DATA_DIR ?? "./data"));
  const staticDir = path.resolve(arg("--static-dir", process.env.COLLIDER_STATIC_DIR ?? process.cwd()));
  const port = Number(arg("--port", "8787"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");

  const server = await startMonitorServer({ port, dataDir, staticDir });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log("[monitor-only] stopping on " + signal);
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
