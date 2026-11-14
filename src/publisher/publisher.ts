import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { ColliderClient } from "../collider/client.js";
import { canonicalJsonStringify, buildContentAddressRefFromJson } from "../core/content-address.js";
import { PUBLIC_RC1 as P, assertPublicAuth } from "../public-rc1/contract.js";
import { DEFAULT_IPFS_CONFIG, validateIpfsConfig, KuboRawPublisher, envelopeBlocks, blockFromBytes, type IpfsConfig, type PinReceipt, KuboRetryError } from "./ipfs.js";
import { pollVerification, type VerificationReceipt } from "./receipts.js";

export type PublisherConfig={enabled:boolean;targets:string[];allowLoopbackHttp:boolean;publishAfter?:string;ipfs?:IpfsConfig};
export const DEFAULT_PUBLISHER_CONFIG:PublisherConfig={enabled:false,targets:[],allowLoopbackHttp:false};
const LIMIT=2*1024*1024, MAX_PENDING=1000;
const clean=(v:any):string=>Array.isArray(v)?Buffer.from(v).toString("hex"):String(v??"").replace(/^0x/,"").toLowerCase();
function ensure(ok:unknown,message:string):asserts ok{if(!ok)throw Error(message);}
const digest=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
export async function atomic(file:string,value:unknown){await mkdir(path.dirname(file),{recursive:true});const tmp=file+".tmp-"+process.pid;const h=await open(tmp,"w",0o600);try{await h.writeFile(canonicalJsonStringify(value));await h.sync();}finally{await h.close();}await rename(tmp,file);}
async function json(file:string,fallback:any=null):Promise<any>{try{return JSON.parse(await readFile(file,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return fallback;throw Error("publisher state/config unreadable; preserve original files");}}
export function validateConfig(c:PublisherConfig){
  ensure(typeof c.enabled==="boolean"&&typeof c.allowLoopbackHttp==="boolean"&&Array.isArray(c.targets)&&c.targets.length<=3,"invalid publisher config");
  for(const target of c.targets){const u=new URL(target);ensure(!u.username&&!u.password&&!u.search&&!u.hash&&(u.pathname==="/"||u.pathname===""),"publisher target must be an origin without credentials/path");
    ensure(u.protocol==="https:"||(c.allowLoopbackHttp&&u.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(u.hostname)),"HTTPS required except explicitly approved loopback tests");}
  if(c.publishAfter!==undefined)ensure(typeof c.publishAfter==="string"&&Number.isFinite(Date.parse(c.publishAfter)),"invalid publication watermark");
  if(c.ipfs)validateIpfsConfig(c.ipfs);
  ensure(!c.enabled||c.targets.length>0||c.ipfs?.enabled,"enabled publisher requires a target or explicit IPFS transport");
}
export async function loadPublisherConfig(dir:string):Promise<PublisherConfig>{const c=await json(path.join(dir,"forecast-publisher.json"),DEFAULT_PUBLISHER_CONFIG);validateConfig(c);return c;}
export async function publisherStatus(dir:string){const config=await loadPublisherConfig(dir),s=await json(path.join(dir,config.ipfs?.enabled?"forecast-outbox-ipfs/state.json":"forecast-outbox/state.json")),jobs:DeliveryState[]=Object.values(s?.jobs??{});return {enabled:config.enabled,targets:config.targets,publishAfter:config.publishAfter??null,verified:jobs.filter(j=>j.verification?.status==="verified").length,verificationReceipts:jobs.filter(j=>j.verification).slice(-5).map(j=>j.verification),ipfs:{enabled:config.ipfs?.enabled??false,kuboApi:config.ipfs?.kuboApi??null,httpFallback:config.ipfs?.httpFallback??true},ipfsBackoffUntil:s?.ipfsBackoff?.until??null,ipfsPinnedJobs:jobs.filter(j=>j.ipfs?.envelopeCid).length,ipfsLastError:jobs.filter(j=>j.ipfs?.lastError).at(-1)?.ipfs?.lastError??null,updatedAt:s?.updatedAt??null,lastError:(await json(path.join(dir,"forecast-publisher-error.json")))?.lastError??s?.lastError??null,pending:jobs.filter(j=>j.status==="pending").length,held:jobs.filter(j=>j.status==="held").length,delivered:jobs.filter(j=>j.status==="delivered").length,validationHeld:Object.keys(s?.validationHolds??{}).length,receipts:jobs.filter(j=>j.receipt).slice(-5).map(j=>j.receipt),backoffUntil:s?.notBefore??null,lastDeliveryError:jobs.filter(j=>j.error).at(-1)?.error??null,deliveryMeaning:"Explorer persisted/queued; NOT HPS-verified"};}
function noPrivatePaths(v:any):void{if(!v||typeof v!=="object")return;for(const [k,x]of Object.entries(v)){ensure(!["privateKey","rawTransaction","signingKeyFile","signature","settings"].includes(k),"private material prohibited in public artifacts");if(k==="localPath"&&typeof x==="string")ensure(!path.isAbsolute(x)&&!path.win32.isAbsolute(x),"absolute localPath inside hashed artifact; cannot redact without changing its hash");noPrivatePaths(x);}}
function cidForHash(hash:string){ensure(/^[a-f0-9]{64}$/.test(hash),"invalid commitment hash");let bits=0,value=0,out="b";for(const b of Buffer.concat([Buffer.from([1,0x55,0x12,0x20]),Buffer.from(hash,"hex")])){value=(value<<8)|b;bits+=8;while(bits>=5){bits-=5;out+="abcdefghijklmnopqrstuvwxyz234567"[(value>>>bits)&31];}}if(bits)out+="abcdefghijklmnopqrstuvwxyz234567"[(value<<(5-bits))&31];return out;}
async function artifact(dir:string,kind:string,hash:string){const cid=cidForHash(hash),file=path.join(dir,kind,cid+".json");ensure((await stat(file)).size<=LIMIT,"artifact exceeds byte limit");const root=await realpath(path.join(dir,kind)),resolved=await realpath(file);ensure(path.dirname(resolved)===root,"artifact symlink escapes public directory");const text=await readFile(file,"utf8"),payload=JSON.parse(text),ref=buildContentAddressRefFromJson(payload);ensure(digest(text)===hash&&ref.sha256Hex===hash&&ref.cid===cid,"artifact bytes/hash/CID mismatch");noPrivatePaths(payload);return {schema:payload.schema,sha256_hex:hash,cid,payload};}
export async function buildEnvelope(dir:string,row:any,report:any,game:any){
  ensure(game?.status===4&&game?.has_result===true&&Number(game.settled_height)>0,"canonical settlement required");
  const user=clean(row.botUser),gameId=clean(row.gameId),throwId=clean(row.actual?.throwMatch?.throw_id);
  ensure(/^[a-f0-9]{64}$/.test(user)&&/^[a-f0-9]{64}$/.test(gameId)&&/^[a-f0-9]{64}$/.test(throwId)&&clean(game.game_id)===gameId,"invalid row identity");
  const commit=await artifact(dir,"prediction-commits",clean(row.predictionCommit?.sha256Hex));
  const reveal=await artifact(dir,"prediction-reveals",clean(row.predictionReveal?.sha256Hex));
  ensure(commit.schema==="collider.prediction.commit.v1"&&reveal.schema==="collider.prediction.reveal.v1","unsupported artifact schema");
  for(const p of [commit.payload,reveal.payload])ensure(clean(p.gameId)===gameId&&clean(p.botUser)===user&&p.decisionId===row.decisionId,"artifact row identity differs");
  ensure(clean(reveal.payload.actualContext?.matchedThrowId)===throwId&&clean(reveal.payload.commit?.sha256Hex)===commit.sha256_hex,"reveal commitment/throw identity differs");
  const raw=report?.throws_raw;ensure(Array.isArray(raw),"canonical throw report required");
  const matches=raw.filter((t:any)=>clean(t.id??t.throw_id)===throwId);ensure(matches.length===1&&clean(matches[0].user)===user&&clean(matches[0].data_commit)===commit.sha256_hex,"canonical throw/data_commit mismatch");
  const history=[];const hashes=[...new Set<string>(raw.filter((t:any)=>clean(t.user)===user).map((t:any)=>clean(t.data_commit)).filter((h:string)=>/^[a-f0-9]{64}$/.test(h)&&h!=="0".repeat(64)&&h!==commit.sha256_hex))].sort();
  ensure(hashes.length<=256,"game history exceeds supported bound");
  for(const hash of hashes){const a=await artifact(dir,"prediction-commits",hash);ensure(a.schema==="collider.prediction.commit.v1"&&clean(a.payload.gameId)===gameId&&clean(a.payload.botUser)===user,"history identity mismatch");history.push(a);}
  const created=Date.parse(reveal.payload.createdAt);ensure(Number.isFinite(created),"invalid reveal timestamp");
  const envelope={schema:"collider.forecast.reveal-envelope.v1",network:"fuji-rc1-public",chain_id:P.chain,created_at_ms:created,agent:{user,label:"Agent1 RC1"},chain_refs:{game_id:gameId,throw_id:throwId,throw_user:user,data_commit:commit.sha256_hex},artifacts:{commit,reveal,history}};
  const bytes=canonicalJsonStringify(envelope);ensure(Buffer.byteLength(bytes)<=LIMIT,"complete history envelope exceeds 2MiB; hold, never truncate");return {id:digest(bytes),bytes,envelope};
}
export type DeliveryState={attempts:number;nextAt:number;target:number;status:"pending"|"delivered"|"held";verification?:VerificationReceipt;receipt?:{artifact_id?:string|number;announcement_id?:string|number;status:string;target:string;transport?:string;envelopeCid?:string};error?:string;ipfs?:{nodeId:string;blocks:Record<string,PinReceipt>;envelopeCid?:string;lastError?:string}};
type State={schema:string;chain:string;user:string;cursors:Record<string,number>;jobs:Record<string,DeliveryState>;lastError:string|null;updatedAt:string;targetCursor?:number;totalBytes?:number;notBefore?:number;identities?:Record<string,string>;validationHolds?:Record<string,string>;ipfsBackoff?:{api:string;until:number}};
type Dependencies={fetchFn?:typeof fetch;now?:()=>number;random?:()=>number;client?:Pick<ColliderClient,"getGame"|"getGameReport">};
async function responseJson(response:Response){ensure((response.headers.get("content-type")??"").includes("application/json"),"non-JSON publisher response");let size=0;const chunks=[];for await(const chunk of response.body as any){size+=chunk.length;ensure(size<=65536,"publisher response too large");chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
export function retryDelay(attempt:number,header:string|null,now:number,random:number){const parsed=header?(/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-now):0;return Math.max(Math.min(86400000,Math.max(0,parsed||0)),Math.min(3600000,5000*2**Math.min(attempt,9)))+Math.floor(random*1000);}
export class ForecastPublisher{
  private busy=false;
  constructor(readonly dir:string,private d:Dependencies={}){}
  async tick(maxDeliveries=2,onlyJobs?:ReadonlySet<string>){if(this.busy)return {busy:true};this.busy=true;let lock:any;
    let root=path.join(this.dir,"forecast-outbox"),stateFile=path.join(root,"state.json");
    try{const config=await loadPublisherConfig(this.dir);if(!config.enabled)return {enabled:false};
      root=path.join(this.dir,config.ipfs?.enabled?"forecast-outbox-ipfs":"forecast-outbox");stateFile=path.join(root,"state.json");await mkdir(root,{recursive:true});
      lock=await open(path.join(root,"publisher.lock"),"wx",0o600);await lock.writeFile(String(process.pid));await lock.sync();
      const settings=await json(path.join(this.dir,"settings.json"));ensure(settings?.rpc===P.rpc&&settings?.expectedNetworkDomain===P.domain,"publisher supports pinned public RC1 data only");const user=clean(settings.user);ensure(/^[a-f0-9]{64}$/.test(user),"invalid publisher user");
      const state:State=await json(stateFile,{schema:"collider.agent1.forecast-outbox.v1",chain:P.chain,user,cursors:{},jobs:{},lastError:null,updatedAt:""});ensure(state.schema==="collider.agent1.forecast-outbox.v1"&&state.chain===P.chain&&state.user===user,"outbox scope mismatch");
      const now=this.d.now??Date.now,fetchFn=this.d.fetchFn??fetch;const save=async()=>{state.updatedAt=new Date(now()).toISOString();await atomic(stateFile,state);};
      if((state.notBefore??0)>now())return {enabled:true,backoffUntil:state.notBefore};
      for(const id of Object.keys(state.jobs))ensure(/^[a-f0-9]{64}$/.test(id),"invalid outbox job identity");
      // Negotiate before backfill, and send to ONE eligible origin per cycle.
      let target=-1,cap:any;
      for(let step=0;step<config.targets.length;step++){const i=((state.targetCursor??0)+step)%config.targets.length;try{const r=await fetchFn(config.targets[i].replace(/\/$/,"")+"/v1/capabilities",{redirect:"error",signal:AbortSignal.timeout(10000)});if([429,503].includes(r.status)){state.notBefore=now()+retryDelay(1,r.headers.get("retry-after"),now(),(this.d.random??Math.random)());await r.body?.cancel();await save();return {enabled:true,backoffUntil:state.notBefore};}ensure(r.ok,"capability HTTP "+r.status);cap=await responseJson(r);ensure(cap.schema==="collider.forecast.provider-capabilities.v1"&&cap.network==="fuji-rc1-public"&&cap.chain_id===P.chain&&clean(cap.native_chain_id)===clean(P.chainHex)&&(cap.features?.single_reveal_post===true||(config.ipfs?.enabled&&cap.features?.reveal_announcement_post===true))&&cap.ingestion?.enabled===true&&cap.ingestion?.accepting===true&&cap.ingestion?.settlement_required===true&&cap.endpoints?.reveal==="/v1/forecast/reveals"&&Number(cap.max_envelope_bytes)>=LIMIT,"capability contract/scope mismatch");target=i;break;}catch{state.lastError="target capability unavailable or incompatible";}}
      if(target<0&&!config.ipfs?.enabled){await save();return {enabled:true,held:true,error:state.lastError};}
      await atomic(path.join(this.dir,"forecast-publisher-error.json"),{lastError:null});
      const client=this.d.client??new ColliderClient(P.rpc);
      if(!this.d.client)assertPublicAuth(await (client as ColliderClient).getAuthContext("0x"+user),"0x"+user);
      const evidenceCache=new Map<string,{game:any;report:any}>();
      ensure(Object.keys(state.jobs).length<=10000,"retained outbox job bound reached; archive explicitly");
      state.totalBytes??=0;state.identities??={};state.validationHolds??={};
      let enqueued=0,scanned=0;const dirs=onlyJobs?[]:[path.join(this.dir,"game-history/results")];
      for(const dir of dirs){let files:string[];try{files=(await readdir(dir)).filter(f=>/^[a-f0-9]{64}\.jsonl$/.test(f)).sort();}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
        ensure(files.length<=10000,"history index file bound exceeded");
        for(const file of files){if(scanned>=20||Object.values(state.jobs).filter(j=>j.status==="pending").length>=MAX_PENDING)break;
          const full=path.join(dir,file);ensure(path.dirname(await realpath(full))===await realpath(dir),"history symlink escapes index");const offset=state.cursors[file]??0,info=await stat(full);ensure(info.size>=offset,"history index truncated; manual cursor reconciliation required");const identity=[info.dev,info.ino,info.birthtimeMs].join(":");ensure(!state.identities[file]||state.identities[file]===identity,"history index replaced; manual reconciliation required");state.identities[file]=identity;
          const stream=createReadStream(full,{start:offset,highWaterMark:65536});let buffer=Buffer.alloc(0),consumed=offset;
          try{for await(const chunk of stream){buffer=Buffer.concat([buffer,chunk]);let n;while((n=buffer.indexOf(10))>=0){ensure(n<=4*1024*1024,"result row exceeds bound");const line=buffer.subarray(0,n);buffer=buffer.subarray(n+1);if(scanned++>=20)break;const end=consumed+n+1;
                try{const row=JSON.parse(line.toString());if(row.predictionCommit&&row.predictionReveal){if(config.publishAfter){const a=await artifact(this.dir,"prediction-commits",clean(row.predictionCommit.sha256Hex));const created=Date.parse(a.payload.createdAt);ensure(Number.isFinite(created),"invalid commit activation timestamp");if(created<=Date.parse(config.publishAfter)){consumed=end;state.cursors[file]=consumed;await save();continue;}}ensure(clean(row.botUser)===user,"foreign result user");let evidence=evidenceCache.get(row.gameId);if(!evidence){evidence={game:await client.getGame(row.gameId),report:await client.getGameReport(row.gameId)};evidenceCache.set(row.gameId,evidence);}const {game,report}=evidence;const built=await buildEnvelope(this.dir,row,report,game);if(!state.jobs[built.id]){ensure(Object.keys(state.jobs).length<10000 && (state.totalBytes??0)+Buffer.byteLength(built.bytes)<=256*1024*1024,"outbox retention/disk bound reached");const filePath=path.join(root,built.id+".json");try{const h=await open(filePath,"wx",0o600);try{await h.writeFile(built.bytes);await h.sync();}finally{await h.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;ensure(digest(await readFile(filePath))===built.id,"outbox bytes differ");}state.jobs[built.id]={attempts:0,nextAt:0,target,status:"pending"};state.totalBytes=(state.totalBytes??0)+Buffer.byteLength(built.bytes);enqueued++;}}
                  consumed=end;state.cursors[file]=consumed;state.lastError=null;delete state.validationHolds[file];await save();
                }catch{state.lastError="settled result/history validation held at "+file+":"+consumed;state.validationHolds[file]=String(consumed);await save();break;}
                if(scanned>=20)break;
              }ensure(buffer.length<=4*1024*1024,"partial result row exceeds bound");if(scanned>=20||state.lastError)break;}
          }finally{stream.destroy();}
        }
      }
      let delivered=0,attempted=0,pinBudget=32;
      deliveryLoop:for(const [id,job]of Object.entries(state.jobs)){if(attempted>=Math.min(10,maxDeliveries))break;if(onlyJobs&&!onlyJobs.has(id))continue;if(job.status!=="pending"||job.nextAt>now())continue;attempted++;
        const bytes=await readFile(path.join(root,id+".json"));ensure(digest(bytes)===id&&bytes.length<=LIMIT,"outbox integrity mismatch");const origin=target>=0?config.targets[target].replace(/\/$/,""):"";job.attempts++;job.target=target;job.nextAt=now()+60000;await save();
        try{
          let endpoint="/v1/forecast/reveals",body:string=bytes.toString("utf8"),announcement=false;
          const ipfs=config.ipfs??DEFAULT_IPFS_CONFIG;
          if(ipfs.enabled){let pinned=false;
            try{if(state.ipfsBackoff?.api===ipfs.kuboApi&&state.ipfsBackoff.until>now())throw new KuboRetryError(state.ipfsBackoff.until-now());const kubo=new KuboRawPublisher(ipfs,fetchFn),nodeId=await kubo.identity();
              job.ipfs??={nodeId,blocks:{}};
              if(job.ipfs.nodeId!==nodeId){job.ipfs.nodeId=nodeId;job.ipfs.blocks={};job.ipfs.envelopeCid=undefined;}
              for(const block of envelopeBlocks(bytes)){
                if(job.ipfs.blocks[block.cid]?.nodeId===nodeId&&job.ipfs.blocks[block.cid]?.readbackVerified)continue;
                if(pinBudget<=0){job.nextAt=now()+30000;job.error="IPFS step budget reached; retained pin progress";await save();continue deliveryLoop;}
                pinBudget--;job.ipfs.blocks[block.cid]=await kubo.pin(block,nodeId);await save();
              }
              job.ipfs.envelopeCid=blockFromBytes(bytes).cid;job.ipfs.lastError=undefined;await save();pinned=true;
            }catch(error){if(error instanceof KuboRetryError){state.ipfsBackoff={api:ipfs.kuboApi,until:now()+error.delayMs};job.nextAt=Math.max(job.nextAt,state.ipfsBackoff.until);}job.ipfs??={nodeId:"",blocks:{}};job.ipfs.lastError="IPFS pin/readback unavailable; no IPFS availability claim";await save();}
            if(pinned&&origin&&cap?.features?.reveal_announcement_post===true&&cap?.endpoints?.announcements==="/v1/forecast/announcements"){
              const envelope=JSON.parse(bytes.toString());endpoint="/v1/forecast/announcements";announcement=true;
              body=canonicalJsonStringify({schema:"collider.forecast.reveal-announcement.v1",network:envelope.network,chain_id:envelope.chain_id,game_id:envelope.chain_refs.game_id,throw_id:envelope.chain_refs.throw_id,throw_user:envelope.chain_refs.throw_user,data_commit:envelope.chain_refs.data_commit,cid:job.ipfs!.envelopeCid});
            }else ensure(ipfs.httpFallback&&origin&&cap?.features?.single_reveal_post===true,"IPFS retained; announcement or permitted HTTP fallback unavailable");
          }
          ensure(origin,"no configured discovery/delivery target");
          const r=await fetchFn(origin+endpoint,{method:"POST",redirect:"error",headers:{"content-type":"application/json","idempotency-key":id},body,signal:AbortSignal.timeout(15000)});const retry=r.headers.get("retry-after");if(r.status!==202){await r.body?.cancel();job.nextAt=now()+retryDelay(job.attempts,retry,now(),(this.d.random??Math.random)());if(r.status>=400&&r.status<500&&![408,409,429].includes(r.status))job.status="held";throw Error("HTTP "+r.status);}
          const receipt=await responseJson(r),receiptId=announcement?receipt.announcement_id:receipt.artifact_id,receiptStatus=announcement?receipt.verification:receipt.status;
          ensure(receipt.accepted===true&&((typeof receiptId==="string"&&/^[a-zA-Z0-9._:-]{1,128}$/.test(receiptId))||(Number.isSafeInteger(receiptId)&&receiptId>=0))&&typeof receiptStatus==="string"&&receiptStatus.length<=64,"invalid persistence receipt");
          job.status="delivered";job.receipt={...(announcement?{announcement_id:receiptId}:{artifact_id:receiptId}),status:receiptStatus,target:origin,transport:announcement?"ipfs-announcement":"http-envelope",...(announcement?{envelopeCid:job.ipfs!.envelopeCid}:{})};job.error=undefined;delivered++;
        }catch{job.error="delivery not acknowledged; retained for retry/review";job.nextAt=Math.max(job.nextAt,now()+retryDelay(job.attempts,null,now(),(this.d.random??Math.random)()));if(job.status==="pending"&&config.targets.length)state.targetCursor=(target+1)%config.targets.length;}
        await save();
      }
      if(target>=0&&cap?.features?.receipt_lookup===true&&cap?.endpoints?.receipts==="/v1/forecast/receipts/{artifact_id}"){let polled=0;for(const [id,job]of Object.entries(state.jobs).sort((a,b)=>(a[1].verification?.nextAt??0)-(b[1].verification?.nextAt??0))){if(polled>=5)break;if(onlyJobs&&!onlyJobs.has(id))continue;if(job.status!=="delivered"||!job.receipt?.artifact_id||job.receipt.target!==config.targets[target].replace(/\/$/,"")||(job.verification?.nextAt??0)>now())continue;const bytes=await readFile(path.join(root,id+".json"));ensure(digest(bytes)===id,"receipt envelope integrity mismatch");job.verification=await pollVerification(fetchFn,job.receipt.target,job.receipt.artifact_id,JSON.parse(bytes.toString()),now());await save();polled++;}}
      return {enabled:true,enqueued,delivered,pending:Object.values(state.jobs).filter(j=>j.status==="pending").length,held:Object.values(state.jobs).filter(j=>j.status==="held").length,lastError:state.lastError};
    }catch(error){await atomic(path.join(this.dir,"forecast-publisher-error.json"),{at:new Date().toISOString(),lastError:"publisher cycle held; inspect scope/config, durable state and publisher lease without resetting them"});throw error;
    }finally{if(lock){await lock.close();await rm(path.join(root,"publisher.lock"));}this.busy=false;}
  }
}

export function startForecastPublisher(dir:string,keepAlive=false){
  const publisher=new ForecastPublisher(dir);let active:Promise<unknown>|null=null,closed=false;
  const tick=()=>{if(active||closed)return;active=publisher.tick().catch(()=>undefined).finally(()=>{active=null;});};
  const timer=setInterval(tick,30000);if(!keepAlive)timer.unref();tick();
  return async()=>{closed=true;clearInterval(timer);if(active)await active;};
}

export async function queueExistingReveals(dir:string,limit=100,dependencies:Dependencies={}){ensure(Number.isInteger(limit)&&limit>=1&&limit<=100,'existing reveal limit must be1..100');const config=await loadPublisherConfig(dir);ensure(config.enabled,'Enable explorer publishing first');const root=path.join(dir,config.ipfs?.enabled?'forecast-outbox-ipfs':'forecast-outbox');await mkdir(root,{recursive:true});const lock=await open(path.join(root,'publisher.lock'),'wx',0o600);await lock.writeFile(String(process.pid));let queued=0,duplicates=0,held=0;const ids:string[]=[];try{const settings=await json(path.join(dir,'settings.json'));ensure(settings.rpc===P.rpc&&settings.expectedNetworkDomain===P.domain,'wrong public deployment');const user=clean(settings.user),state:State=await json(path.join(root,'state.json'),{schema:'collider.agent1.forecast-outbox.v1',chain:P.chain,user,cursors:{},jobs:{},lastError:null,updatedAt:''});ensure(state.chain===P.chain&&state.user===user,'outbox identity mismatch');const client=dependencies.client??new ColliderClient(P.rpc);const evidence=new Map<string,any>(),seen=new Set<string>();const file=path.join(dir,'results.jsonl');ensure((await stat(file)).size<=64*1024*1024,'result file too large for bounded manual export');const rows=(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).reverse();let examined=0;for(const row of rows){if(ids.length>=limit||examined++>=2000)break;if(!row.predictionCommit||!row.predictionReveal||seen.has(row.decisionId))continue;seen.add(row.decisionId);try{let e=evidence.get(row.gameId);if(!e){e={game:await client.getGame(row.gameId),report:await client.getGameReport(row.gameId)};evidence.set(row.gameId,e);}const built=await buildEnvelope(dir,row,e.report,e.game);if(state.jobs[built.id]){duplicates++;continue;}ensure(Object.keys(state.jobs).length<10000&&(state.totalBytes??0)+Buffer.byteLength(built.bytes)<=256*1024*1024,'outbox bound exceeded');await atomic(path.join(root,built.id+'.json'),built.envelope);state.jobs[built.id]={attempts:0,nextAt:0,target:0,status:'pending'};state.totalBytes=(state.totalBytes??0)+Buffer.byteLength(built.bytes);ids.push(built.id);queued++;state.updatedAt=new Date().toISOString();await atomic(path.join(root,'state.json'),state);}catch{held++;}}const result={at:new Date().toISOString(),limit,queued,duplicates,held,ids,activationWatermarkUnchanged:config.publishAfter??null};await atomic(path.join(dir,'forecast-manual-export.json'),result);return result;}finally{await lock.close();await rm(path.join(root,'publisher.lock'));}}
export async function setExplorerPublishing(dir:string,enabled:boolean){ensure(typeof enabled==='boolean','boolean publishing flag required');const prior=await loadPublisherConfig(dir),config={...prior,enabled,targets:prior.targets.length?prior.targets:['https://gamechain.info'],publishAfter:prior.publishAfter??new Date().toISOString()};validateConfig(config);await atomic(path.join(dir,'forecast-publisher.json'),config);return publisherStatus(dir);}
