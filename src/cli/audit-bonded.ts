import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertCapabilities, CANDIDATE_WASM_SHA256, CLC_ASSET, exact, parseExactJson } from "../confirmations/contract.js";
import { FUJI_BONDED_CHAIN, FUJI_BONDED_DOMAIN, FUJI_BONDED_PINS, ensureFujiBondedProfile } from "../core/fuji-bonded.js";
import type { Rc1AuthContext } from "../collider/types.js";
import { assertNativeSigningContext } from "../collider/native-signing.js";

/** Read-only five-node evidence. This module never imports a wallet or prepares/submits signed work. */
export async function auditBondedCanary(dataDir: string, outputName: string) {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(outputName)) throw new Error("use a public report basename");
  await ensureFujiBondedProfile(dataDir);
  const settings = JSON.parse(await readFile(path.join(dataDir, "settings.json"), "utf8"));
  const user = "0x" + String(settings.user).replace(/^0x/, "").toLowerCase();
  async function local(name: string): Promise<any> {
    try { return JSON.parse(await readFile(path.join(dataDir, name), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  const [publicReceipts, funding, nativeIntent, conversion, config] = await Promise.all([
    local("confirmation-receipts.json"), local("testnet-funding-state.json"),
    local("rc1-intent-state.json"), local("rc1-points-conversion-state.json"), local("bonded-confirmations.json"),
  ]);
  const gameIds = (publicReceipts?.jobs ?? []).map((j: any) => String(j.gameId)).slice(0, 4);
  const nodes = await Promise.all([11550, 11552, 11554, 11556, 11558].map(async port => {
    async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      const response = await fetch("http://127.0.0.1:" + port + "/ext/bc/" + FUJI_BONDED_CHAIN + "/collider_v2", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "colliderV2." + method, params }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("audit RPC unavailable");
      const body = parseExactJson(await response.text()) as { result: T; error?: unknown };
      if (body.error) throw new Error("audit RPC rejected");
      return body.result;
    }
    const [auth, ladder, balances, stats, policy] = await Promise.all([
      rpc<Rc1AuthContext>("getAuthContext", [user]),
      rpc<{ level: number; points_total: string; throw_count: string } | null>("getLadderUser", [user]),
      rpc<Record<string, string>>("getBalances", [user]),
      rpc<Record<string, unknown>>("getVerificationStats", [user]),
      rpc<{ artifact_hash: string; result_digest_version: number; policy: any }>("getConfirmationPolicy"),
    ]);
    assertCapabilities(auth, FUJI_BONDED_PINS);
    if (policy.artifact_hash !== "0x" + CANDIDATE_WASM_SHA256 || policy.result_digest_version !== 2
        || auth.user?.user_id !== user) throw new Error("audit native identity/artifact mismatch");
    const selected = (asset: string) => exact(balances[asset] ?? balances[asset.slice(2)] ?? "0");
    const points = exact(ladder?.points_total ?? "0");
    const quote = BigInt(points) > 0n ? await rpc("getClcRedemptionQuote", [user, points]) : null;
    const rounds = await Promise.all(gameIds.map(async (game: string) => {
      const round = await rpc<any>("getConfirmationRound", [game]);
      return round ? { gameId: game, roundId: round.round_id, phase: round.phase,
        candidates: (round.candidates ?? []).filter((c: any) => c.user === user).map((c: any) => ({
          user: c.user, commitment: c.commitment, acceptedHeight: c.accepted_height, acceptedTime: c.accepted_time,
          bondBase: c.bond_clc_base, answer: c.answer, correct: c.correct,
          principalReturned: c.principal_returned, principalForfeited: c.principal_forfeited,
        })) } : { gameId: game, retention: "not_available_not_proof_of_forfeiture" };
    }));
    return { port, height: auth.last_accepted_height, acceptedNextNonce: auth.user!.accepted_next_nonce,
      nextAvailableNonce: auth.user!.next_available_nonce, signingEpoch: assertNativeSigningContext(auth, 43113).epoch,
      level: ladder?.level ?? 0, points, scoredThrows: exact(ladder?.throw_count ?? "0"),
      clcBase: selected(CLC_ASSET), diemBase: selected("0x" + "09".repeat(32)), quote,
      bondedStats: stats, confirmationPolicy: policy.policy, rounds };
  }));
  const comparable = (n: typeof nodes[number]) => JSON.stringify({ ...n, port: undefined, height: undefined });
  if (!nodes.every(n => comparable(n) === comparable(nodes[0]))) throw new Error("five-node wallet/quote/confirmation agreement changed; preserve state and recapture read-only");
  const report = { schema: "agent1.bonded-five-node-audit.v1", asOf: new Date().toISOString(),
    networkDomain: FUJI_BONDED_DOMAIN, chain: FUJI_BONDED_CHAIN, user, fiveNodeAgreement: true,
    eligibility: { requiredLevel: 1, currentLevel: nodes[0].level, levelMet: nodes[0].level >= 1,
      requiredBondBase: exact(nodes[0].confirmationPolicy.bond_clc),
      bondBalanceMet: BigInt(nodes[0].clcBase) >= BigInt(exact(nodes[0].confirmationPolicy.bond_clc)) },
    local: { throwPendingNonce: nativeIntent?.pending?.prepared?.nonce ?? null,
      conversionPendingNonce: conversion?.pending?.prepared?.nonce ?? null,
      confirmationsEnabled: config.enabled, maxNewRounds: config.maxNewRounds, maxCapitalBase: config.maxCapitalBase,
      funding: funding ? { stage: funding.stage, claimStage: funding.claim?.stage ?? null,
        approvalTx: funding.approval?.txHash ?? null, depositTx: funding.deposit?.txHash ?? null } : null },
    publicReceipts: publicReceipts?.jobs ?? [], nodes };
  await writeFile(path.join(dataDir, outputName), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes("--data-dir") || !process.argv.includes("--output")) throw new Error("--data-dir and fresh --output basename required");
  const report = await auditBondedCanary(arg("--data-dir"), arg("--output"));
  console.log(JSON.stringify({ user: report.user, fiveNodeAgreement: report.fiveNodeAgreement,
    eligibility: report.eligibility, acceptedNextNonce: report.nodes[0].acceptedNextNonce,
    clcBase: report.nodes[0].clcBase, diemBase: report.nodes[0].diemBase, output: arg("--output") }));
}
