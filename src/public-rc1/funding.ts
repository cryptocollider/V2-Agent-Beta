import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256 } from "ethers";
import type { AgentWallet } from "../collider/wallet.js";
import type { AgentSettings } from "../core/settings.js";
import type { Rc1AuthContext } from "../collider/types.js";
import { JsonRpcClient } from "../core/rpc.js";
import { CUSTODY, ERC20, readBool, readUint, type StoredEvmTransaction, type FujiTestnetFundingResult } from "../core/fuji-testnet-funding.js";
import { PUBLIC_RC1, GRANT_POLICY, FAUCET_SCOPE, POLICY_SHA256, assertPublicAuth, assertPublicReadiness, assertPublicScope, requirePublic } from "./contract.js";
import { assertPublicSettings } from "./profile.js";
import { AwaitingFaucetSetupError, publicJson } from "./http.js";
import { finalizedReceipt, signPublicOperation, verifyDepositEvent, verifyGrantLeg, verifyPublicStored, type RpcCaller } from "./receipts.js";

const SCHEMA="collider.agent1.public-funding.v1";
type Journal={schema:typeof SCHEMA;scope:typeof FAUCET_SCOPE;wallet:string;stage:string;createdAt:string;updatedAt:string;
  baselineCumulative:string;baselineCredit:string;expectedCumulative:string;expectedCredit:string;
  challenge?:{nonce:string;expiresAt:number;messageHash:string};claimAttemptedAt?:string;claim?:any;
  approval?:StoredEvmTransaction;deposit?:StoredEvmTransaction;depositReceipt?:{hash:string;blockHash:string};error?:string};
