export type SimpleAssetMeta = {
  asset: string;
  symbol: string;
  decimals: number;
};

function cleanHex(value: unknown): string {
  return String(value ?? '').trim().replace(/^0x/i, '').toLowerCase();
}

export function normalizeAssetsMetaPayload(payload: unknown): Record<string, SimpleAssetMeta> {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { assets?: unknown[] } | null | undefined)?.assets)
      ? ((payload as { assets: unknown[] }).assets)
      : [];
  const out: Record<string, SimpleAssetMeta> = {};
  for (const row of rows) {
    const asset = cleanHex((row as { asset?: unknown } | null | undefined)?.asset);
    if (!asset) continue;
    const decimals = Number((row as { decimals?: unknown } | null | undefined)?.decimals);
    out[asset] = {
      asset,
      symbol: String((row as { symbol?: unknown } | null | undefined)?.symbol ?? out[asset]?.symbol ?? asset.slice(0, 8)).trim() || asset.slice(0, 8),
      decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : Number(out[asset]?.decimals ?? 8),
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
