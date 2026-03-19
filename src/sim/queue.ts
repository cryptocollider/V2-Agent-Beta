import type { QueueScenario, SimRunInput } from "../collider/types.js";
import { buildQueueScenarioSet } from "../collider/throw-builder.js";

export type QueueModelOptions = {
  includeSlip1?: boolean;
};

export function buildPlannerQueueScenarios(
  simInput: SimRunInput,
  nextAcceptedHeight: number,
  opts: QueueModelOptions = {},
): QueueScenario[] {
  const base = buildQueueScenarioSet(simInput, nextAcceptedHeight);

  if (opts.includeSlip1 === false) {
    return [base[0]];
  }

  return base;
}