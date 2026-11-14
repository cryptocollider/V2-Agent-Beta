import {workerData,parentPort} from 'node:worker_threads';
import {ColliderClient} from '../collider/client.js';import {runAgentOnce} from './loop.js';import {MASK_LIVE} from '../collider/masks.js';
import {loadPublicGameRuntime} from '../public-rc1/artifacts.js';import {initManagerState,getLatestCandidateContext} from '../core/manager-state.js';import {DEFAULT_POLICY} from '../policy/schema.js';import {resolveAgentProfile} from '../core/agent-profile.js';
import {CLASSIC_MAP,classicIds} from '../experiments/classic-hour.js';
const publicEnvironment=new Set(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','NODE_EXTRA_CA_CERTS']);for(const key of Object.keys(process.env))if(!publicEnvironment.has(key))delete process.env[key];
// This worker receives public planning settings only and never loads a wallet or storage writer.
try{const {settings:s,dataDir}=workerData;const client=new ColliderClient(s.rpc,null);await initManagerState(dataDir);
 const wasm=await loadPublicGameRuntime(client,s.wasm),games=await client.listGames(MASK_LIVE),ids=classicIds(games);
 await runAgentOnce(client,wasm,{...DEFAULT_POLICY,maxSingleThrowBase:s.maxSingleThrowBase,maxSingleThrowUsd:s.maxSingleThrowUsd,maxThrowUsd:s.maxThrowUsd,maxGameExposureUsd:s.maxGameExposureUsd,reserveBalanceBase:s.reserveBalanceBase,allowedAssets:s.allowedAssets,riskMode:s.riskMode,copySlammerWhenSameHoleType:false},
 {sessionId:"keyless-manager-preview",gameStatusMask:MASK_LIVE,botUser:s.user,defaultAsset:s.asset,defaultAmount:s.amount,dryRun:true,storage:undefined,includeSlip1:true,allowedGameIds:ids,candidateBudget:{maxCandidates:Math.min(s.maxCandidates,240),maxMillis:Math.min(s.maxMs,12000)},candidateGen:{xSteps:3,ySteps:2,angleDegs:[-75,-60,-45,-30,-15,0,15,30,45,60,75],speedPcts:[35,50,65,80,95],spinPcts:[-50,-25,0,25,50]},scoreConfig:{robustnessWeight:1,fragilityWeight:.25},agentProfile:resolveAgentProfile(s)});
 const context=getLatestCandidateContext();if(!context?.candidates?.length)throw Error('No usable fresh Classic candidates');parentPort!.postMessage({ok:true,context:{...context,source:'keyless-live-preview',classicMap:CLASSIC_MAP}});
}catch{parentPort!.postMessage({ok:false,error:'Fresh keyless Classic planning preview unavailable'});}
