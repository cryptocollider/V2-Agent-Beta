import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "./storage.js";
import { ensurePendingDecisionIndex, readPendingDecisions } from "./pending-decisions.js";

test("legacy pending index is rebuilt with confirmed throw identity even when log sizes match", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "pending-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = await initStorage(dir);
  const row = { decisionId:"d", gameId:"g", botUser:"aa", ts:"2026-10-27T00:00:00Z", submitted:true,
    payload:{amount:"1"}, signedIntent:{throwId:"11".repeat(32)} };
  await writeFile(paths.throwsFile, JSON.stringify(row)+"\n");
  await writeFile(paths.resultsFile, "");
  await writeFile(path.join(dir,"pending-decisions.json"), JSON.stringify({schema:"collider.agent1.pending-decisions.v1",
    rows:[{...row, throwId:undefined, signedIntent:undefined}], sourceBytes:{throws:(await stat(paths.throwsFile)).size,results:0}}));
  await ensurePendingDecisionIndex(paths);
  assert.equal((await readPendingDecisions(paths,"aa"))[0].throwId, row.signedIntent.throwId);
  assert.equal(JSON.parse(await readFile(path.join(dir,"pending-decisions.json"),"utf8")).identityVersion, 2);
});
