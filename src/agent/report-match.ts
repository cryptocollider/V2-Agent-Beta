export type ExpectedThrowSummary = {
  payload?: {
    asset?: string;
    amount?: string;
    x?: number;
    y?: number;
    angle_rad?: number;
    vx?: number;
    vy?: number;
    angVel?: number;
  };
};

export type MatchedResultSummary = {
  matched: boolean;
  userHex: string;

  wholeGame?: {
    stake_usd?: number;
    returned_usd?: number;
    pnl_usd?: number;
    inputs_by_asset?: Record<string, string>;
    outputs_by_asset?: Record<string, string>;
    asset_meta?: Array<{
      asset: string;
      symbol: string;
      decimals: number;
      mass_scale: number;
    }>;
    per_user_scoreboard?: Array<{
      user: string;
      stake_usd?: number;
      returned_usd?: number;
      pnl_usd?: number;
    }>;
    hole_type_counts?: Record<string, number>;
    user_hole_type_counts?: Record<string, number>;
  };

  throwMatch?: {
    throw_id?: string;
    accepted_at_height?: number;
    enter_frame?: number;
    asset?: string;
    amount?: string;
    value_usd_e8?: string;
    mass_usd?: number;
    hole_type?: number;
    hole_i?: number;
    endFrame?: number;
  };

  payouts?: {
    by_kind?: Record<string, string>;
    by_asset?: Record<string, string>;
    timeline?: Array<{
      idx: number;
      user: string;
      kind: string;
      asset: string;
      amount: string;
    }>;
  };

  bonuses?: Array<{
    kind: string;
    points: number;
    throw_id?: string | null;
  }>;

  bonus_timeline?: Array<{
    idx: number;
    user: string;
    kind: string;
    points: number;
    throw_id?: string | null;
  }>;

  expectationVsActual?: {
    expected_asset?: string;
    expected_amount?: string;
    expected_x?: number;
    expected_y?: number;
    expected_angle_rad?: number;
    actual_hole_type?: number;
    actual_enter_frame?: number;
    actual_value_usd_e8?: string;
    actual_mass_usd?: number;
    actual_pnl_usd?: number;
  };
};

function cleanHex(hex: unknown): string {
  return String(hex ?? "").toLowerCase().replace(/^0x/, "");
}

function bytesToHex(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}

function sameHexish(a: unknown, b: unknown): boolean {
  const ah = Array.isArray(a) ? bytesToHex(a) : cleanHex(a);
  const bh = Array.isArray(b) ? bytesToHex(b) : cleanHex(b);
  return !!ah && !!bh && ah === bh;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

function kindToString(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object") return JSON.stringify(kind);
  return String(kind);
}

function bonusKindToString(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object") {
    const entries = Object.entries(kind as Record<string, unknown>);
    if (entries.length === 1) {
      const [k, v] = entries[0];
      if (v == null || (typeof v === "object" && Object.keys(v as object).length === 0)) return k;
      return `${k}:${JSON.stringify(v)}`;
    }
    return JSON.stringify(kind);
  }
  return String(kind);
}

function approxSame(a: number | undefined, b: number | undefined, eps = 0.001): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}

function assetHexFromUnknown(v: unknown): string {
  if (Array.isArray(v)) return bytesToHex(v);
  return cleanHex(v);
}

function extractAssetMeta(report: Record<string, any>) {
  const assets = Array.isArray(report.assets) ? report.assets : [];
  return assets
    .filter((a) => a && typeof a === "object" && !Array.isArray(a))
    .map((a) => ({
      asset: cleanHex(a.asset),
      symbol: String(a.symbol ?? ""),
      decimals: Number(a.decimals ?? 0),
      mass_scale: Number(a.mass_scale ?? 1),
    }));
}

function extractPerUserScoreboard(report: Record<string, any>) {
  const userOrder = Array.isArray(report.user_order) ? report.user_order : [];
  const stakeUsd = Array.isArray(report.stake_usd) ? report.stake_usd : [];
  const returnedUsd = Array.isArray(report.returned_usd) ? report.returned_usd : [];
  const pnlUsd = Array.isArray(report.pnl_usd) ? report.pnl_usd : [];

  const out: Array<{
    user: string;
    stake_usd?: number;
    returned_usd?: number;
    pnl_usd?: number;
  }> = [];

  for (let i = 0; i < userOrder.length; i++) {
    out.push({
      user: cleanHex(userOrder[i]),
      stake_usd: num(stakeUsd[i]),
      returned_usd: num(returnedUsd[i]),
      pnl_usd: num(pnlUsd[i]),
    });
  }
  return out;
}

