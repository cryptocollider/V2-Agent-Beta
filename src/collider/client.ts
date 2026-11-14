import { setTimeout as sleep } from "node:timers/promises";

import { JsonRpcClient } from "../core/rpc.js";
import { Rc1IntentStore, type PendingSignedThrow } from "./intent-store.js";
import type {
  GameListItem,
  Hex32,
  PlaceThrowArgs,
  PreparedSignedIntent,
  Rc1AuthContext,
  Rc1ClientOptions,
  SignedThrowResult,
  SimRunInput,
  SubmitSignedIntentArgs,
  SubmittedSignedIntent,
  ThrowRecord,
} from "./types.js";
import { AgentWallet, verifyPreparedPlaceThrow } from "./wallet.js";
import { assertNativeSigningContext } from "./native-signing.js";

export type ReconciledStoredThrow = {
  result: SignedThrowResult;
  expected: PlaceThrowArgs;
  metadata: Record<string, unknown> | null;
};

export class PendingSignedIntentError extends Error {
  constructor(readonly result: SignedThrowResult) {
    super(`signed throw nonce ${result.nonce} remains pending canonical reconciliation`);
    this.name = "PendingSignedIntentError";
  }
}

function cleanHex(value: unknown): string {
  return String(value ?? "").trim().replace(/^0x/i, "").toLowerCase();
}

function with0x(value: unknown): string {
  const cleaned = cleanHex(value);
  return cleaned ? `0x${cleaned}` : "";
}

function bytesHex(value: unknown): string {
  if (Array.isArray(value)) return Buffer.from(value.map(Number)).toString("hex");
  return cleanHex(value);
}

function matchingThrow(input: SimRunInput, expected: PlaceThrowArgs): ThrowRecord | null {
  const user = cleanHex(expected.user);
  const commit = expected.data_commit == null ? "" : cleanHex(expected.data_commit);
  const asset = cleanHex(expected.asset);
  return input.throws.find((row) =>
    bytesHex(row.user) === user
    && bytesHex(row.asset) === asset
    && String(row.amount) === String(expected.amount)
    && (row.data_commit == null ? "" : bytesHex(row.data_commit)) === commit
  ) ?? null;
}

function eventPayload(event: unknown, kind: string): Record<string, unknown> | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const payload = (event as Record<string, unknown>)[kind];
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function pendingResult(pending: PendingSignedThrow): SignedThrowResult {
  return {
    status: "pending",
    signer: pending.prepared.signer,
    nonce: pending.prepared.nonce,
    payloadHash: pending.prepared.payload_hash,
    opId: pending.submission?.op_id ?? null,
    throwId: null,
    authenticatedAtHeight: null,
    acceptedAtHeight: null,
    submitError: pending.submitError,
  };
}

export class ColliderClient {
  private readonly rpc: JsonRpcClient;
  private readonly intentStore: Rc1IntentStore | null;
  private signedOperationBusy = false;
  private externalPendingIntentCheck: (() => Promise<boolean>) | null = null;
  private readonly pendingChecks = new Map<string, () => Promise<boolean>>();

  constructor(
    url: string,
    private readonly wallet: AgentWallet | null = null,
    private readonly options: Rc1ClientOptions = {},
  ) {
    this.rpc = new JsonRpcClient(url);
    this.intentStore = options.intentStateFile ? new Rc1IntentStore(options.intentStateFile) : null;
  }

  async listGames(statusMask?: number): Promise<GameListItem[]> {
    return this.rpc.call<GameListItem[]>("colliderV2.listGames", statusMask == null ? [] : [statusMask]);
  }

