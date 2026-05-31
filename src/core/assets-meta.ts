export type SimpleAssetMeta = {
  asset: string;
  symbol: string;
  decimals: number;
};

const DEFAULT_ASSET_DECIMALS: Record<string, number> = {
  "0101010101010101010101010101010101010101010101010101010101010101": 6,
  "0303030303030303030303030303030303030303030303030303030303030303": 18,
  "0505050505050505050505050505050505050505050505050505050505050505": 18,
};

function cleanHex(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => Number(entry).toString(16).padStart(2, '0')).join('').toLowerCase();
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return Array.from(bytes).map((entry) => Number(entry).toString(16).padStart(2, '0')).join('').toLowerCase();
  }
  return String(value ?? '').trim().replace(/^0x/i, '').toLowerCase();
}

export function defaultDecimalsForAsset(asset: unknown): number {
  const normalized = cleanHex(asset);
  return DEFAULT_ASSET_DECIMALS[normalized] ?? 18;
}

export function normalizeAssetsMetaPayload(payload: unknown): Record<string, SimpleAssetMeta> {
  const wrappedRows = Array.isArray((payload as { assets?: unknown[] } | null | undefined)?.assets)
    ? ((payload as { assets: unknown[] }).assets)
    : Array.isArray((payload as { items?: unknown[] } | null | undefined)?.items)
      ? ((payload as { items: unknown[] }).items)
      : null;
  const keyedRows = !Array.isArray(payload) && !wrappedRows && payload && typeof payload === 'object'
    ? Object.entries(payload as Record<string, unknown>).map(([asset, value]) => ({ asset, ...(value && typeof value === 'object' ? value as Record<string, unknown> : {}) }))
    : null;
  const rows = Array.isArray(payload)
    ? payload
    : wrappedRows
      ? wrappedRows
      : keyedRows ?? [];
  const out: Record<string, SimpleAssetMeta> = {};
  for (const row of rows) {
    const asset = cleanHex((row as { asset?: unknown } | null | undefined)?.asset);
    if (!asset) continue;
    const decimals = Number((row as { decimals?: unknown } | null | undefined)?.decimals);
    out[asset] = {
      asset,
      symbol: String((row as { symbol?: unknown } | null | undefined)?.symbol ?? out[asset]?.symbol ?? asset.slice(0, 8)).trim() || asset.slice(0, 8),
      decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : Number(out[asset]?.decimals ?? defaultDecimalsForAsset(asset)),
    };
  }
  return out;
}

export function displayUnitsToBaseUnitsString(value: unknown, decimals: number): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/,/g, '');
  if (!/^[-+]?\d*(?:\.\d*)?$/.test(normalized)) return '';
  const negative = normalized.startsWith('-');
  const unsigned = normalized.replace(/^[-+]/, '');
  const [wholeRaw, fracRaw = ''] = unsigned.split('.');
  const whole = (wholeRaw || '0').replace(/\D/g, '') || '0';
  const safeDecimals = Math.max(0, Number(decimals) || 0);
  const frac = fracRaw.replace(/\D/g, '').slice(0, safeDecimals).padEnd(safeDecimals, '0');
  const digits = (whole + frac).replace(/^0+(?=\d)/, '') || '0';
  return negative && digits !== '0' ? `-${digits}` : digits;
}
