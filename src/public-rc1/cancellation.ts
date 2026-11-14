import { readFile } from "node:fs/promises";
import path from "node:path";
import { Interface, TypedDataEncoder } from "ethers";
import type { AgentWallet } from "../collider/wallet.js";
import type { AgentSettings } from "../core/settings.js";
import type { PreparedSignedIntent, Rc1AuthContext } from "../collider/types.js";
import { verifyNativePreparedEnvelope } from "../collider/native-signing.js";
import { JsonRpcClient } from "../core/rpc.js";
import { PUBLIC_RC1 as P, PUBLIC_ASSETS, FAUCET_SCOPE, assertPublicAuth, assertPublicScope, requirePublic, verifyPublicPayload } from "./contract.js";
import { assertPublicSettings } from "./profile.js";
import { publicAtomicJson } from "./funding.js";
import type { RpcCaller } from "./receipts.js";

export type CancellationRequest={requestId:string;asset:string;amount:string};
const lower=(v:unknown)=>String(v??"").toLowerCase(),bytes=(v:unknown)=>Array.isArray(v)?"0x"+Buffer.from(v).toString("hex"):lower(v);
const CUSTODY_FIELDS=[{name:"requestId",type:"bytes32"},{name:"policyHash",type:"bytes32"},{name:"token",type:"address"},
  {name:"beneficiary",type:"address"},{name:"amount",type:"uint256"},{name:"action",type:"uint8"},{name:"authorityKind",type:"uint8"}];
