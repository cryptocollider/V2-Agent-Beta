import { mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { unlinkSync } from "node:fs";
import { colliderUserIdFromEvmAddress, normalizeEvmAddress } from "../collider/wallet.js";
import { normalizeSettings, saveSettings, type AgentSettings } from "../core/settings.js";
import { PUBLIC_ASSETS, PUBLIC_RC1, requirePublic } from "./contract.js";

async function optionalJson(file:string):Promise<any|null>{try{return JSON.parse(await readFile(file,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw Error("public_rc1_hold: unreadable journal/config "+path.basename(file));}}
export async function inspectOwnerJournals(sourceDir:string,address:string,excludeDir?:string):Promise<Array<{directory:string;pending:false}>> {
  const root=path.dirname(path.resolve(sourceDir)),dirs=(await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name.startsWith("data"));
  const results:Array<{directory:string;pending:false}>=[];
  let foundSource=false;
  for(const dir of dirs){const full=path.join(root,dir.name),settings=await optionalJson(path.join(full,"settings.json"));
    if(path.resolve(full)===path.resolve(sourceDir)&&settings?.expectedEvmAddress?.toLowerCase()===address.toLowerCase())foundSource=true;
    if(excludeDir&&path.resolve(full)===path.resolve(excludeDir))continue;
    if(settings?.expectedEvmAddress?.toLowerCase()!==address.toLowerCase())continue;
    for(const entry of await readdir(full)){if(!entry.endsWith("-state.json"))continue;const state=await optionalJson(path.join(full,entry));
      requirePublic(state&&!state.pending,"uncertain old signed work in "+dir.name+"/"+entry);
      if(entry.includes("funding"))requirePublic(state.stage==="COMPLETE"||(!state.approval&&!state.deposit),"old source funding requires reconciliation");
    }
    const receipts=await optionalJson(path.join(full,"confirmation-receipts.json"));
    requirePublic(!receipts?.jobs?.some((job:any)=>job.pendingNonce!=null||job.auditComplete!==true
      ||!["refunded","forfeited","expired","rejected","cancelled"].includes(job.state)),"old bonded obligations require reconciliation");
    results.push({directory:dir.name,pending:false});
  }
  requirePublic(foundSource,"owner source settings/address not reconciled");return results;
}
export function buildPublicSettings(owner:AgentSettings,sourceDir:string,approvedAddress:string):AgentSettings {
  const address=normalizeEvmAddress(approvedAddress);
  requirePublic(address&&owner.expectedEvmAddress?.toLowerCase()===address,"explicit owner wallet approval/address pin required");
  requirePublic(owner.signingKeyFile||owner.signingKeyEnv,"owner-supplied or explicitly generated wallet required");
  requirePublic(owner.minMillisBetweenLiveThrows>=30000&&owner.maxThrowsPerSession>0&&owner.maxThrowsPerGame>0,"invalid owner risk/cadence bounds");
  return normalizeSettings({...owner,rpc:PUBLIC_RC1.rpc,wasm:PUBLIC_RC1.wasmPath,user:colliderUserIdFromEvmAddress(address).slice(2),
    expectedEvmAddress:address,expectedNetworkId:5,expectedL1Id:PUBLIC_RC1.l1,expectedChainId:PUBLIC_RC1.chainHex,
    expectedNetworkDomain:PUBLIC_RC1.domain,expectedSigningChainId:null,
    bridgeWithdrawal:{cRpc:PUBLIC_RC1.evmRpc,expectedEvmChainId:43113,custodyContract:PUBLIC_RC1.custody,routeId:PUBLIC_RC1.route,
      expectedAttestor:PUBLIC_RC1.attestor,assets:Object.fromEntries(PUBLIC_ASSETS.map(a=>[a.asset,{tokenAddress:a.token,policyHash:a.policy,minWithdrawalAmount:a.minimum}]))},
    asset:PUBLIC_RC1.clc.slice(2),allowedAssets:[PUBLIC_RC1.clc.slice(2)],keepAssets:[PUBLIC_RC1.clc.slice(2)],disposeAssets:[],blockedAssets:[],
    amount:"4000000000000000000",reserveBalanceBase:"400000000000000000000",maxSingleThrowBase:"400000000000000000000",
    allowedGameIds:[],mapPriorities:{},testnetAutoFunding:{...owner.testnetAutoFunding!,enabled:false,profile:PUBLIC_RC1.profile,
      faucetUrl:PUBLIC_RC1.faucet,readinessUrl:PUBLIC_RC1.readiness,claimPollMs:5000,claimTimeoutMs:900000,creditPollMs:5000,creditTimeoutMs:600000,
      evmConfirmations:4,defaultThrowAmount:"4000000000000000000"},
    publicRc1:{profile:PUBLIC_RC1.profile,ownerWallet:address,ownerSourceDir:path.resolve(sourceDir),faucetOperatorProofFile:null,
      artifactSha256:PUBLIC_RC1.wasmSha256,depositAmountBase:PUBLIC_RC1.grant,gasReserveWei:PUBLIC_RC1.exitGasReserve},
    onboarding:{...owner.onboarding!,fundingStatus:"awaiting_funding",fundingCheckedAt:null,fundingError:null,testnetFundingStage:"DISABLED",
      testnetFundingDetail:"awaiting_faucet_setup",testnetFundingUpdatedAt:null,testnetFundingError:null,testnetFundingDepositTx:null},
  });
}
export function assertPublicSettings(settings:AgentSettings):void {
  const p=settings.publicRc1;
  requirePublic(p?.profile===PUBLIC_RC1.profile&&p.ownerWallet===settings.expectedEvmAddress?.toLowerCase()
    &&settings.user.toLowerCase().replace(/^0x/,"")===colliderUserIdFromEvmAddress(p.ownerWallet).slice(2),"public owner/profile pin mismatch");
  requirePublic(settings.rpc===PUBLIC_RC1.rpc&&settings.wasm===PUBLIC_RC1.wasmPath&&p.artifactSha256===PUBLIC_RC1.wasmSha256
    &&settings.expectedNetworkDomain===PUBLIC_RC1.domain&&settings.expectedNetworkId===5&&settings.expectedL1Id===PUBLIC_RC1.l1
    &&settings.expectedChainId===PUBLIC_RC1.chainHex,"public deployment pins changed");
  const bridge=settings.bridgeWithdrawal;
  requirePublic(bridge?.cRpc===PUBLIC_RC1.evmRpc&&bridge.custodyContract===PUBLIC_RC1.custody&&bridge.routeId===PUBLIC_RC1.route
    &&bridge.expectedEvmChainId===43113&&bridge.expectedAttestor===PUBLIC_RC1.attestor,"public custody route changed");
  requirePublic(Object.keys(bridge.assets).length===5&&PUBLIC_ASSETS.every(a=>bridge.assets[a.asset]?.tokenAddress===a.token
    &&bridge.assets[a.asset]?.policyHash===a.policy&&bridge.assets[a.asset]?.minWithdrawalAmount===a.minimum),"public asset/token policy changed");
  requirePublic(settings.asset===PUBLIC_RC1.clc.slice(2)&&settings.allowedAssets?.length===1&&settings.allowedAssets[0]===settings.asset
    &&settings.testnetAutoFunding?.profile===PUBLIC_RC1.profile&&settings.testnetAutoFunding.faucetUrl===PUBLIC_RC1.faucet
    &&settings.testnetAutoFunding.readinessUrl===PUBLIC_RC1.readiness&&p.depositAmountBase===PUBLIC_RC1.grant,"public funding/asset profile changed");
  requirePublic(BigInt(p.gasReserveWei)>=BigInt(PUBLIC_RC1.exitGasReserve)&&settings.minMillisBetweenLiveThrows>=30000,"exit gas/cadence reserve weakened");
}
export async function createPublicProfile(dataDir:string,sourceDir:string,approvedAddress:string,workspace=process.cwd()):Promise<AgentSettings>{
  requirePublic(path.basename(path.resolve(dataDir)).startsWith("data-rc1-public-"),"isolated public data directory required");
  const entries=await readdir(dataDir).catch(e=>{if(e.code==="ENOENT")return [];throw e;});requirePublic(entries.length===0,"never overwrite/copy old journals into public profile");
  const owner=await optionalJson(path.join(sourceDir,"settings.json")) as AgentSettings;
  requirePublic(owner,"owner settings required");await inspectOwnerJournals(sourceDir,approvedAddress);
  if(owner.signingKeyFile){const key=await realpath(owner.signingKeyFile),root=await realpath(workspace),relative=path.relative(root,key);
    requirePublic(relative!==""&&(relative.startsWith("..")||path.isAbsolute(relative)),"private key must remain outside repository");}
  const settings=buildPublicSettings(owner,sourceDir,approvedAddress);await saveSettings(settings,dataDir);return settings;
}
export async function acquirePublicSignerLease(settings:AgentSettings,dataDir:string,leaseRoot?:string):Promise<()=>Promise<void>>{
  const root=leaseRoot??path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),".local/share"),"Collider/Agent1/signer-leases");await mkdir(root,{recursive:true});
  const file=path.join(root,settings.expectedEvmAddress!.toLowerCase()+".lock");let handle;
  try{handle=await open(file,"wx",0o600);}catch{throw Error("public_rc1_hold: owner wallet signer lease held; reconcile, do not clear automatically");}
  await handle.writeFile(JSON.stringify({pid:process.pid,dataDir:path.resolve(dataDir),wallet:settings.expectedEvmAddress}));await handle.sync();
  const cleanup=()=>{try{unlinkSync(file);}catch{/* A hard kill deliberately leaves the lease for manual reconciliation. */}};
  process.once("exit",cleanup);let released=false;
  return async()=>{if(released)return;released=true;process.removeListener("exit",cleanup);await handle.close();await rm(file);};
}
