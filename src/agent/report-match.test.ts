import assert from 'node:assert/strict';
import test from 'node:test';
import {matchReportToSubmittedThrow} from './report-match.js';
const user='aa'.repeat(32),asset='09'.repeat(32),first='11'.repeat(32),second='22'.repeat(32);
const bytes=(h:string)=>h.match(/../g)!.map(x=>parseInt(x,16));
function fixture(){const t={user:bytes(user),asset:bytes(asset),amount:'100',init_pose:{pos:{x:1,y:2},angle_rad:0},init_linvel:{x:3,y:4},init_angvel:0};
 return {report:{throws_raw:[{...t,id:bytes(first)},{...t,id:bytes(second)}],outcomes_raw:[{throw_id:first,hole_type:1,endFrame:20},{throw_id:second,hole_type:2,endFrame:30}],payouts_raw:[]},
 expected:{payload:{asset,amount:'100',x:1,y:2,angle_rad:0,vx:3,vy:4,angVel:0}}};}
test('identical payloads use confirmed throw ID, not the first payload match',()=>{const f=fixture();const r=matchReportToSubmittedThrow(f.report,user,{...f.expected,throwId:'0x'+second});assert.equal(r.throwMatch?.throw_id,second);assert.equal(r.throwMatch?.hole_type,2);});
test('ambiguous payload without identity and missing/wrong canonical identity never guess a match',()=>{const f=fixture();assert.equal(matchReportToSubmittedThrow(f.report,user,f.expected).matched,false);assert.equal(matchReportToSubmittedThrow(f.report,user,{...f.expected,throwId:'ff'.repeat(32)}).matched,false);assert.equal(matchReportToSubmittedThrow({...f.report,throws_raw:f.report.throws_raw.slice(0,1)},user,{throwId:second}).matched,false);});
