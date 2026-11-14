import test from'node:test';import assert from'node:assert/strict';
// @ts-ignore release tooling is intentionally plain Node.js
import{makeZip,readZip}from'../../scripts/zip-source.mjs';
test('source ZIP preserves binary/Unicode paths, rejects path escape and detects corruption',()=>{const entries=[{name:'src/test.ts',data:Buffer.from('export const n=42;\n')},{name:'docs/é.txt',data:Buffer.from([0,255,1,128,2])}],zip=makeZip(entries),back=readZip(zip);assert.deepEqual(back,entries);assert.throws(()=>makeZip([{name:'../wallet.json',data:Buffer.from('x')}]));assert.throws(()=>makeZip([{name:'C:/escape',data:Buffer.from('x')}]));const broken=Buffer.from(zip);broken[30+Buffer.byteLength(entries[0].name)+1]^=128;assert.throws(()=>readZip(broken));});
