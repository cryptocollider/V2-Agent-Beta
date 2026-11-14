import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBoundedProcess } from "./process.js";

test("bounded process awaits and preserves ordered batch log writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-soak-process-"));
  try {
    const output = path.join(dir, "child.log");
    const result = await runBoundedProcess(process.execPath,
      ["-e", "for(let i=0;i<100;i++)process.stdout.write(String(i).padStart(3,'0')+'\\n')"],
      { cwd: dir, timeoutMs: 10_000, outputFile: output });
    assert.equal(result.code, 0);
    assert.equal(await readFile(output, "utf8"), result.stdout);
    assert.equal(result.stdout.trim().split("\n").length, 100);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bounded process can keep a full file while bounding in-memory output without mirroring", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-process-bounded-"));
  const file = path.join(dir, "child.log");
  try {
    const result = await runBoundedProcess(process.execPath,
      ["-e", "for(let i=0;i<100;i++) console.log(String(i).padStart(3,'0'))"],
      { cwd: dir, timeoutMs: 5_000, outputFile: file, mirrorOutput: false, maxCaptureChars: 80 });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.length <= 80);
    const full = await readFile(file, "utf8");
    assert.match(full, /^000/m);
    assert.match(full, /^099/m);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bounded process escalates after an ignored interrupt and still returns", async () => {
  const started = Date.now();
  const result = await runBoundedProcess(process.execPath,
    ["-e", "process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],
    { cwd: os.tmpdir(), timeoutMs: 100, interruptGraceMs: 100, hardKillGraceMs: 500,
      softInterrupt: () => { /* simulate an accepted but ignored interrupt */ } });
  assert.equal(result.timedOut, true);
  assert.equal(result.hardKillIssued, true);
  assert.ok(Date.now() - started < 2_000);
});
