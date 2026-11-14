import { ColliderClient } from "../collider/client.js";
import type { AgentSettings } from "../core/settings.js";
import { PUBLIC_RC1, assertPublicAuth, assertPublicReadiness, requirePublic } from "./contract.js";
import { assertPublicSettings, inspectOwnerJournals } from "./profile.js";
import { assertFaucetHealth } from "./funding.js";
import { publicJson } from "./http.js";
import { assertGameBinding, verifyPublicArtifact } from "./artifacts.js";

export async function publicPreflight(settings:AgentSettings,dataDir:string=PUBLIC_RC1.dataDir):Promise<Record<string,unknown>> {
  assertPublicSettings(settings);await inspectOwnerJournals(settings.publicRc1!.ownerSourceDir,settings.expectedEvmAddress!,dataDir);
  await verifyPublicArtifact(settings.wasm);
  const client=new ColliderClient(PUBLIC_RC1.rpc),auth=await client.getAuthContext("0x"+settings.user.replace(/^0x/,""));
  const signingChainId=assertPublicAuth(auth,"0x"+settings.user.replace(/^0x/,""));
  const gateway=await publicJson<any>(PUBLIC_RC1.gateway);
  requirePublic(gateway?.chain===PUBLIC_RC1.chain&&gateway.mode==="authenticated_client"&&gateway.gateway_version==="client-v1"
    &&gateway.signing_enabled===true&&gateway.automatic_retries===false,"authenticated gateway capability unavailable");
  for(const method of ["prepareSignedIntent","submitSignedIntent","prepareBridgeUserWithdrawal","prepareBridgeCancellation"])
    requirePublic(gateway.client_methods?.includes("colliderV2."+method),"gateway client capability missing");
  let depositReadiness="held";try{assertPublicReadiness(await publicJson(PUBLIC_RC1.readiness));depositReadiness="ready";}catch{/* Read/withdrawal capability is separate from new deposit readiness. */}
  let faucet="awaiting_faucet_setup";try{assertFaucetHealth(await publicJson(PUBLIC_RC1.faucet+"/healthz"));faucet="healthy_operator_proof_still_required";}catch{/* No claims or wallet generation. */}
  const games=(await client.listGames(3)).slice(0,8),bindings=[];
  for(const game of games){const binding=await client.getGameSimulator(game.game_id);assertGameBinding(binding,game.game_id);bindings.push(binding);}
  const feeds=await client.listOracleFeeds(),clc=(feeds as any[]).find(f=>f.asset===PUBLIC_RC1.clc);
  requirePublic(clc?.usable===true&&["clc_genesis_bootstrap","market"].includes(clc.pricing_mode)&&/^\d+$/.test(clc.current?.price_e8??""),"live CLC price unavailable; no bootstrap fallback");
  return {schema:"agent1.public-rc1.preflight.v1",checkedAt:new Date().toISOString(),rpc:PUBLIC_RC1.rpc,wallet:settings.expectedEvmAddress,
    signingChainId,signingEpoch:(auth.native_intent_signing as any).epoch,nextNonce:auth.user!.accepted_next_nonce,
    balances:await client.getBalances("0x"+settings.user),depositReadiness,faucet,gatewaySigningEnabled:true,
    gatewayPublicReady:gateway.public_ready,artifactSha256:PUBLIC_RC1.wasmSha256,gameBindings:bindings,
    clcPricingMode:clc.pricing_mode,clcPriceE8:clc.current.price_e8,financialSignatures:0,transactionsSubmitted:0,agentStarted:false};
}
