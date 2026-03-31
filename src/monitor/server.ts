import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadSettings, saveSettings } from "../core/settings.js";
import { getRuntimeSettings, updateRuntimeSettings, getControlState, applyControlAction } from "../core/runtime-state.js";

type ServerConfig = {
  port?: number;
  dataDir?: string;
  staticDir?: string;
};

async function safeReadText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function parseJsonl(text: string): any[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function startMonitorServer(cfg: ServerConfig = {}): Promise<void> {
  const port = cfg.port ?? 8787;
  const dataDir = cfg.dataDir ?? "./data";
  const staticDir = cfg.staticDir ?? process.cwd();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/logs/runs") {
      const txt = await safeReadText(path.join(dataDir, "runs.jsonl"));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(parseJsonl(txt)));
      return;
    }

    if (url.pathname === "/api/logs/throws") {
      const txt = await safeReadText(path.join(dataDir, "throws.jsonl"));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(parseJsonl(txt)));
      return;
    }

    if (url.pathname === "/api/logs/results") {
      const txt = await safeReadText(path.join(dataDir, "results.jsonl"));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(parseJsonl(txt)));
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const settings = await loadSettings(dataDir);
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(settings));
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const json = JSON.parse(body || "{}");
          const current = await loadSettings(dataDir);
          const merged = { ...current, ...json };

          await saveSettings(merged, dataDir);
          const runtime = updateRuntimeSettings(merged);

          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, settings: merged, runtime }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    if (url.pathname === "/api/runtime-settings" && req.method === "GET") {
      try {
        const runtime = getRuntimeSettings();
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(runtime));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (url.pathname === "/api/control/status" && req.method === "GET") {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(getControlState()));
      return;
    }

    if (url.pathname === "/api/control/action" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const json = JSON.parse(body || "{}");
          const action = String(json.action || "").trim();
          if (!action) throw new Error("missing action");
          const state = applyControlAction(action, json);
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, ...state }));
        } catch (err) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    const filePath = url.pathname === "/"
      ? path.join(staticDir, "monitor.html")
      : path.join(staticDir, url.pathname.replace(/^\/+/, ""));

    try {
      const buf = await readFile(filePath);
      if (filePath.endsWith(".html")) res.setHeader("content-type", "text/html; charset=utf-8");
      else if (filePath.endsWith(".js")) res.setHeader("content-type", "application/javascript; charset=utf-8");
      else if (filePath.endsWith(".css")) res.setHeader("content-type", "text/css; charset=utf-8");
      else res.setHeader("content-type", "application/octet-stream");
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  console.log(`monitor server: http://localhost:${port}`);
}
