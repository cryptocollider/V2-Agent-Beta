import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ColliderClient } from "../collider/client.js";
import type { PreparedSignedIntent, SubmittedSignedIntent } from "../collider/types.js";
import { AgentWallet, verifyPreparedPointsRedemption } from "../collider/wallet.js";
import { readJsonlTail } from "../core/jsonl.js";
import { getControlState } from "../core/runtime-state.js";

export const CLC_ASSET = "0x3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16";
const CLC_UNIT = 10n ** 18n;
const DEFAULT_CONFIG = {
  enabled: false,
  targetClcBase: "5000000000000000000",
  maxPointsPerClc: "1500",
  minPointsPerConversion: "1",
} as const;

export type PointsConversionConfig = {
  enabled: boolean;
  targetClcBase: string;
  maxPointsPerClc: string;
  minPointsPerConversion: string;
};

export type PointsConversionAudit = {
  schema: "collider.agent1.points-conversion-audit.v1";
  ts: string;
  source: "manual" | "auto";
  requestId: string;
  status: "confirmed" | "business_rejected";
  pointsIn: string;
  clcOutBase: string | null;
  rate: string;
  nonce: number;
  opId: string | null;
  acceptedAtHeight: number | null;
  submitError: string | null;
};

type PendingConversion = {
  schema: "collider.agent1.points-conversion-pending.v1";
  createdAt: string;
  source: "manual" | "auto";
  requestId: string;
  pointsIn: string;
  quotedClcOutBase: string;
  rate: string;
  prepared: PreparedSignedIntent;
  signature: string;
  submission: SubmittedSignedIntent | null;
  submitError: string | null;
  lastScannedHeight: number;
};

function exactPositive(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || BigInt(text) < 1n || text.length > 39) throw new Error(`${label} must be a positive exact integer`);
  return BigInt(text).toString();
}

function normalizeConfig(raw: Partial<PointsConversionConfig> | null | undefined): PointsConversionConfig {
  return {
    enabled: raw?.enabled === true,
    targetClcBase: exactPositive(raw?.targetClcBase ?? DEFAULT_CONFIG.targetClcBase, "target CLC base units"),
    maxPointsPerClc: exactPositive(raw?.maxPointsPerClc ?? DEFAULT_CONFIG.maxPointsPerClc, "maximum points per CLC"),
    minPointsPerConversion: exactPositive(raw?.minPointsPerConversion ?? DEFAULT_CONFIG.minPointsPerConversion, "minimum conversion points"),
  };
}

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^0x/, "");
}

function eventPayload(event: unknown, kind: string): Record<string, unknown> | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const value = (event as Record<string, unknown>)[kind];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function pointsNeededForTarget(targetClcBase: string, existingClcBase: string, pointsPerClc: string): string {
  const deficit = BigInt(targetClcBase) - BigInt(existingClcBase);
  if (deficit <= 0n) return "0";
  const rate = BigInt(pointsPerClc);
  if (rate <= 0n) throw new Error("invalid live CLC redemption rate");
  return ((deficit * rate + CLC_UNIT - 1n) / CLC_UNIT).toString();
}

export class PointsConversionService {
  private readonly stateFile: string;
  private readonly auditFile: string;
  private readonly configFile: string;
  private inFlight = false;
  private lastAutoCheckAt = 0;
  private config: PointsConversionConfig = { ...DEFAULT_CONFIG };

  constructor(
    private readonly client: ColliderClient,
    private readonly wallet: AgentWallet,
    private readonly expectedPins: {
      expectedNetworkDomain?: string | null;
      expectedNetworkId?: number | null;
      expectedL1Id?: string | null;
      expectedChainId?: string | null;
      expectedSigningChainId?: number | null;
    },
    dataDir: string,
  ) {
    this.stateFile = path.join(dataDir, "rc1-points-conversion-state.json");
    this.auditFile = path.join(dataDir, "rc1-points-conversions.jsonl");
    this.configFile = path.join(dataDir, "points-conversion-config.json");
  }

