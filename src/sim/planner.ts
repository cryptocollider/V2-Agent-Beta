import type {
  AgentControlThrow,
  Hex32,
  QueueScenario,
  SimRunInput,
} from "../collider/types.js";
import {
  appendSyntheticThrow,
  buildQueueScenarioSet,
  buildSyntheticThrowRecord,
  nextEnterFrame,
} from "../collider/throw-builder.js";
import type { WasmVizRuntime } from "./wasm.js";
import { decodeGameResult, type DecodedGameResult } from "./decode.js";

export type PlannedFutureThrow = AgentControlThrow & {
  user?: Hex32;
  label?: string;
  enterFrameOffset?: number;
  acceptedAtHeightOffset?: number;
};

export type PlannerScenarioOverride = QueueScenario & {
  futureThrows?: PlannedFutureThrow[];
};

export type CandidateScenarioRun = {
  scenario: PlannerScenarioOverride;
  syntheticThrowId: Hex32;
  syntheticInput: SimRunInput;
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
  scenarioOverrides?: PlannerScenarioOverride[];
};

function throwIdHexFromLast(simInput: SimRunInput): Hex32 {
  const last = simInput.throws[simInput.throws.length - 1];
  if (!last) return "";
  const arr = last.id as unknown as number[];
  return arr.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}

function cloneSimInput(simInput: SimRunInput): SimRunInput {
  return JSON.parse(JSON.stringify(simInput)) as SimRunInput;
}

function buildScenarioSet(simInput: SimRunInput, opts: PlanOptions): PlannerScenarioOverride[] {
  if (opts.scenarioOverrides?.length) {
    return opts.scenarioOverrides.map((scenario) => ({
      label: scenario.label,
      enterFrame: scenario.enterFrame,
      acceptedAtHeight: scenario.acceptedAtHeight,
      weight: scenario.weight,
      futureThrows: scenario.futureThrows?.map((futureThrow) => ({ ...futureThrow })),
    }));
  }

  const allScenarios = buildQueueScenarioSet(simInput, opts.nextAcceptedHeight);
  return (opts.includeSlip1 === false ? [allScenarios[0]] : allScenarios).map((scenario) => ({
    ...scenario,
    futureThrows: [],
  }));
}

function appendFutureThrows(
  gameId: Hex32,
  simInput: SimRunInput,
  futureThrows: PlannedFutureThrow[],
  initialScenario: PlannerScenarioOverride,
  defaultUser: Hex32,
): SimRunInput {
  let workingInput = cloneSimInput(simInput);
  let previousAcceptedAtHeight = initialScenario.acceptedAtHeight;

  for (let index = 0; index < futureThrows.length; index++) {
    const futureThrow = futureThrows[index];
    const scenario: QueueScenario = {
      label: futureThrow.label || `future-${index + 1}`,
      enterFrame: Number.isFinite(Number(futureThrow.enterFrameOffset))
        ? initialScenario.enterFrame + Number(futureThrow.enterFrameOffset)
        : nextEnterFrame(workingInput),
      acceptedAtHeight: Number.isFinite(Number(futureThrow.acceptedAtHeightOffset))
        ? initialScenario.acceptedAtHeight + Number(futureThrow.acceptedAtHeightOffset)
        : previousAcceptedAtHeight + 1,
      weight: 1,
    };

    const syntheticThrow = buildSyntheticThrowRecord(
      gameId,
      {
        x: futureThrow.x,
        y: futureThrow.y,
        angleDeg: futureThrow.angleDeg,
        speedPct: futureThrow.speedPct,
        spinPct: futureThrow.spinPct,
        asset: futureThrow.asset,
        amount: futureThrow.amount,
      },
      workingInput,
      futureThrow.user ?? defaultUser,
      scenario,
    );

    workingInput = {
      ...workingInput,
      throws: [...workingInput.throws, syntheticThrow],
    };
    previousAcceptedAtHeight = scenario.acceptedAtHeight;
  }

  return workingInput;
}

export async function runCandidateAcrossQueueScenarios(
  wasm: WasmVizRuntime,
  gameId: Hex32,
  botUser: Hex32,
  simInput: SimRunInput,
  control: AgentControlThrow,
  opts: PlanOptions,
): Promise<CandidatePlanRun> {
  const scenarios = buildScenarioSet(simInput, opts);

  const perScenario: CandidateScenarioRun[] = await Promise.all(
    scenarios.map(async (scenario) => {
      const candidateInput = appendSyntheticThrow(
        gameId,
        control,
        simInput,
        botUser,
        scenario,
      );
      const syntheticThrowId = throwIdHexFromLast(candidateInput);

      const syntheticInput = scenario.futureThrows?.length
        ? appendFutureThrows(
            gameId,
            candidateInput,
            scenario.futureThrows,
            scenario,
            botUser,
          )
        : candidateInput;

      const rawFinalizeBytes = await wasm.runToFinalize(syntheticInput);
      const decoded = decodeGameResult(rawFinalizeBytes);

      return {
        scenario,
        syntheticThrowId,
        syntheticInput,
        rawFinalizeBytes,
        decoded,
        meta: {
          throwsBefore: simInput.throws.length,
          throwsAfter: syntheticInput.throws.length,
          enterFrame: scenario.enterFrame,
          acceptedAtHeight: scenario.acceptedAtHeight,
          futureThrowCount: scenario.futureThrows?.length ?? 0,
          futureScenarioLabel: scenario.label,
        },
      };
    }),
  );

  return {
    control,
    perScenario,
  };
}
