import { buildContentAddressRefFromBytes, canonicalJsonStringify } from "../core/content-address.js";

const MAX_BLOCK_BYTES=2*1024*1024;
function ensure(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(reason);}
export type IpfsConfig={enabled:boolean;kuboApi:string;httpFallback:boolean;allowRemoteKubo?:boolean;authEnv?:string};
export type RawBlock={cid:string;sha256Hex:string;bytes:Uint8Array};
export type PinReceipt={cid:string;sha256Hex:string;bytes:number;nodeId:string;readbackVerified:true};
export const DEFAULT_IPFS_CONFIG:IpfsConfig={enabled:false,kuboApi:"http://127.0.0.1:5001",httpFallback:true};
export class KuboRetryError extends Error{constructor(readonly delayMs:number){super("Kubo backpressure; retry later");}}
export function validateIpfsConfig(c:IpfsConfig){
  ensure(typeof c.enabled==="boolean"&&typeof c.httpFallback==="boolean","invalid IPFS switches");
  const u=new URL(c.kuboApi),local=u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname);
  ensure(!u.username&&!u.password&&!u.hash&&!u.search&&(u.pathname==="/"||u.pathname===""),"Kubo API must be an origin without embedded credentials");
  ensure(local||(u.protocol==="https:"&&c.allowRemoteKubo===true&&!!c.authEnv),"remote Kubo requires explicit HTTPS authenticated opt-in");
  if(c.authEnv)ensure(c.authEnv.length<=128&&/^(?:(?:AGENT1_|COLLIDER_)?IPFS_|KUBO_)[A-Z0-9_]+$/.test(c.authEnv)
    &&!/(PRIVATE_KEY|SIGNING|MNEMONIC|WALLET|SEED)/.test(c.authEnv),"use a dedicated IPFS/KUBO token environment reference, never wallet/signing credentials");
}
export function blockFromBytes(bytes:Uint8Array):RawBlock{ensure(bytes.length>0&&bytes.length<=MAX_BLOCK_BYTES,"raw block outside standard bitswap size bound");const ref=buildContentAddressRefFromBytes(bytes);return {bytes,cid:ref.cid,sha256Hex:ref.sha256Hex};}
export function envelopeBlocks(envelopeBytes:Uint8Array):RawBlock[]{
  const envelope=JSON.parse(Buffer.from(envelopeBytes).toString("utf8"));ensure(envelope.schema==="collider.forecast.reveal-envelope.v1","unsupported IPFS envelope");
  const blocks:RawBlock[]=[];
  for(const ref of[envelope.artifacts.commit,...(envelope.artifacts.history??[]),envelope.artifacts.reveal]){
    const block=blockFromBytes(Buffer.from(canonicalJsonStringify(ref.payload),"utf8"));
    ensure(block.sha256Hex===ref.sha256_hex&&(!ref.cid||ref.cid===block.cid),"hashed artifact changed before IPFS publication");blocks.push(block);
  }
  blocks.push(blockFromBytes(envelopeBytes));return [...new Map(blocks.map(b=>[b.cid,b])).values()];
}
async function boundedBody(r:Response,max:number){const chunks:Uint8Array[]=[];let count=0;const reader=r.body?.getReader();ensure(reader,"empty Kubo response");try{for(;;){const v=await reader.read();if(v.done)break;count+=v.value.length;ensure(count<=max,"Kubo response exceeds bound");chunks.push(v.value);}}finally{await reader.cancel().catch(()=>undefined);}return Buffer.concat(chunks);}
export class KuboRawPublisher{
  private root:string;
  private headers:Record<string,string>={};
  constructor(config:IpfsConfig,private fetchFn:typeof fetch=fetch){validateIpfsConfig(config);ensure(config.enabled,"IPFS publication disabled");this.root=config.kuboApi.replace(/\/$/,"");if(config.authEnv){const token=process.env[config.authEnv];ensure(token,"configured Kubo credential is unavailable");this.headers.authorization="Bearer "+token;}}
  private async request(route:string,body?:FormData){const r=await this.fetchFn(this.root+"/api/v0/"+route,{method:"POST",body,headers:this.headers,redirect:"error",signal:AbortSignal.timeout(30000)});
    if([429,503].includes(r.status)){const h=r.headers.get("retry-after")??"",delay=/^\d+$/.test(h)?Number(h)*1000:Date.parse(h)-Date.now();await r.body?.cancel();throw new KuboRetryError(Math.min(86400000,Math.max(5000,Number.isFinite(delay)?delay:5000)));}
    if(!r.ok||r.redirected){await r.body?.cancel();throw Error("Kubo request failed; no publication receipt");}return r;}
  async identity():Promise<string>{const r=await this.request("id"),j=JSON.parse((await boundedBody(r,65536)).toString());ensure(typeof j.ID==="string"&&/^[a-zA-Z0-9]{10,128}$/.test(j.ID),"Kubo node identity invalid");return j.ID;}
  async pin(block:RawBlock,nodeId:string):Promise<PinReceipt>{
    const ref=blockFromBytes(block.bytes);ensure(ref.cid===block.cid&&ref.sha256Hex===block.sha256Hex,"IPFS block identity mismatch");
    const form=new FormData();form.append("file",new Blob([new Uint8Array(block.bytes)]),"block.bin");
    const r=await this.request("block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=true&allow-big-block=false",form);
    const result=JSON.parse((await boundedBody(r,65536)).toString());ensure(result.Key===block.cid&&result.Size===block.bytes.length,"Kubo returned a different raw CID or size");
    const readback=await boundedBody(await this.request("block/get?arg="+encodeURIComponent(block.cid)),MAX_BLOCK_BYTES);
    ensure(readback.length===block.bytes.length&&buildContentAddressRefFromBytes(readback).cid===block.cid,"Kubo readback hash mismatch");
    return {cid:block.cid,sha256Hex:block.sha256Hex,bytes:block.bytes.length,nodeId,readbackVerified:true};
  }
}
