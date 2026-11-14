export function remainingThrowCap(maximum:number,accepted:number){if(!Number.isSafeInteger(maximum)||!Number.isSafeInteger(accepted)||maximum<1||accepted<0||accepted>maximum)throw Error('Invalid aggregate throw bound');return maximum-accepted;}
export function nextRecoveryRound(used:number[],start:number,roundMs:number,now:number,maximum:number){if(!Number.isFinite(start)||!Number.isFinite(now)||roundMs<=0||maximum<1||used.some(n=>!Number.isInteger(n)||n<0||n>=maximum))throw Error('Invalid recovery timing');return Math.min(maximum,Math.max(0,used.length?Math.max(...used)+1:0,Math.floor((now-start)/roundMs)));}

export function pauseStamp(control:{lastAction?:{ts?:string}|null}){return control.lastAction?.ts??null;}
