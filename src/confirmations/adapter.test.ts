import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ConfirmationReadRpc } from "./adapter.js";
import type { ColliderClient } from "../collider/client.js";

test("read adapter uses canonical accepted block time, lossless integers and exact native routes", async t => {
  const seen: { url: string; method: string; params: unknown }[] = [];
  let authCalls = 0;
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const { method, params } = JSON.parse(text); seen.push({ url: request.url!, method, params });
    let result: unknown;
    if (method === "colliderV2.getAuthContext") result = { last_accepted_height: ++authCalls === 1 ? 10 : 11 };
    else if (method === "lastAccepted") result = { id: "canonical-block" };
    else if (method === "getBlock") {
      assert.deepEqual(params, [{ id: "canonical-block" }]);
      response.end('{"result":{"block":{"height":11,"timestamp":18446744073709551615}}}');
      return;
    } else if (method === "colliderV2.getVerificationStats") {
      response.end('{"result":{"committed":18446744073709551615,"points":"340282366920938463463374607431768211455"}}');
      return;
    } else if (method === "colliderV2.getConfirmationPolicy") result = { policy: { enabled: false } };
    else if (method === "colliderV2.getConfirmationRound") result = null;
    else if (method === "colliderV2.getBlockEventsAt") result = [];
    else { response.statusCode = 400; response.end(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  const adapter = new ConfirmationReadRpc("http://127.0.0.1:" + address.port + "/ext/bc/isolated/collider_v2",
    {} as ColliderClient);
  const snapshot = await adapter.snapshot("test-user");
  assert.equal(authCalls, 2); assert.equal(snapshot.height, 11); assert.equal(snapshot.time, "18446744073709551615");
  const stats = await adapter.stats("test-user") as any;
  assert.equal(stats.committed, "18446744073709551615");
  assert.equal(stats.points, "340282366920938463463374607431768211455");
  assert.equal((await adapter.policy()).policy.enabled, false);
  assert.equal(await adapter.round("game"), null); assert.deepEqual(await adapter.events(11), []);
  assert.ok(seen.every(row => row.url === "/ext/bc/isolated/" + (["lastAccepted", "getBlock"].includes(row.method) ? "rpc" : "collider_v2")));
  assert.ok(seen.every(row => !/prepare|submit|fund|redeem/i.test(row.method)));
});

