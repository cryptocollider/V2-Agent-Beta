export function latestAcceptedManagerAdvice(rows:any[],startNonce:number){
const t=rows.filter(t=>t.submitted===true&&t.signedIntent?.status==='throw_accepted'&&t.signedIntent.nonce>=startNonce).at(-1);
return t?.managerAdvice?{...t.managerAdvice,acceptedNonce:t.signedIntent.nonce,acceptedAt:t.ts,gameId:t.gameId,source:'accepted-throw-audit'}:null;
}
