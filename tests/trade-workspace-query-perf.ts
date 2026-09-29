import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  tradeWorkspacePage,
  tradeWorkspaceExport,
  tradeSignalOptions,
} from "../src/server/portfolio/trade-workspace-query";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
const child = relative(resolve(tmpdir()), directory);
assert.ok(
  !isAbsolute(child) &&
    !child.startsWith("..") &&
    child.startsWith("quant-trade-ledger-"),
);
const db = new Database(join(directory, "quant.sqlite"), { readonly: true });
try {
  const facts = () =>
    JSON.stringify(db.prepare("SELECT * FROM trade_ledger ORDER BY id").all());
  const before = createHash("sha256").update(facts()).digest("hex");
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = tradeWorkspacePage(db, { cursor });
    assert.equal(page.summary.count, 10000);
    ids.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const expected = (
    db
      .prepare(
        "SELECT id FROM trade_ledger ORDER BY trade_date DESC,json_extract(payload,'$.createdAt') DESC,id DESC",
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 10000);
  const exported = tradeWorkspaceExport(db, {});
  assert.deepEqual(
    exported.trades.map((t) => t.id),
    expected,
  );
  const measurements = [];
  for (const [name, query] of [
    ["history", () => tradeWorkspacePage(db, {})],
    [
      "filtered",
      () => tradeWorkspacePage(db, { symbol: "sh600000", query: "中文" }),
    ],
    [
      "signal-options",
      () => tradeSignalOptions(db, { symbol: "sh600000", date: "2026-09-29" }),
    ],
  ] as const) {
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 35; i++) {
      const start = performance.now(),
        value = query();
      if (i >= 5) times.push(performance.now() - start);
      bytes = Buffer.byteLength(JSON.stringify(value));
    }
    times.sort((a, b) => a - b);
    measurements.push({
      name,
      n: times.length,
      p50: times[15],
      p95: times[28],
      bytes,
    });
  }
  assert.equal(createHash("sha256").update(facts()).digest("hex"), before);
  const result = {
    count: ids.length,
    missing: 0,
    duplicates: 0,
    fullExport: exported.count,
    hash: before,
    measurements,
    note: "Direct query timings, not HTTP/browser",
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-trade-ledger/query-initial.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
