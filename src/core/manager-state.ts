import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LatestEligibilitySnapshot } from "../agent/eligibility.js";
import {
  normalizeManagerCandidateSet,
  normalizeManagerTacticalOverlay,
  type LatestCandidateContext,
  type ManagerCandidateSet,
  type ManagerTacticalOverlay,
} from "../strategy/tactical-overlay.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const OVERLAY_FILE = "manager-overlay.json";
const MANAGER_CANDIDATES_FILE = "manager-candidates.json";

let dataDir = "./data";
let managerOverlay: ManagerTacticalOverlay | null = null;
let managerCandidateSet: ManagerCandidateSet | null = null;
let latestEligibilitySnapshot: LatestEligibilitySnapshot | null = null;
let latestCandidateContext: LatestCandidateContext | null = null;

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value as JsonValue)) as T;
}

function overlayFile(): string {
  return path.join(dataDir, OVERLAY_FILE);
}

function managerCandidatesFile(): string {
  return path.join(dataDir, MANAGER_CANDIDATES_FILE);
}

export async function initManagerState(nextDataDir = "./data"): Promise<void> {
  dataDir = nextDataDir;
  await mkdir(dataDir, { recursive: true });
  managerOverlay = await loadManagerOverlayFromDisk();
  managerCandidateSet = await loadManagerCandidateSetFromDisk();
}

async function loadManagerOverlayFromDisk(): Promise<ManagerTacticalOverlay | null> {
  try {
    const raw = await readFile(overlayFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagerTacticalOverlay> | null;
    return parsed ? normalizeManagerTacticalOverlay(parsed) : null;
  } catch {
    return null;
  }
}

async function loadManagerCandidateSetFromDisk(): Promise<ManagerCandidateSet | null> {
  try {
    const raw = await readFile(managerCandidatesFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagerCandidateSet> | null;
    return parsed ? normalizeManagerCandidateSet(parsed) : null;
  } catch {
    return null;
  }
}

export function getManagerOverlay(): ManagerTacticalOverlay | null {
  return clone(managerOverlay);
}

export async function saveManagerOverlay(overlay: ManagerTacticalOverlay | null): Promise<ManagerTacticalOverlay | null> {
  managerOverlay = overlay ? normalizeManagerTacticalOverlay(clone(overlay)) : null;

  if (!managerOverlay) {
    try {
      await rm(overlayFile(), { force: true });
    } catch {
      // Ignore missing overlay files.
    }
    return null;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(overlayFile(), JSON.stringify(managerOverlay, null, 2), "utf8");
  return getManagerOverlay();
}

export function getManagerCandidateSet(): ManagerCandidateSet | null {
  return clone(managerCandidateSet);
}

export async function saveManagerCandidateSet(candidateSet: ManagerCandidateSet | null): Promise<ManagerCandidateSet | null> {
  managerCandidateSet = candidateSet ? normalizeManagerCandidateSet(clone(candidateSet)) : null;

  if (!managerCandidateSet) {
    try {
      await rm(managerCandidatesFile(), { force: true });
    } catch {
      // Ignore missing candidate-set files.
    }
    return null;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(managerCandidatesFile(), JSON.stringify(managerCandidateSet, null, 2), "utf8");
  return getManagerCandidateSet();
}

export function getLatestEligibilitySnapshot(): LatestEligibilitySnapshot | null {
  return clone(latestEligibilitySnapshot);
}

export function setLatestEligibilitySnapshot(snapshot: LatestEligibilitySnapshot | null): void {
  latestEligibilitySnapshot = snapshot ? clone(snapshot) : null;
}

export function getLatestCandidateContext(): LatestCandidateContext | null {
  return clone(latestCandidateContext);
}

export function setLatestCandidateContext(snapshot: LatestCandidateContext | null): void {
  latestCandidateContext = snapshot ? clone(snapshot) : null;
}
