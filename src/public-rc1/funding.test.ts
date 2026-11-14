import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePublicFunding, assertChallenge, assertFaucetHealth } from "./funding.js";
import { fundingFixture, challengeFixture, readinessFixture } from "./fixtures.test-support.js";
import { FAUCET_SCOPE, GRANT_POLICY, PUBLIC_RC1 as P, assertPublicReadiness, assertPublicScope } from "./contract.js";

test("public funding verifies EIP-191, both finalized grant legs, exact approval/deposit/native credit and restart without a duplicate",async t=>{
  const f=await fundingFixture(t);f.state.lostSendResponse=true;f.state.claimLostResponse=true;
  const result=await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies});
  assert.equal(result.status,"FUNDED");assert.equal(result.colliderCredit,P.grant);assert.equal(f.state.claimWrites,1);assert.equal(f.state.sourceWrites.length,2);
  await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies});
  assert.equal(f.state.claimWrites,1);assert.equal(f.state.sourceWrites.length,2);assert.equal(new Set(f.state.sourceWrites).size,2);
});

for(const stage of ["CHECKING","CLAIM_PENDING","CLAIM_COMPLETE","APPROVAL_SIGNED","APPROVAL_RECONCILE","APPROVAL_CONFIRMED","DEPOSIT_SIGNED","DEPOSIT_RECONCILE","DEPOSIT_CONFIRMED","COMPLETE"]){
  test("public interruption at "+stage+" resumes original claim/source hashes without duplicates",async t=>{
    const f=await fundingFixture(t);let stopped=false;
    f.dependencies.checkpoint=async actual=>{if(actual===stage&&!stopped){stopped=true;throw Error("fixture interruption");}};
    await assert.rejects(ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies}));assert.equal(stopped,true);
    await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies});
    assert.equal(f.state.claimWrites,1);assert.equal(f.state.sourceWrites.length,2);assert.equal(new Set(f.state.sourceWrites).size,2);
  });
}
for(const stage of ["CHALLENGE_JOURNALED","CLAIM_ATTEMPTED","APPROVAL_ATTEMPTED","DEPOSIT_ATTEMPTED"]){
  test("public uncertain pre-send boundary "+stage+" holds instead of replacing/replaying work",async t=>{
    const f=await fundingFixture(t);let stopped=false;
    f.dependencies.checkpoint=async actual=>{if(actual===stage&&!stopped){stopped=true;throw Error("fixture before send");}};
    await assert.rejects(ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies}));
    const before={claims:f.state.claimWrites,sends:f.state.sourceWrites.length,challenges:f.state.challenges};
    await assert.rejects(ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies}));
    assert.deepEqual({claims:f.state.claimWrites,sends:f.state.sourceWrites.length,challenges:f.state.challenges},before);
  });
}
test("credit lag and unavailable NEW admission do not replay a confirmed deposit or prevent its reconciliation",async t=>{
  const f=await fundingFixture(t);f.state.creditLag=true;let stopped=false;
  f.dependencies.checkpoint=async actual=>{if(actual==="COLLIDER_CREDIT_PENDING"&&!stopped){stopped=true;throw Error("fixture relay delay");}};
  await assert.rejects(ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies}));
  f.state.creditLag=false;f.state.healthUnavailable=true;f.state.claimUnavailable=true;f.state.readinessHeld=true;
  const result=await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies});
  assert.equal(result.colliderCredit,P.grant);assert.equal(f.state.sourceWrites.length,2);assert.equal(f.state.claimWrites,1);
});
test("already native-funded wallets reuse funding and gas without claiming, and missing setup never signs/adopts another wallet",async t=>{
  const f=await fundingFixture(t);f.state.nativeFunded=10n;f.state.healthUnavailable=true;
  assert.equal((await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies})).status,"ALREADY_FUNDED");
  assert.equal(f.state.challenges+f.state.claimWrites+f.state.sourceWrites.length,0);
  f.state.nativeFunded=0n;f.settings.publicRc1!.faucetOperatorProofFile=null;
  await assert.rejects(ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies}),/awaiting_faucet_setup/);
  assert.equal(f.state.challenges+f.state.claimWrites+f.state.sourceWrites.length,0);
});
for(const change of ["nativeRoute","token","domain","journalWallet","allowance","gasReserve","gasPrice","grantEvent","depositEvent","finality"]){
  test("public funding fails closed for "+change,async t=>{
    const f=await fundingFixture(t);
    if(change==="nativeRoute")f.settings.rpc="http://127.0.0.1:11550/old";
    if(change==="token")f.settings.bridgeWithdrawal!.assets[P.clc].tokenAddress="0x"+"09".repeat(20);
    if(change==="domain")f.settings.expectedNetworkDomain="0x"+"00".repeat(32);
    if(change==="journalWallet"){await writeFile(path.join(f.dir,"public-testnet-funding-state.json"),JSON.stringify({schema:"collider.agent1.public-funding.v1",wallet:"0x"+"00".repeat(20),scope:FAUCET_SCOPE}));}
    if(change==="allowance")f.state.allowance=1n;
    if(change==="gasReserve")f.state.gasBalance=0n;
    if(change==="gasPrice")f.state.price=6000000000n;
    if(change==="grantEvent")f.state.badTokenEvent=true;
    if(change==="depositEvent")f.state.badDepositEvent=true;
    if(change==="finality")f.state.badBlock=true;
    await assert.rejects(ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,dependencies:f.dependencies}));
    assert.ok(f.state.claimWrites<=1);assert.equal(new Set(f.state.sourceWrites).size,f.state.sourceWrites.length);
    if(change!=="depositEvent")assert.equal(f.state.sourceWrites.length,0);
  });
}
test("scoped challenge validates the exact message, expiry and purpose; no transfer/approval text can be appended",async()=>{
  const wallet="0x"+"12".repeat(20),now=Date.parse("2026-11-04T12:00:00Z"),challenge=challengeFixture(wallet,now);
  assert.doesNotThrow(()=>assertChallenge(challenge,wallet,now));
  for(const changed of [{...challenge,message:challenge.message+"\napprove all tokens"},{...challenge,address:"0x"+"13".repeat(20)},
    {...challenge,expires_at:0},{...challenge,message:challenge.message.replace(P.domain,"0x"+"00".repeat(32))}])assert.throws(()=>assertChallenge(changed,wallet,now));
  assert.throws(()=>assertPublicScope({...FAUCET_SCOPE,token:"old DIEM"}));
  assert.throws(()=>assertPublicReadiness(readinessFixture(now-90000),now));
  const health={...FAUCET_SCOPE,ready:true,network:"fuji",faucet:"test-only",amount:P.grant,gas_wei:P.gasGrant,grant_policy:GRANT_POLICY,
    inventory_token_base:P.grant,inventory_gas_wei:"57000000000000000",claim_count:0,readiness_expires_at_ms:now+1000};
  assert.doesNotThrow(()=>assertFaucetHealth(health,now));
  for(const bad of [{...health,claim_count:20},{...health,inventory_gas_wei:"0"},{...health,inventory_token_base:"0"},
    {...health,grant_policy:{...GRANT_POLICY,max_claims_24h:999}}])assert.throws(()=>assertFaucetHealth(bad,now));
});

test('explicit public-user opt-in needs no machine-local operator proof and retains one-use verification',async t=>{const f=await fundingFixture(t);f.settings.publicRc1!.faucetOperatorProofFile=null;const result=await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,acceptScopedFaucet:true,dependencies:f.dependencies});assert.equal(result.status,'FUNDED');assert.equal(f.state.claimWrites,1);await ensurePublicFunding({settings:f.settings,wallet:f.wallet,dataDir:f.dir,acceptScopedFaucet:true,dependencies:f.dependencies});assert.equal(f.state.claimWrites,1);});
