import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPredictionCommitBundle} from './prediction-artifact.js';

test('empty-board prediction includes the hypothetical live-valued return, not zero or a fake loss',()=>{
 const id='11'.repeat(32),user='aa'.repeat(32),asset='09'.repeat(32),bytes=(s:string)=>[...Buffer.from(s,'hex')];
 const canonical={game:{no_winner_policy:'BiggestLoser'},map:{},throws:[],assets:[],snap_every:1,frame_cap_override:null};
 const synthetic={...canonical,assets:[{asset:bytes(asset),decimals:18}],throws:[{id:bytes(id),user:bytes(user),asset:bytes(asset),
  amount:'5555555555555556',value_usd_e8:'1000000000',price_epoch:1,mass_usd:10,enter_frame:0}]};
 const plan={perScenario:[{scenario:{weight:1},syntheticThrowId:id,syntheticInput:synthetic,
  decoded:{per_throw:[{throw_id:id,hole_type:3,hole_i:0,endFrame:10}]}}]};
 const original=JSON.stringify(canonical);
 const bundle=buildPredictionCommitBundle({createdAt:'2026-10-27T13:00:00Z',sessionId:'test',decisionId:'test',
  gameId:'bb'.repeat(32),botUser:user,candidateHash:null,plan:plan as any,simInput:canonical as any});
 assert.ok(Math.abs(bundle.summary!.pnlUsd??999)<1e-8);
 assert.equal(bundle.summary?.valueUsdE8,'1000000000');
 assert.equal(JSON.stringify(canonical),original);
});