export function verifyCancellationPreview(preview:any,expected:CancellationRequest,wallet:AgentWallet):void{
  const pin=PUBLIC_ASSETS.find(a=>a.asset===expected.asset),w=preview?.withdrawal,t=preview?.custody_typed_data;
  requirePublic(pin&&/^0x[0-9a-f]{64}$/i.test(expected.requestId)&&/^\d+$/.test(expected.amount)&&BigInt(expected.amount)>0n,"cancellation identity/amount invalid");
  requirePublic(preview.request_id===expected.requestId&&preview.authority==="User"&&preview.user_custody_signature_required===true
    &&preview.attestor_required===false&&lower(preview.expected_user_signer)===wallet.address.toLowerCase()
    &&w?.request_id===expected.requestId&&w.asset===expected.asset&&w.amount===expected.amount&&w.to===wallet.userId
    &&w.policy_hash===pin.policy&&w.source?.kind==="user"&&w.source.user===wallet.userId&&["Pending","CancelRequested"].includes(w.status),"cancellation withdrawal scope differs");
  requirePublic(t?.primaryType==="CustodyWithdrawal"&&t.domain?.name==="Collider V2 Custody"&&t.domain.version==="1"&&String(t.domain.chainId)==="43113"
    &&lower(t.domain.verifyingContract)===P.custody&&t.domain.salt===P.route
    &&JSON.stringify(t.types?.CustodyWithdrawal)===JSON.stringify(CUSTODY_FIELDS),"cancellation custody schema/domain differs");
  const message=t.message;
  requirePublic(message.requestId===expected.requestId&&message.policyHash===pin.policy&&lower(message.token)===pin.token
    &&lower(message.beneficiary)===wallet.address.toLowerCase()&&String(message.amount)===expected.amount&&String(message.action)==="2"&&String(message.authorityKind)==="1",
    "cancellation economic fields/action differ");
  requirePublic(lower(TypedDataEncoder.hash(t.domain,{CustodyWithdrawal:CUSTODY_FIELDS},message))===lower(preview.custody_digest),"cancellation custody digest differs");
}
export function verifyPreparedCancellation(prepared:PreparedSignedIntent,context:Rc1AuthContext,expected:CancellationRequest,wallet:AgentWallet,custodySignature:string):void{
  assertPublicAuth(context,wallet.userId);verifyNativePreparedEnvelope(prepared,context);verifyPublicPayload(prepared);
  const detail=JSON.parse(prepared.details)?.CancelWithdrawal,m=(prepared.typed_data as any)?.message;
  requirePublic(prepared.signer===wallet.userId&&prepared.action==="bridge.withdraw.cancel"&&prepared.nonce===context.user?.next_available_nonce
    &&Number.isSafeInteger(prepared.valid_until_height)&&prepared.valid_until_height>prepared.issued_at_height&&prepared.valid_until_height<=prepared.issued_at_height+512,
    "cancellation native authorization differs");
  requirePublic(detail&&bytes(detail.actor)===wallet.userId&&bytes(detail.request_id)===expected.requestId&&bytes(detail.custody_signature)===lower(custodySignature)
    &&m.target===expected.requestId&&String(m.amountBaseUnits)==="0"&&m.asset==="0x"+"00".repeat(32),"cancellation native operation/presentation differs");
}
export async function publicCancellation(params:{settings:AgentSettings;dataDir:string;wallet:AgentWallet;expected:CancellationRequest;
  broadcast?:boolean;resume?:boolean;dependencies?:{native?:RpcCaller;evm?:RpcCaller;sleep?:(ms:number)=>Promise<void>}}):Promise<any>{
  const {settings,wallet,expected}=params;assertPublicSettings(settings);requirePublic(settings.expectedEvmAddress?.toLowerCase()===wallet.address.toLowerCase(),"cancellation owner differs");
  const native=params.dependencies?.native??new JsonRpcClient(P.rpc),evm=params.dependencies?.evm??new JsonRpcClient(P.evmRpc),
    sleep=params.dependencies?.sleep??(ms=>new Promise(r=>setTimeout(r,ms))),file=path.join(params.dataDir,"public-cancellation-state.json");
  let state:any;try{state=JSON.parse(await readFile(file,"utf8"));assertPublicScope(state.scope);requirePublic(state.wallet===wallet.userId,"cancellation journal owner differs");}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;state={schema:"agent1.public-cancellation.v1",scope:FAUCET_SCOPE,wallet:wallet.userId,pending:null,lastResult:null};}
  if(params.resume&&!state.pending)return state.lastResult??{status:"no_pending_cancellation"};
  if(state.pending)requirePublic(JSON.stringify(state.pending.expected)===JSON.stringify(expected),"another cancellation needs original reconciliation");
  else{
    if(state.lastResult?.requestId===expected.requestId)return state.lastResult;
    const context=await native.call<Rc1AuthContext>("colliderV2.getAuthContext",[wallet.userId]);assertPublicAuth(context,wallet.userId);
    const preview=await native.call<any>("colliderV2.prepareBridgeCancellation",[expected.requestId]);verifyCancellationPreview(preview,expected,wallet);
    requirePublic(preview.withdrawal.status==="Pending","cancellation already requested; observe original request");
    const abi=new Interface(["function custodyAuthorizationDigest(bytes32,bytes32,address,address,uint256,uint8,uint8) view returns (bytes32)"]);
    requirePublic(BigInt(await evm.call<string>("eth_chainId",[]))===43113n,"cancellation source chain differs");
    const raw=await evm.call<string>("eth_call",[{to:P.custody,data:abi.encodeFunctionData("custodyAuthorizationDigest",[expected.requestId,preview.withdrawal.policy_hash,
      PUBLIC_ASSETS.find(a=>a.asset===expected.asset)!.token,wallet.address,expected.amount,2,1])},"latest"]);
    requirePublic(lower(abi.decodeFunctionResult("custodyAuthorizationDigest",raw)[0])===lower(preview.custody_digest),"Solidity cancellation digest differs");
    if(!params.broadcast)return {status:"verified_cancellation_preview",...expected,custodyDigest:preview.custody_digest,financialSignatures:0};
    for(const name of ["rc1-intent-state.json","rc1-points-conversion-state.json","rc1-withdrawal-state.json"]){
      try{const row=JSON.parse(await readFile(path.join(params.dataDir,name),"utf8"));requirePublic(!row.pending,"another signed operation blocks cancellation");}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
    const custodySignature=wallet.signDigest(preview.custody_digest);
    const prepared=await native.call<PreparedSignedIntent>("colliderV2.prepareSignedIntent",[{signer:wallet.userId,method:"colliderV2.cancelWithdrawal",params:[wallet.userId,expected.requestId,custodySignature],ttl_blocks:32}]);
    verifyPreparedCancellation(prepared,context,expected,wallet,custodySignature);
    const signature=await wallet.signPreparedIntent(prepared);
    state.pending={expected,prepared,signature,attempted:false};await publicAtomicJson(file,state);
    state.pending.attempted=true;await publicAtomicJson(file,state);
    try{await native.call("colliderV2.submitSignedIntent",[{signer:prepared.signer,nonce:prepared.nonce,issued_at_height:prepared.issued_at_height,
      valid_until_height:prepared.valid_until_height,op_b64:prepared.op_b64,signature}],{retries:0});}catch{/* Never retry or resign; canonical reconciliation below. */}
  }
  const pending=state.pending;
  for(let poll=0;poll<20;poll++){
    const auth=await native.call<Rc1AuthContext>("colliderV2.getAuthContext",[wallet.userId]);assertPublicAuth(auth,wallet.userId);
    let authenticated=false,cancelled=false;
    for(let height=pending.prepared.issued_at_height+1;height<=Math.min(auth.last_accepted_height,pending.prepared.valid_until_height+1);height++){
      const events=await native.call<any[]>("colliderV2.getBlockEventsAt",[height]);
      authenticated=authenticated||events.some(e=>e.SignedIntentAuthenticated?.signer===wallet.userId&&e.SignedIntentAuthenticated.nonce===pending.prepared.nonce
        &&e.SignedIntentAuthenticated.action==="bridge.withdraw.cancel"&&e.SignedIntentAuthenticated.payload_hash===pending.prepared.payload_hash);
      cancelled=cancelled||events.some(e=>e.BridgeWithdrawalCancelRequested?.request_id===expected.requestId&&e.BridgeWithdrawalCancelRequested.actor===wallet.userId);
    }
    if(authenticated&&cancelled){state.lastResult={status:"cancel_requested",...expected,nonce:pending.prepared.nonce,
      note:"Not terminal restoration. Keep tracking withdrawal source cancellation and native Restored evidence."};state.pending=null;await publicAtomicJson(file,state);return state.lastResult;}
    if(params.resume||poll===19)break;await sleep(5000);
  }
  await publicAtomicJson(file,state);return {status:"pending_cancellation_reconciliation",...expected,nonce:pending.prepared.nonce};
}
