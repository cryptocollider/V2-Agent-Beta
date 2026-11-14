#!/usr/bin/env node
import {acceleratedOverride} from "../agent/accelerated.js";
import {setRpcObserver} from "../core/rpc.js";
import {appendFile} from "node:fs/promises";
import { writeFile } from 'node:fs/promises';
import { initializeNewPublicWallet } from '../bank/first-start.js';
import { createInstanceWallet, vaultFile } from '../bank/vault.js';
import { publicPlanningSettings, keylessPreviewEnvironment } from '../agent/preview-settings.js';
import {DisplayNameService} from "../public-rc1/display-name-service.js";
import { BankWalletService } from '../bank/service.js';

import path from "node:path";
import { startForecastPublisher } from "../publisher/publisher.js";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { Worker } from "node:worker_threads";

import { runAgentOnce } from "../agent/loop.js";
import { runAgentSession } from "../agent/session.js";
import { recordReconciledAcceptedThrow } from "../agent/signed-intent-recovery.js";
import { ColliderClient } from "../collider/client.js";
import { Rc1WithdrawalStore } from "../collider/withdrawal-store.js";
import { MASK_LIVE } from "../collider/masks.js";
import { AgentWallet } from "../collider/wallet.js";
import {
  getLatestCandidateContext,
  getLatestEligibilitySnapshot,
  getManagerCandidateSet,
  getManagerOverlay,
  initManagerState,
  saveManagerCandidateSet,
  saveManagerOverlay,
} from "../core/manager-state.js";
import { ensureRc1Bootstrap } from "../core/bootstrap.js";
import {
  FUJI_DIEM_ASSET,
  ensureFujiTestnetFunding,
  type FujiTestnetFundingProgress,
} from "../core/fuji-testnet-funding.js";
import {
  FUJI_EASY_START_DATA_DIR,
  ensureFujiEasyStart,
  prepareFujiEasyStartManager,
} from "../core/fuji-easy-start.js";
import { FUJI_GAP_DATA_DIR, ensureFujiGapEasyStart } from "../core/fuji-gap-easy-start.js";
import { FUJI_NATIVE_V2_DATA_DIR, ensureFujiNativeV2Profile } from "../core/fuji-native-v2.js";
import { FUJI_BONDED_DATA_DIR, ensureFujiBondedProfile } from "../core/fuji-bonded.js";
import { loadSettings, normalizeSettings, saveSettings } from "../core/settings.js";
import { initStorage, makeSessionId } from "../core/storage.js";
import {
  applyControlAction,
  getControlState,
  getRuntimeSettings,
  initRuntimeSettings,
  updateControlState,
  updateRuntimeSettings,
} from "../core/runtime-state.js";
import { DEFAULT_POLICY } from "../policy/schema.js";
import { loadVizWasm, type WasmVizRuntime } from "../sim/wasm.js";
import { buildReplaySvgExportWithRuntime } from "../monitor/replay-svg.js";
import { PointsConversionService, type PointsConversionConfig } from "../points/conversion.js";
import { loadBondedConfirmations } from "../confirmations/integration.js";
import type { BondedConfirmationService } from "../confirmations/service.js";
import { PUBLIC_RC1, assertPublicAuth } from "../public-rc1/contract.js";
import { assertPublicSettings, inspectOwnerJournals, acquirePublicSignerLease } from "../public-rc1/profile.js";
import { publicPreflight } from "../public-rc1/preflight.js";
import { ensurePublicFunding } from "../public-rc1/funding.js";
import { loadPublicGameRuntime } from "../public-rc1/artifacts.js";
import type { TestnetFundingStage } from "../core/settings.js";

type MonitorBridgeRequest = {
  type: "bridge-request";
  id: string;
  method: string;
  payload?: unknown;
};

