import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { migrate } from "../src/server/db/migrations";
import { DeliveryPreviewWorkspace } from "../src/server/portfolio/delivery-preview-workspace";
assert.equal(typeof global.gc, "function", "run node --expose-gc --import tsx");
const db = new Database(":memory:");
migrate(db);
const directory = mkdtempSync(join(tmpdir(), "quant-delivery-cache-"));
const workspace = new DeliveryPreviewWorkspace(),
  samples: unknown[] = [];
const file = join(directory, "synthetic.csv");
const rows = Array.from(
  { length: 10000 },
  (_, i) => `20240301,600000,买入,10,100,1000,-1000,row-${i}`,
);
writeFileSync(
  file,
  [
    "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,成交编号",
    ...rows,
  ].join("\n"),
);
function sample(visits: number) {
  global.gc!();
  samples.push({ visits, ...process.memoryUsage(), cache: workspace.stats() });
}
try {
  sample(0);
  let firstToken = "";
  for (let i = 0; i < 35; i++) {
    const preview = await workspace.start(db, {
      path: file,
      account: `缓存合成-${i % 20}`,
      source: "generic",
    });
    if (i === 0) firstToken = preview.token;
    const page = await workspace.page(db, {
      token: preview.token,
      offset: 9980,
    });
    assert.equal(page.items.length, 20);
    assert.ok(workspace.stats().count <= 4);
    assert.ok(workspace.stats().bytes <= 64 * 1048576);
    if ([5, 10, 20, 30, 35].includes(i + 1)) sample(i + 1);
  }
  await assert.rejects(
    () => workspace.page(db, { token: firstToken }),
    /预览已过期/,
  );
  workspace.dispose();
  sample(36);
  assert.deepEqual(workspace.stats(), { count: 0, bytes: 0 });
  const small = new DeliveryPreviewWorkspace({
    count: 4,
    bytes: 1,
    ttl: 600000,
  });
  const started = performance.now();
  try {
    const preview = await small.start(db, {
      path: file,
      account: "超预算合成",
      source: "generic",
    });
    assert.equal(preview.cached, false);
    const page = await small.page(db, { token: preview.token, offset: 9980 });
    assert.equal(page.items.length, 20);
    const all = await small.export(db, preview.token);
    assert.equal(all.preview.rawRows.length, 10000);
    assert.equal(small.stats().bytes, 0);
  } finally {
    small.dispose();
  }
  const reparseMs = performance.now() - started;
  for (const table of ["trade_fills", "cash_flows", "import_batches"])
    assert.equal(
      (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
      0,
    );
  const report = {
    samples,
    reparseMs,
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    scope:
      "isolated in-memory SQLite, 20 accounts, 35 large previews, real forced Node GC; serialized cache budget is not heap size",
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-delivery-import/workspace-server-memory.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  workspace.dispose();
  db.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(
    !isAbsolute(child) &&
      !child.startsWith("..") &&
      child.startsWith("quant-delivery-cache-"),
  );
  rmSync(directory, { recursive: true, force: true });
}
