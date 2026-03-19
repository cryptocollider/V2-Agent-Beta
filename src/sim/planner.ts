import type {
  AgentControlThrow,
  Hex32,
  QueueScenario,
  SimRunInput,
} from "../collider/types.js";
import { appendSyntheticThrow, buildQueueScenarioSet } from "../collider/throw-builder.js";
import type { WasmVizRuntime } from "./wasm.js";
import { decodeGameResult, type DecodedGameResult } from "./decode.js";

export type CandidateScenarioRun = {
  scenario: QueueScenario;
  syntheticThrowId: Hex32;
  rawFinalizeBytes: Uint8Array;
  decoded: DecodedGameResult;
  meta: Record<string, unknown>;
};

export type CandidatePlanRun = {
  control: AgentControlThrow;
  perScenario: CandidateScenarioRun[];
};

export type PlanOptions = {
  nextAcceptedHeight: number;
  includeSlip1?: boolean;
};

function throwIdHexFromLast(simInput: SimRunInput): Hex32 {
  const last = simInput.throws[simInput.throws.length - 1];
  if (!last) return "";
  const arr = last.id as unknown as number[];
  return arr.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}

export async function runCandidateAcrossQueueScenarios(
  wasm: WasmVizRuntime,
  gameId: Hex32,
  botUser: Hex32,
  simInput: SimRunInput,
  control: AgentControlThrow,
  opts: PlanOptions,
): Promise<CandidatePlanRun> {
  const allScenarios = buildQueueScenarioSet(simInput, opts.nextAcceptedHeight);
  const scenarios: QueueScenario[] = opts.includeSlip1 === false
    ? [allScenarios[0]]
    : allScenarios;

  const perScenario: CandidateScenarioRun[] = await Promise.all(
    scenarios.map(async (scenario) => {
      const syntheticInput = appendSyntheticThrow(
        gameId,
        control,
        simInput,
        botUser,
        scenario,
      );

      const rawFinalizeBytes = await wasm.runToFinalize(syntheticInput);
      const decoded = decodeGameResult(rawFinalizeBytes);

      const syntheticThrowId = throwIdHexFromLast(syntheticInput);

      return {
        scenario,
        syntheticThrowId,
        rawFinalizeBytes,
        decoded,
        meta: {
          throwsBefore: simInput.throws.length,
          throwsAfter: syntheticInput.throws.length,
          enterFrame: scenario.enterFrame,
          acceptedAtHeight: scenario.acceptedAtHeight,
        },
      };
    }),
  );

  return {
    control,
    perScenario,
  };
}