let monitorBridgeClient: ColliderClient | null = null;
let monitorBridgeWasm: WasmVizRuntime | null = null;
let managerPreviewBusy = false;
let monitorBridgeName:DisplayNameService|null=null;
let monitorBridgeBank: BankWalletService | null = null;
let monitorBridgePointsService: PointsConversionService | null = null;
let monitorBridgeConfirmations: BondedConfirmationService | null = null;
let monitorOnlyRuntime = false;
let acceleratedRuntimeInfo:unknown=null;
let releasePublicSignerLease:(()=>Promise<void>)|null=null;
let stopForecastPublication:(()=>Promise<void>)|null=null;

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function handleMonitorBridgeRequest(message: MonitorBridgeRequest): Promise<unknown> {
  switch (message.method) {
    case "getManagerPreview": {
      if (managerPreviewBusy) throw Error("A manager preview is already running");
      const current = getRuntimeSettings(); assertPublicSettings(current); if (!current.publicRc1) throw Error("Public RC1 preview required");
      const settings = publicPlanningSettings(current);
      managerPreviewBusy = true;
      try { return await new Promise((resolve,reject) => {
        const worker = new Worker(new URL('../agent/planning-preview-worker.js', import.meta.url), {workerData:{settings,dataDir:String(arg('--data-dir',process.env.COLLIDER_DATA_DIR ?? PUBLIC_RC1.dataDir))},env:keylessPreviewEnvironment(),stdout:true,stderr:true});
        worker.stdout?.resume(); worker.stderr?.resume();
        const timer = setTimeout(() => {void worker.terminate();reject(Error('Fresh planning preview timed out'));},60000);
        worker.once('message',(result:any)=>{clearTimeout(timer);void worker.terminate();if(result.ok)resolve(result.context);else reject(Error(result.error));});
        worker.once('error',()=>{clearTimeout(timer);reject(Error('Fresh planning worker unavailable'));});
        worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('Fresh planning worker stopped'));});
      }); } finally {managerPreviewBusy=false;}
    }
    case "getAgentName": if(!monitorBridgeName)throw Error("Name service unavailable");return monitorBridgeName.status();
    case "setAgentName": if(!monitorBridgeName)throw Error("Name service unavailable");return monitorBridgeName.set((message.payload??{}) as Record<string,unknown>);
    case "getBankWallet":
      if (!monitorBridgeBank) throw Error("Wallet banking requires a loaded public-RC1 wallet");
      return await monitorBridgeBank.snapshot();
    case "saveBankPolicy":
      if (!monitorBridgeBank) throw Error("Wallet banking is unavailable");
      return await monitorBridgeBank.savePolicy((message.payload ?? {}) as Record<string, unknown>);
    case "depositBankWallet":
      if (!monitorBridgeBank) throw Error("Wallet banking is unavailable");
      return await monitorBridgeBank.deposit((message.payload ?? {}) as Record<string, unknown>);
    case "unlockBankWallet":
      if (!monitorBridgeBank) throw Error("Wallet banking is unavailable");
      return await monitorBridgeBank.unlock((message.payload ?? {}) as Record<string, unknown>);
    case "encryptBankWallet":
      if (!monitorBridgeBank) throw Error("Wallet banking is unavailable");
      return await monitorBridgeBank.encrypt((message.payload ?? {}) as Record<string, unknown>);
    case "requestBankWithdrawal":
      if (!monitorBridgeBank) throw Error("Wallet banking is unavailable");
      return await monitorBridgeBank.request((message.payload ?? {}) as Record<string, unknown>);
    case "getRuntimeSettings":
      return getRuntimeSettings();
    case "updateRuntimeSettings":
      return updateRuntimeSettings((message.payload ?? {}) as Record<string, unknown>);
    case "getControlState":
      return {...getControlState(),acceleratedTest:acceleratedRuntimeInfo};
    case "applyControlAction": {
      const request = (message.payload ?? {}) as { action?: string; payload?: Record<string, unknown> };
      if (monitorBridgeBank?.isLocked() && request.action !== "stop") throw Error("Unlock the wallet in Bank before starting play");
      if (monitorOnlyRuntime && request.action !== "stop") {
        throw new Error("monitor-only mode cannot start an automatic throw session");
      }
      return applyControlAction(String(request.action || ""), request.payload ?? {});
    }
    case "getLatestEligibilitySnapshot":
      return getLatestEligibilitySnapshot();
    case "getLatestCandidateContext":
      return getLatestCandidateContext();
    case "getManagerOverlay":
      return getManagerOverlay();
    case "saveManagerOverlay":
      return await saveManagerOverlay((message.payload ?? null) as any);
    case "getManagerCandidateSet":
      return getManagerCandidateSet();
    case "saveManagerCandidateSet":
      return await saveManagerCandidateSet((message.payload ?? null) as any);
    case "buildReplaySvgExport":
      if (!monitorBridgeClient || !monitorBridgeWasm) {
        throw new Error("replay svg export unavailable before runtime initialization");
      }
      return await buildReplaySvgExportWithRuntime({
        client: monitorBridgeClient,
        wasm: monitorBridgeWasm,
        request: (message.payload ?? {}) as any,
      });
    case "getPointsConversionStatus":
      if (!monitorBridgePointsService) throw new Error("points conversion runtime not initialized");
      return { ...await monitorBridgePointsService.status(), runtimeMode: monitorOnlyRuntime ? "monitor-only" : "live-session" };
    case "getConfirmationStatus":
      if (!monitorBridgeConfirmations) return { available: false, enabled: false, reason: "reviewed_profile_required" };
      return { ...await monitorBridgeConfirmations.status(), control: getControlState().state };
    case "saveConfirmationConfig": {
      if (!monitorBridgeConfirmations || monitorOnlyRuntime) throw new Error("reviewed persistent confirmation runtime unavailable");
      const request = (message.payload ?? {}) as Record<string, unknown>;
      if (Object.keys(request).join() !== "enabled") throw new Error("only confirmation enabled may be changed");
      return await monitorBridgeConfirmations.saveEnabled(request.enabled);
    }
    case "savePointsConversionConfig":
      if (!monitorBridgePointsService) throw new Error("points conversion runtime not initialized");
      return await monitorBridgePointsService.saveConfig((message.payload ?? {}) as Partial<PointsConversionConfig>);
    case "redeemPointsForClc": {
      if (!monitorBridgePointsService) throw new Error("points conversion runtime not initialized");
      const request = (message.payload ?? {}) as Record<string, unknown>;
      return await monitorBridgePointsService.redeem({
        pointsIn: String(request.pointsIn ?? ""),
        expectedPointsPerClc: String(request.expectedPointsPerClc ?? ""),
        requestId: String(request.requestId ?? ""),
        source: "manual",
      });
    }
    default:
      throw new Error(`unknown monitor bridge method: ${message.method}`);
  }
}

