import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { migrate } from "../src/server/db/migrations";
import {
  monitorWorkspacePage,
  signalWorkspacePage,
  deliveryWorkspacePage,
} from "../src/server/monitoring/monitor-workspace-query";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signals-"));
const db = new Database(join(directory, "quant.sqlite"));
try {
  const hash = () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          db
            .prepare(
              "SELECT * FROM records WHERE kind IN ('monitor','signal','delivery','channel','settings') ORDER BY id",
            )
            .all(),
        ),
      )
      .digest("hex");
  const original = hash();
  migrate(db);
  assert.equal(hash(), original, "metadata migration must not change records");
  const result = [];
  for (const [kind, query, total] of [
    ["monitor", monitorWorkspacePage, 1000],
    ["signal", signalWorkspacePage, 10000],
    ["delivery", deliveryWorkspacePage, 50000],
  ] as const) {
    const ids: string[] = [];
    let cursor: string | undefined,
      pages = 0;
    do {
      const page = query(db, { cursor });
      ids.push(...page.items.map((row) => row.id));
      pages++;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const expected = (
      db
        .prepare(
          "SELECT id FROM records WHERE kind=? ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC",
        )
        .all(kind) as { id: string }[]
    ).map((row) => row.id);
    assert.deepEqual(ids, expected);
    assert.equal(ids.length, total);
    assert.equal(new Set(ids).size, total);
    result.push({ kind, count: ids.length, pages, duplicates: 0, missing: 0 });
  }
  const output = {
    result,
    recordsUnchanged: hash() === original,
    recordsHash: original,
    userVersion: db.pragma("user_version", { simple: true }),
    integrity: db.pragma("integrity_check", { simple: true }),
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-signals/completeness.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output));
} finally {
  db.close();
}
