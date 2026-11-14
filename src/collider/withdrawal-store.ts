import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BridgeWithdrawalArgs,
  BridgeWithdrawalPreview,
  BridgeWithdrawalResult,
  BridgeWithdrawalObservation,
  PreparedSignedIntent,
  SubmittedSignedIntent,
} from "./types.js";

export type PendingSignedWithdrawal = {
  schema: "collider.agent1.signed-withdrawal.v1";
  createdAt: string;
  updatedAt: string;
  prepared: PreparedSignedIntent;
  expected: BridgeWithdrawalArgs;
  preview: BridgeWithdrawalPreview;
  custodySignature: string;
  intentSignature: string;
  submission: SubmittedSignedIntent | null;
  submitError: string | null;
  balanceBefore: string;
  lastScannedHeight: number;
};

type WithdrawalState = {
  schema: "collider.agent1.withdrawal-state.v1";
  pending: PendingSignedWithdrawal | null;
};

export class Rc1WithdrawalStore {
  constructor(private readonly stateFile: string) {}

  private auditFile(): string {
    return path.join(path.dirname(this.stateFile), "rc1-signed-withdrawals.jsonl");
  }

  async loadPending(): Promise<PendingSignedWithdrawal | null> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<WithdrawalState>;
      return parsed.schema === "collider.agent1.withdrawal-state.v1" && parsed.pending?.schema === "collider.agent1.signed-withdrawal.v1"
        ? parsed.pending
        : null;
    } catch {
      return null;
    }
  }

  async savePending(pending: PendingSignedWithdrawal): Promise<void> {
    await this.writeState({
      schema: "collider.agent1.withdrawal-state.v1",
      pending: { ...pending, updatedAt: new Date().toISOString() },
    });
  }

  async complete(pending: PendingSignedWithdrawal, result: BridgeWithdrawalResult): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await appendFile(this.auditFile(), `${JSON.stringify({
      schema: "collider.agent1.signed-withdrawal-audit.v1",
      ts: new Date().toISOString(),
      signer: result.signer,
      nonce: result.nonce,
      payloadHash: result.payloadHash,
      opId: result.opId,
      requestId: result.requestId,
      status: result.status,
      authenticatedAtHeight: result.authenticatedAtHeight,
      reservedAtHeight: result.reservedAtHeight,
      asset: pending.expected.asset,
      amount: pending.expected.amount,
      withdrawalNonce: pending.expected.withdrawalNonce,
      originRefId: pending.expected.originRefId,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      submitError: result.submitError,
    })}\n`, "utf8");
    await this.writeState({ schema: "collider.agent1.withdrawal-state.v1", pending: null });
  }

  async recordObservation(observation: BridgeWithdrawalObservation): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await appendFile(path.join(path.dirname(this.stateFile), "rc1-withdrawal-observations.jsonl"), `${JSON.stringify({
      schema: "collider.agent1.withdrawal-observation.v1",
      ts: new Date().toISOString(),
      ...observation,
    })}\n`, "utf8");
  }

  private async writeState(state: WithdrawalState): Promise<void> {
    const dir = path.dirname(this.stateFile);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.stateFile);
  }
}
