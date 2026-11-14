import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadVizWasm, type WasmVizRuntime } from "../sim/wasm.js";
import { PUBLIC_RC1, requirePublic } from "./contract.js";

export type BindingClient={getGameSimulator(game:string):Promise<any>;getFrozenConfirmationInput(game:string):Promise<any>};
export function assertGameBinding(binding:any,game:string):void{
  requirePublic(binding?.game_id?.toLowerCase().replace(/^0x/,"")===game.toLowerCase().replace(/^0x/,"")&&binding.artifact_hash==="0x"+PUBLIC_RC1.wasmSha256
    &&binding.arena_schema===4&&binding.preview_abi===2&&binding.result_digest_version===2,"unsupported game simulator binding; no latest fallback");
}
export async function verifyPublicArtifact(file:string=PUBLIC_RC1.wasmPath):Promise<void>{
  const bytes=await readFile(file);requirePublic(bytes.length===PUBLIC_RC1.wasmBytes&&createHash("sha256").update(bytes).digest("hex")===PUBLIC_RC1.wasmSha256,"public simulator bytes/hash differ");
}
export async function loadPublicGameRuntime(client:BindingClient,file:string=PUBLIC_RC1.wasmPath,loader=loadVizWasm):Promise<WasmVizRuntime>{
  await verifyPublicArtifact(file);const runtime=await loader(file,PUBLIC_RC1.wasmSha256);
  return {runToFinalize:async()=>{throw Error("public_rc1_hold: select the game/round artifact before simulation");},
    forGame:async(game:string)=>{
      const binding=await client.getGameSimulator(game);assertGameBinding(binding,game);
      const frozen=await client.getFrozenConfirmationInput(game);
      if(frozen)requirePublic(frozen.game_id?.toLowerCase().replace(/^0x/,"")===game.toLowerCase().replace(/^0x/,"")&&frozen.artifact_hash===binding.artifact_hash&&frozen.digest_version===2,
        "frozen round simulator binding differs");
      return runtime;
    }};
}
