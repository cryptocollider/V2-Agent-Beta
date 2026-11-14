// Public bytecode fixture only: no wallet, key, funding or signed RPC methods.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { JsonRpcClient } from "../core/rpc.js";
import { PUBLIC_RC1, requirePublic } from "../public-rc1/contract.js";
const rpc=new JsonRpcClient(PUBLIC_RC1.evmRpc);
requirePublic(BigInt(await rpc.call<string>("eth_chainId",[]))===43113n,"Fuji fixture chain mismatch");
const code=await rpc.call<string>("eth_getCode",[PUBLIC_RC1.custody,"latest"]);
const bytes=Buffer.from(code.replace(/^0x/,""),"hex"),hash=createHash("sha256").update(bytes).digest("hex");
requirePublic(hash===PUBLIC_RC1.custodyCodeSha256,"deployed custody fixture hash mismatch");
await mkdir("assets/public-rc1-20261104",{recursive:true});
await writeFile("assets/public-rc1-20261104/custody-runtime.bin",bytes,{flag:"wx"});
console.log(JSON.stringify({status:"PUBLIC_BYTECODE_FIXTURE_STAGED",bytes:bytes.length,sha256:hash,signatures:0,broadcasts:0}));
