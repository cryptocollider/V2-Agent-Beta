import { PUBLIC_RC1, verifyPublicPayload } from "../public-rc1/contract.js";
import { parsePublicJson, retryAfterMs } from "../public-rc1/http.js";

export type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: number;
  result: T;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type RpcSample={method:string;elapsedMs:number;http:number|null;ok:boolean;attempt:number;bytes:number};
let rpcObserver:((sample:RpcSample)=>void)|null=null;
export function setRpcObserver(observer:((sample:RpcSample)=>void)|null){rpcObserver=observer;}
function observeRpc(sample:RpcSample){try{rpcObserver?.(sample);}catch{/* Measurement must never change RPC/signing outcomes. */}}
export type RpcClientOptions = {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  redactErrors?: boolean;
  sleep?: (ms:number)=>Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(err: unknown): boolean {
  const msg = String(err ?? "");
  return (
    msg.includes("fetch failed") ||
    msg.includes("UND_ERR_SOCKET") ||
    msg.includes("ECONNRESET") ||
    msg.includes("other side closed") ||
    msg.includes("socket hang up") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("aborted")
  );
}

function readMethod(method:string):boolean {
  return /^(colliderV2\.(get[A-Z]|list[A-Z]|userIdFromEvmAddress)|eth_(get|call$|chainId$|blockNumber$|gasPrice$|estimateGas$))/.test(method);
}
const publicReads=new Map<string,{expires:number;value:Promise<unknown>}>();
export function isPublicReadMethod(method:string):boolean{return /^colliderV2\.(get[A-Z]|list[A-Z]|userIdFromEvmAddress$)/.test(method);}

export class JsonRpcClient {
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly wait:(ms:number)=>Promise<void>;

  constructor(
    private readonly url: string,
    private readonly defaultHeaders: Record<string, string> = {},
    opts: RpcClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 600;
    this.wait=opts.sleep??sleep;
  }

  async call<T>(method: string, params: unknown[] = [], opts: RpcClientOptions = {}): Promise<T> {
    const publicNative=this.url===PUBLIC_RC1.rpc;
    if(this.url.startsWith(PUBLIC_RC1.origin)&&!publicNative)throw Error("unapproved public RPC path");
    if(publicNative&&!isPublicReadMethod(method)&&!["colliderV2.prepareSignedIntent","colliderV2.submitSignedIntent","colliderV2.prepareBridgeUserWithdrawal","colliderV2.prepareBridgeCancellation"].includes(method))throw Error("public RPC method denied");
    const ttl=publicNative&&["colliderV2.getAssetsMeta","colliderV2.getHoleRules","colliderV2.getSimulatorVersions"].includes(method)?10000:0;
    if(ttl){const key=this.url+method+JSON.stringify(params),hit=publicReads.get(key);if(hit&&hit.expires>Date.now())return await hit.value as T;
      const value=this.perform<T>(method,params,opts);publicReads.set(key,{expires:Date.now()+ttl,value});while(publicReads.size>64)publicReads.delete(publicReads.keys().next().value!);
      try{return await value;}catch(error){publicReads.delete(key);throw error;}}
    return await this.perform<T>(method,params,opts);
  }

  private async perform<T>(method:string,params:unknown[],opts:RpcClientOptions):Promise<T>{
    const sensitive=!!opts.redactErrors||method==="colliderV2.submitSignedIntent"||method==="eth_sendRawTransaction";
    const id = this.nextId++;
    const retries = readMethod(method) ? (opts.retries ?? this.retries) : 0;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let backoff:number|null=null;
      const requestStarted=performance.now();let http:number|null=null,replyBytes=0;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      try {
        console.log(`[rpc] -> ${method} ${this.url}`);

        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this.defaultHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
          signal: ac.signal,
          redirect: "error",
        });

        http=res.status;
        console.log(`[rpc] <- ${method} HTTP ${res.status}`);

        if (!res.ok) {
          if([429,503].includes(res.status)&&readMethod(method))backoff=retryAfterMs(res.headers.get("retry-after"));
          throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
        }

        let text:string;
        if(this.url===PUBLIC_RC1.rpc){
          const reader=res.body?.getReader();if(!reader)throw Error("empty public RPC response");
          const chunks:Uint8Array[]=[];let bytes=0;
          try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>4*1024*1024)throw Error("public RPC response exceeds bound");chunks.push(next.value);}}
          finally{await reader.cancel().catch(()=>undefined);}text=Buffer.concat(chunks).toString("utf8");
        }else text=await res.text();
        replyBytes=Buffer.byteLength(text);
        const data = (this.url===PUBLIC_RC1.rpc ? parsePublicJson(text) : JSON.parse(text)) as JsonRpcSuccess<T> | JsonRpcFailure;
        if(this.url===PUBLIC_RC1.rpc&&(data.jsonrpc!=="2.0"||data.id!==id))throw Error("public RPC envelope mismatch");

        if ("error" in data) {
          throw new Error(sensitive ? "sensitive RPC rejected" : `RPC ${method} failed: ${data.error.message}`);
        }

        clearTimeout(timer);
        if(this.url===PUBLIC_RC1.rpc&&method==="colliderV2.prepareSignedIntent")verifyPublicPayload(data.result);
        observeRpc({method,elapsedMs:performance.now()-requestStarted,http,ok:true,attempt,bytes:replyBytes});
        return data.result;
      } catch (err) {
        observeRpc({method,elapsedMs:performance.now()-requestStarted,http,ok:false,attempt,bytes:replyBytes});
        clearTimeout(timer);

        const retryable = backoff!==null||isRetryableNetworkError(err);
        console.warn(`[rpc] ${retryable ? "network failure" : "failure"} on ${method}:`, sensitive ? "sensitive RPC outcome unavailable" : err);

        if (!retryable || attempt >= retries) {
          if (sensitive) throw new Error("sensitive RPC outcome unavailable");
          throw err;
        }

        const delay = backoff!==null?backoff+Math.floor(Math.random()*250):(opts.retryDelayMs ?? this.retryDelayMs)*(attempt+1);
        console.warn(`[rpc] retrying ${method} in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await (opts.sleep??this.wait)(delay);
      }
    }

    throw new Error(`RPC ${method} exhausted retries`);
  }
}