export type PublicFundingDependencies={fetchFn?:typeof fetch;evmRpc?:RpcCaller;colliderRpc?:RpcCaller;sleep?:(ms:number)=>Promise<void>;now?:()=>Date;checkpoint?:(stage:string)=>Promise<void>};
export async function publicAtomicJson(file:string,value:unknown):Promise<void>{
  await mkdir(path.dirname(file),{recursive:true});const temporary=file+".tmp-"+process.pid+"-"+Date.now()+"-"+Math.random().toString(16).slice(2);
  const handle=await open(temporary,"wx",0o600);try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}await rename(temporary,file);
}
async function load(file:string):Promise<any|null>{try{return JSON.parse(await readFile(file,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw Error("public_rc1_hold: financial journal unreadable; never reset it");}}
export function assertFaucetHealth(health:any,now=Date.now()):void{
  assertPublicScope(health);
  requirePublic(health.ready===true&&health.network==="fuji"&&health.faucet==="test-only"&&health.amount===PUBLIC_RC1.grant&&health.gas_wei===PUBLIC_RC1.gasGrant
    &&Number.isSafeInteger(health.claim_count)&&health.claim_count>=0&&health.claim_count<20&&health.readiness_expires_at_ms>now,"faucet held/exhausted/not scoped ready");
  requirePublic(health.grant_policy&&Object.keys(health.grant_policy).length===Object.keys(GRANT_POLICY).length
    &&Object.entries(GRANT_POLICY).every(([k,v])=>health.grant_policy[k]===v),"sealed grant policy/caps changed");
  requirePublic(/^\d+$/.test(health.inventory_token_base)&&BigInt(health.inventory_token_base)>=BigInt(PUBLIC_RC1.grant)
    &&/^\d+$/.test(health.inventory_gas_wei)&&BigInt(health.inventory_gas_wei)>=57000000000000000n,"faucet token/gas inventory insufficient");
}
export function assertChallenge(challenge:any,wallet:string,now=Date.now()):void{
  const address=wallet.toLowerCase(),nonce=challenge?.nonce,expiry=challenge?.expires_at;
  requirePublic(challenge?.address===address&&typeof nonce==="string"&&/^[0-9a-f]{32}$/.test(nonce)
    &&Number.isSafeInteger(expiry)&&expiry*1000>now&&expiry*1000<=now+600000,"challenge recipient/nonce/expiry mismatch");
  const issued=expiry-600;
  const message=["Collider Fuji RC1 test-token faucet","Network: Fuji C-Chain 43113","Collider chain: "+PUBLIC_RC1.chain,
    "Wallet: "+address,"Nonce: "+nonce,"Issued: "+issued,"Expires: "+expiry,"Deployment: "+PUBLIC_RC1.deployment,
    "Network domain: "+PUBLIC_RC1.domain,"Route: "+PUBLIC_RC1.route,"Custody: "+PUBLIC_RC1.custody,"Asset: "+PUBLIC_RC1.clc,
    "Token: "+PUBLIC_RC1.token,"Grant policy: "+POLICY_SHA256,"CLC base units: "+PUBLIC_RC1.grant,"AVAX gas wei: "+PUBLIC_RC1.gasGrant,
    "One test-only claim; no transfer or custody approval is authorized."].join("\n");
  requirePublic(issued*1000<=now+5000&&challenge.message===message,"challenge domain/purpose/message differs");
}
function assertClaim(claim:any,wallet:string):void{
  assertPublicScope(claim);requirePublic(claim.address===wallet.toLowerCase()&&claim.amount===PUBLIC_RC1.grant&&claim.gas_wei===PUBLIC_RC1.gasGrant
    &&["QUEUED","TOKEN_SIGNED_UNCERTAIN","TOKEN_FINAL","GAS_SIGNED_UNCERTAIN","GAS_FINAL","COMPLETE"].includes(claim.stage),"claim wallet/grant/stage mismatch");
}
async function assertOperatorProof(file:string|null):Promise<void>{
  if(!file)throw new AwaitingFaucetSetupError("owner-reviewed funded HTTPS faucet proof required");
  const proof=await load(file);requirePublic(proof?.schema==="collider.agent1.public-faucet-operator-proof.v1"&&proof.operatorApproved===true
    &&proof.endpointVerified===true&&proof.inventoryVerified===true&&proof.endpoint===PUBLIC_RC1.faucet,"operator faucet proof missing/unapproved");
  assertPublicScope(proof.scope);
}
export async function ensurePublicFunding(params:{settings:AgentSettings;dataDir:string;wallet:AgentWallet;
  acceptScopedFaucet?:boolean;
  onProgress?:(value:{stage:string;detail:string|null;updatedAt:string;error:string|null;depositTx:string|null})=>unknown;dependencies?:PublicFundingDependencies}):Promise<FujiTestnetFundingResult>{
  const {settings,wallet,dataDir}=params;assertPublicSettings(settings);
  requirePublic(settings.testnetAutoFunding?.enabled,"public funding requires explicit opt-in");
  requirePublic(settings.expectedEvmAddress?.toLowerCase()===wallet.address.toLowerCase(),"approved signer differs");
  const d=params.dependencies??{},now=d.now??(()=>new Date()),sleep=d.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
  const evm=d.evmRpc??new JsonRpcClient(PUBLIC_RC1.evmRpc),native=d.colliderRpc??new JsonRpcClient(PUBLIC_RC1.rpc);
  const http=<T>(url:string,init:RequestInit={},notFound=false)=>publicJson<T>(url,init,{fetchFn:d.fetchFn,sleep,notFound});
  await mkdir(dataDir,{recursive:true});const file=path.join(dataDir,"public-testnet-funding-state.json"),lockFile=file+".lock";
  let lock;try{lock=await open(lockFile,"wx",0o600);await lock.writeFile(String(process.pid));}catch{throw Error("public_rc1_hold: funding lease held; reconcile without clearing it");}
  let journal:Journal|null=null;
  const persist=async(stage:string)=>{if(journal){journal.stage=stage;journal.updatedAt=now().toISOString();await publicAtomicJson(file,journal);}
    await params.onProgress?.({stage,detail:stage==="AWAITING_FAUCET_SETUP"?"awaiting_faucet_setup":null,updatedAt:now().toISOString(),error:journal?.error??null,depositTx:journal?.deposit?.txHash??null});await d.checkpoint?.(stage);};
  const balance=async()=>{const values=await native.call<Record<string,string>>("colliderV2.getBalances",[wallet.userId]);return String(values[PUBLIC_RC1.clc]??values[PUBLIC_RC1.clc.slice(2)]??"0");};
  const credit=async()=>String((await native.call<any>("colliderV2.getBridgeDepositCredit",[PUBLIC_RC1.clc,wallet.userId])).credited_cumulative_amount);
  const readiness=async()=>assertPublicReadiness(await http(PUBLIC_RC1.readiness),now().getTime());
  try{
    journal=await load(file) as Journal|null;
    if(journal){requirePublic(journal.schema===SCHEMA&&journal.wallet===wallet.address.toLowerCase(),"journal schema/wallet mismatch");assertPublicScope(journal.scope);}
    for(const name of ["rc1-intent-state.json","rc1-points-conversion-state.json","rc1-withdrawal-state.json","public-cancellation-state.json"]){const other=await load(path.join(dataDir,name));requirePublic(!other?.pending,"pending native operation blocks new funding");}
    assertPublicAuth(await native.call<Rc1AuthContext>("colliderV2.getAuthContext",[wallet.userId]),wallet.userId);
    requirePublic(BigInt(await evm.call<string>("eth_chainId",[]))===43113n,"Fuji source chain mismatch");
    const currentBalance=await balance(),currentCredit=await credit();
    requirePublic(/^\d+$/.test(currentBalance)&&/^\d+$/.test(currentCredit),"invalid native accounting integers");
    if(!journal&&BigInt(currentBalance)>0n){
      requirePublic(BigInt(await evm.call<string>("eth_getBalance",[wallet.address,"latest"]))>=BigInt(settings.publicRc1!.gasReserveWei),"existing native CLC funded but exit gas below reserve");
      return {status:"ALREADY_FUNDED",asset:PUBLIC_RC1.clc,amount:PUBLIC_RC1.grant,wallet:wallet.address,depositTx:null,colliderCredit:currentCredit,colliderBalance:currentBalance};
    }
    const cumulative=await readUint(evm,PUBLIC_RC1.custody,CUSTODY,"cumulativeDeposits",[PUBLIC_RC1.clc,wallet.address]);
    if(!journal)requirePublic(cumulative===BigInt(currentCredit),"preexisting source deposit credit not reconciled; no new deposit");
    if(!journal){journal={schema:SCHEMA,scope:FAUCET_SCOPE,wallet:wallet.address.toLowerCase(),stage:"CHECKING",createdAt:now().toISOString(),updatedAt:now().toISOString(),
      baselineCumulative:cumulative.toString(),baselineCredit:currentCredit,expectedCumulative:(cumulative+BigInt(PUBLIC_RC1.grant)).toString(),expectedCredit:(BigInt(currentCredit)+BigInt(PUBLIC_RC1.grant)).toString()};await persist("CHECKING");}
    requirePublic(BigInt(journal.expectedCumulative)===BigInt(journal.baselineCumulative)+BigInt(PUBLIC_RC1.grant)
      &&BigInt(journal.expectedCredit)===BigInt(journal.baselineCredit)+BigInt(PUBLIC_RC1.grant),"journal grant target changed");
    if(journal.stage!=="COMPLETE"){
      // Status always precedes health/admission. Recovery remains possible when NEW admission is held.
      let claim:any;
      try{claim=await http<any>(PUBLIC_RC1.faucet+"/v1/claims/"+wallet.address.toLowerCase(),{},true);}
      catch{if(journal.claim?.stage==="COMPLETE")claim=journal.claim;else throw new AwaitingFaucetSetupError("claim status unavailable; preserve the original wallet/journal");}
      if(!claim){
        requirePublic(!journal.claimAttemptedAt&&!journal.challenge&&!journal.claim,"claim admission uncertain; poll original wallet, never replace challenge");
        if(!params.acceptScopedFaucet)await assertOperatorProof(settings.publicRc1!.faucetOperatorProofFile);
        let health:any;try{health=await http(PUBLIC_RC1.faucet+"/healthz");}catch{throw new AwaitingFaucetSetupError("HTTPS dispenser not healthy/exposed");}
        assertFaucetHealth(health,now().getTime());await readiness();
        const challenge=await http<any>(PUBLIC_RC1.faucet+"/v1/challenge?address="+encodeURIComponent(wallet.address.toLowerCase()));assertChallenge(challenge,wallet.address,now().getTime());
        journal.challenge={nonce:challenge.nonce,expiresAt:challenge.expires_at,messageHash:createHash("sha256").update(challenge.message).digest("hex")};await persist("CHALLENGE_JOURNALED");
        const signature=await wallet.signPersonalMessage(challenge.message);journal.claimAttemptedAt=now().toISOString();await persist("CLAIM_ATTEMPTED");
        try{claim=await http(PUBLIC_RC1.faucet+"/v1/claim",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({address:wallet.address.toLowerCase(),nonce:challenge.nonce,signature})});}
        catch{claim=await http(PUBLIC_RC1.faucet+"/v1/claims/"+wallet.address.toLowerCase(),{},true);requirePublic(claim,"claim response uncertain; only poll original wallet");}
      }
      for(let polls=0;;polls++){
        assertClaim(claim,wallet.address);journal.claim=claim;await persist("CLAIM_PENDING");if(claim.stage==="COMPLETE")break;
        requirePublic(polls<Math.ceil(settings.testnetAutoFunding!.claimTimeoutMs/5000),"original claim remains pending; no write retry");
        await sleep(Math.max(5000,settings.testnetAutoFunding!.claimPollMs));claim=await http(PUBLIC_RC1.faucet+"/v1/claims/"+wallet.address.toLowerCase());
      }
      await verifyGrantLeg(evm,claim,wallet.address,"token");await verifyGrantLeg(evm,claim,wallet.address,"gas");await persist("CLAIM_COMPLETE");
    }
    const checkCode=async()=>{
      const code=await evm.call<string>("eth_getCode",[PUBLIC_RC1.custody,"latest"]);
      requirePublic(/^0x(?:[0-9a-f]{2})+$/i.test(code)&&createHash("sha256").update(Buffer.from(code.slice(2),"hex")).digest("hex")===PUBLIC_RC1.custodyCodeSha256,"custody runtime code differs");
      const tokenCode=await evm.call<string>("eth_getCode",[PUBLIC_RC1.token,"latest"]);
      requirePublic(keccak256(tokenCode)==="0xc067166e2d616ff703add0a643b19fa50f4c3f54e206589447dd69a787a6c140","CLC contract code differs");
    };
    const runOperation=async(kind:"approval"|"deposit",to:string,data:string)=>{
      let stored=journal![kind];
      if(!stored){await readiness();stored=await signPublicOperation(kind,wallet,evm,to,data,settings.publicRc1!.gasReserveWei,now);journal![kind]=stored;await persist(kind.toUpperCase()+"_SIGNED");}
      verifyPublicStored(stored,wallet.address,to,data);
      // A prior attempt or retained receipt is evidence to READ, never permission to resend.
      if(!stored.broadcastAttemptedAt){await readiness();await checkCode();stored.broadcastAttemptedAt=now().toISOString();stored.broadcastAttempts=1;await persist(kind.toUpperCase()+"_ATTEMPTED");
        try{const hash=await evm.call<string>("eth_sendRawTransaction",[stored.rawTransaction],{retries:0});requirePublic(hash.toLowerCase()===stored.txHash.toLowerCase(),"source RPC hash differs");}
        catch{stored.broadcastError="source write response uncertain; reconcile original hash";}await persist(kind.toUpperCase()+"_RECONCILE");}
      for(let polls=0;polls<60;polls++){
        const receipt=await finalizedReceipt(evm,stored.txHash,wallet.address,to);
        if(receipt){stored.receipt={status:1,blockNumber:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,confirmedAt:now().toISOString()};await persist(kind.toUpperCase()+"_CONFIRMED");return receipt;}
        await sleep(5000);
      }throw Error("public_rc1_hold: original source transaction uncertain; no rebroadcast or replacement");
    };
    if(journal.approval?.broadcastAttemptedAt&&!journal.deposit)await runOperation("approval",PUBLIC_RC1.token,ERC20.encodeFunctionData("approve",[PUBLIC_RC1.custody,PUBLIC_RC1.grant]));
    if(!journal.deposit){
      await readiness();
      const code=await evm.call<string>("eth_getCode",[PUBLIC_RC1.custody,"latest"]);
      requirePublic(/^0x(?:[0-9a-f]{2})+$/i.test(code)&&createHash("sha256").update(Buffer.from(code.slice(2),"hex")).digest("hex")===PUBLIC_RC1.custodyCodeSha256,"custody runtime code differs");
      const tokenCode=await evm.call<string>("eth_getCode",[PUBLIC_RC1.token,"latest"]);
      requirePublic(keccak256(tokenCode)==="0xc067166e2d616ff703add0a643b19fa50f4c3f54e206589447dd69a787a6c140","CLC contract code differs");
      requirePublic(await readBool(evm,PUBLIC_RC1.custody,CUSTODY,"depositsEnabled",[PUBLIC_RC1.clc]),"CLC deposits disabled");
      requirePublic(await readUint(evm,PUBLIC_RC1.token,ERC20,"balanceOf",[wallet.address])>=BigInt(PUBLIC_RC1.grant),"final grant token balance missing");
      const allowance=await readUint(evm,PUBLIC_RC1.token,ERC20,"allowance",[wallet.address,PUBLIC_RC1.custody]);
      requirePublic(allowance===0n||allowance===BigInt(PUBLIC_RC1.grant),"unexpected existing allowance; no replacement approval");
      if(journal.approval||allowance===0n)await runOperation("approval",PUBLIC_RC1.token,ERC20.encodeFunctionData("approve",[PUBLIC_RC1.custody,PUBLIC_RC1.grant]));
      requirePublic(await readUint(evm,PUBLIC_RC1.token,ERC20,"allowance",[wallet.address,PUBLIC_RC1.custody])===BigInt(PUBLIC_RC1.grant),"exact approval unavailable");
    }
    const depositReceipt=await runOperation("deposit",PUBLIC_RC1.custody,CUSTODY.encodeFunctionData("depositTo",[PUBLIC_RC1.clc,PUBLIC_RC1.grant,wallet.address]));
    verifyDepositEvent(depositReceipt,wallet.address,journal.expectedCumulative);journal.depositReceipt={hash:journal.deposit!.txHash,blockHash:depositReceipt.blockHash};
    requirePublic((await readUint(evm,PUBLIC_RC1.custody,CUSTODY,"cumulativeDeposits",[PUBLIC_RC1.clc,wallet.address])).toString()===journal.expectedCumulative,"source cumulative deposit delta differs");
    for(let polls=0;;polls++){
      const credited=await credit(),current=await balance();
      if(credited===journal.expectedCredit){await persist("COMPLETE");return {status:"FUNDED",asset:PUBLIC_RC1.clc,amount:PUBLIC_RC1.grant,wallet:wallet.address,
        depositTx:journal.deposit!.txHash,colliderCredit:credited,colliderBalance:current};}
      requirePublic(BigInt(credited)<=BigInt(journal.expectedCredit)&&polls<Math.ceil(settings.testnetAutoFunding!.creditTimeoutMs/5000),"native credit pending/mismatched; preserve original deposit");
      await persist("COLLIDER_CREDIT_PENDING");await sleep(Math.max(5000,settings.testnetAutoFunding!.creditPollMs));
    }
  }catch(error){if(journal)journal.error=error instanceof AwaitingFaucetSetupError?error.message:"funding held; original signed evidence retained";
    await persist(error instanceof AwaitingFaucetSetupError?"AWAITING_FAUCET_SETUP":"HOLD");throw error;
  }finally{await lock.close();await rm(lockFile);}
}
