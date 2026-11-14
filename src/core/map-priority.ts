export const DEFAULT_MAP_PRIORITY = 5;

export function canonicalMapId(value: unknown): string | null {
  const id = String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

export function normalizeMapPriorities(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [raw, priority] of Object.entries(value)) {
    const id = canonicalMapId(raw);
    if (id && typeof priority === "number" && Number.isInteger(priority) && priority >= 1 && priority <= 10) out[id] = priority;
  }
  return out;
}

export function mapPriority(mapId: unknown, priorities?: Record<string, number>): number {
  const id = canonicalMapId(mapId), value = id ? priorities?.[id] : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10 ? value : DEFAULT_MAP_PRIORITY;
}
