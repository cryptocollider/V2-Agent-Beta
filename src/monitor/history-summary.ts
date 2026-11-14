import { open, stat } from "node:fs/promises";

type JsonRow = Record<string, unknown>;

type GameAccumulator = {
  gameId: string;
  lastSeenTs: string | null;
  accepted: number;
  scored: number;
  resolved: number;
  scans: number;
  candidates: number;
  inputsByAsset: Record<string, string>;
  acceptedDecisions: Set<string>;
  scoredDecisions: Set<string>;
  acceptedStakes: Map<string, { asset: string; amount: string }>;
  exactReturns: Map<string, Record<string, string>>;
  canonicalReturns: Record<string, string> | null;
  canonicalReturnsConflict: boolean;
};

export type GameHistorySummary = Omit<GameAccumulator, "acceptedDecisions" | "scoredDecisions" | "acceptedStakes" | "exactReturns" | "canonicalReturns" | "canonicalReturnsConflict">;

type FileAccumulator = {
  file: string;
  offset: number;
  carry: string;
  rows: number;
  acceptedOrScoredRows: number;
  gameIds: Set<string>;
  latestTs: string | null;
  latestNonce: number | null;
  fileBytes: number;
  identity: string | null;
  byGame: Map<string, GameAccumulator>;
};

export type HistorySummary = {
  schema: "collider.agent1.history-summary.v1";
  generatedAt: string;
  throws: {
    rows: number;
    accepted: number;
    games: number;
    latestTs: string | null;
    latestNonce: number | null;
    fileBytes: number;
  };
  results: {
    rows: number;
    scored: number;
    games: number;
    latestTs: string | null;
    fileBytes: number;
  };
  pendingAcceptedThrows: number;
  bank: {
    outByAsset: Record<string, string>;
    inByAsset: Record<string, string>;
    pendingByAsset: Record<string, string>;
    unverifiedReturnDecisions: number;
  };
  recentGames: GameHistorySummary[];
};

function fresh(file: string): FileAccumulator {
  return { file, offset: 0, carry: "", rows: 0, acceptedOrScoredRows: 0,
    gameIds: new Set(), latestTs: null, latestNonce: null, fileBytes: 0, identity: null,
    byGame: new Map() };
}

function gameFor(acc: FileAccumulator, gameId: string): GameAccumulator {
  let game = acc.byGame.get(gameId);
  if (!game) {
    game = { gameId, lastSeenTs: null, accepted: 0, scored: 0, resolved: 0, scans: 0,
      candidates: 0, inputsByAsset: {}, acceptedDecisions: new Set(), scoredDecisions: new Set(),
      acceptedStakes: new Map(), exactReturns: new Map(), canonicalReturns: null, canonicalReturnsConflict: false };
    acc.byGame.set(gameId, game);
  }
  return game;
}

function addInputs(game: GameAccumulator, row: JsonRow): void {
  const expected = row.expected && typeof row.expected === "object" ? row.expected as JsonRow : null;
  const payload = (row.payload ?? row.submitted_payload ?? expected?.payload) as JsonRow | undefined;
  const asset = String(payload?.asset ?? row.asset ?? "").toLowerCase().replace(/^0x/, "");
  const amount = String(payload?.amount ?? row.amount ?? "0");
  if (!/^[0-9a-f]{64}$/.test(asset) || !/^\d+$/.test(amount)) return;
  game.inputsByAsset[asset] = (BigInt(game.inputsByAsset[asset] ?? "0") + BigInt(amount)).toString();
  const decision = String(row.decisionId ?? "");
  if (decision) game.acceptedStakes.set(decision, { asset, amount });
}

function exactReturnsForResult(row: JsonRow): Record<string, string> | null {
  const actual = row.actual && typeof row.actual === "object" ? row.actual as JsonRow : null;
  const match = actual?.throwMatch && typeof actual.throwMatch === "object" ? actual.throwMatch as JsonRow : null;
  if (match?.returned_by_asset_exact !== true) return null;
  if (!["vm_integer_attribution", "canonical_throw_payouts"].includes(String(match.returned_by_asset_source))) return null;
  const raw = match.returned_by_asset;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const asset = key.toLowerCase().replace(/^0x/, "");
    const amount = String(value);
    if (!/^[0-9a-f]{64}$/.test(asset) || !/^\d+$/.test(amount)) return null;
    result[asset] = amount;
  }
  return result;
}

function addAssetAmount(map: Record<string, string>, asset: string, amount: string): void {
  map[asset] = (BigInt(map[asset] ?? "0") + BigInt(amount)).toString();
}

