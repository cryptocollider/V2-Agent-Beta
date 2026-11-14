/** Exact display amounts: never round principal through floating point. */
export function amountToBase(value: unknown, decimals: number): bigint {
  const text=String(value??'').trim();
  if(!Number.isInteger(decimals)||decimals<0||decimals>36||!/^\d+(?:\.\d+)?$/.test(text))throw Error('Enter a positive decimal amount');
  const [whole,fraction='']=text.split('.');if(fraction.length>decimals)throw Error('Amount has too many decimal places');
  const base=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
  if(base<=0n||base>=2n**128n)throw Error('Amount is outside supported range');return base;
}
export function splitWithdrawal(amount:bigint,source:bigint,collider:bigint){
  if(amount<=0n||source<0n||collider<0n||amount>source+collider)throw Error('Insufficient available aggregate balance');
  const sourceAmount=source<amount?source:amount;return {sourceAmount,bridgeAmount:amount-sourceAmount};
}
