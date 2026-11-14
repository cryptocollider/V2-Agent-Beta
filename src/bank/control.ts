export function mayResumeInternalDeposit(job:{kind?:string;automatic?:boolean;resumeAfter?:boolean;stage:string;pauseActionTs?:string},control:{state:string;lastAction?:{ts:string}|null}){
  return job.kind==='deposit'&&job.automatic===true&&job.resumeAfter===true&&job.stage==='COMPLETE'&&control.state==='paused'&&!!job.pauseActionTs&&control.lastAction?.ts===job.pauseActionTs;
}