async function startMonitorWorker(cfg: { port: number; dataDir: string; staticDir: string }): Promise<Worker> {
  const workerExt = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`../monitor/worker.${workerExt}`, import.meta.url), {
    workerData: cfg,
  });

  return await new Promise<Worker>((resolve, reject) => {
    let settled = false;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve(worker);
    };

    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    worker.on("message", async (message: any) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "bridge-request") {
        try {
          const result = await handleMonitorBridgeRequest(message as MonitorBridgeRequest);
          worker.postMessage({ type: "bridge-response", id: message.id, ok: true, result });
        } catch (err) {
          worker.postMessage({ type: "bridge-response", id: message.id, ok: false, error: String(err) });
        }
        return;
      }

      if (message.type === "listening") {
        finishResolve();
        return;
      }

      if (message.type === "startup_error") {
        finishReject(message.error || "monitor worker failed during startup");
      }
    });

    worker.once("error", (err) => {
      if (settled) {
        console.error("[monitor-worker]", err);
        updateControlState({ state: "paused", mode: "monitor-fault",
          lastMessage: "Monitor worker failed; automatic throws paused." });
        return;
      }
      finishReject(err);
    });

    worker.once("exit", (code) => {
      if (code === 0) return;
      const error = new Error(`[monitor-worker] exited with code ${code}`);
      if (settled) {
        console.error(error.message);
        updateControlState({ state: "paused", mode: "monitor-fault",
          lastMessage: "Monitor worker exited; automatic throws paused." });
        return;
      }
      finishReject(error);
    });
  });
}

async function stopMonitorWorker(worker: Worker | null): Promise<void> {
  if (!worker) return;
  worker.removeAllListeners("exit");
  await worker.terminate();
}

