import {createHash} from 'node:crypto';import type {PreparedSignedIntent,Rc1AuthContext} from '../collider/types.js';import {verifyNativePreparedEnvelope} from '../collider/native-signing.js';import {assertPublicAuth} from './contract.js';
export function verifyDisplayLabel(prepared:PreparedSignedIntent,auth:Rc1AuthContext,user:string,label:string){
  if(!/^[a-zA-Z0-9_-]{3,20}$/.test(label))throw Error('Invalid vanity label');assertPublicAuth(auth,user);verifyNativePreparedEnvelope(prepared,auth);
  if(prepared.signer.toLowerCase()!==user.toLowerCase()||prepared.action!=='user.label.set'||prepared.nonce!==auth.user!.accepted_next_nonce||auth.user!.next_available_nonce!==prepared.nonce)throw Error('Label signer, action or nonce differs');
  const name=Buffer.from(label),index=Buffer.alloc(4),length=Buffer.alloc(8);index.writeUInt32LE(39);length.writeBigUInt64LE(BigInt(name.length));const canonical=Buffer.concat([index,Buffer.from(user.slice(2),'hex'),length,name]);
  if(!Buffer.from(prepared.op_b64,'base64').equals(canonical)||'0x'+createHash('sha256').update('ColliderV2/IntentPayload/V1').update(canonical).digest('hex')!==prepared.payload_hash)throw Error('Label payload differs from canonical SetDisplayLabel');
  const details=JSON.parse(prepared.details);if(Object.keys(details).join()!=='SetDisplayLabel'||details.SetDisplayLabel.label!==label||Buffer.from(details.SetDisplayLabel.user).toString('hex')!==user.slice(2).toLowerCase())throw Error('Label presentation differs');
}