  async getGame(gameId: Hex32): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.getGame", [gameId]);
  }

  async getGameSimulator(gameId:Hex32):Promise<unknown>{return this.rpc.call("colliderV2.getGameSimulator",[gameId]);}
  async getFrozenConfirmationInput(gameId:Hex32):Promise<unknown>{return this.rpc.call("colliderV2.getFrozenConfirmationInput",[gameId]);}

  async getHoleRules(): Promise<Record<string, unknown>> {
    return this.rpc.call<Record<string, unknown>>("colliderV2.getHoleRules", []);
  }

  async getSimInput(gameId: Hex32): Promise<SimRunInput> {
    return this.rpc.call<SimRunInput>("colliderV2.getSimInput", [gameId]);
  }

  async getGameReport(gameId: Hex32): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.getGameReport", [gameId]);
  }

  async getBalances(user: Hex32): Promise<Record<string, string>> {
    return this.rpc.call<Record<string, string>>("colliderV2.getBalances", [user]);
  }

  async getLadderUser(user: Hex32): Promise<{ points_total: string; throw_count: string } | null> {
    return this.rpc.call<{ points_total: string; throw_count: string } | null>("colliderV2.getLadderUser", [user]);
  }

  async getClcRedemptionQuote(user: Hex32, pointsIn: string): Promise<{
    enabled: boolean;
    disable_reason: string | null;
    points_in: string;
    points_per_clc: string;
    clc_out: string;
  }> {
    return this.rpc.call("colliderV2.getClcRedemptionQuote", [user, pointsIn]);
  }

  setExternalPendingIntentCheck(check: () => Promise<boolean>): void {
    this.externalPendingIntentCheck = check;
  }

  registerPendingIntentCheck(id: string, check: () => Promise<boolean>): () => void {
    if (this.pendingChecks.has(id)) throw new Error("duplicate pending intent guard");
    this.pendingChecks.set(id, check);
    return () => { this.pendingChecks.delete(id); };
  }

  async hasExternalPendingIntent(except?: string): Promise<boolean> {
    if (await this.externalPendingIntentCheck?.()) return true;
    for (const [id, check] of this.pendingChecks) if (id !== except && await check()) return true;
    return false;
  }

  isSignedIntentBusy(): boolean { return this.signedOperationBusy; }

  async withSignedIntentLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.signedOperationBusy) throw new Error("another Agent1 signed operation is in progress");
    this.signedOperationBusy = true;
    try {
      return await work();
    } finally {
      this.signedOperationBusy = false;
    }
  }

  async getAssetsMeta(): Promise<unknown> {
    return this.rpc.call<unknown>("colliderV2.getAssetsMeta", []);
  }

  async getBridgeDepositCredit(asset: Hex32, user: Hex32): Promise<Record<string, unknown>> {
    return this.rpc.call<Record<string, unknown>>("colliderV2.getBridgeDepositCredit", [asset, user]);
  }

  async listOracleFeeds(): Promise<unknown[]> {
    return this.rpc.call<unknown[]>("colliderV2.listOracleFeeds", []);
  }

  async getAuthContext(user?: Hex32): Promise<Rc1AuthContext> {
    return this.rpc.call<Rc1AuthContext>("colliderV2.getAuthContext", user ? [with0x(user)] : []);
  }

  async userIdFromEvmAddress(address: string): Promise<Hex32> {
    return this.rpc.call<Hex32>("colliderV2.userIdFromEvmAddress", [address]);
  }

  async getBlockEventsAt(height: number): Promise<unknown[]> {
    return this.rpc.call<unknown[]>("colliderV2.getBlockEventsAt", [height]);
  }

  async prepareSignedIntent(args: {
    signer: Hex32;
    method: string;
    params: unknown[];
    ttl_blocks?: number;
  }): Promise<PreparedSignedIntent> {
    return this.rpc.call<PreparedSignedIntent>("colliderV2.prepareSignedIntent", [args],
      args.method === "colliderV2.commitGameConfirmation" || args.method === "colliderV2.revealGameConfirmation"
        ? { retries: 0, redactErrors: true } : {});
  }

  async submitSignedIntent(args: SubmitSignedIntentArgs, sensitive = false): Promise<SubmittedSignedIntent> {
    // A timeout is ambiguous: the VM may have enqueued the intent. Never let
    // the generic transport retry re-send a signed nonce.
    return this.rpc.call<SubmittedSignedIntent>("colliderV2.submitSignedIntent", [args], { retries: 0, redactErrors: sensitive });
  }

  private assertContext(context: Rc1AuthContext): void {
    assertNativeSigningContext(context, this.options.expectedSigningChainId);
    if (!context.domain_configured) throw new Error("Collider RPC is not an initialized RC1 auth domain");
    if (!context.user?.canonical_wallet_user) throw new Error("Collider RPC rejected Agent1's canonical wallet-backed UserId");
    if (cleanHex(context.user.user_id) !== cleanHex(this.wallet?.userId)) throw new Error("Collider auth context returned a different user identity");
    if (this.options.expectedNetworkDomain && cleanHex(context.network_domain) !== cleanHex(this.options.expectedNetworkDomain)) {
      throw new Error("Collider RPC network domain does not match expectedNetworkDomain");
    }
    if (this.options.expectedNetworkId != null && context.network_id !== this.options.expectedNetworkId) throw new Error("Collider RPC Avalanche network id mismatch");
    if (this.options.expectedL1Id && cleanHex(context.l1_id) !== cleanHex(this.options.expectedL1Id)) throw new Error("Collider RPC L1 id mismatch");
    if (this.options.expectedChainId && cleanHex(context.chain_id) !== cleanHex(this.options.expectedChainId)) throw new Error("Collider RPC chain id mismatch");
  }

  private async reconcilePending(
    pending: PendingSignedThrow,
    timeoutMs: number,
  ): Promise<SignedThrowResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let authenticatedAtHeight: number | null = null;

    do {
      const context = await this.getAuthContext(pending.prepared.signer);
      this.assertContext(context);
      const startHeight = Math.max(pending.prepared.issued_at_height + 1, pending.lastScannedHeight + 1);
      for (let height = startHeight; height <= context.last_accepted_height; height++) {
        const events = await this.getBlockEventsAt(height);
        for (const event of events) {
          const auth = eventPayload(event, "SignedIntentAuthenticated");
          if (
            auth
            && cleanHex(auth.signer) === cleanHex(pending.prepared.signer)
            && Number(auth.nonce) === pending.prepared.nonce
            && String(auth.action) === pending.prepared.action
            && cleanHex(auth.payload_hash) === cleanHex(pending.prepared.payload_hash)
          ) {
            authenticatedAtHeight = height;
          }
        }
        pending.lastScannedHeight = height;
      }

      const nonceConsumed = Number(context.user?.accepted_next_nonce ?? 0) > pending.prepared.nonce;
      if (authenticatedAtHeight != null || nonceConsumed) {
        const input = await this.getSimInput(pending.expected.game_id);
        const accepted = matchingThrow(input, pending.expected);
        const result: SignedThrowResult = accepted
          ? {
            status: "throw_accepted",
            signer: pending.prepared.signer,
            nonce: pending.prepared.nonce,
            payloadHash: pending.prepared.payload_hash,
            opId: pending.submission?.op_id ?? null,
            throwId: with0x(bytesHex(accepted.id)),
            authenticatedAtHeight,
            acceptedAtHeight: accepted.accepted_at_height,
            submitError: pending.submitError,
          }
          : {
            status: "authenticated_business_rejected",
            signer: pending.prepared.signer,
            nonce: pending.prepared.nonce,
            payloadHash: pending.prepared.payload_hash,
            opId: pending.submission?.op_id ?? null,
            throwId: null,
            authenticatedAtHeight,
            acceptedAtHeight: null,
            submitError: pending.submitError,
          };
        if (this.intentStore) await this.intentStore.complete(pending, result);
        return result;
      }

      if (context.last_accepted_height > pending.prepared.valid_until_height) {
        const result: SignedThrowResult = {
          ...pendingResult(pending),
          status: "expired",
        };
        if (this.intentStore) await this.intentStore.complete(pending, result);
        return result;
      }

      if (this.intentStore) await this.intentStore.savePending(pending);
      if (Date.now() >= deadline) break;
      await sleep(Math.max(250, this.options.reconcilePollMs ?? 1_500));
    } while (Date.now() <= deadline);

    return pendingResult(pending);
  }

  async reconcilePendingSignedIntent(timeoutMs = 0): Promise<ReconciledStoredThrow | null> {
    if (!this.intentStore) return null;
    const pending = await this.intentStore.loadPending();
    if (!pending) return null;
    const result = await this.reconcilePending(pending, timeoutMs);
    return {
      result,
      expected: pending.expected,
      metadata: pending.metadata,
    };
  }

  async placeThrowSigned(
    args: PlaceThrowArgs,
    metadata: Record<string, unknown> | null = null,
  ): Promise<SignedThrowResult> {
    return this.withSignedIntentLock(() => this.placeThrowSignedUnlocked(args, metadata));
  }

  private async placeThrowSignedUnlocked(
    args: PlaceThrowArgs,
    metadata: Record<string, unknown> | null,
  ): Promise<SignedThrowResult> {
    if (!this.wallet) throw new Error("live RC1 throw requires a configured Agent1 signing wallet");

    const existing = await this.reconcilePendingSignedIntent(0);
    if (existing) {
      throw new PendingSignedIntentError(existing.result);
    }
    if (await this.hasExternalPendingIntent()) {
      throw new Error("unresolved external signed operation; refusing to sign a new throw");
    }

    const expected: PlaceThrowArgs = {
      ...args,
      user: this.wallet.userId,
      amount: String(args.amount),
    };
    if (!/^\d+$/.test(expected.amount)) throw new Error("throw amount must remain an exact base-unit decimal string");

    const serverUserId = await this.userIdFromEvmAddress(this.wallet.address);
    if (cleanHex(serverUserId) !== cleanHex(this.wallet.userId)) throw new Error("RPC EVM address to Collider UserId derivation mismatch");

    const context = await this.getAuthContext(this.wallet.userId);
    this.assertContext(context);
    const prepared = await this.prepareSignedIntent({
      signer: this.wallet.userId,
      method: "colliderV2.placeThrow",
      params: [expected],
      ttl_blocks: this.options.intentTtlBlocks ?? 32,
    });
    verifyPreparedPlaceThrow({
      prepared,
      context,
      expected,
      wallet: this.wallet,
      expectedNetworkDomain: this.options.expectedNetworkDomain,
      expectedNetworkId: this.options.expectedNetworkId,
      expectedL1Id: this.options.expectedL1Id,
      expectedChainId: this.options.expectedChainId,
      expectedSigningChainId: this.options.expectedSigningChainId,
    });

    const signature = await this.wallet.signPreparedIntent(prepared);
    const pending: PendingSignedThrow = {
      schema: "collider.agent1.signed-throw.v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prepared,
      expected,
      signature,
      submission: null,
      submitError: null,
      lastScannedHeight: prepared.issued_at_height,
      metadata,
    };
    if (this.intentStore) await this.intentStore.savePending(pending);

    try {
      pending.submission = await this.submitSignedIntent({
        signer: prepared.signer,
        nonce: prepared.nonce,
        issued_at_height: prepared.issued_at_height,
        valid_until_height: prepared.valid_until_height,
        op_b64: prepared.op_b64,
        signature,
      });
    } catch (error) {
      pending.submitError = String(error);
    }
    if (this.intentStore) await this.intentStore.savePending(pending);

    return this.reconcilePending(pending, this.options.reconcileTimeoutMs ?? 90_000);
  }
}
