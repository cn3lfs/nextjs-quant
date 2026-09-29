/** Isolated large-evidence acceptance and forced-GC samples, not a universal leak proof. */
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
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-news-"));
const base = process.env.BASE ?? "http://127.0.0.1:3223";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const db = new Database(join(directory, "quant.sqlite")),
  source = new Database(join(directory, "news.sqlite"));
db.pragma("busy_timeout=5000");
source.pragma("busy_timeout=5000");
const rows = source
  .prepare("SELECT id,content FROM news ORDER BY ctime DESC,id DESC LIMIT 20")
  .all();
const row = db
  .prepare(
    "SELECT id,payload FROM records WHERE kind='news-analysis' ORDER BY updated_at DESC LIMIT 1",
  )
  .get();
const original = JSON.parse(row.payload),
  report = structuredClone(original);
report.news = Array.from({ length: 1000 }, (_, i) => ({
  ...original.news[0],
  id: i + 1,
  hash: `fixture-${i}`,
  content: i === 0 ? "压力原文".repeat(250000) : "合成原文",
}));
report.items = report.news.map((n) => ({ ...original.items[0], id: n.id }));
report.distribution = { 未确定: 1000 };
report.status = "complete";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  source.transaction(() => {
    for (const item of rows)
      source
        .prepare("UPDATE news SET content=? WHERE id=?")
        .run(`${item.id}:` + "压力原文".repeat(250000), item.id);
  })();
  db.prepare("UPDATE records SET payload=? WHERE id=?").run(
    JSON.stringify(report),
    row.id,
  );
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const filter = {
    cutoff: Date.parse("2025-01-07T16:00:00+08:00"),
    query: "",
    historical: true,
  };
  await page.goto(
    base + "/news?newsQuery=" + encodeURIComponent(JSON.stringify(filter)),
  );
  await page.locator("[data-news-original]").first().waitFor();
  const samples = [];
  async function sample(visits) {
    await cdp.send("HeapProfiler.collectGarbage");
    samples.push({ visits, ...(await cdp.send("Runtime.getHeapUsage")) });
  }
  await sample(0);
  for (let i = 0; i < 20; i++) {
    await page.locator("[data-news-original]").nth(i).click();
    await page
      .getByRole("button", { name: "下载完整新闻原文", exact: true })
      .waitFor();
    assert.ok((await page.locator("pre").innerText()).length <= 8000);
    if (i === 0) {
      await page.evaluate(() => {
        const original = URL.createObjectURL;
        URL.createObjectURL = () => {
          URL.createObjectURL = original;
          throw new Error("synthetic export failure");
        };
      });
      await page
        .getByRole("button", { name: "下载完整新闻原文", exact: true })
        .click();
      await page
        .getByRole("alert")
        .getByText("导出未成功，请重试导出；原始报告未被修改。", {
          exact: true,
        })
        .waitFor();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "下载完整新闻原文", exact: true })
        .click();
      const data = JSON.parse(
        readFileSync(await (await download).path(), "utf8"),
      );
      assert.ok(data.item.content.length >= 1000000);
    }
    await page
      .getByRole("button", { name: "返回新闻列表", exact: true })
      .click();
    await page.locator("[data-news-original]").first().waitFor();
    if ((i + 1) % 5 === 0) await sample(i + 1);
  }
  await page.goto(base + "/news?analysis=" + row.id);
  await page.getByText("1000条 · 第1页", { exact: true }).waitFor();
  assert.equal(await page.locator("article").count(), 20);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载新闻分析与原文", exact: true })
    .click();
  const exported = JSON.parse(
    readFileSync(await (await download).path(), "utf8"),
  );
  assert.equal(exported.format, "quant-news-analysis-export-1");
  assert.equal(exported.items.length, 1000);
  assert.equal(exported.news[0].content.length, 1000000);
  await page.getByText("原文依据 1", { exact: true }).click();
  assert.equal((await page.locator("pre").first().innerText()).length, 8000);
  await page.getByRole("button", { name: "下一页分类", exact: true }).click();
  await page.getByText("1000条 · 第2页", { exact: true }).waitFor();
  assert.equal(await page.locator("article").count(), 20);
  await page
    .getByText("行业分布（全部已完成条目）：未确定 1000条", { exact: true })
    .waitFor();
  const persisted = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("guanlan-query-cache");
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("queries")) {
            db.close();
            resolve("");
            return;
          }
          const read = db
            .transaction("queries")
            .objectStore("queries")
            .get("trpc");
          read.onsuccess = () => {
            resolve(read.result ?? "");
            db.close();
          };
          read.onerror = () => {
            resolve("");
            db.close();
          };
        };
        request.onerror = () => resolve("");
      }),
  );
  assert.ok(!persisted.includes("压力原文"));
  assert.ok(!persisted.includes("newsOriginal"));
  assert.ok(!persisted.includes("newsAnalysis"));
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs", "quant-news", "browser-memory.json"),
    JSON.stringify(
      {
        samples,
        persistedBytes: Buffer.byteLength(persisted),
        millionCharacterFullExport: true,
        exportFailureRetry: true,
        analysis1000Bounded20: true,
        errors,
        browser: browser.version(),
        note: "20 distinct million-character source reads with forced Chromium GC; source/archive payloads restored in finally; no model",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  source.transaction(() => {
    for (const item of rows)
      source
        .prepare("UPDATE news SET content=? WHERE id=?")
        .run(item.content, item.id);
  })();
  db.prepare("UPDATE records SET payload=? WHERE id=?").run(
    row.payload,
    row.id,
  );
  source.close();
  db.close();
}
