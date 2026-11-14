const hex=(v:unknown)=>String(v??"").replace(/^0x/,"").toLowerCase();
export function cohortMetrics(throwRows:any[],results:any[],startNonce:number){
  const accepted=throwRows.filter(t=>t.submitted===true&&t.signedIntent?.status==="throw_accepted"&&t.signedIntent.nonce>=startNonce);
  const ids=new Set(accepted.map(t=>t.decisionId)),throwIds=new Set(accepted.map(t=>hex(t.signedIntent.throwId)));
  const scored=new Map<string,any>();for(const r of results)if(ids.has(r.decisionId)&&r.actual?.matched)scored.set(r.decisionId,r);
  let principal=0n,settledPrincipal=0n,exactReturn=0n,unverifiedReturns=0;const returns:Record<string,string>={},holes:Record<string,number>={},bonus=new Map<string,number>(),hps:number[]=[],errors:number[]=[];
  for(const t of accepted){principal+=BigInt(t.payload.amount);const r=scored.get(t.decisionId);if(!r)continue;settledPrincipal+=BigInt(t.payload.amount);const a=r.actual.throwMatch;if(a?.returned_by_asset_exact===true){for(const [asset,amount] of Object.entries(a.returned_by_asset??{})){const k=hex(asset);returns[k]=(BigInt(returns[k]??"0")+BigInt(String(amount))).toString();if(k===hex(t.payload.asset))exactReturn+=BigInt(String(amount));}}else unverifiedReturns++;
    const kind=String(a?.hole_type??"unknown");holes[kind]=(holes[kind]??0)+1;
    if(typeof r.honestScore?.honestScore==="number")hps.push(r.honestScore.honestScore);
    const predicted=t.basePrediction?.pnlUsd,actual=r.actual.expectationVsActual?.actual_pnl_usd;if(typeof predicted==="number"&&typeof actual==="number")errors.push(Math.abs(predicted-actual));
    for(const b of r.actual.bonuses??[]){if(!throwIds.has(hex(b.throw_id)))continue;bonus.set([r.gameId,hex(b.throw_id),JSON.stringify(b.kind),b.points].join(":"),Number(b.points));}
  }
  const unique=new Set(accepted.map(t=>JSON.stringify([t.payload.init_pose,t.payload.init_linvel,t.payload.init_angvel]))).size;
  const n=[...scored.values()].length,entropy=Object.values(holes).reduce((s,c)=>s-(c/n)*Math.log2(c/n),0);
  return {accepted:accepted.length,settled:n,scored:hps.length,pending:accepted.length-n,games:new Set(accepted.map(t=>t.gameId)).size,principalBase:principal.toString(),settledPrincipalBase:settledPrincipal.toString(),pendingPrincipalBase:(principal-settledPrincipal).toString(),exactReturnedBase:exactReturn.toString(),returnsByAsset:returns,unverifiedReturns,settledNetClcBase:unverifiedReturns?null:(exactReturn-settledPrincipal).toString(),attributedThrowPoints:[...bonus.values()].reduce((a,b)=>a+b,0),uniqueControls:unique,settledHoleCounts:holes,holeEntropyBits:entropy||0,meanHps:hps.length?hps.reduce((a,b)=>a+b,0)/hps.length:null,pnlMaeUsd:errors.length?errors.reduce((a,b)=>a+b,0)/errors.length:null,selectedScoreNudges:accepted.filter(t=>Number(t.overlay?.scoreDelta??0)!==0).length,verifiedSelectionChanges:accepted.filter(t=>t.overlay?.withoutOverlayWinnerHash&&t.candidateHash!==t.overlay.withoutOverlayWinnerHash).length,policyIds:[...new Set(accepted.map(t=>t.overlay?.policyId).filter(Boolean))]};
}
