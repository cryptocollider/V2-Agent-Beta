import { protectLocalSecret, randomWalletPassword } from '../core/os-wallet.js';
import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';import {Wallet} from 'ethers';
import {AgentWallet} from '../collider/wallet.js';
import {enforceOwnerOnly} from '../core/fuji-test-wallet.js';
export function vaultFile(dataDir:string){return path.join(process.env.LOCALAPPDATA||os.homedir(),'Collider','Agent1','wallets',createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0,24),'wallet.json');}
export function checkPassword(password:unknown):string{if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Use a wallet password of 12–256 characters');return password;}
export async function saveEncryptedWallet(wallet:AgentWallet,password:string,file:string){
  checkPassword(password);await mkdir(path.dirname(file),{recursive:true});const text=await wallet.encrypt(password);
  const verified=await Wallet.fromEncryptedJson(text,password);if(verified.address.toLowerCase()!==wallet.address.toLowerCase())throw Error('Encrypted wallet identity differs');
  const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,text,{flag:'wx',mode:0o600});await enforceOwnerOnly(temporary);await rename(temporary,file);await enforceOwnerOnly(file);
}
export async function verifyWalletPassword(file:string,password:unknown,address:string){
  if(typeof password!=='string'||!password||password.length>256)throw Error('Wallet password required');
  try{const wallet=await Wallet.fromEncryptedJson(await readFile(file,'utf8'),password);if(wallet.address.toLowerCase()!==address.toLowerCase())throw Error();}
  catch{throw Error('Wallet password or encrypted wallet identity is incorrect');}
}
export async function createEncryptedWallet(password:string,file:string){
  checkPassword(password);const wallet=Wallet.createRandom();await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,await wallet.encrypt(password),{flag:'wx',mode:0o600});await enforceOwnerOnly(file);return wallet.address;
}
export async function removeLegacyKey(file:string,newFile:string){if(path.resolve(file)!==path.resolve(newFile))await unlink(file);}

export async function createInstanceWallet(file:string,password?:string){
  const wallet=Wallet.createRandom(),secret=password?checkPassword(password):randomWalletPassword();
  const keystore=await wallet.encrypt(secret);
  const envelope=password?keystore:JSON.stringify({schema:'agent1.os-protected-wallet.v1',address:wallet.address,keystore,protectedPassword:(await protectLocalSecret(Buffer.from(secret))).toString('base64')});
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,envelope,{flag:'wx',mode:0o600});await enforceOwnerOnly(file);return wallet.address;
}