async function main(): Promise<void> {
  const stopAtArg=arg("--stop-at","");
  const stopAtMs=stopAtArg?Date.parse(stopAtArg):undefined;
  if(stopAtMs!==undefined&&(!Number.isFinite(stopAtMs)||stopAtMs<=Date.now()))throw Error("--stop-at must be a future absolute timestamp");
  const monitorOnly = hasFlag("--wallet-monitor-only");
  monitorOnlyRuntime = monitorOnly;
  const easyFujiRequested = hasFlag("--fuji-easy-start");
  const gapFujiRequested = hasFlag("--fuji-gap-easy-start");
  const nativeV2Requested = hasFlag("--fuji-native-v2");
  const bondedFujiRequested = hasFlag("--fuji-bonded");
  const publicFujiRequested=hasFlag("--fuji-public-rc1");
  if ([easyFujiRequested, gapFujiRequested, nativeV2Requested, bondedFujiRequested,publicFujiRequested].filter(Boolean).length > 1) throw new Error("choose exactly one Fuji profile");
  const dataDir = arg(
    "--data-dir",
    process.env.COLLIDER_DATA_DIR ?? (publicFujiRequested?PUBLIC_RC1.dataDir:bondedFujiRequested ? FUJI_BONDED_DATA_DIR : nativeV2Requested ? FUJI_NATIVE_V2_DATA_DIR : gapFujiRequested ? FUJI_GAP_DATA_DIR : easyFujiRequested ? FUJI_EASY_START_DATA_DIR : "./data"),
  )!;
  const staticDir = arg("--static-dir", process.env.COLLIDER_STATIC_DIR ?? process.cwd())!;
  if (easyFujiRequested) {
    const firstRun = await ensureFujiEasyStart(dataDir, {
      workspaceDir: process.cwd(),
      signingKeyFile: arg("--signing-key-file", process.env.COLLIDER_AGENT_SIGNING_KEY_FILE),
      allowDisposableTestWallet: hasFlag("--create-disposable-test-wallet"),
    });
    console.log(`[fuji-easy-start] profile=${firstRun.created ? "created" : "existing"} dataDir=${dataDir}`);
    if (firstRun.wallet) {
      console.log(`[fuji-easy-start] wallet=${firstRun.wallet.address} key=${firstRun.wallet.signingKeyFile}`);
    }
  }
  if (gapFujiRequested) {
    const firstRun = await ensureFujiGapEasyStart(dataDir, {
      workspaceDir: process.cwd(),
      signingKeyFile: arg("--signing-key-file", process.env.COLLIDER_AGENT_SIGNING_KEY_FILE),
      allowDisposableTestWallet: hasFlag("--create-disposable-test-wallet"),
    });
    console.log(`[fuji-gap-easy-start] profile=${firstRun.created ? "created" : "existing"} dataDir=${dataDir}`);
    if (firstRun.wallet) console.log(`[fuji-gap-easy-start] wallet=${firstRun.wallet.address} key=${firstRun.wallet.signingKeyFile}`);
  }
  let fileSettings = await loadSettings(dataDir);
  let newPublicWallet = false;
  if (publicFujiRequested && !fileSettings.publicRc1) {if(hasFlag("--public-preflight"))throw Error("Initialize a new profile before read-only public preflight");fileSettings=await initializeNewPublicWallet(dataDir,{password:process.env.COLLIDER_AGENT_KEY_PASSWORD});newPublicWallet=true;}
  if(publicFujiRequested){
    assertPublicSettings(fileSettings);
    const cancellation=await readFile(path.join(dataDir,"public-cancellation-state.json"),"utf8").then(text=>JSON.parse(text)).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
    if(cancellation?.pending)throw Error("public cancellation requires original journal reconciliation before gameplay");
    await inspectOwnerJournals(fileSettings.publicRc1!.ownerSourceDir,fileSettings.expectedEvmAddress!,dataDir);
    if(hasFlag("--create-disposable-test-wallet")||hasFlag("--bonded-confirmations-config")||hasFlag("--fuji-auto-fund"))throw Error("public profile requires explicit prepared instance wallet and --public-auto-fund, not historical Fuji options");
    if(hasFlag("--public-preflight")){console.log(JSON.stringify(await publicPreflight(fileSettings,dataDir),null,2));return;}
    releasePublicSignerLease=await acquirePublicSignerLease(fileSettings,dataDir);
  }else if(fileSettings.publicRc1)throw Error("public RC1 settings require --fuji-public-rc1; no implicit route selection");
  if (bondedFujiRequested) await ensureFujiBondedProfile(dataDir);
  const confirmationConfigFile = arg("--bonded-confirmations-config", bondedFujiRequested ? path.join(dataDir, "bonded-confirmations.json") : undefined);
  if (nativeV2Requested) await ensureFujiNativeV2Profile(dataDir);
  const dryRunRequested = hasFlag("--dry-run");
  const autoFundRequested = !hasFlag("--skip-auto-fund") && (publicFujiRequested?(hasFlag("--public-auto-fund")||!!fileSettings.testnetAutoFunding?.enabled):(
    hasFlag("--fuji-auto-fund")
    || easyFujiRequested
    || gapFujiRequested
    || nativeV2Requested
    || process.env.COLLIDER_FUJI_AUTO_FUND === "1"
    || !!fileSettings.testnetAutoFunding?.enabled
  ));
  const testnetAutoFunding = {
    ...fileSettings.testnetAutoFunding!,
    enabled: autoFundRequested,
    faucetUrl: arg(
      "--fuji-faucet-url",
      process.env.COLLIDER_FUJI_FAUCET_URL ?? fileSettings.testnetAutoFunding?.faucetUrl,
    )!,
  };
  const requestedAsset = arg("--asset", process.env.COLLIDER_DEFAULT_ASSET ?? fileSettings.asset)!;
  const requestedAmount = arg("--amount", process.env.COLLIDER_DEFAULT_AMOUNT ?? fileSettings.amount)!;
  const bootstrapSeedSettings = normalizeSettings({
    ...fileSettings,
    rpc: arg("--rpc", process.env.COLLIDER_RPC_URL ?? fileSettings.rpc)!,
    wasm: arg("--wasm", process.env.COLLIDER_SIM_WASM ?? fileSettings.wasm)!,
    asset: autoFundRequested && !requestedAsset ? FUJI_DIEM_ASSET : requestedAsset,
    amount: autoFundRequested && (!/^\d+$/.test(requestedAmount) || BigInt(requestedAmount) <= 0n)
      ? testnetAutoFunding.defaultThrowAmount
      : requestedAmount,
    testnetAutoFunding,
  });
  if(publicFujiRequested){
    bootstrapSeedSettings.publicRc1={...bootstrapSeedSettings.publicRc1!,faucetOperatorProofFile:arg("--faucet-proof",bootstrapSeedSettings.publicRc1?.faucetOperatorProofFile??undefined)??null};
    assertPublicSettings(bootstrapSeedSettings);
    const auth=await new ColliderClient(PUBLIC_RC1.rpc).getAuthContext("0x"+bootstrapSeedSettings.user.replace(/^0x/,""));
    bootstrapSeedSettings.expectedSigningChainId=assertPublicAuth(auth,"0x"+bootstrapSeedSettings.user.replace(/^0x/,""));
  }
  if (!bootstrapSeedSettings.signingKeyFile && !process.env[bootstrapSeedSettings.signingKeyEnv || 'COLLIDER_AGENT_PRIVATE_KEY'] && !bootstrapSeedSettings.expectedEvmAddress) {
    const file = vaultFile(dataDir);
    const address = await createInstanceWallet(file, process.env.COLLIDER_AGENT_KEY_PASSWORD);
    bootstrapSeedSettings.signingKeyFile = file; bootstrapSeedSettings.expectedEvmAddress = address;
    bootstrapSeedSettings.user = '00'.repeat(12) + address.slice(2).toLowerCase();
    await saveSettings(bootstrapSeedSettings, dataDir);
    await writeFile(path.join(dataDir,"bank-policy.json"),JSON.stringify({autoDepositReceived:true}),{flag:"wx",mode:0o600});
  }
  const wallet = await AgentWallet.load(bootstrapSeedSettings);
  let bootstrappedSettings = await ensureRc1Bootstrap(bootstrapSeedSettings, dataDir, wallet);
  if (autoFundRequested && !dryRunRequested && !monitorOnly) {
    if (!wallet) throw new Error("Fuji testnet auto-funding requires the configured signing wallet");
    if (bootstrappedSettings.onboarding?.fundingStatus === "rpc_incompatible") {
      throw new Error("Fuji testnet auto-funding requires a compatible pinned RC1 RPC");
    }
    if (bootstrappedSettings.onboarding?.fundingStatus !== "funded") {
      let progressSettings = bootstrappedSettings;
      const recordProgress = async (progress: FujiTestnetFundingProgress): Promise<void> => {
        progressSettings = normalizeSettings({
          ...progressSettings,
          onboarding: {
            ...progressSettings.onboarding!,
            testnetFundingStage: progress.stage,
            testnetFundingDetail: progress.detail,
            testnetFundingUpdatedAt: progress.updatedAt,
            testnetFundingError: progress.error,
            testnetFundingDepositTx: progress.depositTx,
          },
        });
        await saveSettings(progressSettings, dataDir);
        console.log("[fuji-auto-fund] stage=" + progress.stage);
      };
      const fundingParameters={
        settings: bootstrappedSettings,
        dataDir,
        wallet,
        onProgress: recordProgress,
      };
      if(publicFujiRequested)await ensurePublicFunding({...fundingParameters,acceptScopedFaucet:hasFlag("--accept-public-testnet-faucet"),onProgress:async progress=>{
        const raw=progress.stage;
        const stage:TestnetFundingStage=raw==="COMPLETE"?"COMPLETE":raw==="AWAITING_FAUCET_SETUP"?"AWAITING_FAUCET_SETUP":raw==="HOLD"?"AMBIGUOUS"
          :raw.startsWith("APPROVAL")?"APPROVAL_PENDING":raw.startsWith("DEPOSIT")?"DEPOSIT_PENDING":raw==="COLLIDER_CREDIT_PENDING"?"COLLIDER_CREDIT_PENDING":"CLAIM_PENDING";
        await recordProgress({...progress,stage});}});
      else await ensureFujiTestnetFunding(fundingParameters);
      bootstrappedSettings = await ensureRc1Bootstrap(progressSettings, dataDir, wallet);
    }
  }

  const effectiveSettings = {
    ...bootstrappedSettings,
    maxCandidates: Number(arg("--max-candidates", String(bootstrappedSettings.maxCandidates))),
    maxMs: Number(arg("--max-ms", String(bootstrappedSettings.maxMs))),
    pollMs: Number(arg("--poll-ms", String(bootstrappedSettings.pollMs))),
    maxThrowsPerGame: Number(arg("--max-throws-per-game", String(bootstrappedSettings.maxThrowsPerGame))),
    maxThrowsPerSession: Number(arg("--max-throws-per-session", String(bootstrappedSettings.maxThrowsPerSession))),
    minMillisBetweenLiveThrows: Number(
      arg("--min-ms-between-live-throws", String(bootstrappedSettings.minMillisBetweenLiveThrows)),
    ),
    monitorPort: Number(arg("--monitor-port", String(bootstrappedSettings.monitorPort))),
  };
  if(publicFujiRequested){assertPublicSettings(effectiveSettings);
    if(effectiveSettings.maxThrowsPerSession>fileSettings.maxThrowsPerSession||effectiveSettings.maxThrowsPerGame>fileSettings.maxThrowsPerGame
      ||effectiveSettings.minMillisBetweenLiveThrows<fileSettings.minMillisBetweenLiveThrows)throw Error("public migration cannot increase owner play limits");}

  initRuntimeSettings(effectiveSettings);
  if (newPublicWallet) updateControlState({state:"paused",lastMessage:"New independent wallet ready to receive funds. Choose your settings and start play when ready."});
  if(stopAtMs!==undefined){const timer=setTimeout(()=>updateControlState({state:"paused",lastMessage:"Timed play window complete; no new signed throws authorized.",lastAction:{action:"auto_pause_time_limit",ts:new Date().toISOString()}}),Math.max(0,stopAtMs-Date.now()));timer.unref();}
  if (hasFlag("--start-paused")) updateControlState({ state: "paused", mode: "operator-pause",
    lastMessage: "Started paused: no automatic throws or new commitments; existing accepted bonds still recover." });
  if (monitorOnly) updateControlState({ state: "paused", mode: "monitor-only",
    lastMessage: "Monitor-only: automatic throws disabled at the authorized session cap." });
  await initManagerState(dataDir);
  if (easyFujiRequested || gapFujiRequested) {
    const managerSetup = await prepareFujiEasyStartManager(dataDir);
    console.log(`[fuji-easy-start] manager=${managerSetup} autoApply=false monitor=http://localhost:${effectiveSettings.monitorPort}/`);
  }

  const rpcUrl = effectiveSettings.rpc;
  const wasmPath = effectiveSettings.wasm;
  const botUser = effectiveSettings.user;
  const asset = effectiveSettings.asset;
  const amount = effectiveSettings.amount;
  const maxCandidates = effectiveSettings.maxCandidates;
  const maxMillis = effectiveSettings.maxMs;
  const pollMs = effectiveSettings.pollMs;
  const monitorPort = effectiveSettings.monitorPort;
  const dryRun = dryRunRequested;
  const stopOnWinner = hasFlag("--stop-on-winner");
  const runOnceOnly = hasFlag("--once") || hasFlag("--single-run");
  const loop = hasFlag("--loop") || !runOnceOnly;
  const serveMonitor = !hasFlag("--no-monitor");
  if (monitorOnly && !serveMonitor) throw new Error("wallet monitor-only mode requires the monitor");
  const maxCycles = Number(arg("--max-cycles", "999999"));
  const stopWhenSessionCapReached = hasFlag("--exit-on-session-cap");
  if (confirmationConfigFile && (!loop || monitorOnly || dryRun || stopWhenSessionCapReached || hasFlag("--max-cycles"))) {
    throw new Error("bonded confirmations require the persistent live session loop for reveal recovery");
  }
  const preferredGameId = arg("--game-id", "")?.trim() || undefined;

  if (!rpcUrl) throw new Error("missing RC1 rpc; set settings.rpc, COLLIDER_RPC_URL, or --rpc");
  if (!wasmPath) throw new Error("missing wasm");
  if (!botUser) throw new Error("missing wallet identity; configure expectedEvmAddress and a signing key source");
  if (!dryRun && !wallet) throw new Error("live RC1 mode requires COLLIDER_AGENT_PRIVATE_KEY or signingKeyFile");
  if (!dryRun && !effectiveSettings.expectedNetworkDomain) throw new Error("live RC1 mode requires expectedNetworkDomain pinning");
  if (effectiveSettings.onboarding?.fundingStatus === "rpc_incompatible") {
    throw new Error(`configured RPC is not RC1-compatible: ${effectiveSettings.onboarding.fundingError ?? "auth probe failed"}`);
  }
  if (!asset) throw new Error("missing RC1 asset; configure a canonical fresh-genesis asset id");
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("amount must be a positive exact base-unit decimal string");

  const sessionId = makeSessionId();
  const storage = await initStorage(dataDir, { maxActiveLogBytes: effectiveSettings.maxActiveLogBytes });
  if (publicFujiRequested) stopForecastPublication=startForecastPublisher(dataDir);

  const pendingWithdrawal = await new Rc1WithdrawalStore(path.join(dataDir, "rc1-withdrawal-state.json")).loadPending();
  if (pendingWithdrawal) {
    throw new Error(`unresolved signed withdrawal nonce ${pendingWithdrawal.prepared.nonce}; run npm run withdraw -- --data-dir ${dataDir} --resume before live play`);
  }

  console.log(
    `session=${sessionId} dataDir=${storage.rootDir} mode=${dryRun ? "dry-run" : "live"} loop=${loop ? "yes" : "no"} monitor=${serveMonitor ? "yes" : "no"}`,
  );

  let monitorWorker: Worker | null = null;
  if (serveMonitor) {
    monitorWorker = await startMonitorWorker({
      port: monitorPort,
      dataDir,
      staticDir,
    });
  }

  const client = new ColliderClient(rpcUrl, wallet, {
    expectedSigningChainId: effectiveSettings.expectedSigningChainId,
    expectedNetworkDomain: effectiveSettings.expectedNetworkDomain,
    expectedNetworkId: effectiveSettings.expectedNetworkId,
    expectedL1Id: effectiveSettings.expectedL1Id,
    expectedChainId: effectiveSettings.expectedChainId,
    intentTtlBlocks: effectiveSettings.intentTtlBlocks,
    reconcilePollMs: effectiveSettings.intentReconcilePollMs,
    reconcileTimeoutMs: effectiveSettings.intentReconcileTimeoutMs,
    intentStateFile: path.join(dataDir, "rc1-intent-state.json"),
  });
  if (wallet?.isLocked) applyControlAction("stop");
  const recoveredIntent = await client.reconcilePendingSignedIntent(Math.min(30_000, effectiveSettings.intentReconcileTimeoutMs ?? 90_000));
  if (recoveredIntent?.result.status === "pending") {
    throw new Error(`unresolved signed intent nonce ${recoveredIntent.result.nonce}; refusing to risk a duplicate throw`);
  }
  if (recoveredIntent) {
    await recordReconciledAcceptedThrow(storage, recoveredIntent, sessionId);
    console.log(`[rc1] reconciled prior signed intent nonce=${recoveredIntent.result.nonce} status=${recoveredIntent.result.status}`);
  }
  const pointsService = wallet && !dryRun ? new PointsConversionService(client, wallet, {
    expectedSigningChainId: effectiveSettings.expectedSigningChainId,
    expectedNetworkDomain: effectiveSettings.expectedNetworkDomain,
    expectedNetworkId: effectiveSettings.expectedNetworkId,
    expectedL1Id: effectiveSettings.expectedL1Id,
    expectedChainId: effectiveSettings.expectedChainId,
  }, dataDir) : null;
  if (pointsService) await pointsService.init();
  if (wallet && effectiveSettings.publicRc1 && !dryRun) {
    monitorBridgeBank = new BankWalletService(client, wallet, effectiveSettings, dataDir);
    await monitorBridgeBank.init();
    monitorBridgeName=new DisplayNameService(client,wallet,dataDir);await monitorBridgeName.init();
  }
  const confirmations = await loadBondedConfirmations(confirmationConfigFile, effectiveSettings, dataDir, client, wallet);
  monitorBridgeConfirmations = confirmations;
  monitorBridgePointsService = pointsService;
  console.log(`[rc1] wallet=${wallet?.address ?? effectiveSettings.expectedEvmAddress} user=${botUser} domain=${effectiveSettings.expectedNetworkDomain}`);
  const wasm = publicFujiRequested ? await loadPublicGameRuntime(client,wasmPath) : await loadVizWasm(wasmPath);
  monitorBridgeClient = client;
  monitorBridgeWasm = wasm;

  if (monitorOnly) {
    console.log(`[monitor-only] wallet-linked monitor ready on port ${monitorPort}; throw loop disabled`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await stopMonitorWorker(monitorWorker);
    return;
  }

  const policy = {
    ...DEFAULT_POLICY,
    minGameStakeUsd: effectiveSettings.minGameStakeUsd ?? undefined,
    maxSingleThrowUsd: effectiveSettings.maxSingleThrowUsd ?? undefined,
    maxGameExposureUsd: effectiveSettings.maxGameExposureUsd ?? undefined,
    minThrowUsd: effectiveSettings.minThrowUsd ?? undefined,
    maxThrowUsd: effectiveSettings.maxThrowUsd ?? undefined,
    riskMode: effectiveSettings.riskMode,
    customStrategy: effectiveSettings.customStrategy ?? undefined,
    copySlammerWhenSameHoleType: effectiveSettings.copySlammerWhenSameHoleType,
    allowedAssets: effectiveSettings.allowedAssets,
    mapPriorities: effectiveSettings.mapPriorities,
    blockedAssets: effectiveSettings.blockedAssets,
    keepAssets: effectiveSettings.keepAssets,
    disposeAssets: effectiveSettings.disposeAssets,
    reserveBalanceBase: effectiveSettings.reserveBalanceBase,
    maxSingleThrowBase: effectiveSettings.maxSingleThrowBase,
    targetBalanceUsd: effectiveSettings.targetBalanceUsd ?? undefined,
    targetProfitUsd: effectiveSettings.targetProfitUsd ?? undefined,
    learnFromManualThrows: effectiveSettings.humanLearning?.enabled,
    learnOwnManualThrows: effectiveSettings.humanLearning?.learnOwnManualThrows,
    humanLearningAddresses: effectiveSettings.humanLearning?.addresses,
    humanLearningMaxSeeds: effectiveSettings.humanLearning?.maxSeedsPerCycle ?? undefined,
    maxThrowsPerGame: effectiveSettings.maxThrowsPerGame,
    maxThrowsPerSession: effectiveSettings.maxThrowsPerSession,
    minMillisBetweenLiveThrows: effectiveSettings.minMillisBetweenLiveThrows,
  };

  const fixedThrowBase=arg("--fixed-throw-base");
  if(fixedThrowBase&&!/^[1-9][0-9]*$/.test(fixedThrowBase))throw Error("Invalid fixed experiment stake");
  const loopCfg = {
    fixedStake:fixedThrowBase?{asset,amount:fixedThrowBase}:undefined,
    gameStatusMask: MASK_LIVE,
    botUser,
    defaultAsset: asset,
    defaultAmount: amount!,
    dryRun,
    includeSlip1: true,
    sessionId,
    storage,
    preferredGameId,
    liveUntilMs:stopAtMs,
    allowedGameIds: effectiveSettings.allowedGameIds,
    candidateBudget: {
      maxCandidates,
      maxMillis,
      stopOnWinner,
      winnerScoreThreshold: 20000,
    },
    candidateGen: {
      xSteps: 3,
      ySteps: 2,
      angleDegs: [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75],
      speedPcts: [35, 50, 65, 80, 95],
      spinPcts: [-50, -25, 0, 25, 50],
    },
    scoreConfig: {
      robustnessWeight: 1.0,
      fragilityWeight: 0.25,
    },
  };

  const accelerated=acceleratedOverride(effectiveSettings,stopAtMs,hasFlag("--accelerated-test"),Date.now(),hasFlag("--accelerated-four-hour"),hasFlag("--research-two-hour"),Number(arg("--research-used-throws","0")));
  if(accelerated){acceleratedRuntimeInfo=accelerated;console.log(`[accelerated-test] ${accelerated.maxThrows} new throws maximum, 15s start-to-start target, independent deadline; normal saved cadence unchanged`);let metricsBuffer="",flushing=false;const metricsFile=path.join(dataDir,"rpc-performance-"+process.pid+".jsonl");setRpcObserver(sample=>{if(metricsBuffer.length<1024*1024)metricsBuffer+=JSON.stringify({...sample,ts:Date.now()})+"\n";});const timer=setInterval(()=>{if(flushing||!metricsBuffer)return;flushing=true;const text=metricsBuffer;metricsBuffer="";void appendFile(metricsFile,text).catch(()=>{}).finally(()=>{flushing=false;});},1000);timer.unref();}
  if (loop) {
    // Short canonical commitment windows need a wakeup independent of the 30-second throw cadence.
    // This is the SAME service/client/wallet, not another signer or process.
    let confirmationWork: Promise<unknown> | null = null;
    const confirmationTimer = confirmations ? setInterval(() => {
      if (confirmationWork) return;
      confirmationWork = confirmations.tick(getControlState().state === "live")
        .catch(error => {
          const safeCode = error instanceof Error && error.message === "accepted chain clock changed during confirmation read" ? "clock_changed"
            : error instanceof Error && error.message === "noninteger confirmation JSON number" ? "noninteger_json"
            : error instanceof Error && error.name === "TimeoutError" ? "read_timeout" : "read_or_reconcile_failed";
          console.error("[bonded-confirmations]", safeCode);
          updateControlState({ state: "paused", lastMessage: "Bonded confirmation requires canonical reconciliation." });
        })
        .finally(() => { confirmationWork = null; });
    }, 1000) : null;
    try { await runAgentSession(
      client,
      wasm,
      policy,
      loopCfg,
      {
        pollMs,
        maxCycles,
        cooldownMsPerGame: accelerated?0:20000,
        accelerated,
        stopWhenSessionCapReached,
        stopAtMs,
        maybeAutoConvert: pointsService ? () => pointsService.maybeAutoConvert() : undefined,
        serviceBondedConfirmations: confirmations ? () => confirmations.tick(getControlState().state === "live") : undefined,
      },
    ); } finally {
      if (confirmationTimer) clearInterval(confirmationTimer);
      if (confirmationWork) await confirmationWork;
      await confirmations?.close();
    }
    await stopMonitorWorker(monitorWorker);
    console.log("[monitor] stopped after finite agent session");
    return;
  }

  const result = await runAgentOnce(
    client,
    wasm,
    policy,
    loopCfg,
  );

  // Public one-shot output must not dump prediction commitment salts or private recovery fields.
  console.log(JSON.stringify(publicFujiRequested ? {
    decisionId: result.decisionId, gameId: result.gameId, winnerSubmitted: result.winnerSubmitted,
    signedSubmission: result.signedSubmission, eligibilityCode: result.eligibilityCode, stoppedBy: result.stoppedBy,
  } : result, null, 2));
  await stopMonitorWorker(monitorWorker);
}

main().finally(async()=>{await monitorBridgeBank?.close();await stopForecastPublication?.();await releasePublicSignerLease?.();}).catch((err) => {
  console.error(err);
  process.exit(1);
});
