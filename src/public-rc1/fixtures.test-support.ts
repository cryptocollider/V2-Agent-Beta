import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Interface, Transaction, Wallet, verifyMessage } from "ethers";
import { AgentWallet } from "../collider/wallet.js";
import { normalizeSettings } from "../core/settings.js";
import { CUSTODY, ERC20 } from "../core/fuji-testnet-funding.js";
import { PUBLIC_RC1 as P, PUBLIC_ASSETS, FAUCET_SCOPE, GRANT_POLICY, POLICY_SHA256 } from "./contract.js";
import { buildPublicSettings } from "./profile.js";
import { EVENTS, type RpcCaller } from "./receipts.js";
import type { PublicFundingDependencies } from "./funding.js";

export function authFixture(user:string,epoch=7):any{return {network_id:5,domain_configured:true,network_domain:P.domain,l1_id:P.l1,chain_id:P.chainHex,
  last_accepted_height:100,native_intent_signing:{evm_chain_id:43113,epoch},eip712:{name:"Collider V2",version:"2",uses_chain_id:true,chain_id:"43113",domain_separator_field:"salt"},
  user:{user_id:user,canonical_wallet_user:true,accepted_next_nonce:0,next_available_nonce:0}};}
export function readinessFixture(now=Date.now()):any{return {ready:true,reasons:[],checkedAtMs:now-1000,expiresAtMs:now+19000,scope:{networkId:5,evmChainId:43113,
  chainIdCb58:P.chain,networkDomain:P.domain,contract:P.custody,routeId:P.route,assets:Object.fromEntries(PUBLIC_ASSETS.map(a=>[a.asset,
    {symbol:a.symbol,token:a.token,policyHash:a.policy,decimals:a.decimals,minDepositAmount:a.minimum,minWithdrawalAmount:a.minimum,depositsEnabled:true}]))}};}
