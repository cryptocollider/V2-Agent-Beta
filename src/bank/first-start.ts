import {mkdir,readFile,readdir} from 'node:fs/promises';import path from 'node:path';
import {AgentWallet} from '../collider/wallet.js';import {createInstanceWallet,vaultFile} from './vault.js';import {loadSettings,normalizeSettings,saveSettings,type AgentSettings} from '../core/settings.js';import {buildPublicSettings} from '../public-rc1/profile.js';
/** Only a genuinely new directory may create an independent wallet. Imported/old identities use the existing reconciled preparation flow. */
export async function initializeNewPublicWallet(dataDir:string,options:{walletFile?:string;password?:string}={}):Promise<AgentSettings>{
  await mkdir(dataDir,{recursive:true});const entries=await readdir(dataDir);if(entries.some(name=>name!=='settings.json'))throw Error('Existing profile data requires reconciliation; no new wallet was created');
  const initial=await loadSettings(dataDir);if(initial.publicRc1||initial.expectedEvmAddress||initial.signingKeyFile)throw Error('Use the prepared owner-wallet import flow for an existing identity');
  const file=options.walletFile??vaultFile(dataDir);let exists=true;try{await readFile(file,'utf8');}catch(e){if((e as any).code==='ENOENT')exists=false;else throw e;}
  if(!exists)await createInstanceWallet(file,options.password);
  const wallet=await AgentWallet.load({signingKeyFile:file,signingKeyPasswordEnv:'AGENT1_FIRST_START_PASSWORD'},{AGENT1_FIRST_START_PASSWORD:options.password});if(!wallet)throw Error('Encrypted instance wallet could not be loaded');
  const owner=normalizeSettings({...initial,expectedEvmAddress:wallet.address,signingKeyFile:file,signingKeyEnv:"",minMillisBetweenLiveThrows:30000,maxThrowsPerGame:22,maxThrowsPerSession:498,maxSingleThrowBase:'4000000000000000000',maxSingleThrowUsd:.1,maxThrowUsd:.1,maxGameExposureUsd:110});
  const ownerDir=path.join(dataDir,'data-wallet-owner');await saveSettings(owner,ownerDir);const settings=buildPublicSettings(owner,ownerDir,wallet.address);settings.maxSingleThrowBase='4000000000000000000';settings.testnetAutoFunding!.enabled=false;await saveSettings(settings,dataDir);await import('node:fs/promises').then(fs=>fs.writeFile(path.join(dataDir,'bank-policy.json'),JSON.stringify({autoDepositReceived:true}),{flag:'wx',mode:0o600}));return settings;
}
