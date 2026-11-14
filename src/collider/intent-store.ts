import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlaceThrowArgs, PreparedSignedIntent, SignedThrowResult, SubmittedSignedIntent } from "./types.js";

export type PendingSignedThrow = {
  schema: "collider.agent1.signed-throw.v1";
  createdAt: string;
  updatedAt: string;
  prepared: PreparedSignedIntent;
  expected: PlaceThrowArgs;
  signature: string;
  submission: SubmittedSignedIntent | null;
  submitError: string | null;
  lastScannedHeight: number;
  metadata: Record<string, unknown> | null;
};

type IntentState = {
  schema: "collider.agent1.intent-state.v1";
  pending: PendingSignedThrow | null;
};

export class Rc1IntentStore {
  constructor(private readonly stateFile: string) {}

  private auditFile(): string {
    return path.join(path.dirname(this.stateFile), "rc1-signed-intents.jsonl");
  }

  async loadPending(): Promise<PendingSignedThrow | null> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<IntentState>;
      return parsed.schema === "collider.agent1.intent-state.v1" && parsed.pending
        ? parsed.pending
        : null;
    } catch {
      return null;
    }
  }

  async savePending(pending: PendingSignedThrow): Promise<void> {
    await this.writeState({
      schema: "collider.agent1.intent-state.v1",
      pending: {
        ...pending,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async complete(pending: PendingSignedThrow, result: SignedThrowResult): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await appendFile(this.auditFile(), `${JSON.stringify({
      schema: "collider.agent1.signed-intent-audit.v1",
      ts: new Date().toISOString(),
      signer: result.signer,
      nonce: result.nonce,
      payloadHash: result.payloadHash,
      opId: result.opId,
      throwId: result.throwId,
      status: result.status,
      authenticatedAtHeight: result.authenticatedAtHeight,
      acceptedAtHeight: result.acceptedAtHeight,
      submitError: result.submitError,
      gameId: pending.expected.game_id,
      dataCommit: pending.expected.data_commit,
      metadata: pending.metadata,
    })}\n`, "utf8");
    await this.writeState({
      schema: "collider.agent1.intent-state.v1",
      pending: null,
    });
  }

  private async writeState(state: IntentState): Promise<void> {
    const dir = path.dirname(this.stateFile);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, this.stateFile);
  }
}