export function challengeFixture(wallet:string,now:number):any{
  const issued=Math.floor(now/1000),expiry=issued+600,nonce="ab".repeat(16),address=wallet.toLowerCase();
  return {address,nonce,expires_at:expiry,message:["Collider Fuji RC1 test-token faucet","Network: Fuji C-Chain 43113","Collider chain: "+P.chain,
    "Wallet: "+address,"Nonce: "+nonce,"Issued: "+issued,"Expires: "+expiry,"Deployment: "+P.deployment,"Network domain: "+P.domain,
    "Route: "+P.route,"Custody: "+P.custody,"Asset: "+P.clc,"Token: "+P.token,"Grant policy: "+POLICY_SHA256,
    "CLC base units: "+P.grant,"AVAX gas wei: "+P.gasGrant,"One test-only claim; no transfer or custody approval is authorized."].join("\n")};
}
export async function fundingFixture(t:{after:(fn:()=>Promise<unknown>)=>unknown}){
  const dir=await mkdtemp(path.join(tmpdir(),"public-rc1-funding-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  // Ephemeral fixture key, never committed or selected by production startup.
  const ephemeral=Wallet.createRandom();const wallet=(await AgentWallet.load({signingKeyEnv:"FIXTURE_ONLY"},{FIXTURE_ONLY:ephemeral.privateKey}))!;
  const owner=normalizeSettings({expectedEvmAddress:wallet.address,signingKeyEnv:"FIXTURE_ONLY",maxThrowsPerGame:22,maxThrowsPerSession:498,minMillisBetweenLiveThrows:30000,
    maxThrowUsd:10,maxSingleThrowUsd:10,maxGameExposureUsd:110,monitorPort:8795});
  const settings=buildPublicSettings(owner,dir,wallet.address);settings.testnetAutoFunding!.enabled=true;
  settings.publicRc1!.faucetOperatorProofFile=path.join(dir,"proof.json");
  await writeFile(settings.publicRc1!.faucetOperatorProofFile,JSON.stringify({schema:"collider.agent1.public-faucet-operator-proof.v1",operatorApproved:true,
    endpointVerified:true,inventoryVerified:true,endpoint:P.faucet,scope:FAUCET_SCOPE}));
  const now=()=>new Date("2026-11-04T12:00:00Z"),tokenHash="0x"+"11".repeat(32),gasHash="0x"+"22".repeat(32),blockHash="0x"+"33".repeat(32);
  const state={claim:false,claimWrites:0,challenges:0,sourceWrites:[] as string[],nonce:0,tokenBalance:0n,allowance:0n,cumulative:0n,
    gasBalance:5000000000000000n,price:1000000000n,creditLag:false,healthUnavailable:false,readinessHeld:false,lostSendResponse:false,
    badTokenEvent:false,badDepositEvent:false,badBlock:false,claimUnavailable:false,claimLostResponse:false,nativeFunded:0n,
    checkpoints:[] as string[],receipts:new Map<string,any>(),calls:[] as string[]};
  const event=(name:string,args:unknown[],address:string)=>({address,...EVENTS.encodeEventLog(EVENTS.getEvent(name)!,args)});
  const receipt=(hash:string,from:string,to:string,logs:any[]=[])=>({transactionHash:hash,from,to,status:"0x1",blockNumber:"0x3e8",blockHash,logs});
  const grant=()=>({...FAUCET_SCOPE,address:wallet.address.toLowerCase(),amount:P.grant,gas_wei:P.gasGrant,stage:"COMPLETE",token_tx_id:tokenHash,gas_tx_id:gasHash});
  const tokenTransfer=new Interface(["function transfer(address recipient,uint256 amount)"]);
  const custodyCode="0x"+(await readFile("assets/public-rc1-20261104/custody-runtime.bin")).toString("hex");
  const tokenCode="0x"+(await readFile("assets/public-rc1-20261104/clc-runtime.hex","utf8")).trim().replace(/^0x/,"");
  const evm:RpcCaller={async call<T>(method:string,params:unknown[]=[],opts?:{retries?:number}):Promise<T>{
    state.calls.push(method);let result:unknown;
    if(method==="eth_chainId")result="0xa869";
    else if(method==="eth_getCode")result=String(params[0]).toLowerCase()===P.custody?custodyCode:tokenCode;
    else if(method==="eth_getBalance")result="0x"+state.gasBalance.toString(16);
    else if(method==="eth_getTransactionCount")result="0x"+state.nonce.toString(16);
    else if(method==="eth_gasPrice")result="0x"+state.price.toString(16);
    else if(method==="eth_estimateGas")result="0x186a0";
    else if(method==="eth_blockNumber")result="0x3ed";
    else if(method==="eth_getBlockByNumber")result={hash:state.badBlock?"0x"+"ff".repeat(32):blockHash};
    else if(method==="eth_getTransactionByHash")result=params[0]===tokenHash?{hash:tokenHash,from:P.dispenser,to:P.token,blockHash,value:"0x0",input:tokenTransfer.encodeFunctionData("transfer",[wallet.address,P.grant])}
      :{hash:gasHash,from:P.dispenser,to:wallet.address,blockHash,value:"0x"+BigInt(P.gasGrant).toString(16),input:"0x"};
    else if(method==="eth_getTransactionReceipt"){
      if(params[0]===tokenHash)result=receipt(tokenHash,P.dispenser,P.token,[event("Transfer",[P.dispenser,wallet.address,state.badTokenEvent?1n:BigInt(P.grant)],P.token)]);
      else if(params[0]===gasHash)result=receipt(gasHash,P.dispenser,wallet.address);
      else result=state.receipts.get(String(params[0]))??null;
    }else if(method==="eth_call"){
      const request=params[0] as {to:string;data:string},selector=request.data.slice(0,10);
      if(selector===ERC20.getFunction("balanceOf")!.selector)result=ERC20.encodeFunctionResult("balanceOf",[state.tokenBalance]);
      else if(selector===ERC20.getFunction("allowance")!.selector)result=ERC20.encodeFunctionResult("allowance",[state.allowance]);
      else if(selector===CUSTODY.getFunction("cumulativeDeposits")!.selector)result=CUSTODY.encodeFunctionResult("cumulativeDeposits",[state.cumulative]);
      else if(selector===CUSTODY.getFunction("depositsEnabled")!.selector)result=CUSTODY.encodeFunctionResult("depositsEnabled",[true]);
      else throw Error("unexpected fixture eth_call");
    }else if(method==="eth_sendRawTransaction"){
      if(opts?.retries!==0)throw Error("fixture forbids automatic source write retry");
      const tx=Transaction.from(String(params[0]));const journal=JSON.parse(await readFile(path.join(dir,"public-testnet-funding-state.json"),"utf8"));
      const kind=tx.to?.toLowerCase()===P.token?"approval":"deposit";
      if(journal[kind].txHash!==tx.hash||!journal[kind].broadcastAttemptedAt||tx.nonce!==state.nonce)throw Error("write-before-journal or nonce mismatch");
      state.sourceWrites.push(tx.hash!);state.nonce++;
      let logs:any[]=[];
      if(kind==="approval"){const decoded=ERC20.decodeFunctionData("approve",tx.data);if(String(decoded[0]).toLowerCase()!==P.custody||String(decoded[1])!==P.grant)throw Error("wrong approval");state.allowance=BigInt(P.grant);}
      else{const decoded=CUSTODY.decodeFunctionData("depositTo",tx.data);if(String(decoded[0])!==P.clc||String(decoded[1])!==P.grant||String(decoded[2]).toLowerCase()!==wallet.address.toLowerCase())throw Error("wrong deposit");
        state.cumulative+=BigInt(P.grant);state.allowance=0n;state.tokenBalance-=BigInt(P.grant);
        logs=[event("DepositAccepted",[P.clc,wallet.address,wallet.address,state.badDepositEvent?1n:BigInt(P.grant),state.cumulative],P.custody)];}
      state.receipts.set(tx.hash!,receipt(tx.hash!,wallet.address,tx.to!,logs));
      if(state.lostSendResponse){state.lostSendResponse=false;throw Error("fixture lost source response after acceptance");}result=tx.hash;
    }else throw Error("unexpected fixture EVM method "+method);
    return result as T;
  }};
  const native:RpcCaller={async call<T>(method:string):Promise<T>{
    if(method==="colliderV2.getAuthContext")return authFixture(wallet.userId) as T;
    if(method==="colliderV2.getBalances")return {[P.clc]:(state.nativeFunded+(state.creditLag?0n:state.cumulative)).toString()} as T;
    if(method==="colliderV2.getBridgeDepositCredit")return {credited_cumulative_amount:(state.creditLag?0n:state.cumulative).toString()} as T;
    throw Error("unexpected fixture native method "+method);
  }};
  const response=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
  const fetchFn:typeof fetch=async(input,init)=>{
    const url=String(input);if(init?.redirect!=="error")throw Error("fixture requires redirect rejection");
    if(url===P.readiness)return response(200,state.readinessHeld?{ready:false}:readinessFixture(now().getTime()));
    if(url.endsWith("/healthz"))return state.healthUnavailable?response(503,{}):response(200,{...FAUCET_SCOPE,ready:true,network:"fuji",faucet:"test-only",amount:P.grant,gas_wei:P.gasGrant,
      grant_policy:GRANT_POLICY,inventory_token_base:"100000000000000000000000",inventory_gas_wei:"250000000000000000",claim_count:0,readiness_expires_at_ms:now().getTime()+20000});
    if(url.includes("/v1/claims/"))return state.claimUnavailable?response(503,{}):state.claim?response(200,grant()):response(404,{});
    if(url.includes("/v1/challenge?")){state.challenges++;return response(200,challengeFixture(wallet.address,now().getTime()));}
    if(url.endsWith("/v1/claim")&&init?.method==="POST"){
      const body=JSON.parse(String(init.body));if(verifyMessage(challengeFixture(wallet.address,now().getTime()).message,body.signature).toLowerCase()!==wallet.address.toLowerCase())throw Error("bad EIP-191 fixture signature");
      state.claim=true;state.claimWrites++;state.tokenBalance=BigInt(P.grant);
      if(state.claimLostResponse){state.claimLostResponse=false;throw Error("fixture lost admission response");}return response(200,grant());
    }throw Error("unexpected fixture HTTP route");
  };
  const dependencies:PublicFundingDependencies={evmRpc:evm,colliderRpc:native,fetchFn,sleep:async()=>{},now};
  return {dir,wallet,settings,state,dependencies,grant};
}
