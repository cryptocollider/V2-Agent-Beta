import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {ManagerProviderRequest,ManagerProviderResult} from "../types.js";

type RunResult={code:number;stdout:string;stderr:string};
export type CodexRunner=(exe:string,args:string[],cwd:string,input:string)=>Promise<RunResult>;
const schema={type:"object",additionalProperties:false,required:["reply","summary","proposals"],properties:{reply:{type:"string"},summary:{type:["string","null"]},proposals:{type:"array",maxItems:2,items:{type:"object",additionalProperties:false,required:["kind","title","why","payloadJson"],properties:{kind:{type:"string",enum:["settings_patch","overlay","candidate_set","target_game","clear_target_game"]},title:{type:"string"},why:{type:"string"},payloadJson:{type:"string"}}}}}};
export function codexManagerArgs(dir:string,model:string,effort="low"):string[]{return ["exec","--ignore-user-config","--ignore-rules","--ephemeral","--skip-git-repo-check","--sandbox","read-only","--disable","shell_tool","--disable","unified_exec","--disable","apps","--disable","multi_agent","--disable","skill_mcp_dependency_install","-c",'approval_policy="never"',"-c",'web_search="disabled"',"-c",`model_reasoning_effort="${effort}"`,"-c","project_doc_max_bytes=0","--json","--output-schema",path.join(dir,"schema.json"),"--output-last-message",path.join(dir,"response.json"),...(model&&model!=="default"?["--model",model]:[]),"-"];}
function safeEnvironment(){const keep=["PATH","Path","SYSTEMROOT","SystemRoot","WINDIR","COMSPEC","USERPROFILE","LOCALAPPDATA","APPDATA","HOME","TEMP","TMP","CODEX_HOME"];return Object.fromEntries(keep.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]! ]));}
async function run(exe:string,args:string[],cwd:string,input:string):Promise<RunResult>{return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,env:safeEnvironment(),windowsHide:true,shell:false,stdio:["pipe","pipe","pipe"]});let out="",err="",done=false;
  const finish=(error?:Error,code=0)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve({code,stdout:out,stderr:err});};
  const timer=setTimeout(()=>finish(new Error("Codex manager timed out; no automatic retry")),90000);
  child.stdout.on("data",b=>{out+=b;if(Buffer.byteLength(out)>262144)finish(new Error("Codex manager output bound exceeded"));});
  child.stderr.on("data",b=>{err+=b;if(Buffer.byteLength(err)>65536)finish(new Error("Codex manager diagnostics bound exceeded"));});
  child.once("error",()=>finish(new Error("Codex CLI unavailable; install/sign in locally")));child.once("close",code=>finish(undefined,code??1));child.stdin.end(input);
});}
export async function invokeCodexProvider(request:ManagerProviderRequest,runner:CodexRunner=run,removeTemp:typeof rm=rm):Promise<ManagerProviderResult>{
  const effort=request.config.reasoningEffort??"low";if(!["low","medium","high"].includes(effort))throw Error("Invalid manager reasoning effort");
  const exe=process.env.COLLIDER_CODEX_EXECUTABLE||"codex";
  if(exe!=="codex"&&(!path.isAbsolute(exe)||!/^codex(?:\.exe)?$/i.test(path.basename(exe))))throw Error("Codex executable must be an absolute codex binary path, not a shell command");
  let completed:ManagerProviderResult|undefined;
  const dir=await mkdtemp(path.join(os.tmpdir(),"collider-codex-manager-")),started=Date.now();
  try{
    const auth=await runner(exe,["login","status"],dir,"");if(auth.code!==0||!/Logged in using ChatGPT/i.test(auth.stdout+auth.stderr))throw Error("Codex manager requires ChatGPT sign-in; API-key billing is not enabled by this adapter");
    const prompt=["You are an advisory game manager. Use only the supplied public snapshot. Do not call tools, read files, browse, execute commands, or contact any service. Return one concise JSON response. Proposal payloadJson is a JSON-encoded object; never claim execution.",request.systemPrompt,...request.messages.slice(-2).map(m=>m.role+": "+m.content)].join("\n\n");
    if(Buffer.byteLength(prompt)>48000)throw Error("Codex manager input exceeds minimal-inference bound");
    await writeFile(path.join(dir,"schema.json"),JSON.stringify(schema));
    const r=await runner(exe,codexManagerArgs(dir,request.config.model,effort),dir,prompt);if(r.code!==0)throw Error("Codex manager failed; inspect local sign-in/allowance, no automatic paid fallback or retry");
    let usage:Record<string,unknown>|null=null,toolCalls=0;
    for(const line of r.stdout.split("\n")){if(!line.trim())continue;let e:any;try{e=JSON.parse(line);}catch{continue;}if(e.type==="turn.completed")usage=e.usage??null;if(e.item?.type&&!["agent_message","reasoning"].includes(e.item.type))toolCalls++;}
    if(toolCalls)throw Error("Codex manager attempted tools; response rejected");
    const raw=await readFile(path.join(dir,"response.json"),"utf8");if(Buffer.byteLength(raw)>16384)throw Error("Codex manager response exceeds bound");
    const v=JSON.parse(raw);if(typeof v.reply!=="string"||!Array.isArray(v.proposals)||v.proposals.length>2)throw Error("Invalid Codex manager response");
    const proposals=v.proposals.map((p:any)=>({kind:p.kind,title:p.title,why:p.why,payload:JSON.parse(p.payloadJson)}));
    return completed={provider:"codex",model:request.config.model||"default",text:JSON.stringify({reply:v.reply,summary:v.summary,proposals}),usage:{...(usage??{}),authMode:"chatgpt",elapsedMs:Date.now()-started,toolCalls:0,reasoningEffort:effort,configuredModel:request.config.model||"default"}};
  }finally{try{await removeTemp(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{if(completed?.usage)completed.usage.cleanupWarning="Temporary directory cleanup deferred; inference result preserved";process.emitWarning("Codex manager temporary cleanup deferred; no inference retry or signed-operation retry",{code:"MANAGER_TEMP_CLEANUP"});}}
}
