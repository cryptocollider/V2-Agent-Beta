import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createPublicProfile, buildPublicSettings, inspectOwnerJournals } from "../public-rc1/profile.js";
import { PUBLIC_RC1, requirePublic } from "../public-rc1/contract.js";
import { saveSettings, type AgentSettings } from "../core/settings.js";
import { loadOrCreateFujiTestWallet } from "../core/fuji-test-wallet.js";

export async function preparePublicCli(args=process.argv.slice(2)):Promise<void>{
  const arg=(key:string,fallback?:string)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
  const source=arg("--owner-settings-dir"),data=arg("--data-dir",PUBLIC_RC1.dataDir)!;
  requirePublic(source,"--owner-settings-dir required; no bundled default wallet");
  let settings:AgentSettings;
  if(args.includes("--generate-instance-wallet")){
    requirePublic(!arg("--approve-wallet"),"choose existing approved wallet OR explicit new instance wallet");
    requirePublic(path.basename(path.resolve(data)).startsWith("data-rc1-public-"),"isolated public profile required");
    const entries=await readdir(data).catch(e=>{if(e.code==="ENOENT")return [];throw e;});requirePublic(entries.length===0,"no wallet rotation/reset for an existing profile");
    const owner=JSON.parse(await readFile(path.join(source,"settings.json"),"utf8")) as AgentSettings;
    requirePublic(!owner.publicRc1,"an existing public instance cannot be used to rotate wallets");
    requirePublic(owner.expectedEvmAddress,"owner source wallet pin required");
    await inspectOwnerJournals(source,owner.expectedEvmAddress);
    const id=createHash("sha256").update(path.resolve(data)).digest("hex").slice(0,24);
    const output=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),".local/share"),"Collider/Agent1/public-rc1",id,"agent1.hex");
    const wallet=await loadOrCreateFujiTestWallet(output);
    settings=buildPublicSettings({...owner,expectedEvmAddress:wallet.address,signingKeyFile:wallet.signingKeyFile},data,wallet.address);
    await saveSettings(settings,data);
  }else{
    const approved=arg("--approve-wallet");requirePublic(approved,"--approve-wallet must explicitly pin the existing owner's address");
    settings=await createPublicProfile(data,source,approved);
  }
  console.log(JSON.stringify({status:"PUBLIC_PROFILE_PREPARED_NOT_STARTED",dataDir:path.resolve(data),wallet:settings.expectedEvmAddress,
    keyStoredOutsideRepository:true,autoFunding:false,aiAutoApply:false,automaticConversion:false,
    walletMode:args.includes("--generate-instance-wallet")?"explicit_per_instance_generation":"owner_supplied",financialSignatures:0,transactionsSubmitted:0}));
}
if(process.argv[1]&&path.resolve(process.argv[1]).replace(/\\/g,"/").endsWith("/prepare-public-rc1.js"))void preparePublicCli().catch(e=>{console.error(String(e));process.exitCode=1;});
