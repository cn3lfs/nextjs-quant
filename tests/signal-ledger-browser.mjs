/** Production UI acceptance, isolated database only, fixture mutations restored in finally. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signal-ledger-"));
const base = process.env.BASE ?? "http://127.0.0.1:3222";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const logs = join(tmpdir(), "logs", "quant-signal-ledger");
const db = new Database(join(directory, "quant.sqlite"));
db.pragma("busy_timeout=5000");
const signals = db.prepare("SELECT * FROM signal_ledger").all(),
  runs = db.prepare("SELECT * FROM signal_ledger_runs").all(),
  decisions = db
    .prepare("SELECT * FROM records WHERE kind='notification-decision'")
    .all();
assert.equal(signals.length, 121);
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  checks = [],
  errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  let reads = 0,
    historyReads = 0,
    analysisReads = 0,
    snapshots = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/api/trpc/") && /ledger[A-Z]/.test(url.pathname))
      reads++;
    if (url.pathname.includes("ledgerHistory")) historyReads++;
    if (url.pathname.includes("ledgerAnalysis")) analysisReads++;
    if (url.pathname.includes("snapshot")) snapshots++;
  });
  await page.goto(base + "/signal-ledger");
  await page.getByText(/匹配 121 条 · 待观察 49 · 有效 48 · 留空 24/).waitFor();
  assert.equal(snapshots, 0);
  assert.equal(analysisReads, 0);
  assert.equal(await page.locator("button[data-ledger-signal]").count(), 20);
  assert.equal(
    await page
      .getByRole("button", { name: "最近30交易日", exact: true })
      .isDisabled(),
    true,
  );
  for (let i = 2; i <= 7; i++) {
    await page.getByRole("button", { name: "下一页信号", exact: true }).click();
    await page
      .getByText(`121条信号 · 第${i}页 · 每页20条`, { exact: true })
      .waitFor();
    await page.locator("button[data-ledger-signal]").first().waitFor();
  }
  assert.equal(await page.locator("button[data-ledger-signal]").count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "下一页信号", exact: true })
      .isDisabled(),
    true,
  );
  const selected = await page
    .locator("button[data-ledger-signal]")
    .first()
    .getAttribute("data-ledger-signal");
  await page.locator("button[data-ledger-signal]").first().click();
  await page
    .getByRole("button", { name: "导出完整信号依据", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "导出完整信号依据", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "返回信号列表", exact: true }).click();
  await page
    .getByText("121条信号 · 第7页 · 每页20条", { exact: true })
    .waitFor();
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-ledger-signal") === id,
    selected,
  );
  checks.push(
    "121 signals across 7 pages, whole-filter stats, detail reload and focus restoration",
  );
  await page.getByRole("button", { name: "全部历史", exact: true }).click();
  await page.locator("button[data-ledger-signal]").first().waitFor();
  await page.getByLabel("证券代码", { exact: true }).fill("sz000001");
  await page.getByLabel("证券代码", { exact: true }).press("Enter");
  await page
    .getByText("当前筛选没有匹配信号，请调整条件。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "全部历史", exact: true }).click();
  await page.getByText(/匹配 121 条/).waitFor();
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await page.getByRole("combobox", { name: "结果状态", exact: true }).click();
  await page.getByRole("option", { name: "已固定·留空", exact: true }).click();
  await page.getByRole("button", { name: "查询信号", exact: true }).click();
  await page.getByText(/匹配 24 条 · 待观察 0 · 有效 0 · 留空 24/).waitFor();
  await page.getByRole("button", { name: "全样本分析", exact: true }).click();
  await page.getByText(/样本121条/).waitFor();
  assert.equal(analysisReads, 1);
  const filteredUrl = page.url();
  await page.getByRole("button", { name: "下一组分析", exact: true }).click();
  await page
    .getByRole("region", { name: "信息含量", exact: true })
    .getByText("第 2 / 4 页", { exact: true })
    .waitFor();
  assert.equal(page.url(), filteredUrl);
  await page.getByText(/匹配 24 条 · 待观察 0 · 有效 0 · 留空 24/).waitFor();
  checks.push(
    "empty filter and settled blanks distinct; full analytics remains 121 regardless of filter",
  );
  await page.getByRole("button", { name: "全样本分析", exact: true }).click();
  await page.getByRole("button", { name: "全部历史", exact: true }).click();
  await page.getByText(/匹配 121 条/).waitFor();
  const original = signals.find((row) => row.id === "fixture:000004"),
    large = JSON.parse(original.payload);
  large.evidence = "完整合成证据".repeat(180000);
  db.prepare("UPDATE signal_ledger SET payload=? WHERE id=?").run(
    JSON.stringify(large),
    large.id,
  );
  await page.goto(
    base + "/signal-ledger?signal=" + encodeURIComponent(large.id),
  );
  await page
    .getByRole("button", { name: "导出完整信号依据", exact: true })
    .waitFor();
  await page.getByText("结构证据", { exact: true }).click();
  await page.getByText(/证据第 1 \/ /).waitFor();
  assert.ok((await page.locator("body").innerText()).length < 40000);
  await page.evaluate(() => {
    window.originalObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw new Error("fixture export failure");
    };
  });
  await page
    .getByRole("button", { name: "导出完整信号依据", exact: true })
    .click();
  await page.getByText(/导出未成功/).waitFor();
  await page.evaluate(() => {
    URL.createObjectURL = window.originalObjectURL;
  });
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出完整信号依据", exact: true })
    .click();
  const download = await downloaded;
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.equal(exported.signal.evidence, large.evidence);
  assert.equal(exported.schemaVersion, 1);
  db.prepare("UPDATE signal_ledger SET payload=? WHERE id=?").run(
    original.payload,
    original.id,
  );
  checks.push(
    "million-character evidence bounded rendering and complete export with retry",
  );
  await page.getByRole("button", { name: "返回信号列表", exact: true }).click();
  await page.locator("button[data-ledger-signal]").first().waitFor();
  for (let i = 0; i < 20; i++) {
    await page.locator("button[data-ledger-signal]").nth(i).click();
    await page
      .getByRole("button", { name: "导出完整信号依据", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "返回信号列表", exact: true })
      .click();
    await page.locator("button[data-ledger-signal]").first().waitFor();
  }
  const persisted = await page.evaluate(async () => {
    const out = [];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of db.objectStoreNames) {
        const values = await new Promise((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        out.push(...values);
      }
      db.close();
    }
    return JSON.stringify(out);
  });
  assert.ok(!persisted.includes("完整合成证据"));
  assert.ok(!persisted.includes("ledgerDetail"));
  assert.ok(persisted.length < 1000000);
  checks.push("20 evidence round trips excluded from persistent cache");
  const task = runs.find((row) => row.date === "2025-01-01"),
    active = JSON.parse(task.payload);
  active.status = "running";
  active.errors = Array.from({ length: 25 }, (_, i) => ({
    symbol: "sh600000",
    reason: `fixture reason ${i}`,
  }));
  db.prepare("UPDATE signal_ledger_runs SET payload=? WHERE date=?").run(
    JSON.stringify(active),
    active.date,
  );
  await page.getByRole("button", { name: "刷新台账", exact: true }).click();
  await page
    .getByRole("button", {
      name: `取消台账任务（${active.date}）`,
      exact: true,
    })
    .click();
  await page
    .getByText("取消已请求，等待后台结束当前步骤。", { exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(
      db
        .prepare("SELECT payload FROM signal_ledger_runs WHERE date=?")
        .get(active.date).payload,
    ).cancelRequested,
    true,
  );
  await page
    .getByRole("button", {
      name: `取消台账任务（${active.date}）`,
      exact: true,
    })
    .click();
  await page
    .getByText("已请求取消，仍在等待后台确认。", { exact: true })
    .waitFor();
  active.status = "complete";
  db.prepare("UPDATE signal_ledger_runs SET payload=? WHERE date=?").run(
    JSON.stringify(active),
    active.date,
  );
  await page
    .getByRole("button", {
      name: `取消台账任务（${active.date}）`,
      exact: true,
    })
    .click();
  await page.getByText("任务已结束，无需取消。", { exact: true }).waitFor();
  checks.push(
    "cancel request, repeat and finished race return distinct truthful results",
  );
  await page.getByRole("button", { name: "每日任务历史", exact: true }).click();
  await page
    .getByText("122条任务 · 第1页 · 每页20条", { exact: true })
    .waitFor();
  for (let i = 2; i <= 7; i++) {
    await page.getByRole("button", { name: "下一页任务", exact: true }).click();
    await page
      .getByText(`122条任务 · 第${i}页 · 每页20条`, { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "查看任务依据", exact: true })
      .first()
      .waitFor();
  }
  await page
    .getByRole("button", { name: "查看任务依据", exact: true })
    .last()
    .click();
  await page.getByText("共25条原因 · 第1组", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一组原因", exact: true }).click();
  await page
    .getByText("sh600000：fixture reason 24", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "每日任务历史", exact: true }).click();
  const exemplar = JSON.parse(decisions[0].payload);
  const insert = db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)");
  for (let i = 0; i < 96; i++) {
    const id = `browser:decision:${i}`;
    insert.run(
      id,
      "notification-decision",
      JSON.stringify({ ...exemplar, id, createdAt: 1 }),
      1,
    );
  }
  await page.getByRole("button", { name: "投递决策历史", exact: true }).click();
  await page
    .getByText("121条决策 · 第1页 · 每页20条", { exact: true })
    .waitFor();
  for (let i = 2; i <= 7; i++) {
    await page.getByRole("button", { name: "下一页决策", exact: true }).click();
    await page
      .getByText(`121条决策 · 第${i}页 · 每页20条`, { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "查看决策依据", exact: true })
      .first()
      .waitFor();
  }
  await page.getByRole("button", { name: "查看决策依据", exact: true }).click();
  await page
    .getByRole("region", { name: "决策依据", exact: true })
    .getByText(/未入队/)
    .waitFor();
  await page.getByRole("button", { name: "投递决策历史", exact: true }).click();
  checks.push(
    "122 task dates, paged reasons and 121 unmatched notification decisions reachable",
  );
  await page.goto(base + "/signal-ledger?signal=missing");
  await page.getByText(/信号记录不存在/).waitFor();
  await page.getByRole("button", { name: "返回信号列表", exact: true }).click();
  await page.locator("button[data-ledger-signal]").first().waitFor();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: join(logs, `after-${width}.png`),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  checks.push("missing detail recovery and responsive widths");
  await page.waitForTimeout(2000);
  const idleHistory = historyReads,
    idleAnalysis = analysisReads;
  await page.waitForTimeout(60000);
  assert.equal(historyReads, idleHistory);
  assert.equal(analysisReads, idleAnalysis);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1500);
  const hidden = reads;
  await page.waitForTimeout(60000);
  assert.equal(reads, hidden);
  const beforeRestore = historyReads;
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2000);
  assert.ok(historyReads - beforeRestore <= 1);
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(1500);
  const routed = reads;
  await page.waitForTimeout(60000);
  assert.equal(reads, routed);
  checks.push(
    "idle no history/analysis polling; simulated hidden and route hidden 60 seconds zero ledger reads",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "browser-after.json"),
    JSON.stringify(
      {
        checks,
        errors,
        persistedBytes: persisted.length,
        restored: historyReads - beforeRestore,
      },
      null,
      2,
    ),
  );
} catch (error) {
  writeFileSync(
    join(logs, "browser-failure.json"),
    JSON.stringify({ checks, errors, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  db.transaction(() => {
    for (const row of signals)
      db.prepare("UPDATE signal_ledger SET payload=? WHERE id=?").run(
        row.payload,
        row.id,
      );
    for (const row of runs)
      db.prepare("INSERT OR REPLACE INTO signal_ledger_runs VALUES(?,?)").run(
        row.date,
        row.payload,
      );
    db.prepare("DELETE FROM records WHERE kind='notification-decision'").run();
    const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
    for (const row of decisions)
      insert.run(row.id, row.kind, row.payload, row.updated_at);
  })();
  db.close();
}