  async init(): Promise<void> {
    try {
      this.config = normalizeConfig(JSON.parse(await readFile(this.configFile, "utf8")) as PointsConversionConfig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.client.setExternalPendingIntentCheck(async () => !!await this.loadPending());
    const pending = await this.loadPending();
    if (pending) {
      const result = await this.reconcile(pending, 30_000);
      if (result.status === "pending") throw new Error(`unresolved points conversion nonce ${pending.prepared.nonce}; refusing live play`);
    }
  }

  async status(): Promise<{ available: true; config: PointsConversionConfig; history: PointsConversionAudit[]; pending: { nonce: number; pointsIn: string; createdAt: string } | null }> {
    const pending = await this.loadPending();
    const history = (await readJsonlTail<PointsConversionAudit>(this.auditFile, 40)).rows;
    return {
      available: true,
      config: { ...this.config },
      history,
      pending: pending ? { nonce: pending.prepared.nonce, pointsIn: pending.pointsIn, createdAt: pending.createdAt } : null,
    };
  }

  async saveConfig(patch: Partial<PointsConversionConfig>): Promise<PointsConversionConfig> {
    if (typeof patch !== "object" || !patch || Array.isArray(patch)) throw new Error("invalid conversion config");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
    const next = normalizeConfig({ ...this.config, ...patch });
    await this.atomicWrite(this.configFile, JSON.stringify(next, null, 2));
    this.config = next;
    return { ...next };
  }

  private async atomicWrite(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  }

  private async loadPending(): Promise<PendingConversion | null> {
    try {
      const row = JSON.parse(await readFile(this.stateFile, "utf8")) as { pending?: PendingConversion | null };
      if (row.pending && row.pending.schema !== "collider.agent1.points-conversion-pending.v1") throw new Error("unknown conversion journal schema");
      return row.pending ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async savePending(pending: PendingConversion | null): Promise<void> {
    await this.atomicWrite(this.stateFile, JSON.stringify({ schema: "collider.agent1.points-conversion-state.v1", pending }, null, 2));
  }

  private async complete(pending: PendingConversion, row: PointsConversionAudit): Promise<void> {
    const prior = await this.findAudit((entry) => entry.nonce === row.nonce && entry.opId === row.opId);
    if (!prior) {
      await appendFile(this.auditFile, JSON.stringify(row) + "\n", "utf8");
    }
    await this.savePending(null);
  }

  // Only signed mutations scan the complete append-only audit. The monitor's
  // regular status path remains bounded to the latest 40 rows.
  private async findAudit(match: (entry: PointsConversionAudit) => boolean): Promise<PointsConversionAudit | null> {
    let text: string;
    try {
      text = await readFile(this.auditFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as PointsConversionAudit;
      if (match(row)) return row;
    }
    return null;
  }

  private async reconcile(pending: PendingConversion, timeoutMs: number): Promise<PointsConversionAudit | { status: "pending"; nonce: number; opId: string | null }> {
    const deadline = Date.now() + timeoutMs;
    do {
      const context = await this.client.getAuthContext(this.wallet.userId);
      const start = Math.max(pending.prepared.issued_at_height + 1, pending.lastScannedHeight + 1);
      for (let height = start; height <= context.last_accepted_height; height++) {
        const events = await this.client.getBlockEventsAt(height);
        const auth = events.map((event) => eventPayload(event, "SignedIntentAuthenticated")).find((event) => event
          && cleanHex(event.signer) === cleanHex(this.wallet.userId)
          && Number(event.nonce) === pending.prepared.nonce
          && String(event.action) === pending.prepared.action
          && cleanHex(event.payload_hash) === cleanHex(pending.prepared.payload_hash));
        if (auth) {
          const redemptions = events.map((event) => eventPayload(event, "PointsRedeemed")).filter((event) => event
            && cleanHex(event.user) === cleanHex(this.wallet.userId)
            && String(event.points_in) === pending.pointsIn);
          if (redemptions.length > 1) throw new Error(`ambiguous points redemption events at height ${height}; preserving signed-operation journal`);
          const redemption = redemptions[0];
          const row: PointsConversionAudit = {
            schema: "collider.agent1.points-conversion-audit.v1",
            ts: new Date().toISOString(),
            source: pending.source,
            requestId: pending.requestId,
            status: redemption ? "confirmed" : "business_rejected",
            pointsIn: pending.pointsIn,
            clcOutBase: redemption ? String(redemption.clc_out) : null,
            rate: redemption ? String(redemption.points_per_clc) : pending.rate,
            nonce: pending.prepared.nonce,
            opId: pending.submission?.op_id ?? null,
            acceptedAtHeight: height,
            submitError: pending.submitError,
          };
          await this.complete(pending, row);
          return row;
        }
        pending.lastScannedHeight = height;
      }
      await this.savePending(pending);
      if (Date.now() >= deadline) break;
      await sleep(1_500);
    } while (Date.now() <= deadline);
    return { status: "pending", nonce: pending.prepared.nonce, opId: pending.submission?.op_id ?? null };
  }

  async redeem(params: { pointsIn: string; expectedPointsPerClc: string; requestId: string; source: "manual" | "auto" }): Promise<PointsConversionAudit | { status: "pending"; nonce: number; opId: string | null }> {
    if (this.inFlight) throw new Error("points conversion already in progress");
    this.inFlight = true;
    try {
      return await this.client.withSignedIntentLock(async () => {
        const old = await this.loadPending();
        if (old) return await this.reconcile(old, 0); // Never sign or broadcast a replacement.
        if (await this.client.hasExternalPendingIntent()) throw new Error("another signed operation requires reconciliation");
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(params.requestId)) throw new Error("invalid conversion request id");
        const repeated = await this.findAudit((row) => row.requestId === params.requestId);
        if (repeated) return repeated;
        const pointsIn = exactPositive(params.pointsIn, "pointsIn");
        const expectedRate = exactPositive(params.expectedPointsPerClc, "expectedPointsPerClc");
        const existingThrow = await this.client.reconcilePendingSignedIntent(0);
        if (existingThrow) throw new Error(`throw nonce ${existingThrow.result.nonce} needs reconciliation before conversion`);
        const ladder = await this.client.getLadderUser(this.wallet.userId);
        if (!ladder || BigInt(ladder.points_total) < BigInt(pointsIn)) throw new Error("insufficient spendable ladder points");
        const quote = await this.client.getClcRedemptionQuote(this.wallet.userId, pointsIn);
        if (!quote.enabled || BigInt(quote.clc_out) <= 0n) throw new Error(quote.disable_reason || "redemption quote disabled");
        if (quote.points_in !== pointsIn || quote.points_per_clc !== expectedRate) throw new Error("redemption rate changed; refresh the quote before signing");
        if (params.source === "auto") {
          if (!this.config.enabled || getControlState().state !== "live") throw new Error("automatic conversion was disabled or Agent1 was paused");
          if (BigInt(quote.points_per_clc) > BigInt(this.config.maxPointsPerClc)) throw new Error("current rate exceeds auto-convert ceiling");
        }

        const context = await this.client.getAuthContext(this.wallet.userId);
        const prepared = await this.client.prepareSignedIntent({
          signer: this.wallet.userId,
          method: "colliderV2.redeemPointsForClc",
          params: [this.wallet.userId, pointsIn],
          ttl_blocks: 32,
        });
        verifyPreparedPointsRedemption({
          prepared, context, user: this.wallet.userId, pointsIn, wallet: this.wallet,
          ...this.expectedPins,
        });
        if (params.source === "auto" && (!this.config.enabled || getControlState().state !== "live")) {
          throw new Error("automatic conversion was disabled or Agent1 was paused before signing");
        }
        const signature = await this.wallet.signPreparedIntent(prepared);
        const pending: PendingConversion = {
          schema: "collider.agent1.points-conversion-pending.v1",
          createdAt: new Date().toISOString(), source: params.source, requestId: params.requestId,
          pointsIn, quotedClcOutBase: quote.clc_out, rate: quote.points_per_clc,
          prepared, signature, submission: null, submitError: null,
          lastScannedHeight: prepared.issued_at_height,
        };
        await this.savePending(pending); // Journal before any broadcast.
        try {
          pending.submission = await this.client.submitSignedIntent({
            signer: prepared.signer, nonce: prepared.nonce,
            issued_at_height: prepared.issued_at_height,
            valid_until_height: prepared.valid_until_height,
            op_b64: prepared.op_b64, signature,
          });
        } catch (error) {
          pending.submitError = String(error); // A timeout remains ambiguous; never retry.
        }
        await this.savePending(pending);
        return await this.reconcile(pending, 90_000);
      });
    } finally {
      this.inFlight = false;
    }
  }

  async maybeAutoConvert(): Promise<void> {
    if (!this.config.enabled || this.inFlight || Date.now() - this.lastAutoCheckAt < 30_000) return;
    this.lastAutoCheckAt = Date.now();
    if (await this.loadPending()) throw new Error("auto-convert has an unresolved signed operation");
    const balances = await this.client.getBalances(this.wallet.userId);
    const existingClc = String(balances[CLC_ASSET] ?? "0");
    if (BigInt(existingClc) >= BigInt(this.config.targetClcBase)) return;
    const ladder = await this.client.getLadderUser(this.wallet.userId);
    if (!ladder || BigInt(ladder.points_total) < BigInt(this.config.minPointsPerConversion)) return;
    // A full-balance quote can be disabled by treasury capacity even when the
    // smaller target-sized conversion is valid. Probe only the configured minimum.
    const availableQuote = await this.client.getClcRedemptionQuote(this.wallet.userId, this.config.minPointsPerConversion);
    if (!availableQuote.enabled || BigInt(availableQuote.points_per_clc) > BigInt(this.config.maxPointsPerClc)) return;
    const pointsIn = pointsNeededForTarget(this.config.targetClcBase, existingClc, availableQuote.points_per_clc);
    if (BigInt(pointsIn) > BigInt(ladder.points_total) || BigInt(pointsIn) < BigInt(this.config.minPointsPerConversion)) return;
    const result = await this.redeem({
      pointsIn, expectedPointsPerClc: availableQuote.points_per_clc,
      requestId: `auto-${Date.now()}-${pointsIn}`, source: "auto",
    });
    if (result.status === "pending") throw new Error(`auto-conversion nonce ${result.nonce} remains unresolved`);
    if (result.status !== "confirmed") throw new Error(`auto-conversion nonce ${result.nonce} did not redeem`);
  }
}
