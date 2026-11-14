import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JsonRpcClient } from "./rpc.js";

test("sensitive signed RPC rejection never echoes payloads and never retries", async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end(JSON.stringify({ error: { message: "test-private-opening-marker" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const rpc = new JsonRpcClient("http://127.0.0.1:" + port);
  const original = console.warn; const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    await assert.rejects(rpc.call("colliderV2.submitSignedIntent", [{ salt: "test-private-opening-marker" }],
      { retries: 0, redactErrors: true }), error => {
        assert.ok(!String(error).includes("test-private-opening-marker")); return true;
      });
  } finally { console.warn = original; }
  assert.equal(requests, 1); assert.ok(!warnings.join().includes("test-private-opening-marker"));
});

test("RPC deadline includes a stalled JSON response body after successful headers", async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++; response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders();
    response.write('{"result":');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const rpc = new JsonRpcClient("http://127.0.0.1:" + port);
  await assert.rejects(rpc.call("colliderV2.submitSignedIntent", [], { timeoutMs: 100, retries: 0, redactErrors: true }),
    /sensitive RPC outcome unavailable/);
  assert.equal(requests, 1);
});

test('RPC connection reuse and observer failures cannot change validated results',async t=>{const {setRpcObserver}=await import('./rpc.js');const headers:string[]=[];const server=createServer(async(req,res)=>{headers.push(String(req.headers.connection));let body='';for await(const c of req)body+=c;const v=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result:7}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{setRpcObserver(null);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});setRpcObserver(()=>{throw Error('metrics sink failure');});const rpc=new JsonRpcClient('http://127.0.0.1:'+(server.address() as any).port);for(let i=0;i<4;i++)assert.equal(await rpc.call('colliderV2.getBalances',[]),7);assert.ok(headers.every(h=>h!=='close'));});