function canonicalReturnsForResult(row: JsonRow): Record<string,string> | null {
  const actual = row.actual as Record<string,any> | undefined;
  if (row.botUser && actual?.userHex && String(row.botUser).replace(/^0x/,"").toLowerCase() !== String(actual.userHex).replace(/^0x/,"").toLowerCase()) return null;
  const raw=actual?.payouts?.by_asset;
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) return null;
  const out:Record<string,string>={};
  for(const [key,value]of Object.entries(raw)){
    const asset=key.toLowerCase().replace(/^0x/,""),amount=String(value);
    if(!/^[0-9a-f]{64}$/.test(asset)||!/^\d+$/.test(amount))return null;
    if(BigInt(amount)>0n)out[asset]=BigInt(amount).toString();
  }
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}

function canonicalGameId(value: unknown): string | null {
  const clean = String(value ?? "").trim().toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{64}$/.test(clean) ? clean : null;
}

function finiteNonce(value: unknown): number | null {
  const nonce = Number(value);
  return Number.isSafeInteger(nonce) && nonce >= 0 ? nonce : null;
}

function consumeLine(acc: FileAccumulator, line: string, kind: "throws" | "results" | "runs"): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let row: JsonRow;
  try {
    row = JSON.parse(trimmed) as JsonRow;
  } catch {
    return;
  }
  acc.rows += 1;
  const gameId = canonicalGameId(row.gameId);
  if (gameId) acc.gameIds.add(gameId);
  if (typeof row.ts === "string" && row.ts) acc.latestTs = row.ts;
  const game = gameId ? gameFor(acc, gameId) : null;
  if (game && typeof row.ts === "string" && row.ts && (!game.lastSeenTs || row.ts > game.lastSeenTs)) game.lastSeenTs = row.ts;
  if (kind === "throws") {
    const signedIntent = row.signedIntent && typeof row.signedIntent === "object"
      ? row.signedIntent as JsonRow : null;
    if (row.submitted === true && signedIntent?.status === "throw_accepted") {
      acc.acceptedOrScoredRows += 1;
      if (game) {
        const decision = String(row.decisionId ?? "");
        if (!decision || !game.acceptedDecisions.has(decision)) {
          game.accepted += 1;
          addInputs(game, row);
          if (decision) game.acceptedDecisions.add(decision);
        }
      }
      const nonce = finiteNonce(signedIntent.nonce);
      if (nonce != null) acc.latestNonce = acc.latestNonce == null ? nonce : Math.max(acc.latestNonce, nonce);
    }
  } else if (kind === "results") {
    const honestScore = row.honestScore && typeof row.honestScore === "object"
      ? row.honestScore as JsonRow : null;
    if (Number.isFinite(Number(honestScore?.honestScore))) {
      acc.acceptedOrScoredRows += 1;
    }
    if (game) {
      const decision = String(row.decisionId ?? "");
      if (!decision || !game.scoredDecisions.has(decision)) {
        game.resolved += 1;
        if (Number.isFinite(Number(honestScore?.honestScore))) game.scored += 1;
        if (decision) game.scoredDecisions.add(decision);
      }
      if (decision) {
        const exact = exactReturnsForResult(row);
        if (exact) game.exactReturns.set(decision, exact);
      }
      const canonical = canonicalReturnsForResult(row);
      if (canonical) {
        if (game.canonicalReturns && JSON.stringify(game.canonicalReturns)!==JSON.stringify(canonical)) game.canonicalReturnsConflict=true;
        else game.canonicalReturns=canonical;
      }
    }
  } else if (game) {
    game.scans += 1;
    const search = row.search && typeof row.search === "object" ? row.search as JsonRow : null;
    game.candidates += Math.max(0, Number(search?.examinedCount ?? 0) || 0);
  }
}

async function updateAccumulator(acc: FileAccumulator, kind: "throws" | "results" | "runs"): Promise<void> {
  let info;
  try {
    info = await stat(acc.file);
  } catch {
    Object.assign(acc, fresh(acc.file));
    return;
  }
  const identity = `${info.dev}:${info.ino}`;
  if ((acc.identity != null && acc.identity !== identity) || info.size < acc.offset) {
    Object.assign(acc, fresh(acc.file));
  }
  acc.identity = identity;
  if (info.size === acc.offset) {
    acc.fileBytes = info.size;
    return;
  }
  const handle = await open(acc.file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = acc.offset;
    let text = acc.carry;
    while (position < info.size) {
      const length = Math.min(chunk.length, info.size - position);
      const read = await handle.read(chunk, 0, length, position);
      if (read.bytesRead <= 0) break;
      position += read.bytesRead;
      text += chunk.toString("utf8", 0, read.bytesRead);
      const lines = text.split(/\r?\n/);
      text = lines.pop() ?? "";
      for (const line of lines) consumeLine(acc, line, kind);
    }
    acc.offset = position;
    acc.carry = text;
    acc.fileBytes = info.size;
  } finally {
    await handle.close();
  }
}

