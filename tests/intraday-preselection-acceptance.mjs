/** Extended preselection UI acceptance; all database writes are isolated fixtures. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-intraday-"));
const base = process.env.BASE ?? "http://127.0.0.1:3221";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const dir = join(tmpdir(), "logs", "quant-intraday"),
  db = new Database(join(data, "quant.sqlite"));
db.pragma("busy_timeout=5000");
assert.equal(db.pragma("user_version", { simple: true }), 11);
const backup = db
  .prepare("SELECT * FROM records WHERE kind LIKE 'intraday-%'")
  .all();
const insert = db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [],
  errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  let historyRequests = 0,
    snapshotRequests = 0;
  let intradayReads = 0;
  page.on("request", (r) => {
    if (
      r.method() === "GET" &&
      /\/api\/trpc\//.test(r.url()) &&
      /intraday(?:Summary|History|Runs|Storage|Export|RunDetail)/.test(
        new URL(r.url()).pathname,
      )
    )
      intradayReads++;
    if (r.url().includes("intradayHistory")) historyRequests++;
    if (r.method() === "POST" && r.url().includes("/api/trpc/snapshot"))
      snapshotRequests++;
  });
  const observations = backup
    .filter((r) => r.kind === "intraday-preview")
    .sort((a, b) => b.updated_at - a.updated_at);
  assert.equal(observations.length, 41);
  const first = observations[0];
  const large = JSON.parse(first.payload);
  large.signals[0].evidence = "large-evidence-" + "x".repeat(1_000_000);
  insert.run(first.id, first.kind, JSON.stringify(large), first.updated_at);
  const filter = {};
  const url =
    base + "/intraday?preselect=" + encodeURIComponent(JSON.stringify(filter));
  await page.goto(url);
  await page
    .getByRole("button", { name: "查看依据", exact: true })
    .first()
    .waitFor();
  assert.equal(snapshotRequests, 0);
  checks.push("no unrelated initial market snapshot");
  const clickRow = () =>
    page.locator(`button[data-observation="${first.id}"]`).click();
  await clickRow();
  await page.getByRole("button", { name: "导出完整依据" }).waitFor();
  await page.getByText("原始行情与完整依据", { exact: true }).click();
  await page.getByText(/证据第 1 \/ /).waitFor();
  assert.ok((await page.locator("body").innerText()).length < 25000);
  const savedURL = await page.evaluate(() => {
    window.originalCreateURL = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw Error("fixture export failure");
    };
    return location.href;
  });
  await page.getByRole("button", { name: "导出完整依据" }).click();
  await page.getByText(/导出未成功/).waitFor();
  await page.evaluate(() => {
    URL.createObjectURL = window.originalCreateURL;
  });
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出完整依据" }).click();
  const download = await event;
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.equal(
    exported.observation.signals[0].evidence.length,
    large.signals[0].evidence.length,
  );
  await page.reload();
  await page.getByRole("button", { name: "返回结果", exact: true }).click();
  assert.equal(
    await page.locator(":focus").getAttribute("data-observation"),
    first.id,
  );
  checks.push(
    "large evidence segmented/full export/error retry/reload return focus",
  );
  for (let i = 0; i < 20; i++) {
    await page.locator("button[data-observation]").nth(i).click();
    await page.getByRole("button", { name: "导出完整依据" }).waitFor();
    await page.getByRole("button", { name: "返回结果", exact: true }).click();
  }
  await page.waitForTimeout(4500);
  const cache = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("guanlan-query-cache");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains("queries")) {
            d.close();
            resolve({ bytes: 0, detail: false });
            return;
          }
          const q = d.transaction("queries").objectStore("queries").get("trpc");
          q.onsuccess = () => {
            const t = q.result ?? "";
            d.close();
            resolve({
              bytes: new TextEncoder().encode(t).length,
              detail:
                t.includes("intradayExport") || t.includes("large-evidence-"),
            });
          };
        };
      }),
  );
  assert.equal(cache.detail, false);
  assert.ok(cache.bytes < 1_000_000);
  checks.push("20 detail round trips do not persist full evidence");
  await page.getByText("编辑参数", { exact: true }).click();
  await page.route("**/api/trpc/intradaySave*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.getByLabel("最低RPS", { exact: true }).fill("92");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByLabel("最低RPS", { exact: true }).fill("93");
  await page.getByText("设置已保存", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("最低RPS", { exact: true }).inputValue(),
    "93",
  );
  await page.getByText("RPS50 ≥ 92", { exact: true }).waitFor();
  await page.unroute("**/api/trpc/intradaySave*");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  checks.push("save response preserves edits made during save");
  const originalBatch = backup.find((row) => row.kind === "intraday-run");
  const batchValue = JSON.parse(originalBatch.payload);
  for (let i = 0; i < 120; i++) {
    const id = "intraday-run:" + i.toString(16).padStart(64, "0");
    insert.run(
      id,
      "intraday-run",
      JSON.stringify({
        ...batchValue,
        id,
        startedAt: Date.now() + i,
        config: { ...batchValue.config, minimumRps: 80 + i / 100 },
        status: i === 119 ? "partial" : "complete",
        pool: {
          ...batchValue.pool,
          rows:
            i === 119
              ? Array.from({ length: 25 }, () => ({
                  symbol: "sh600000",
                  rps: 95,
                }))
              : [],
        },
        results:
          i === 119
            ? Array.from({ length: 25 }, (_, index) => ({
                symbol: "sh600000",
                observationId: null,
                reason: `合成缺失原因 ${index}`,
              }))
            : [],
      }),
      Date.now() + i,
    );
  }
  await page.getByRole("button", { name: "刷新批次", exact: true }).click();
  await page.getByText("121批 · 第1页", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "配置与原因", exact: true })
    .first()
    .click();
  await page.getByText("逐证券原因", { exact: true }).click();
  await page.getByText("共 25 条 · 第 1 组", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一组原因", exact: true }).click();
  await page.getByText("SH600000：合成缺失原因 24", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "配置与原因", exact: true })
    .first()
    .click();
  for (let i = 2; i <= 7; i++) {
    await page.getByRole("button", { name: "下一批次页", exact: true }).click();
    await page.getByText(`121批 · 第${i}页`, { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "配置与原因", exact: true }).click();
  await page.getByText(/来源 tdx-local.*RPS50\s*≥\s*90/).waitFor();
  await page.getByRole("button", { name: "查看该批观测", exact: true }).click();
  await page.getByText(/匹配 41 条/).waitFor();
  checks.push(
    "121 batches reachable and historical configuration differs from current saved configuration",
  );
  await page.getByLabel("证券代码", { exact: true }).fill("sz000001");
  await page.getByLabel("证券代码", { exact: true }).press("Enter");
  await page.getByText(/当前范围没有观测记录/).waitFor();
  await page.getByRole("button", { name: "全部历史", exact: true }).click();
  await page.locator("button[data-observation]").first().waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 2 页 · 每页20条", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 3 页 · 每页20条", { exact: true }).waitFor();
  const lastId = await page
    .locator("button[data-observation]")
    .first()
    .getAttribute("data-observation");
  await page.locator("button[data-observation]").first().click();
  await page.getByRole("button", { name: "清理记录", exact: true }).click();
  const run = backup.find((r) => r.kind === "intraday-run"),
    running = JSON.parse(run.payload);
  running.status = "running";
  running.leaseUntil = Date.now() + 60000;
  insert.run(run.id, run.kind, JSON.stringify(running), run.updated_at);
  await page.getByRole("button", { name: "确认清理", exact: true }).click();
  await page.getByText(/批次仍在执行/).waitFor();
  assert.ok(db.prepare("SELECT id FROM records WHERE id=?").get(lastId));
  insert.run(run.id, run.kind, run.payload, run.updated_at);
  await page.getByRole("button", { name: "确认清理", exact: true }).click();
  await page.getByText("第 2 页 · 每页20条", { exact: true }).waitFor();
  assert.equal(
    db.prepare("SELECT id FROM records WHERE id=?").get(lastId),
    undefined,
  );
  await page.waitForFunction(() =>
    document.activeElement?.matches("button[data-observation]"),
  );
  await page.reload();
  await page.getByText("第 2 页 · 每页20条", { exact: true }).waitFor();
  checks.push(
    "active lease blocks cleanup; deleting last page retreats and persists",
  );
  await page.goto(
    base + "/intraday?observation=intraday-preview:" + "f".repeat(64),
  );
  await page.getByText(/预选记录不存在/).waitFor();
  await page.getByRole("button", { name: "返回结果", exact: true }).click();
  checks.push("missing detail recoverable");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: join(dir, `intraday-final-${width}.png`),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  checks.push("1440/1024/390 no document overflow");
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(1500);
  const hiddenStart = historyRequests;
  const hiddenReads = intradayReads;
  await page.waitForTimeout(60000);
  assert.equal(historyRequests - hiddenStart, 0);
  assert.equal(intradayReads - hiddenReads, 0);
  await page.locator('a[href="/intraday"]').first().click();
  await page.waitForTimeout(2000);
  const restored = historyRequests - hiddenStart;
  assert.ok(restored <= 1, `restore history requests ${restored}`);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1500);
  const documentHiddenReads = intradayReads;
  await page.waitForTimeout(60000);
  assert.equal(intradayReads - documentHiddenReads, 0);
  const beforeDocumentRestore = historyRequests;
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2000);
  assert.ok(historyRequests - beforeDocumentRestore <= 1);
  checks.push(
    "simulated document visibility hidden 60 seconds zero intraday reads",
  );
  await page.locator('a[href="/market"]').first().click();
  await page.waitForTimeout(1500);
  assert.equal(snapshotRequests, 1);
  checks.push(
    "hidden 60 seconds zero history requests; single restore refresh",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(dir, "browser-acceptance.json"),
    JSON.stringify({ checks, cache, errors, restored }, null, 2),
  );
} catch (error) {
  writeFileSync(
    join(dir, "browser-acceptance-failure.json"),
    JSON.stringify({ checks, errors, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  db.transaction(() => {
    db.prepare("DELETE FROM records WHERE kind LIKE 'intraday-%'").run();
    for (const row of backup)
      insert.run(row.id, row.kind, row.payload, row.updated_at);
  })();
  db.close();
}
