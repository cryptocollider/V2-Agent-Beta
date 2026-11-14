import type { ReconciledStoredThrow } from "../collider/client.js";
import type { ArtifactLogRef, StoragePaths } from "../core/storage.js";
import { appendThrowLog } from "../core/storage.js";

export type RecoveredAcceptedDecision = {
  decisionId: string;
  gameId: string;
  submittedAt: number;
  expected: ReconciledStoredThrow["expected"];
  predictionCommitRef?: ArtifactLogRef;
};

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataArtifact(metadata: Record<string, unknown> | null): ArtifactLogRef | undefined {
  const value = metadata?.predictionCommit;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ArtifactLogRef
    : undefined;
}

export async function recordReconciledAcceptedThrow(
  storage: StoragePaths,
  recovered: ReconciledStoredThrow,
  fallbackSessionId: string,
): Promise<RecoveredAcceptedDecision | null> {
  if (recovered.result.status !== "throw_accepted") return null;

  const metadata = recovered.metadata;
  const ts = metadataString(metadata, "ts") ?? new Date().toISOString();
  const decisionId = metadataString(metadata, "decisionId")
    ?? `rc1-${recovered.result.payloadHash}-${recovered.result.nonce}`;
  const sessionId = metadataString(metadata, "sessionId") ?? fallbackSessionId;
  const candidateHash = metadataString(metadata, "candidateHash") ?? undefined;
  const predictionCommit = metadataArtifact(metadata);

  await appendThrowLog(storage, {
    ts,
    sessionId,
    decisionId,
    gameId: recovered.expected.game_id,
    botUser: recovered.expected.user,
    submitted: true,
    signedIntent: recovered.result,
    dryRun: false,
    eligibilityCode: "rc1_reconciled",
    candidateHash,
    payload: recovered.expected,
    predictionCommit,
  });

  return {
    decisionId,
    gameId: recovered.expected.game_id,
    submittedAt: new Date(ts).getTime() || Date.now(),
    expected: recovered.expected,
    predictionCommitRef: predictionCommit,
  };
}
