export function decimalIntegerToApproxNumber(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const digits = raw.replace(/^0+/, "") || "0";
  const significant = digits.slice(0, 15);
  const magnitude = digits.length - significant.length;
  const approximate = Number(significant) * Math.pow(10, magnitude);
  return Number.isFinite(approximate) ? approximate : null;
}

export function decimalUnitsToApproxNumber(value: unknown, decimals: number): number | null {
  const integer = decimalIntegerToApproxNumber(value);
  if (integer == null || !Number.isSafeInteger(decimals) || decimals < 0) return null;
  const scaled = integer / Math.pow(10, decimals);
  return Number.isFinite(scaled) ? scaled : null;
}

export function decimalE8ToApproxNumber(value: unknown): number | null {
  return decimalUnitsToApproxNumber(value, 8);
}

export function multiplyDecimalIntegerByApprox(
  value: unknown,
  multiplier: number,
): number | null {
  const integer = decimalIntegerToApproxNumber(value);
  if (integer == null || !Number.isFinite(multiplier)) return null;
  const product = integer * multiplier;
  return Number.isFinite(product) ? product : null;
}
