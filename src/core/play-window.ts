export function assertLivePlayWindow(deadline: number | undefined, now = Date.now()): void {
  if (deadline !== undefined && (!Number.isFinite(deadline) || now >= deadline)) {
    throw new Error("live play deadline reached; no new signed throw authorized");
  }
}
