import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
/** Windows CurrentUser DPAPI protects only the random keystore password. No shell interpolation. */
export async function protectLocalSecret(value:Buffer,decrypt=false):Promise<Buffer>{
  if(process.platform!=='win32')throw Error('Set COLLIDER_AGENT_KEY_PASSWORD to create a portable encrypted wallet on this platform');
  const verb=decrypt?'Unprotect':'Protect';
  const code=`Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${verb}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let out='';const timer=setTimeout(()=>{child.kill();reject(Error('Local wallet protection timed out'));},15000);child.stdout.on('data',b=>{out+=b;if(out.length>32768){child.kill();reject(Error('Local wallet protection failed'));}});child.stderr.resume();child.once('error',()=>{clearTimeout(timer);reject(Error('Local wallet protection unavailable'));});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Local wallet protection failed'));resolve(Buffer.from(out.trim(),'base64'));});child.stdin.end(value.toString('base64'));});
}
export const randomWalletPassword=()=>randomBytes(32).toString('base64url');
