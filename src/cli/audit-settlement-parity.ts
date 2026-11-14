// Public read-only reconciliation: no wallet, signing, funding or control APIs.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildPriceLookupFromGameReport,buildScenarioSettlementView} from '../agent/prediction-settlement.js';
import {matchReportToSubmittedThrow} from '../agent/report-match.js';
import {HistorySummaryReader} from '../monitor/history-summary.js';

export async function auditSettlementParity(dataDir:string){
 const settings=JSON.parse(await readFile(path.join(dataDir,'settings.json'),'utf8'));
 const url=new URL(settings.rpc);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw Error('loopback audit RPC required');
 const rpc=async(method:string,params:unknown[]=[])=>{
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'colliderV2.'+method,params}),signal:AbortSignal.timeout(10000)});
  const b=await r.json() as any;if(!r.ok||b.error)throw Error('canonical audit read failed: '+method);return b.result;
 };
 const rows=async(name:string)=>(await readFile(path.join(dataDir,name),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const [results,throws,holeRules]=await Promise.all([rows('results.jsonl'),rows('throws.jsonl'),rpc('getHoleRules')]);
 const user='0x'+String(settings.user).replace(/^0x/,'').toLowerCase();
 const auth=await rpc('getAuthContext',[user]);if(auth.network_domain!==settings.expectedNetworkDomain)throw Error('audit domain mismatch');
 const byDecision=new Map(throws.map(t=>[t.decisionId,t]));
 const games=new Map<string,{report:any;input:any}>();
 await Promise.all([...new Set<string>(results.map(r=>r.gameId))].map(async game=>{
  const [report,input]=await Promise.all([rpc('getGameReport',[game]),rpc('getSimInput',[game])]);
  buildScenarioSettlementView({input:{...input,throws:report.throws_raw},outcomes:report.outcomes_raw,holeRules,priceLookup:buildPriceLookupFromGameReport(report),canonicalPayouts:report.payouts_raw});
  games.set(game,{report,input});
 }));
 const canonical:Record<string,bigint>={},attributed:Record<string,bigint>={};let correctedIds=0;const matchedIds=new Set<string>();
 for(const {report}of games.values())for(const p of report.payouts_raw)if(p.user.toLowerCase()===user){const asset=String(p.asset).replace(/^0x/,'');canonical[asset]=(canonical[asset]??0n)+BigInt(p.amount);}
 for(const row of results){const t=byDecision.get(row.decisionId),game=games.get(row.gameId)!;if(!t?.signedIntent?.throwId)throw Error('confirmed throw identity missing');
  const matched=matchReportToSubmittedThrow(game.report,user,{...row.expected,throwId:t.signedIntent.throwId},game.input,holeRules);
  if(!matched.matched||!matched.throwMatch?.returned_by_asset_exact)throw Error('reconciled throw unavailable');
  const id=String(t.signedIntent.throwId).replace(/^0x/,'');if(matched.throwMatch.throw_id!==id||matchedIds.has(id))throw Error('throw identity not unique');matchedIds.add(id);
  if(row.actual?.throwMatch?.throw_id!==id)correctedIds++;
  for(const [a,n]of Object.entries(matched.throwMatch.returned_by_asset??{}))attributed[a]=(attributed[a]??0n)+BigInt(n);
 }
 const summary=await new HistorySummaryReader(path.join(dataDir,'throws.jsonl'),path.join(dataDir,'results.jsonl')).read();
 for(const a of new Set([...Object.keys(canonical),...Object.keys(attributed)])){
  if((attributed[a]??0n)!==(canonical[a]??0n)||BigInt(summary.bank.inByAsset[a]??'0')!==(canonical[a]??0n))throw Error('bank/attribution differs from canonical VM payout');
 }
 const allCanonical={...canonical};let newlySettledGames=0;
 for(const game of new Set<string>(throws.map(t=>t.gameId))){
  if(games.has(game))continue;
  const state=await rpc('getGame',[game]);if(state?.status!==4)continue;
  const report=await rpc('getGameReport',[game]);newlySettledGames++;
  for(const p of report.payouts_raw)if(p.user.toLowerCase()===user){const a=String(p.asset).replace(/^0x/,'');allCanonical[a]=(allCanonical[a]??0n)+BigInt(p.amount);}
 }
 const balances=await rpc('getBalances',[user]),walletReconciliation:Record<string,unknown>={};
 for(const a of Object.keys(summary.bank.outByAsset)){
  const credit=await rpc('getBridgeDepositCredit',['0x'+a,user]);
  const expected=BigInt(credit.credited_cumulative_amount)-BigInt(summary.bank.outByAsset[a])+(allCanonical[a]??0n);
  const actual=BigInt(balances['0x'+a]??balances[a]??'0');walletReconciliation[a]={expected:expected.toString(),actual:actual.toString(),equal:expected===actual};
 }
 return {schema:'agent1.settlement-parity-audit.v1',asOf:new Date().toISOString(),rpc:settings.rpc,user,settledGames:games.size,results:results.length,
  uniqueMatchedThrows:matchedIds.size,previouslyWrongThrowIds:correctedIds,integerPlanMatchesCanonicalAllGames:true,
  canonicalReturns:Object.fromEntries(Object.entries(canonical).map(([a,n])=>[a,n.toString()])),
  correctedBankReturns:summary.bank.inByAsset,unverifiedReturnDecisions:summary.bank.unverifiedReturnDecisions,
  nextNonce:auth.user.accepted_next_nonce,newlySettledGamesSinceLocalScoring:newlySettledGames,
  currentCanonicalReturnsAllAcceptedGames:Object.fromEntries(Object.entries(allCanonical).map(([a,n])=>[a,n.toString()])),walletReconciliation};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--data-dir');if(index<0||!process.argv[index+1])throw Error('--data-dir required');
 console.log(JSON.stringify(await auditSettlementParity(process.argv[index+1]),null,2));
}
