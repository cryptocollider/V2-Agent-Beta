import assert from "node:assert/strict";
import test from "node:test";

import { parseManagerChatResponse } from "./session.js";

test("manager response parser accepts structured JSON proposals", () => {
  const parsed = parseManagerChatResponse(
    "```json\n{\"reply\":\"Ready.\",\"summary\":\"RC1 checked.\",\"proposals\":[]}\n```",
  );
  assert.equal(parsed.reply, "Ready.");
  assert.equal(parsed.summary, "RC1 checked.");
  assert.deepEqual(parsed.proposals, []);
});

test("manager response parser degrades plain text to a safe reply", () => {
  const parsed = parseManagerChatResponse("I can help diagnose that without changing settings.");
  assert.equal(parsed.reply, "I can help diagnose that without changing settings.");
  assert.equal(parsed.summary, null);
  assert.deepEqual(parsed.proposals, []);
});

test("manager response parser never extracts actions from malformed text", () => {
  const raw = "Draft: {not valid JSON} and no executable proposal.";
  const parsed = parseManagerChatResponse(raw);
  assert.equal(parsed.reply, raw);
  assert.deepEqual(parsed.proposals, []);
});

test("manager response parser rejects an empty provider response", () => {
  assert.throws(() => parseManagerChatResponse("   "), /Empty manager response/);
});

test('every provider receives the selected doctrine thesis and real backup intent without any live inference',async()=>{const {buildManagerSystemPrompt}=await import('./session.js');const {resolveAgentProfile}=await import('../core/agent-profile.js');for(const id of ['tough_nut','peanut','nutjob','prof_deez_nutz']){const profile=resolveAgentProfile({doctrinePack:id as any});const snapshot:any={generatedAt:'now',settings:{doctrinePack:id,maxThrowsPerGame:11},profile,latestEligibility:{selectedGameId:'g',perGame:[{gameId:'g',ownAcceptedThrows:3,status:0}]}};const prompt=buildManagerSystemPrompt(snapshot);assert.ok(prompt.includes(profile.doctrineSeed.thesis));assert.ok(prompt.includes('not a random-vs-LLM control'));assert.ok(prompt.includes('current rules beat historical notes'));if(id==='peanut')assert.ok(prompt.includes('"backupSlotPlanningTarget": 2'));}});
test('ordinary manager candidate advice is bound to a fresh-simulated control rather than lost in later random sampling',async()=>{const {bindManagerProposal}=await import('./session.js');const c={candidateHash:'known',candidate:{x:10,y:10,angleDeg:45,speedPct:80,spinPct:0,source:'grid',asset:'aa',amount:'4'}};const snapshot:any={latestCandidates:{candidates:[c]}};const result=bindManagerProposal({kind:'overlay',title:'test',why:'test',payload:{candidateScoreDeltas:{known:500}}},snapshot);assert.equal((result.payload!.candidateSet as any).candidates[0].amount,'4');assert.notEqual(Object.keys(result.payload!.candidateScoreDeltas as any)[0],'known');assert.throws(()=>bindManagerProposal({kind:'overlay',title:'bad',why:'bad',payload:{candidateScoreDeltas:{unknown:500}}},snapshot),/approved/);});
