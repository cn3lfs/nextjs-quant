import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
const child = relative(resolve(tmpdir()), directory);
assert.ok(
  !isAbsolute(child) &&
    !child.startsWith("..") &&
    child.startsWith("quant-cash-reconciliation-"),
);
const { sqlite } = await import("../src/server/db");
const { commitDeliveryImport } =
  await import("../src/server/portfolio/delivery-import-service");
const db = sqlite();
for (const table of ["import_batches", "trade_fills", "cash_flows", "records"])
  assert.equal(
    (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
    0,
    "fresh isolated database required",
  );
const calendar = Array.from({ length: 1000 }, (_, i) =>
  new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
);
const account = "现金基线";
const header =
  "日期,时间,操作,摘要,证券代码,成交价格,成交数量,发生金额,资金余额";
const rows: string[] = [];
let balance = 0;
for (let i = 0; i < calendar.length; i++) {
  const count = i === 0 ? 20000 : 1;
  for (let j = 0; j < count; j++) {
    balance++;
    rows.push(
      `${calendar[i]!.replaceAll("-", "")},090000,其他,银行转存,,,,1,${balance}`,
    );
  }
}
commitDeliveryImport(
  Buffer.from([header, ...rows].join("\n")),
  {
    account,
    source: "generic",
    fileName: "synthetic-cash.csv",
    scope: "cashFlowsOnly",
  },
  db,
);
db.prepare("INSERT INTO records VALUES('settings','settings',?,1)").run(
  JSON.stringify({ tdxRoot: join(directory, "missing-tdx"), calendar }),
);
const facts = Object.fromEntries(
  ["import_batches", "trade_fills", "cash_flows", "records"].map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  ]),
);
const hash = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
mkdirSync(logs, { recursive: true });
const manifest = {
  directory,
  account,
  days: calendar.length,
  rows: rows.length,
  hash,
  counts: Object.fromEntries(
    Object.entries(facts).map(([table, values]) => [table, values.length]),
  ),
  source: "synthetic calendar and cash movements, no external data",
};
writeFileSync(join(logs, "q0-fixture.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
db.close();
