import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonlTail } from "./jsonl.js";

test("readJsonlTail returns only the newest bounded window", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-jsonl-"));
  const file = path.join(dir, "large.jsonl");
  try {
    const chunks: string[] = [];
    for (let i = 0; i < 20_000; i++) chunks.push(JSON.stringify({ i, payload: "x".repeat(120) }) + "\n");
    await appendFile(file, chunks.join(""), "utf8");

    const page = await readJsonlTail<{ i: number }>(file, 50);
    assert.equal(page.rows.length, 50);
    assert.equal(page.rows[0]?.i, 19_950);
    assert.equal(page.rows[49]?.i, 19_999);
    assert.equal(page.truncated, true);
    assert.ok(page.scannedBytes < page.fileBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readJsonlTail preserves UTF-8 split across reverse-read block boundaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent1-jsonl-utf8-"));
  const file = path.join(dir, "large.jsonl");
  try {
    const padding = "x".repeat((256 * 1024) - 20);
    const rows = [
      { i: 1, text: `${padding}🧠` },
      { i: 2, text: "Collider café" },
    ];
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const page = await readJsonlTail<{ i: number; text: string }>(file, 2);
    assert.deepEqual(page.rows, rows);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
