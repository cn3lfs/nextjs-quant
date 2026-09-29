import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { previewDeliveryImport } from "../src/server/portfolio/delivery-import-service";

const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
const child = relative(resolve(tmpdir()), directory);
assert.ok(
  !isAbsolute(child) &&
    !child.startsWith("..") &&
    child.startsWith("quant-delivery-import-"),
);
const { sqlite } = await import("../src/server/db");
const db = sqlite();
try {
  for (const table of [
    "import_batches",
    "trade_fills",
    "cash_flows",
    "records",
  ])
    assert.equal(
      (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
      0,
      "fresh isolated database required",
    );
  const files = join(directory, "synthetic-files");
  mkdirSync(files, { recursive: true });
  const rows = Array.from(
    { length: 10000 },
    (_, i) => `20240301,600000,买入,10,100,1000,-1000,fixture-${i}`,
  );
  const content = Buffer.from(
    [
      "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,成交编号",
      ...rows,
    ].join("\n"),
  );
  writeFileSync(join(files, "large.csv"), content);
  const preview = previewDeliveryImport(
    content,
    { account: "合成账户", source: "generic", fileName: "large.csv" },
    db,
  );
  assert.equal(preview.summary.new, 10000);
  const payload = JSON.stringify({
    mapping: preview.mapping,
    diagnostics: [],
    unresolved: [],
    statistics: { fills: 100, cashFlows: 0, unresolved: 0, anomalies: 0 },
    rawRows: preview.rawRows.slice(0, 100),
  });
  const insert = db.prepare(
    "INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 1000; i++)
      insert.run(
        `fixture-batch-${String(i).padStart(5, "0")}`,
        "合成历史账户",
        "generic",
        createHash("sha256").update(`fixture-${i}`).digest("hex"),
        `history-${i}.csv`,
        1700000000000 + i,
        payload,
      );
  })();
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
      ),
    )
    .digest("hex");
  const logs = join(tmpdir(), "logs/quant-delivery-import");
  mkdirSync(logs, { recursive: true });
  const manifest = {
    directory,
    files,
    batches: 1000,
    fills: 0,
    cashFlows: 0,
    hash,
    fileHash: createHash("sha256").update(content).digest("hex"),
  };
  writeFileSync(join(logs, "fixture.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
} finally {
  db.close();
}
