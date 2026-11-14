import { createHash } from "node:crypto";
import { assertNativeSigningContext } from "../collider/native-signing.js";
import type { Rc1AuthContext } from "../collider/types.js";

export const PUBLIC_RC1 = Object.freeze({
  profile:"fuji_rc1_public_20261104" as const, deployment:"public-rc1-clc-dispenser-20261104-v1",
  chain:"YMKxfWMq7yHN77o9oPhvcVMu2TST7sV6y4Z6JLUvfDoSUbq7o",
  domain:"0x33b848fb090b5558d6dd420513f6c8070737faebe58f5408897a2e862d084672",
  l1:"0xbf8b93366d252466f318d8fd088ce0b89e5c2d5455055132e571c43fd3133534",
  chainHex:"0x472f604889ec400446f9d5160e745d1f1d06f1f188b86ac2c1f318ac746e630e",
  origin:"https://v2.cryptocollider.com:8443",
  rpc:"https://v2.cryptocollider.com:8443/ext/bc/YMKxfWMq7yHN77o9oPhvcVMu2TST7sV6y4Z6JLUvfDoSUbq7o/collider_v2",
  gateway:"https://v2.cryptocollider.com:8443/rc1/gateway/status",
  readiness:"https://v2.cryptocollider.com:8443/rc1/readiness/status",
  faucet:"https://v2.cryptocollider.com:8443/rc1/test-faucet",
  evmRpc:"https://api.avax-test.network/ext/bc/C/rpc",
  custody:"0x5939ca86957e7b49bc550c885dca7d7f694929f7",
  custodyCodeSha256:"8630910ee848845a951e27b8cab8e6f55d45958c8a3744ed69d593001f4aa960",
  route:"0xafeab6a5b9e1c169ba1a2627cb1c85a7ff25e4e24253567bc2ac0d8b8501ff26",
  attestor:"0xae4167bfa9bb6097623165dce54fb0d953d209a1",
  dispenser:"0xa745451bf7b3c89bc20bb9057867a0083b73947a",
  clc:"0x3e0e0f0eedd306b23b0f386df33a36fac07cbd9e45a7ad02d1c40adedbee2e16",
  token:"0xaf4b602794c385e9e50b14abe284d93e1a0b971e",
  policy:"0x3244ca6db27e852db0deb7c3bd9c919536e9260b5e95ba06a5aa9c3662b27b43",
  wasmSha256:"bd5dcbe14cfcd98b8bbcdf3c4d7968ca5607b3a2ccb3593fb773ea4cdedbc561", wasmBytes:1208746,
  wasmPath:"./assets/public-rc1-20261104/sim_core-0.2.1.wasm", dataDir:"./data-rc1-public-20261104a",
  grant:"4000000000000000000000", gasGrant:"5000000000000000", exitGasReserve:"1000000000000000",
  maxGasPrice:"5000000000", maxTransactionFee:"1000000000000000",
});
export const PUBLIC_ASSETS = [
  {symbol:"CLC",decimals:18,asset:PUBLIC_RC1.clc,token:PUBLIC_RC1.token,policy:PUBLIC_RC1.policy,minimum:"10000000000000000"},
  {symbol:"USDC",decimals:6,asset:"0x"+"01".repeat(32),token:"0x5425890298aed601595a70ab815c96711a31bc65",policy:"0x852f71c41b6c014d5d77ffb36ebc2f256bdce8126863968f4bbda776a6b8bda8",minimum:"100000"},
  {symbol:"LINK",decimals:18,asset:"0x"+"0b".repeat(32),token:"0x0b9d5d9136855f6fec3c0993fee6e9ce8a297846",policy:"0xed45b48df08ce97d83af7e4eeba9d55984eb607e22f459b6eb05e91ffac10c3d",minimum:"10000000000000000"},
  {symbol:"EURC",decimals:6,asset:"0x"+"0d".repeat(32),token:"0x5e44db7996c682e92a960b65ac713a54ad815c6b",policy:"0x2f3596749a9a1e04c609d5e63472bd357c8907753ed38381670eb78f6b69332c",minimum:"100000"},
  {symbol:"WAVAX",nativeSymbolAlias:"AVAX",decimals:18,asset:"0x"+"05".repeat(32),token:"0xd00ae08403b9bbb9124bb305c09058e32c39a48c",policy:"0x19ffac9d0344bf3541a84bbaa7f7c5165d838fe6ab8a160ae557898802df8a33",minimum:"1000000000000000"},
] as const;
export const GRANT_POLICY = Object.freeze({deployment_id:PUBLIC_RC1.deployment,amount:PUBLIC_RC1.grant,gas_wei:PUBLIC_RC1.gasGrant,
  max_claims_24h:20,max_queued:20,lifetime_token_cap:"80000000000000000000000",lifetime_gas_grants_cap:"100000000000000000",
  minimum_remaining_gas_wei:"50000000000000000",maximum_fee_per_transaction_wei:PUBLIC_RC1.maxTransactionFee,
  maximum_gas_price_wei:PUBLIC_RC1.maxGasPrice,finality_blocks:3,one_claim_per_wallet:true,challenge_lifetime_secs:600});
