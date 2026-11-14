import path from "node:path";
import { readFile } from "node:fs/promises";
import { AgentWallet } from "../collider/wallet.js";
import { loadSettings } from "../core/settings.js";
import { PUBLIC_RC1, requirePublic } from "../public-rc1/contract.js";
import { assertPublicSettings, acquirePublicSignerLease } from "../public-rc1/profile.js";
import { publicCancellation } from "../public-rc1/cancellation.js";
const args=process.argv.slice(2),arg=(key:string,fallback?:string)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const dir=arg("--data-dir",PUBLIC_RC1.dataDir)!,settings=await loadSettings(dir);assertPublicSettings(settings);
const release=await acquirePublicSignerLease(settings,dir);
try{
  const wallet=await AgentWallet.load(settings);requirePublic(wallet,"approved cancellation wallet unavailable");
  let expected={requestId:arg("--request-id")??"",asset:arg("--asset",PUBLIC_RC1.clc)!,amount:arg("--amount")??""};
  if(args.includes("--resume")){const state=JSON.parse(await readFile(path.join(dir,"public-cancellation-state.json"),"utf8"));expected=state.pending?.expected??state.lastResult;}
  requirePublic(expected,"original cancellation journal not found");
  console.log(JSON.stringify(await publicCancellation({settings,dataDir:dir,wallet,expected,broadcast:args.includes("--broadcast"),resume:args.includes("--resume")}),null,2));
}finally{await release();}
