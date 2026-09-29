import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const logs = join(tmpdir(), "logs/quant-cls-review");
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3224/cls-review");
  const list = page.getByLabel("报告列表", { exact: true });
  await list.getByRole("button").first().waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const heaps = [];
  async function heap(visits) {
    await cdp.send("HeapProfiler.collectGarbage");
    heaps.push({ visits, ...(await cdp.send("Runtime.getHeapUsage")) });
  }
  await heap(0);
  const timings = [];
  for (let i = 0; i < 35; i++) {
    const index = 2019 - (i % 20),
      start = performance.now();
    await list
      .getByRole("button", { name: new RegExp(`合成报告 ${index} ·`) })
      .click();
    await page
      .getByRole("heading", { name: `合成报告 ${index}`, exact: true })
      .waitFor();
    await page
      .getByRole("textbox", { name: "事实原文摘录", exact: true })
      .waitFor();
    if (i >= 5) timings.push(performance.now() - start);
    if (i === 0) {
      await page.getByText("完整已保存原文", { exact: true }).click();
      assert.ok((await page.locator("pre").innerText()).length <= 8001);
      await page
        .getByRole("button", { name: "完整原文下一段", exact: true })
        .click();
      await page.getByText(/完整原文第 2 \/ /).waitFor();
      await page.screenshot({
        path: join(logs, "large-report-1440.png"),
        fullPage: true,
      });
    }
    await page
      .getByRole("button", { name: "返回报告列表", exact: true })
      .click();
    if ([4, 9, 19, 34].includes(i)) await heap(i + 1);
  }
  timings.sort((a, b) => a - b);
  await list.getByRole("button", { name: /合成报告 2000 ·/ }).click();
  await page.getByText(/全报告当前结论：支持 5000/).waitFor();
  const facts = page.getByRole("region", { name: "事实核对记录", exact: true });
  assert.equal(await facts.locator("article").count(), 20);
  await facts.getByRole("button", { name: "下一页", exact: true }).click();
  await facts.getByText("第 2 页", { exact: true }).waitFor();
  await page.getByText(/全报告当前结论：支持 5000/).waitFor();
  await page.getByRole("button", { name: "报告信息", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出报告与全部关联复盘", exact: true })
    .click();
  const downloaded = await pending;
  const exported = JSON.parse(readFileSync(await downloaded.path(), "utf8"));
  assert.equal(exported.facts.length, 10000);
  assert.ok(
    Buffer.byteLength(exported.report.report.markdown) > 2 * 1024 * 1024 - 1000,
  );
  const persisted = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("guanlan-query-cache");
        request.onerror = () => reject(request.error);
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
            resolve(JSON.stringify(read.result ?? ""));
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
  assert.ok(
    !persisted.includes("clsReviewExport") &&
      !persisted.includes("clsReviewFactDetail") &&
      !persisted.includes("clsReviewVerificationDetail"),
  );
  const result = {
    browser: browser.version(),
    p50: timings[15],
    p95: timings[28],
    heaps,
    errors,
    largeExportBytes: Buffer.byteLength(exported.report.report.markdown),
    exportedFacts: exported.facts.length,
    persistedEvidence: false,
  };
  writeFileSync(
    join(logs, "stress-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.ok(timings[28] <= 1000, "large report opening <= 1 second");
  // 20 x ~4 MiB report payloads must not be retained after their observers unmount.
  assert.ok(
    heaps.at(-1).usedSize - heaps[1].usedSize < 32 * 1024 * 1024,
    "bounded warmed heap growth",
  );
} finally {
  await browser.close();
}
