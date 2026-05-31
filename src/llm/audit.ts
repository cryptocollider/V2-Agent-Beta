import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ManagerLlmAction } from "./types.js";

const MANAGER_LLM_AUDIT_FILE = "manager-llm-audit.jsonl";
const MAX_AUDIT_ROWS = 200;

let dataDir = "./data";

export type ManagerLlmAuditEntry = {
  id: string;
  actionId: string | null;
  ts: string;
  event: "proposed" | "applied" | "rejected" | "guided" | "hidden" | "apply_failed";
  title: string;
  note: string | null;
  action: ManagerLlmAction | null;
  snapshot: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};

function auditFile(): string {
  return path.join(dataDir, MANAGER_LLM_AUDIT_FILE);
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

export async function initManagerLlmAudit(nextDataDir = "./data"): Promise<void> {
  dataDir = nextDataDir;
  await mkdir(dataDir, { recursive: true });
}

export async function appendManagerLlmAuditEntry(
  entry: Omit<ManagerLlmAuditEntry, "id" | "ts"> & Partial<Pick<ManagerLlmAuditEntry, "id" | "ts">>,
): Promise<ManagerLlmAuditEntry> {
  await mkdir(dataDir, { recursive: true });
  const normalized: ManagerLlmAuditEntry = {
    id: String(entry.id ?? `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    actionId: entry.actionId ? String(entry.actionId) : null,
    ts: String(entry.ts ?? new Date().toISOString()),
    event: entry.event,
    title: String(entry.title || "Manager action"),
    note: entry.note ? String(entry.note).trim() || null : null,
    action: entry.action ? clone(entry.action) : null,
    snapshot: entry.snapshot ? clone(entry.snapshot) : null,
    result: entry.result ? clone(entry.result) : null,
  };
  await appendFile(auditFile(), `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export async function readManagerLlmAuditEntries(limit = 30): Promise<ManagerLlmAuditEntry[]> {
  try {
    const raw = await readFile(auditFile(), "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(MAX_AUDIT_ROWS, limit)));
    return lines
      .map((line) => JSON.parse(line) as ManagerLlmAuditEntry)
      .reverse();
  } catch {
    return [];
  }
}
