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
    child === "quant-cash-reconciliation-pressure",
);
const { sqlite } = await import("../src/server/db");
const { commitDeliveryImport } =
  await import("../src/server/portfolio/delivery-import-service");
const db = sqlite();
for (const table of ["import_batches", "cash_flows", "trade_fills", "records"])
  assert.equal(
    (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
    0,
  );
const calendar = Array.from({ length: 10000 }, (_, i) =>
  new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10),
);
const header =
  "日期,时间,操作,摘要,证券代码,成交价格,成交数量,发生金额,资金余额";
const row = (date: string, balance: number | null, amount = 1) => [
  date.replaceAll("-", ""),
  "090000",
  "其他",
  "银行转存",
  "",
  "",
  "",
  String(amount),
  balance === null ? "" : String(balance),
];
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function base(account: string, rows: string[][]) {
  const imported = commitDeliveryImport(
    Buffer.from([header, ...rows.map((row) => row.join(","))].join("\n")),
    {
      account,
      source: "generic",
      fileName: `${account}.csv`,
      scope: "cashFlowsOnly",
    },
    db,
  );
  return JSON.parse(
    (
      db
        .prepare("SELECT payload FROM import_batches WHERE id=?")
        .get(imported.batchId) as { payload: string }
    ).payload,
  ) as Record<string, unknown>;
}
function evidence(
  account: string,
  id: string,
  template: Record<string, unknown>,
  rows: string[][],
) {
  // Synthetic retained-evidence batches have no owned ledger events. All cash
  // flows are imported above through the normal parser; these rows test reading.
  db.prepare("INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)").run(
    id,
    account,
    "generic",
    digest(rows),
    `${id}.csv`,
    1,
    JSON.stringify({
      ...template,
      rawRows: rows,
      statementOpeningCash: 0,
      receipt: { fills: 0, cashFlows: 0, duplicate: 0 },
      statistics: { fills: 0, cashFlows: 0, unresolved: 0, anomalies: 0 },
    }),
  );
}
const stress = "现金万日期";
const stressTemplate = base(
  stress,
  calendar.map((date, i) =>
    row(date, i % 4 === 2 ? null : i + 1 + (i % 4 === 1 ? 0.01 : 0)),
  ),
);
evidence(
  stress,
  "cash-pressure-conflicts",
  stressTemplate,
  calendar.flatMap((date, i) => (i % 4 === 3 ? [row(date, i + 2)] : [])),
);
const large = "现金大证据";
const largeTemplate = base(
  large,
  calendar.slice(0, 20).map((date, i) => row(date, i + 1)),
);
const largeRows = calendar
  .slice(0, 20)
  .flatMap((date) => Array.from({ length: 20000 }, (_, j) => row(date, j + 1)));
evidence(large, "cash-pressure-large", largeTemplate, largeRows);
const sources = "现金千来源";
const sourceTemplate = base(sources, [row(calendar[0]!, 1)]);
db.transaction(() => {
  for (let i = 1; i < 1000; i++)
    evidence(sources, `cash-pressure-source-${i}`, sourceTemplate, [
      [...row(calendar[0]!, (i % 2) + 1), String(i)],
    ]);
})();
// Extra unmapped cell makes each file hash distinct without inventing cash rows.
db.prepare("INSERT INTO records VALUES('settings','settings',?,1)").run(
  JSON.stringify({ tdxRoot: join(directory, "missing-tdx"), calendar }),
);
const facts = Object.fromEntries(
  ["import_batches", "trade_fills", "cash_flows", "records"].map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  ]),
);
const manifest = {
  directory,
  accounts: { stress, large, sources },
  calendar,
  hash: digest(facts),
  counts: Object.fromEntries(
    Object.entries(facts).map(([table, rows]) => [table, rows.length]),
  ),
  expectedStress: {
    days: 10000,
    matched: 2500,
    difference: 2500,
    unavailable: 2500,
    conflict: 2500,
  },
  large: { dates: 20, rowsPerSource: 20000 },
  sourceCount: 1000,
  source:
    "synthetic dates, imported cash movements and retained evidence fixtures",
};
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
mkdirSync(logs, { recursive: true });
writeFileSync(join(logs, "q3-fixture.json"), JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify({
    ...manifest,
    calendar: `${calendar[0]}..${calendar.at(-1)}`,
  }),
);
db.close();