export class HistorySummaryReader {
  private throws: FileAccumulator;
  private results: FileAccumulator;
  private runs: FileAccumulator | null;
  private inFlight: Promise<HistorySummary> | null = null;

  constructor(throwsFile: string, resultsFile: string, runsFile?: string) {
    this.throws = fresh(throwsFile);
    this.results = fresh(resultsFile);
    this.runs = runsFile ? fresh(runsFile) : null;
  }

  async read(): Promise<HistorySummary> {
    if (this.inFlight) return await this.inFlight;
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<HistorySummary> {
    await Promise.all([updateAccumulator(this.throws, "throws"), updateAccumulator(this.results, "results"),
      ...(this.runs ? [updateAccumulator(this.runs, "runs")] : [])]);
    const games = new Map<string, GameHistorySummary>();
    const bank: HistorySummary["bank"] = {
      outByAsset: {}, inByAsset: {}, pendingByAsset: {}, unverifiedReturnDecisions: 0,
    };
    for (const source of this.throws.byGame.values()) {
      const resolved = this.results.byGame.get(source.gameId);
      for (const [asset, amount] of Object.entries(source.inputsByAsset)) {
        addAssetAmount(bank.outByAsset, asset, amount);
      }
      for (const [decision, stake] of source.acceptedStakes) {
        if (!resolved?.scoredDecisions.has(decision)) {
          addAssetAmount(bank.pendingByAsset, stake.asset, stake.amount);
        }
      }
    }
    for (const source of this.results.byGame.values()) {
      // Canonical VM payouts are per user/game, repeated on each decision's
      // result. Count them once; never sum local per-throw estimates as credits.
      if (source.canonicalReturns && !source.canonicalReturnsConflict) {
        for(const [asset,amount]of Object.entries(source.canonicalReturns))addAssetAmount(bank.inByAsset,asset,amount);
        continue;
      }
      if (source.canonicalReturnsConflict) { bank.unverifiedReturnDecisions += source.scoredDecisions.size; continue; }
      bank.unverifiedReturnDecisions += [...source.scoredDecisions]
        .filter((decision) => !source.exactReturns.has(decision)).length;
      for (const returned of source.exactReturns.values()) {
        for (const [asset, amount] of Object.entries(returned)) {
          addAssetAmount(bank.inByAsset, asset, amount);
        }
      }
    }
    for (const acc of [this.runs, this.throws, this.results]) {
      if (!acc) continue;
      for (const source of acc.byGame.values()) {
        const game = games.get(source.gameId) ?? { gameId: source.gameId, lastSeenTs: null,
          accepted: 0, scored: 0, resolved: 0, scans: 0, candidates: 0, inputsByAsset: {} };
        if (source.lastSeenTs && (!game.lastSeenTs || source.lastSeenTs > game.lastSeenTs)) game.lastSeenTs = source.lastSeenTs;
        game.accepted += source.accepted;
        game.scored += source.scored;
        game.resolved += source.resolved;
        game.scans += source.scans;
        game.candidates += source.candidates;
        for (const [asset, amount] of Object.entries(source.inputsByAsset)) {
          game.inputsByAsset[asset] = (BigInt(game.inputsByAsset[asset] ?? "0") + BigInt(amount)).toString();
        }
        games.set(source.gameId, game);
      }
    }
    return {
      schema: "collider.agent1.history-summary.v1",
      generatedAt: new Date().toISOString(),
      throws: { rows: this.throws.rows, accepted: this.throws.acceptedOrScoredRows,
        games: this.throws.gameIds.size, latestTs: this.throws.latestTs,
        latestNonce: this.throws.latestNonce, fileBytes: this.throws.fileBytes },
      results: { rows: this.results.rows, scored: this.results.acceptedOrScoredRows,
        games: this.results.gameIds.size, latestTs: this.results.latestTs,
        fileBytes: this.results.fileBytes },
      pendingAcceptedThrows: Math.max(0, this.throws.acceptedOrScoredRows - this.results.acceptedOrScoredRows),
      bank,
      recentGames: [...games.values()]
        .sort((a, b) => String(b.lastSeenTs ?? "").localeCompare(String(a.lastSeenTs ?? "")) || a.gameId.localeCompare(b.gameId))
        .slice(0, 200),
    };
  }
}