export const POLICY_SHA256=createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(GRANT_POLICY).sort(([a],[b])=>a<b?-1:a>b?1:0)))).digest("hex");
export const FAUCET_SCOPE=Object.freeze({deployment_id:PUBLIC_RC1.deployment,network_id:5,evm_chain_id:43113,
  collider_chain_id:PUBLIC_RC1.chain,network_domain:PUBLIC_RC1.domain,route_id:PUBLIC_RC1.route,custody_address:PUBLIC_RC1.custody,
  asset:PUBLIC_RC1.clc,token:PUBLIC_RC1.token,policy_hash:PUBLIC_RC1.policy,dispenser:PUBLIC_RC1.dispenser,grant_policy_sha256:POLICY_SHA256});
export function requirePublic(value:unknown,reason:string):asserts value {if(!value)throw Error("public_rc1_hold: "+reason);}
export function assertPublicAuth(auth:Rc1AuthContext,user:string):number {
  requirePublic(auth.network_id===5&&auth.domain_configured===true&&auth.network_domain===PUBLIC_RC1.domain&&auth.l1_id===PUBLIC_RC1.l1
    &&auth.chain_id===PUBLIC_RC1.chainHex&&auth.user?.canonical_wallet_user===true&&auth.user.user_id.toLowerCase()===user.toLowerCase(),"auth route/wallet mismatch");
  return assertNativeSigningContext(auth).evm_chain_id;
}
export function assertPublicScope(value:unknown):void {
  const row=value as Record<string,unknown>;
  requirePublic(row&&Object.entries(FAUCET_SCOPE).every(([key,expected])=>row[key]===expected),"faucet deployment/route/token/policy mismatch");
}
export function verifyPublicPayload(value:unknown):void {
  const prepared=value as {op_b64?:string;payload_hash?:string};
  requirePublic(typeof prepared?.op_b64==="string"&&prepared.op_b64.length<=350000,"native payload bytes missing/oversized");
  const bytes=Buffer.from(prepared.op_b64,"base64");
  requirePublic(bytes.length>0&&bytes.length<=256*1024&&bytes.toString("base64")===prepared.op_b64
    &&"0x"+createHash("sha256").update("ColliderV2/IntentPayload/V1").update(bytes).digest("hex")===prepared.payload_hash,
    "native op_b64/payload hash mismatch");
}
export function assertPublicUrl(url:string,expected:string):void {
  const parsed=new URL(url);requirePublic(parsed.href===expected&&parsed.protocol==="https:"&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash,"unapproved HTTPS origin/path");
}
export function assertPublicReadiness(value:unknown,now=Date.now()):void {
  const r=value as any,s=r?.scope;
  requirePublic(r?.ready===true&&Array.isArray(r.reasons)&&r.reasons.length===0&&Number.isSafeInteger(r.checkedAtMs)&&Number.isSafeInteger(r.expiresAtMs)
    &&r.checkedAtMs<=now+5000&&r.checkedAtMs<=now&&now<r.expiresAtMs&&r.expiresAtMs<=r.checkedAtMs+60000,"new-deposit readiness expired/held");
  requirePublic(s?.networkId===5&&s.evmChainId===43113&&s.chainIdCb58===PUBLIC_RC1.chain&&s.networkDomain===PUBLIC_RC1.domain
    &&s.contract===PUBLIC_RC1.custody&&s.routeId===PUBLIC_RC1.route,"readiness scope mismatch");
  for(const a of PUBLIC_ASSETS){const p=s.assets?.[a.asset];requirePublic(p?.token?.toLowerCase()===a.token&&p.policyHash===a.policy&&p.decimals===a.decimals
    &&p.minDepositAmount===a.minimum&&p.minWithdrawalAmount===a.minimum,"readiness asset/policy mismatch");}
  requirePublic(s.assets[PUBLIC_RC1.clc].depositsEnabled===true,"new CLC deposits disabled");
}
