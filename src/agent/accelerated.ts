import {PUBLIC_RC1 as P} from '../public-rc1/contract.js';
export function acceleratedOverride(s:any,deadline:number|undefined,requested:boolean,now=Date.now(),fourHour=false,research=false,used=0){
  if(fourHour&&research)throw Error("Conflicting accelerated modes");
  if(!requested){if(fourHour||research)throw Error('Four-hour accelerated mode requires explicit accelerated opt-in');return undefined;}
  if(!Number.isInteger(used)||used<0||used>=400||(!research&&used!==0))throw Error("Invalid prior research allowance usage");
  const maxThrows=research?400-used:fourHour?800:100,maxWindowMs=(research?123:fourHour?243:33)*60000;
  if(!s.publicRc1||!deadline||deadline<=now||deadline-now>maxWindowMs||s.rpc!==P.rpc||s.maxThrowsPerSession!==maxThrows||s.amount!=='4000000000000000000'||s.maxSingleThrowBase!==s.amount||s.maxGameExposureUsd!==110||s.maxThrowsPerGame!==22||s.testnetAutoFunding?.enabled||BigInt(s.publicRc1.gasReserveWei)<BigInt(P.exitGasReserve))throw Error('Accelerated mode requires its explicit timed public test limits, no funding and protected native gas');
  return {startIntervalMs:15000,maxThrows,stopAtMs:deadline};
}
