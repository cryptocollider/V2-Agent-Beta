import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HistorySummaryReader} from './history-summary.js';
const game='11'.repeat(32),asset='09'.repeat(32);
test('VM per-game payouts count once despite repeated rows, local rounding and incorrect duplicate throw attribution',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'canonical-bank-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const throwsFile=path.join(dir,'throws.jsonl'),resultsFile=path.join(dir,'results.jsonl');
 await writeFile(throwsFile,[0,1].map(i=>JSON.stringify({gameId:game,decisionId:'d'+i,submitted:true,signedIntent:{status:'throw_accepted',nonce:i},payload:{asset,amount:'10'}})).join('\n')+'\n');
 const rows=[0,1].map(i=>({gameId:game,decisionId:'d'+i,actual:{payouts:{by_asset:{[asset]:'9007199254740993'}},throwMatch:{returned_by_asset_exact:true,returned_by_asset:{[asset]:'9999999999999999'}}}}));
 await writeFile(resultsFile,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');const reader=new HistorySummaryReader(throwsFile,resultsFile);
 const s=await reader.read();assert.equal(s.bank.inByAsset[asset],'9007199254740993');assert.equal(s.bank.unverifiedReturnDecisions,0);
 await appendFile(resultsFile,JSON.stringify({...rows[0],actual:{payouts:{by_asset:{[asset]:'2'}}}})+'\n');
 const conflict=await reader.read();assert.equal(conflict.bank.inByAsset[asset],undefined);assert.equal(conflict.bank.unverifiedReturnDecisions,2);
});
test('an old exact flag without canonical provenance is not a verified credit',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'unverified-bank-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const tf=path.join(dir,'throws.jsonl'),rf=path.join(dir,'results.jsonl');await writeFile(tf,'');
 await writeFile(rf,JSON.stringify({gameId:game,decisionId:'old',actual:{throwMatch:{returned_by_asset_exact:true,returned_by_asset:{[asset]:'123'}}}})+'\n');
 const s=await new HistorySummaryReader(tf,rf).read();assert.deepEqual(s.bank.inByAsset,{});assert.equal(s.bank.unverifiedReturnDecisions,1);
});
