import { Interface } from "ethers";
import type { AgentSettings } from "./settings.js";
import { FUJI_BONDED_CHAIN, FUJI_BONDED_DOMAIN } from "./fuji-bonded.js";

export const BONDED_TOPUP = { campaign: "bonded-operator-diem-20261021a",
  wallet: "0x8575d1e6b4f9aac31321d9bb094b7eb87d626770",
  token: "0x5bc1cb82cb2684fe4eec76ab7feb80ba0797c20c",
  custody: "0x214b60558281d87f4e272baf3348ddf2bd8c8ebf",
  amount: 1000000000000000000n, baseline: 55555555555555555n,
  origin: "0xb7c73f842f5a6eeb0056378bb3ff6b6636d017d763b12429db1dbcfdc02094ab",
  source: "0xc27fb75f720ec80513248d496e1cf9062dbc8968" } as const;
const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

export function assertBondedTopupLocal(settings: AgentSettings, state: {
  originalFundingStage: unknown; nativePending: boolean; conversionPending: boolean; jobs: number;
}): void {
  if (settings.expectedEvmAddress?.toLowerCase() !== BONDED_TOPUP.wallet
      || settings.expectedNetworkDomain !== FUJI_BONDED_DOMAIN
      || !settings.rpc.includes("/" + FUJI_BONDED_CHAIN + "/")
      || settings.bridgeWithdrawal?.custodyContract?.toLowerCase() !== BONDED_TOPUP.custody
      || settings.expectedSigningChainId !== 43113 || state.originalFundingStage !== "COMPLETE"
      || state.nativePending || state.conversionPending || state.jobs !== 0) {
    throw new Error("bonded top-up requires exact new-chain owner, completed original grant and no pending work/jobs");
  }
}
export function assertBondedTopupOrigin(receipt: any): void {
  if (!receipt || receipt.status !== "0x1" || receipt.transactionHash?.toLowerCase() !== BONDED_TOPUP.origin) {
    throw new Error("exact bonded origin transfer receipt missing");
  }
  const matches = (receipt.logs ?? []).filter((log: any) => log.address?.toLowerCase() === BONDED_TOPUP.token)
    .flatMap((log: any) => { try { const event = transfer.parseLog(log); return event?.name === "Transfer"
      && event.args.from.toLowerCase() === BONDED_TOPUP.source && event.args.to.toLowerCase() === BONDED_TOPUP.wallet
      ? [event.args.value] : []; } catch { return []; } });
  if (matches.length !== 1 || matches[0] !== BONDED_TOPUP.amount) throw new Error("bonded origin transfer amount/source/recipient mismatch");
}

/** Read-only recovery of a previously attempted EVM hash; absence is never permission to rebroadcast. */
export function bondedAttemptReceipt(stored: { txHash: string; to: string }, receipt: any, tip: bigint) {
  const block = receipt?.blockNumber && /^0x[0-9a-f]+$/i.test(receipt.blockNumber) ? BigInt(receipt.blockNumber) : -1n;
  if (!receipt || receipt.transactionHash?.toLowerCase() !== stored.txHash.toLowerCase()
      || receipt.from?.toLowerCase() !== BONDED_TOPUP.wallet || receipt.to?.toLowerCase() !== stored.to.toLowerCase()
      || receipt.status !== "0x1" || block < 0n || block > BigInt(Number.MAX_SAFE_INTEGER)
      || tip - block + 1n < 2n || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash ?? "")) {
    throw new Error("existing EVM attempt is unresolved; no replay authorized");
  }
  return { blockNumber: Number(block), blockHash: receipt.blockHash as string, status: 1,
    confirmedAt: new Date().toISOString() };
}
