import test from "node:test";import assert from "node:assert/strict";
import {BASELINES,primaryGoalWeights,behaviorHash,validatedSeedOverlay,reconciledWalletNonces} from "./doctrine-baseline.js";
import {normalizeSettings} from "../core/settings.js";
test("four goal/doctrine baselines have identical non-identity behavior and balanced risk",()=>{
  const hashes=BASELINES.map(b=>behaviorHash(normalizeSettings({user:b.id,expectedEvmAddress:b.id,monitorPort:b.port,doctrinePack:b.doctrine,goalWeights:primaryGoalWeights(b.primaryGoal),riskMode:"balanced",copySlammerWhenSameHoleType:false,maxThrowsPerSession:11})));
  assert.equal(new Set(hashes).size,1);for(const b of BASELINES)assert.equal(primaryGoalWeights(b.primaryGoal)[b.primaryGoal],.7);
  const s=normalizeSettings({reserveBalanceBase:"400"});assert.notEqual(behaviorHash(s),behaviorHash({...s,reserveBalanceBase:"0"}));
});
test("baseline permits only small score nudges for known candidates and never financial/control proposals",()=>{
  const h=new Set(["abc"]);assert.equal(validatedSeedOverlay({candidateScoreDeltas:{abc:100}},h,"test").candidateScoreDeltas?.abc,100);
  assert.equal(validatedSeedOverlay({candidateSourceScoreDeltas:{history:10}},h,"test").candidateSourceScoreDeltas?.history,10);
  for(const p of [{candidateSourceScoreDeltas:{unknown:1}},{holeTypeScoreDeltas:{"9":1}},{candidateSourceScoreDeltas:{grid:60},holeTypeScoreDeltas:{"3":60}}])assert.throws(()=>validatedSeedOverlay(p,h,"test"));
  for(const p of [{reserveBalanceBase:"0"},{pnlBiasUsd:1},{candidateScoreDeltas:{unknown:1}},{candidateScoreDeltas:{abc:101}},{candidateScoreDeltas:{abc:70},holeTypeScoreDeltas:{"3":70}},{candidateScoreDeltas:{abc:0}}])assert.throws(()=>validatedSeedOverlay(p,h,"test"));
});
test("confirmed authenticated business rejections consume nonces without counting as accepted throws",()=>{
  assert.equal(reconciledWalletNonces([0,1,3],[2],4),true);
  assert.equal(reconciledWalletNonces([0,1,3],[],4),false);
  assert.equal(reconciledWalletNonces([0,1,2],[2],4),false);
  assert.equal(reconciledWalletNonces([0,1,3],[2],5),false);
});
