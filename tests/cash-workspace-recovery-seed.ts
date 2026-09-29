import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(
  readFileSync(join(logs, "q3-fixture.json"), "utf8"),
) as { directory: string; calendar: string[] };
assert.equal(
  resolve(process.env.QUANT_DATA_DIR ?? ""),
  resolve(fixture.directory),
);
assert.equal(
  resolve(fixture.directory),
  resolve(join(tmpdir(), "quant-cash-reconciliation-pressure")),
);
const { sqlite } = await import("../src/server/db");
const { commitDeliveryImport } =
  await import("../src/server/portfolio/delivery-import-service");
const db = sqlite(),
  account = "现金恢复";
assert.equal(
  (
    db
      .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
      .get(account) as { n: number }
  ).n,
  0,
);
const ids = [];
for (let part = 0; part < 2; part++) {
  const rows = fixture.calendar
    .slice(part * 20, (part + 1) * 20)
    .map(
      (date, i) =>
        `${date.replaceAll("-", "")},090000,其他,银行转存,,,,1,${part * 20 + i + 1}`,
    );
  const result = commitDeliveryImport(
    Buffer.from(
      [
        "日期,时间,操作,摘要,证券代码,成交价格,成交数量,发生金额,资金余额",
        ...rows,
      ].join("\n"),
    ),
    {
      account,
      source: "generic",
      fileName: `cash-recovery-${part}.csv`,
      scope: "cashFlowsOnly",
    },
    db,
  );
  ids.push(result.batchId);
}
const facts = Object.fromEntries(
  ["import_batches", "trade_fills", "cash_flows"].map((table) => [
    table,
    db
      .prepare(`SELECT * FROM ${table} WHERE account=? ORDER BY id`)
      .all(account),
  ]),
);
const manifest = {
  directory: fixture.directory,
  account,
  ids,
  hash: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  dates: fixture.calendar.slice(0, 40),
};
writeFileSync(
  join(logs, "q3-recovery-fixture.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest));
db.close();
