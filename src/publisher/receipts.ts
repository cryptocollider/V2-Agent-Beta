import { PUBLIC_RC1 as P } from "../public-rc1/contract.js";

export type VerificationReceipt={checkedAt:string;nextAt:number;status:string;url:string;eligible?:boolean;honestScore?:number;error?:string};
const clean=(v:unknown)=>String(v??"").replace(/^0x/,"").toLowerCase();
export async function pollVerification(fetchFn:typeof fetch,origin:string,id:string|number,envelope:any,now:number):Promise<VerificationReceipt>{
  const key=String(id);if(!/^[a-zA-Z0-9._:-]{1,128}$/.test(key))throw Error("invalid receipt identity");
  const url=origin+"/v1/forecast/receipts/"+encodeURIComponent(key),base={checkedAt:new Date(now).toISOString(),nextAt:now+60000,url};
  try{
    const r=await fetchFn(url,{redirect:"error",signal:AbortSignal.timeout(10000)});
    if(!r.ok){await r.body?.cancel();return {...base,status:"pending",error:"receipt HTTP "+r.status,nextAt:now+Math.max(60000,Math.min(86400000,Number(r.headers.get("retry-after")) *1000||0))};}
    if(!(r.headers.get("content-type")??"").includes("application/json"))throw Error("receipt type");
    let size=0;const chunks:Uint8Array[]=[];for await(const c of r.body as any){size+=c.length;if(size>65536)throw Error("receipt size");chunks.push(c);}
    const v=JSON.parse(Buffer.concat(chunks).toString()),refs=envelope.chain_refs;
    if(String(v.artifact_id)!==key||v.network!=="fuji-rc1-public"||v.chain_id!==P.chain||clean(v.data_commit)!==clean(refs.data_commit)||clean(v.game_id)!==clean(refs.game_id)||clean(v.throw_id)!==clean(refs.throw_id)||clean(v.user_id)!==clean(refs.throw_user))throw Error("receipt scope");
    const status=v.verification??v.status;if(!["queued","pending","verified","rejected"].includes(status))throw Error("receipt status");
    const verified=status==="verified",score=v.score?.honest_score;
    if(verified&&(!Number.isFinite(score)||![0,1,false,true].includes(v.score?.eligible)))throw Error("receipt score");
    return {...base,status,...(verified?{eligible:!!v.score.eligible,honestScore:score}:{}),nextAt:status==="verified"||status==="rejected"?Number.MAX_SAFE_INTEGER:base.nextAt};
  }catch{return {...base,status:"pending",error:"receipt unavailable or scope mismatch; delivery acknowledgement preserved"};}
}
