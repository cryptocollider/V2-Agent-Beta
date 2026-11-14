import { PUBLIC_RC1, requirePublic } from "./contract.js";

export class AwaitingFaucetSetupError extends Error {
  readonly stage="AWAITING_FAUCET_SETUP";
  constructor(reason:string){super("awaiting_faucet_setup: "+reason);this.name="AwaitingFaucetSetupError";}
}
export class PublicHttpError extends Error {
  constructor(readonly status:number,readonly retryAfterMs:number){super("public HTTP "+status);}
}
export function parsePublicJson(text:string):unknown {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,token=>{
    if(token.startsWith('"'))return token;
    requirePublic(Number.isFinite(Number(token)),"nonfinite JSON number");
    if(!/^-?\d+$/.test(token))return token;
    const n=BigInt(token);return n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER)?JSON.stringify(token):token;
  }));
}
export function retryAfterMs(value:string|null,now=Date.now()):number {
  if(!value)return 1000;
  const delay=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-now;
  return Number.isFinite(delay)?Math.max(0,Math.min(60000,delay)):1000;
}
export async function publicJson<T>(url:string,init:RequestInit={},dependencies:{fetchFn?:typeof fetch;sleep?:(ms:number)=>Promise<void>;maxBytes?:number;notFound?:boolean}={}):Promise<T|null>{
  const u=new URL(url),faucetRoot=PUBLIC_RC1.faucet+"/";
  requirePublic(u.protocol==="https:"&&!u.username&&!u.password&&!u.hash
    && (url.startsWith(faucetRoot)||url===PUBLIC_RC1.gateway||url===PUBLIC_RC1.readiness),"public HTTP URL not pinned");
  const isRead=!init.method||init.method==="GET",sleep=dependencies.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
  for(let attempt=0;;attempt++){
    const response=await (dependencies.fetchFn??fetch)(url,{...init,redirect:"error",signal:AbortSignal.timeout(15000),headers:{accept:"application/json",...init.headers}});
    requirePublic(!response.redirected&&!(response.status>=300&&response.status<400),"redirect rejected");
    if(response.status===404&&dependencies.notFound)return null;
    if(!response.ok){
      const error=new PublicHttpError(response.status,retryAfterMs(response.headers.get("retry-after")));
      await response.body?.cancel();
      if(isRead&&[429,503].includes(error.status)&&attempt<2){await sleep(error.retryAfterMs+Math.floor(Math.random()*250));continue;}
      throw error;
    }
    requirePublic((response.headers.get("content-type")??"").toLowerCase().includes("application/json"),"public response is not JSON");
    const reader=response.body?.getReader();requirePublic(reader,"empty HTTP body");
    const chunks:Uint8Array[]=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;requirePublic(length<=(dependencies.maxBytes??262144),"public response exceeds bound");chunks.push(value);}}
    finally{await reader.cancel().catch(()=>undefined);}
    return parsePublicJson(Buffer.concat(chunks).toString("utf8")) as T;
  }
}
