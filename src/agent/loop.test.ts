import assert from "node:assert/strict";
import test from "node:test";

import type { GameListItem } from "../collider/types.js";
import { filterGamesByAllowlist } from "./loop.js";

function game(gameId: string): GameListItem {
  return {
    game_id: gameId,
    status: 0,
    name: gameId,
    map_id: `0x${"11".repeat(32)}`,
    created_height: 1,
    last_throw_height: 0,
    throws: 0,
    stake: "0",
    min_throws: 3,
    throw_min_value: "1",
  };
}

test("game allowlist excludes unrelated live games and normalizes hex prefixes", () => {
  const selected = filterGamesByAllowlist(
    [game(`0x${"aa".repeat(32)}`), game(`0x${"bb".repeat(32)}`)],
    ["AA".repeat(32)],
  );

  assert.deepEqual(selected.map((row) => row.game_id), [`0x${"aa".repeat(32)}`]);
});

test("empty game allowlist retains the normal live-game universe", () => {
  const games = [game(`0x${"aa".repeat(32)}`), game(`0x${"bb".repeat(32)}`)];

  assert.equal(filterGamesByAllowlist(games, []), games);
});
