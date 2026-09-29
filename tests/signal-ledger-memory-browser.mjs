/** Chromium heap samples with explicit GC; not an OS RSS or leak-free guarantee. */
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
const rows = db
  .prepare(
    "SELECT id,payload FROM signal_ledger ORDER BY observed_date DESC,symbol,id LIMIT 20",
  )
  .all();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  db.transaction(() => {
    for (const [index, row] of rows.entries()) {
      const value = JSON.parse(row.payload);
      value.evidence = `${index}:完整合成证据;`.repeat(130000);
      db.prepare("UPDATE signal_ledger SET payload=? WHERE id=?").run(
        JSON.stringify(value),
        row.id,
      );
    }
  })();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await page.goto(base + "/signal-ledger");
  await page.locator("button[data-ledger-signal]").first().waitFor();
  const samples = [];
  async function sample(visits) {
    await cdp.send("HeapProfiler.collectGarbage");
    samples.push({ visits, ...(await cdp.send("Runtime.getHeapUsage")) });
  }
  await sample(0);
  for (let i = 0; i < 20; i++) {
    await page.locator("button[data-ledger-signal]").nth(i).click();
    await page
      .getByRole("button", { name: "导出完整信号依据", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "返回信号列表", exact: true })
      .click();
    await page.locator("button[data-ledger-signal]").first().waitFor();
    if ((i + 1) % 5 === 0) await sample(i + 1);
  }
  writeFileSync(
    join(tmpdir(), "logs", "quant-signal-ledger", "browser-memory.json"),
    JSON.stringify(
      {
        samples,
        browser: browser.version(),
        note: "20 distinct million-character evidence reads, gcTime=0; forced Chromium GC at each sample; do not compare with natural-GC latency or infer absence of all leaks",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  db.transaction(() => {
    for (const row of rows)
      db.prepare("UPDATE signal_ledger SET payload=? WHERE id=?").run(
        row.payload,
        row.id,
      );
  })();
  db.close();
}