export function matchReportToSubmittedThrow(
  report: unknown,
  botUserHex: string,
  expected?: ExpectedThrowSummary,
): MatchedResultSummary {
  const r = report as Record<string, any>;
  const userHex = cleanHex(botUserHex);

  const userOrder: unknown[] = Array.isArray(r.user_order) ? r.user_order : [];
  const assetOrder: unknown[] = Array.isArray(r.asset_order) ? r.asset_order : [];
  const throwsMatrix: unknown[] = Array.isArray(r.throws) ? r.throws : [];
  const returnedMatrix: unknown[] = Array.isArray(r.returned) ? r.returned : [];
  const stakeUsd: unknown[] = Array.isArray(r.stake_usd) ? r.stake_usd : [];
  const returnedUsd: unknown[] = Array.isArray(r.returned_usd) ? r.returned_usd : [];
  const pnlUsd: unknown[] = Array.isArray(r.pnl_usd) ? r.pnl_usd : [];

  const throwsRaw: Array<Record<string, any>> = Array.isArray(r.throws_raw) ? r.throws_raw : [];
  const outcomesRaw: Array<Record<string, any>> = Array.isArray(r.outcomes_raw) ? r.outcomes_raw : [];
  const payoutsRaw: Array<Record<string, any>> = Array.isArray(r.payouts_raw) ? r.payouts_raw : [];
  const bonusAwards: Array<Record<string, any>> = Array.isArray(r.bonus_awards) ? r.bonus_awards : [];

  const userIdx = userOrder.findIndex((u) => sameHexish(u, userHex));

  const inputsByAsset: Record<string, string> = {};
  const outputsByAsset: Record<string, string> = {};

  if (userIdx >= 0) {
    const rowIn = Array.isArray(throwsMatrix[userIdx]) ? throwsMatrix[userIdx] : [];
    const rowOut = Array.isArray(returnedMatrix[userIdx]) ? returnedMatrix[userIdx] : [];

    for (let i = 0; i < assetOrder.length; i++) {
      const assetHex = cleanHex(assetOrder[i]);
      inputsByAsset[assetHex] = String(rowIn[i] ?? "0");
      outputsByAsset[assetHex] = String(rowOut[i] ?? "0");
    }
  }

  const expectedPayload = expected?.payload;
  const expectedAsset = cleanHex(expectedPayload?.asset ?? "");
  const expectedAmount = str(expectedPayload?.amount);
  const expectedX = num(expectedPayload?.x);
  const expectedY = num(expectedPayload?.y);
  const expectedAngle = num(expectedPayload?.angle_rad);
  const expectedVx = num(expectedPayload?.vx);
  const expectedVy = num(expectedPayload?.vy);
  const expectedAngVel = num(expectedPayload?.angVel);

  let matchedThrow: Record<string, any> | null = null;

  const userThrows = throwsRaw.filter((t) => sameHexish(t.user, userHex));

  if (expectedPayload) {
    matchedThrow =
      userThrows.find((t) =>
        sameHexish(t.asset, expectedAsset) &&
        str(t.amount) === expectedAmount &&
        approxSame(num(t.init_pose?.pos?.x), expectedX, 0.5) &&
        approxSame(num(t.init_pose?.pos?.y), expectedY, 0.5) &&
        approxSame(num(t.init_pose?.angle_rad), expectedAngle, 0.01) &&
        approxSame(num(t.init_linvel?.x), expectedVx, 1.0) &&
        approxSame(num(t.init_linvel?.y), expectedVy, 1.0) &&
        approxSame(num(t.init_angvel), expectedAngVel, 0.5)
      ) ?? null;
  }

  if (!matchedThrow && userThrows.length) {
    matchedThrow = userThrows[userThrows.length - 1];
  }

  const matchedThrowIdHex = matchedThrow ? bytesToHex(matchedThrow.id) : "";
  const matchedOutcome =
    outcomesRaw.find((o) => sameHexish(o.throw_id, matchedThrowIdHex)) ?? null;

  const throwUserById = new Map<string, string>();
  for (const t of throwsRaw) {
    throwUserById.set(bytesToHex(t.id), assetHexFromUnknown(t.user));
  }

  const holeTypeCounts: Record<string, number> = {};
  const userHoleTypeCounts: Record<string, number> = {};

  for (const o of outcomesRaw) {
    const ht = String(o.hole_type ?? "unknown");
    holeTypeCounts[ht] = (holeTypeCounts[ht] ?? 0) + 1;

    const throwUser = throwUserById.get(assetHexFromUnknown(o.throw_id));
    if (throwUser === userHex) {
      userHoleTypeCounts[ht] = (userHoleTypeCounts[ht] ?? 0) + 1;
    }
  }

  const userPayouts = payoutsRaw.filter((p) => sameHexish(p.user, userHex));

  const payoutsByKind: Record<string, string> = {};
  const payoutsByAsset: Record<string, string> = {};

  for (const p of userPayouts) {
    const kind = kindToString(p.kind);
    const amount = BigInt(String(p.amount ?? "0"));
    payoutsByKind[kind] = (BigInt(payoutsByKind[kind] ?? "0") + amount).toString();

    const assetHex = assetHexFromUnknown(p.asset);
    payoutsByAsset[assetHex] = (BigInt(payoutsByAsset[assetHex] ?? "0") + amount).toString();
  }

  const payoutTimeline = payoutsRaw.map((p, idx) => ({
    idx,
    user: assetHexFromUnknown(p.user),
    kind: kindToString(p.kind),
    asset: assetHexFromUnknown(p.asset),
    amount: String(p.amount ?? "0"),
  }));

  const userBonuses = bonusAwards
    .filter((b) => sameHexish(b.user, userHex))
    .map((b) => ({
      kind: bonusKindToString(b.kind),
      points: Number(b.points ?? 0),
      throw_id: b.throw_id ? bytesToHex(b.throw_id) : null,
    }));

  const bonusTimeline = bonusAwards.map((b, idx) => ({
    idx,
    user: assetHexFromUnknown(b.user),
    kind: bonusKindToString(b.kind),
    points: Number(b.points ?? 0),
    throw_id: b.throw_id ? bytesToHex(b.throw_id) : null,
  }));

  return {
    matched: !!matchedThrow,
    userHex,

    wholeGame: userIdx >= 0 ? {
      stake_usd: num(stakeUsd[userIdx]),
      returned_usd: num(returnedUsd[userIdx]),
      pnl_usd: num(pnlUsd[userIdx]),
      inputs_by_asset: inputsByAsset,
      outputs_by_asset: outputsByAsset,
      asset_meta: extractAssetMeta(r),
      per_user_scoreboard: extractPerUserScoreboard(r),
      hole_type_counts: holeTypeCounts,
      user_hole_type_counts: userHoleTypeCounts,
    } : {
      asset_meta: extractAssetMeta(r),
      per_user_scoreboard: extractPerUserScoreboard(r),
      hole_type_counts: holeTypeCounts,
      user_hole_type_counts: userHoleTypeCounts,
    },

    throwMatch: matchedThrow ? {
      throw_id: matchedThrowIdHex || undefined,
      accepted_at_height: num(matchedThrow.accepted_at_height),
      enter_frame: num(matchedThrow.enter_frame),
      asset: assetHexFromUnknown(matchedThrow.asset) || undefined,
      amount: str(matchedThrow.amount),
      value_usd_e8: str(matchedThrow.value_usd_e8),
      mass_usd: num(matchedThrow.mass_usd),
      hole_type: matchedOutcome ? num(matchedOutcome.hole_type) : undefined,
      hole_i: matchedOutcome ? num(matchedOutcome.hole_i) : undefined,
      endFrame: matchedOutcome ? num(matchedOutcome.endFrame) : undefined,
    } : undefined,

    payouts: {
      by_kind: payoutsByKind,
      by_asset: payoutsByAsset,
      timeline: payoutTimeline,
    },

    bonuses: userBonuses,
    bonus_timeline: bonusTimeline,

    expectationVsActual: {
      expected_asset: expectedAsset || undefined,
      expected_amount: expectedAmount,
      expected_x: expectedX,
      expected_y: expectedY,
      expected_angle_rad: expectedAngle,
      actual_hole_type: matchedOutcome ? num(matchedOutcome.hole_type) : undefined,
      actual_enter_frame: matchedThrow ? num(matchedThrow.enter_frame) : undefined,
      actual_value_usd_e8: matchedThrow ? str(matchedThrow.value_usd_e8) : undefined,
      actual_mass_usd: matchedThrow ? num(matchedThrow.mass_usd) : undefined,
      actual_pnl_usd: userIdx >= 0 ? num(pnlUsd[userIdx]) : undefined,
    },
  };
}