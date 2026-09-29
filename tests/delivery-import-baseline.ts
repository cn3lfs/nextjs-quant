import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/server/db/migrations";
import { DeliveryStore } from "../src/server/portfolio/delivery-store";
import { previewDeliveryImport } from "../src/server/portfolio/delivery-import-service";
import { deliveryBatchPage } from "../src/server/portfolio/delivery-workspace-query";

// In-memory only: importing this benchmark never opens the application database.
const db = new Database(":memory:");
migrate(db);
const store = new DeliveryStore(db);
const samples: Record<string, unknown>[] = [];
function measure(name: string, operation: () => unknown) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const result = operation();
    const elapsed = performance.now() - start;
    if (i >= 5) times.push(elapsed);
    bytes = Buffer.byteLength(JSON.stringify(result));
  }
  times.sort((a, b) => a - b);
  samples.push({
    name,
    n: times.length,
    p50: times[14],
    p95: times[28],
    bytes,
  });
}
try {
  const payload = JSON.stringify({
    mapping: {},
    diagnostics: [],
    unresolved: [],
    statistics: { fills: 0, cashFlows: 0, unresolved: 0, anomalies: 0 },
    rawRows: [["合成证据".repeat(350)]],
  });
  const insert = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  let previous = 0;
  for (const count of [100, 1000, 10000]) {
    db.transaction(() => {
      for (let i = previous; i < count; i++)
        insert.run(
          `batch-${i}`,
          "基线账户",
          "generic",
          `hash-${i}`,
          `${i}.csv`,
          i,
          payload,
        );
    })();
    previous = count;
    if (process.env.DELIVERY_COMPARE === "1")
      measure(`paged-batches-${count}`, () => {
        const page = deliveryBatchPage(db, {});
        assert.equal(page.items.length, 20);
        assert.ok(page.nextCursor);
        return page;
      });
    measure(`legacy-batches-${count}`, () => {
      const rows = store.batches().map(({ payload: value, ...batch }) => ({
        ...batch,
        statistics: value.statistics,
      }));
      assert.equal(rows.length, count);
      return rows;
    });
  }
  for (const count of [1000, 10000]) {
    const bytes = Buffer.from(
      [
        "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,成交编号",
        ...Array.from(
          { length: count },
          (_, i) => `20240301,600000,买入,10,100,1000,-1000,fixture-${i}`,
        ),
      ].join("\n"),
    );
    measure(`legacy-preview-${count}`, () => {
      const result = previewDeliveryImport(
        bytes,
        { account: "预览账户", source: "generic", fileName: "synthetic.csv" },
        db,
      );
      assert.equal(result.parsed.fills.length, count);
      assert.equal(result.summary.new, count);
      return result;
    });
    assert.equal(
      (db.prepare("SELECT count(*) n FROM trade_fills").get() as { n: number })
        .n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT count(*) n FROM cash_flows").get() as { n: number })
        .n,
      0,
    );
  }
  const output = {
    node: process.version,
    cpu: cpus()[0]?.model,
    ram: totalmem(),
    database: ":memory:",
    note: "Service timing excludes JSON serialization; bytes are uncompressed serialized output. Synthetic fixtures only; not HTTP/browser timings.",
    samples,
  };
  const logs = join(tmpdir(), "logs/quant-delivery-import");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    join(
      logs,
      process.env.DELIVERY_COMPARE === "1"
        ? "d1-service-comparison.json"
        : "d0-service-baseline.json",
    ),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output));
} finally {
  db.close();
}
