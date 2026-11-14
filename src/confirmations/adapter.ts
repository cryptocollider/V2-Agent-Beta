import type { ColliderClient } from "../collider/client.js";
import { exact, parseExactJson, type Frozen, type Policy, type Round } from "./contract.js";
import type { ConfirmationTransport, Snapshot } from "./service.js";
import type { Rc1AuthContext } from "../collider/types.js";

/** Read-only, lossless RPC adapter. It never logs server payloads/private openings. */
export class ConfirmationReadRpc implements ConfirmationTransport {
  constructor(private readonly url: string, private readonly client: ColliderClient) {}
  private async call<T>(method: string, params: unknown, chain = false): Promise<T> {
    const url = chain ? this.url.replace(/\/collider_v2$/, "/rpc") : this.url;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("confirmation read RPC unavailable");
    if (!response.body) throw new Error("empty confirmation read response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 20 * 1024 * 1024) throw new Error("confirmation read response exceeds bound");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const text = Buffer.concat(chunks).toString("utf8");
    const body = parseExactJson(text) as { result: T; error?: unknown };
    if (body.error || !("result" in body)) throw new Error("confirmation read RPC rejected");
    return body.result;
  }
  async snapshot(user: string): Promise<Snapshot> {
    for (let i = 0; i < 3; i++) {
      const context = await this.call<Rc1AuthContext>("colliderV2.getAuthContext", [user]);
      const last = await this.call<{ id: string }>("lastAccepted", [], true);
      const { block } = await this.call<{ block: { height: string | number; timestamp: string | number } }>("getBlock", [{ id: last.id }], true);
      if (exact(context.last_accepted_height) === exact(block.height)) return { context, height: block.height, time: block.timestamp };
    }
    throw new Error("accepted chain clock changed during confirmation read");
  }
  list() { return this.call<{ rounds: { game_id: string; phase: string }[] }>("colliderV2.listConfirmationRounds", []); }
  policy() { return this.call<{ policy: Policy; artifact_hash: string; result_digest_version: number }>("colliderV2.getConfirmationPolicy", []); }
  round(game: string) { return this.call<Round | null>("colliderV2.getConfirmationRound", [game]); }
  frozen(game: string) { return this.call<Frozen | null>("colliderV2.getFrozenConfirmationInput", [game]); }
  stats(user: string) { return this.call<unknown>("colliderV2.getVerificationStats", [user]); }
  ladder(user: string) { return this.call<{ level: number; points_total: string; throw_count: string } | null>("colliderV2.getLadderUser", [user]); }
  async balance(user: string) {
    const values = await this.client.getBalances(user);
    return values["0x3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16"]
      ?? values["3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16"] ?? "0";
  }
  events(height: number) { return this.call<unknown[]>("colliderV2.getBlockEventsAt", [height]); }
}
