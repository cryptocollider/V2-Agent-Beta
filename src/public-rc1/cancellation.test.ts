import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Interface, TypedDataEncoder } from "ethers";
import { NATIVE_DOMAIN_FIELDS, NATIVE_INTENT_FIELDS } from "../collider/native-signing.js";
import type { PreparedSignedIntent } from "../collider/types.js";
import { PUBLIC_RC1 as P } from "./contract.js";
import { fundingFixture, authFixture } from "./fixtures.test-support.js";
import { publicCancellation, verifyCancellationPreview, verifyPreparedCancellation } from "./cancellation.js";

test("public cancellation verifies uint256 Solidity digest, signs once and reconciles without any faucet/readiness dependency",async t=>{
  const f=await fundingFixture(t),expected={requestId:"0x"+"44".repeat(32),asset:P.clc,amount:"1000000000000000000"};
  const fields=[{name:"requestId",type:"bytes32"},{name:"policyHash",type:"bytes32"},{name:"token",type:"address"},{name:"beneficiary",type:"address"},
    {name:"amount",type:"uint256"},{name:"action",type:"uint8"},{name:"authorityKind",type:"uint8"}];
  const domain={name:"Collider V2 Custody",version:"1",chainId:43113,verifyingContract:P.custody,salt:P.route};
  const message={requestId:expected.requestId,policyHash:P.policy,token:P.token,beneficiary:f.wallet.address,amount:expected.amount,action:2,authorityKind:1};
  const digest=TypedDataEncoder.hash(domain,{CustodyWithdrawal:fields},message);
  const preview={request_id:expected.requestId,authority:"User",user_custody_signature_required:true,attestor_required:false,expected_user_signer:f.wallet.address,
    custody_digest:digest,custody_typed_data:{domain,types:{CustodyWithdrawal:fields},primaryType:"CustodyWithdrawal",message},
    withdrawal:{request_id:expected.requestId,asset:P.clc,amount:expected.amount,to:f.wallet.userId,policy_hash:P.policy,source:{kind:"user",user:f.wallet.userId},status:"Pending"}};
  verifyCancellationPreview(preview,expected,f.wallet);
  for(const changed of [{...preview,custody_digest:"0x"+"00".repeat(32)},{...preview,expected_user_signer:P.dispenser},
    {...preview,custody_typed_data:{...preview.custody_typed_data,message:{...message,action:1}}}])assert.throws(()=>verifyCancellationPreview(changed,expected,f.wallet));
  let submitted=0,prepared:PreparedSignedIntent|null=null;
  const context=()=>({...authFixture(f.wallet.userId,7),last_accepted_height:submitted?101:100,
    user:{user_id:f.wallet.userId,canonical_wallet_user:true,accepted_next_nonce:submitted?6:5,next_available_nonce:submitted?6:5}});
  const native={async call<T>(method:string,params:unknown[]=[]):Promise<T>{
    if(method==="colliderV2.getAuthContext")return context() as T;
    if(method==="colliderV2.prepareBridgeCancellation")return preview as T;
    if(method==="colliderV2.prepareSignedIntent"){
      const request=params[0] as any,custodySignature=request.params[2];assert.equal(request.method,"colliderV2.cancelWithdrawal");
      const details=JSON.stringify({CancelWithdrawal:{actor:[...Buffer.from(f.wallet.userId.slice(2),"hex")],request_id:[...Buffer.from(expected.requestId.slice(2),"hex")],custody_signature:[...Buffer.from(custodySignature.slice(2),"hex")]}});
      const op=Buffer.from("offline fixture operation"),payload="0x"+createHash("sha256").update("ColliderV2/IntentPayload/V1").update(op).digest("hex");
      const nativeDomain={name:"Collider V2",version:"2",chainId:43113,salt:P.domain};
      const m={signer:f.wallet.userId,action:"bridge.withdraw.cancel",description:"Cancel withdrawal",amount:"0",asset:"0x"+"00".repeat(32),amountBaseUnits:"0",token:"0x"+"00".repeat(20),
        target:expected.requestId,recipient:"0x"+"00".repeat(20),details,signingEpoch:7,nonce:5,issuedAtHeight:100,validUntilHeight:132,payloadHash:payload,networkDomain:P.domain};
      prepared={native_intent_signing:{evm_chain_id:43113,epoch:7},signer:f.wallet.userId,action:"bridge.withdraw.cancel",nonce:5,issued_at_height:100,valid_until_height:132,
        details,payload_hash:payload,network_domain:P.domain,op_b64:op.toString("base64"),digest:TypedDataEncoder.hash(nativeDomain,{ColliderIntent:NATIVE_INTENT_FIELDS},m),
        typed_data:{primaryType:"ColliderIntent",domain:nativeDomain,types:{EIP712Domain:NATIVE_DOMAIN_FIELDS,ColliderIntent:NATIVE_INTENT_FIELDS},message:m}};
      verifyPreparedCancellation(prepared,context(),expected,f.wallet,custodySignature);return prepared as T;
    }
    if(method==="colliderV2.submitSignedIntent"){submitted++;return {op_id:"fixture"} as T;}
    if(method==="colliderV2.getBlockEventsAt")return [{SignedIntentAuthenticated:{signer:f.wallet.userId,nonce:5,action:"bridge.withdraw.cancel",payload_hash:prepared!.payload_hash}},
      {BridgeWithdrawalCancelRequested:{request_id:expected.requestId,actor:f.wallet.userId}}] as T;
    throw Error("unexpected cancellation method "+method);
  }};
  const abi=new Interface(["function custodyAuthorizationDigest(bytes32,bytes32,address,address,uint256,uint8,uint8) view returns (bytes32)"]);
  const evm={async call<T>(method:string,params:unknown[]=[]):Promise<T>{if(method==="eth_chainId")return "0xa869" as T;
    assert.equal(method,"eth_call");const request=params[0] as any;const args=abi.decodeFunctionData("custodyAuthorizationDigest",request.data);
    assert.equal(args[4],BigInt(expected.amount));assert.equal(args[5],2n);return abi.encodeFunctionResult("custodyAuthorizationDigest",[digest]) as T;}};
  const dependencies={native,evm,sleep:async()=>{}};
  const dry=await publicCancellation({settings:f.settings,dataDir:f.dir,wallet:f.wallet,expected,dependencies});assert.equal(dry.financialSignatures,0);assert.equal(submitted,0);
  const result=await publicCancellation({settings:f.settings,dataDir:f.dir,wallet:f.wallet,expected,dependencies,broadcast:true});assert.equal(result.status,"cancel_requested");assert.equal(submitted,1);
  const resumed=await publicCancellation({settings:f.settings,dataDir:f.dir,wallet:f.wallet,expected,dependencies,resume:true});assert.equal(resumed.status,"cancel_requested");assert.equal(submitted,1);
  assert.equal(f.state.claimWrites,0);assert.equal(f.state.sourceWrites.length,0);
});
