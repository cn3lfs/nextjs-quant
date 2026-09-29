import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signal-ledger-"));
const base = process.env.BASE ?? "http://127.0.0.1:3222";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const db = new Database(join(directory, "quant.sqlite"));
db.pragma("busy_timeout=5000");
const date = "2025-01-01",
  id = "fixture:000000";
const beforeRun = db
  .prepare("SELECT payload FROM signal_ledger_runs WHERE date=?")
  .get(date);
const beforeOutcomes = db
  .prepare("SELECT * FROM signal_ledger_outcomes WHERE signal_id=?")
  .all(id);
const run = JSON.parse(beforeRun.payload);
run.status = "running";
delete run.cancelRequested;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  db.prepare("UPDATE signal_ledger_runs SET payload=? WHERE date=?").run(
    JSON.stringify(run),
    date,
  );
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(base + "/signal-ledger?signal=" + encodeURIComponent(id));
  await page
    .getByRole("button", { name: `取消台账任务（${date}）`, exact: true })
    .waitFor();
  await page
    .getByRole("region", { name: "T+5结果", exact: true })
    .getByText("T+5：待观察", { exact: true })
    .waitFor();
  const sample = JSON.parse(
    db
      .prepare(
        "SELECT payload FROM signal_ledger_outcomes WHERE settled=1 AND json_extract(payload,'$.returnPct') IS NOT NULL LIMIT 1",
      )
      .get().payload,
  );
  db.prepare(
    "INSERT OR REPLACE INTO signal_ledger_outcomes VALUES(?,?,?,?)",
  ).run(
    id,
    5,
    1,
    JSON.stringify({
      ...sample,
      horizon: 5,
      settled: true,
      returnPct: 33,
      reasons: [],
    }),
  );
  run.status = "complete";
  db.prepare("UPDATE signal_ledger_runs SET payload=? WHERE date=?").run(
    JSON.stringify(run),
    date,
  );
  await page
    .getByRole("region", { name: "T+5结果", exact: true })
    .getByText("T+5：33.00% · 已固定·有效", { exact: true })
    .waitFor();
  writeFileSync(
    join(tmpdir(), "logs", "quant-signal-ledger", "browser-refresh.json"),
    JSON.stringify({ completedRunRefreshesOpenDetail: true }),
  );
} finally {
  await browser.close();
  db.transaction(() => {
    db.prepare("UPDATE signal_ledger_runs SET payload=? WHERE date=?").run(
      beforeRun.payload,
      date,
    );
    db.prepare("DELETE FROM signal_ledger_outcomes WHERE signal_id=?").run(id);
    const insert = db.prepare(
      "INSERT INTO signal_ledger_outcomes VALUES(?,?,?,?)",
    );
    for (const row of beforeOutcomes)
      insert.run(row.signal_id, row.horizon, row.settled, row.payload);
  })();
  db.close();
}
