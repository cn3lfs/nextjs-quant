/** Real tRPC timings on temporary fixture rows; restores the isolated DB. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import SuperJSON from "superjson";
const Database = createRequire(import.meta.url)("better-sqlite3");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-research-archive-"));
const base = process.env.BASE ?? "http://127.0.0.1:3220";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const db = new Database(join(data, "quant.sqlite"));
db.pragma("busy_timeout=5000");
const kinds = ["report", "chan-report", "canslim-report", "wyckoff-report"];
const count = () =>
  db
    .prepare(
      "SELECT count(*) n FROM records WHERE kind IN ('report','chan-report','canslim-report','wyckoff-report')",
    )
    .get().n;
const initial = count(),
  insert = db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  ),
  ids = [],
  results = [];
assert.ok(initial < 1000);
try {
  for (const target of [1000, 10000]) {
    db.transaction(() => {
      while (initial + ids.length < target) {
        const i = ids.length,
          kind = kinds[i % 4];
        const id = `${kind}-${createHash("sha256")
          .update("archive-http-fixture-" + i)
          .digest("hex")}`;
        insert.run(
          id,
          kind,
          JSON.stringify({
            id,
            createdAt: 1,
            contextId: "archive-source",
            title: `研究性能 ${i}`,
            result: { title: `研究性能 ${i}` },
            evidence: { symbol: "sh600519" },
            dossier: { symbol: "sh600519" },
            frames: { symbol: "sh600519" },
          }),
          1,
        );
        ids.push(id);
      }
    })();
    assert.equal(count(), target);
    for (const [name, input] of [
      ["all", {}],
      ["filtered", { symbol: "sh600519", keyword: "研究" }],
    ]) {
      const samples = [];
      let bytes = 0,
        total = 0;
      for (let i = 0; i < 35; i++) {
        const start = performance.now();
        const response = await fetch(
          `${base}/api/trpc/researchArchiveHistory?input=${encodeURIComponent(SuperJSON.stringify(input))}`,
          {
            headers: { "x-quant-client": "workbench", origin: base },
            signal: AbortSignal.timeout(15000),
          },
        );
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const value = SuperJSON.deserialize(JSON.parse(text).result.data);
        if (i >= 5) samples.push(performance.now() - start);
        assert.equal(value.items.length, 20);
        bytes = Buffer.byteLength(text);
        total = value.filteredTotal;
        assert.ok(bytes < 32768);
        if (name === "all") assert.equal(total, target);
      }
      results.push({
        target,
        name,
        total,
        bytes,
        samples,
        p95: [...samples].sort((a, b) => a - b)[28],
      });
    }
  }
} finally {
  const remove = db.prepare("DELETE FROM records WHERE id=?");
  db.transaction(() => {
    for (const id of ids) remove.run(id);
  })();
  assert.equal(count(), initial);
  db.close();
}
writeFileSync(
  join(tmpdir(), "logs", "quant-research-archive", "http-performance.json"),
  JSON.stringify({ results, restoredCount: initial }, null, 2),
);
console.log(JSON.stringify(results.map(({ samples, ...value }) => value)));
