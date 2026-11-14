import type { AssetMeta, SimRunInput } from "../collider/types.js";

const assetId = (value: unknown): string => {
  if (Array.isArray(value)) {
    if (value.length !== 32 || value.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return "";
    return Buffer.from(value).toString("hex");
  }
  const clean = String(value ?? "").replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(clean) ? clean : "";
};
export function missingPlanningAssets(input: SimRunInput, required: string[]): string[] {
  const included = new Set((input.assets ?? []).map(row => assetId(row.asset)));
  return [...new Set(required.map(assetId).filter(Boolean))].filter(id => !included.has(id));
}

/** Hypothetical gameplay only. Never call this on the frozen binary confirmation path. */
export function enrichPlanningAssets(input: SimRunInput, payload: unknown, required: string[]): SimRunInput {
  const missing = new Set(missingPlanningAssets(input, required));
  if (!missing.size) return input;
  if (!Array.isArray(payload) || payload.length > 4096) throw new Error("invalid bounded canonical asset catalog");
  const added: AssetMeta[] = [];
  const seen = new Set<string>();
  const materialFields = ["density", "density_gWeight_mul", "friction", "friction_gWeight_mul",
    "restitution", "restitution_gWeight_mul", "linear_damping", "angular_damping"];
  for (const value of payload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>, id = assetId(row.asset);
    if (!missing.has(id)) continue;
    if (seen.has(id)) throw new Error("duplicate canonical planning asset");
    seen.add(id);
    // No default decimals/material and no activation of dormant or disabled catalog entries.
    if (row.status !== 3 || !Number.isSafeInteger(row.decimals) || Number(row.decimals) < 0 || Number(row.decimals) > 30
        || typeof row.radius_px !== "number" || !Number.isFinite(row.radius_px) || row.radius_px <= 0
        || typeof row.mass_scale !== "number" || !Number.isFinite(row.mass_scale) || row.mass_scale <= 0
        || typeof row.name !== "string" || typeof row.symbol !== "string" || !row.material
        || typeof row.material !== "object" || Array.isArray(row.material)
        || materialFields.some(key => typeof (row.material as Record<string, unknown>)[key] !== "number"
          || !Number.isFinite((row.material as Record<string, unknown>)[key]))) continue;
    added.push({ ...structuredClone(row), asset: [...Buffer.from(id, "hex")] } as unknown as AssetMeta);
  }
  if (!added.length) return input;
  const planning = structuredClone(input);
  planning.assets.push(...added);
  return planning;
}
