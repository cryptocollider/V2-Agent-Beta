import {mkdir,readFile,writeFile,access} from "node:fs/promises";
import path from "node:path";import os from "node:os";
import {createReadStream} from "node:fs";import {createInterface} from "node:readline";
import {loadOrCreateFujiTestWallet} from "../core/fuji-test-wallet.js";
import {normalizeSettings,saveSettings} from "../core/settings.js";
import {createPublicProfile} from "../public-rc1/profile.js";
import {BASELINES,primaryGoalWeights,behaviorHash} from "../experiments/doctrine-baseline.js";
import {DEFAULT_MANAGER_LLM_CONFIG} from "../llm/types.js";
import {PUBLIC_RC1 as P} from "../public-rc1/contract.js";
import {buildContentAddressRefFromJson} from "../core/content-address.js";

const root="data-doctrine-baselines-20261110a",old="data-rc1-public-20261104a";await mkdir(root,{recursive:true});
try{await access(path.join(root,"manifest.json"));throw Error("baseline manifest already exists; preserve wallets and all journals");}catch(e){if((e as any).code!=="ENOENT")throw e;}
const template=JSON.parse(await readFile(path.join(old,"settings.json"),"utf8")),settled=new Set<string>();
for await(const l of createInterface({input:createReadStream(path.join(old,"results.jsonl")),crlfDelay:Infinity})){const r=JSON.parse(l);if(r.actual?.matched)settled.add(String(r.gameId).replace(/^0x/,""));}
let run:any;for await(const l of createInterface({input:createReadStream(path.join(old,"runs.jsonl")),crlfDelay:Infinity})){const r=JSON.parse(l);if(r.submitted&&settled.has(String(r.gameId).replace(/^0x/,""))&&r.topDetailed?.length>1)run=r;}
if(!run)throw Error("no settled public candidate packet available");
const packet={schema:"agent1.doctrine-shared-packet.v1",source:"Archived settled public run; frozen comparison, not fresh execution",gameId:run.gameId,ts:run.ts,pointForecastAvailable:false,candidates:run.topDetailed.slice(0,10).map((r:any)=>({candidateHash:r.candidateHash,source:r.source,asset:r.asset,amount:r.amount,x:r.x,y:r.y,angleDeg:r.angleDeg,speedPct:r.speedPct,spinPct:r.spinPct,baseScore:r.baseScore,basePrediction:r.basePrediction?{pnlUsd:r.basePrediction.pnlUsd,bestPnlUsd:r.basePrediction.bestPnlUsd,worstPnlUsd:r.basePrediction.worstPnlUsd,holeType:r.basePrediction.holeType,holeTypeCounts:r.basePrediction.holeTypeCounts,scenarioCount:r.basePrediction.scenarioCount}:null}))};
await writeFile(path.join(root,"shared-packet.json"),JSON.stringify(packet,null,2)+"\n");const profiles=[];
for(const b of BASELINES){
  const key=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),".local/share"),"Collider/Agent1/test-wallets/doctrines-20261110a",b.id+".hex");
  const ownerDir=path.join(root,"data-owner-"+b.id);let previous:any=null;
  for(const location of [ownerDir,path.join(root,"owners",b.id)]){try{previous=JSON.parse(await readFile(path.join(location,"settings.json"),"utf8"));break;}catch(e){if((e as any).code!=="ENOENT")throw e;}}
  const wallet=await loadOrCreateFujiTestWallet(key);
  if(!wallet.created&&(!previous||previous.expectedEvmAddress?.toLowerCase()!==wallet.address.toLowerCase()||path.resolve(previous.signingKeyFile)!==path.resolve(key)))throw Error("existing wallet lacks matching preparation identity; reconcile manually");
  await mkdir(ownerDir,{recursive:true});
  const owner=normalizeSettings({...template,user:"",signingKeyFile:wallet.signingKeyFile,signingKeyEnv:null,expectedEvmAddress:wallet.address,maxThrowsPerSession:11,riskMode:"balanced",customStrategy:null,copySlammerWhenSameHoleType:false,goalWeights:primaryGoalWeights(b.primaryGoal),doctrinePack:b.doctrine,monitorPort:b.port,mapPriorities:{},humanLearning:{enabled:false,learnOwnManualThrows:false,addresses:[],maxSeedsPerCycle:0},targetProfitUsd:null,targetBalanceUsd:null});await saveSettings(owner,ownerDir);
  const dir="data-rc1-public-ai-"+b.id+"-20261110a";await mkdir(dir,{recursive:true});let settings=await createPublicProfile(dir,ownerDir,wallet.address);settings=normalizeSettings({...settings,doctrinePack:b.doctrine,goalWeights:primaryGoalWeights(b.primaryGoal),riskMode:"balanced",customStrategy:null,copySlammerWhenSameHoleType:false,maxThrowsPerSession:11,monitorPort:b.port,mapPriorities:{},humanLearning:{enabled:false,learnOwnManualThrows:false,addresses:[],maxSeedsPerCycle:0}});await saveSettings(settings,dir);
  const manager=JSON.parse(JSON.stringify(DEFAULT_MANAGER_LLM_CONFIG));manager.activeProvider="codex";manager.autoApply=false;manager.providers.codex.enabled=true;for(const p of Object.values(manager.providers) as any[])p.maxOutputTokens=768;manager.providers.openrouter.model="liquid/lfm-3-1.7b:free";manager.providers.openrouter.apiKeyEnv="OPENROUTER_API_KEY";manager.providers.venice.apiKeyEnv="VENICE_API_KEY";manager.providers.openai.apiKeyEnv="OPENAI_API_KEY";
  await writeFile(path.join(dir,"manager-llm.json"),JSON.stringify({config:manager,history:[],pendingActions:[],busy:false,lastError:null,lastUpdatedAt:null,lastProvider:null,lastSummary:null},null,2)+"\n");
  await writeFile(path.join(dir,"forecast-publisher.json"),JSON.stringify({enabled:false,targets:["https://gamechain.info"],allowLoopbackHttp:false},null,2)+"\n");
  profiles.push({...b,address:wallet.address,user:settings.user,dataDir:dir,monitor:"http://127.0.0.1:"+b.port,behaviorHash:behaviorHash(settings),goalWeights:settings.goalWeights,status:"prepared-unfunded",inference:{provider:"codex",model:"default",effort:"low",initialCalls:1,periodicCalls:0,autoApply:false,allowedEffects:"score overlay only,total absolute bias<=100"}});
}
if(new Set(profiles.map(p=>p.behaviorHash)).size!==1)throw Error("baseline non-treatment behavior differs; do not launch");
const manifest={schema:"agent1.four-doctrine-baselines.v1",createdAt:new Date().toISOString(),chain:P.chain,profiles,sharedPacketSha256:buildContentAddressRefFromJson(packet).sha256Hex,treatmentFields:["doctrinePack","goalWeights"],commonPolicy:{cadenceMs:30000,maxThrowsPerGame:22,maxThrowsPerSession:11,maxThrowUsd:10,maxGameExposureUsd:110,reserveClc:400,humanLearning:false,copySlammers:false},livePilot:{status:"awaiting human budget/funding approval",maximumTotalThrows:44,externalOneUseGrants:4,grantClcEach:4000,grantAvaxEach:.005,tournamentCreation:false},providerStatus:{codex:"ChatGPT sign-in selected; real inference to verify next",openrouter:"current free model pinned,awaiting local key",venice:"disabled until human credits ready",openaiApi:"disabled,separate API credit/billing required"}};
await writeFile(path.join(root,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");console.log(JSON.stringify({manifest:path.join(root,"manifest.json"),profiles:profiles.map(({id,address,monitor,behaviorHash})=>({id,address,monitor,behaviorHash})),sharedPacketCandidates:packet.candidates.length,transactions:0,fundingClaims:0}));
