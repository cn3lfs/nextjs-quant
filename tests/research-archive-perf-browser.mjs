/** Production-browser timings; DOM-visible + two frames is a proxy, not INP. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
assert.equal(process.env.ARCHIVE_ISOLATED, "1");
const base = process.env.BASE ?? "http://127.0.0.1:3220";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const phase = process.env.ARCHIVE_PHASE ?? "after";
const dir = join(tmpdir(), "logs", "quant-research-archive");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    window.archiveLongTasks = [];
    new PerformanceObserver((list) =>
      window.archiveLongTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: "longtask", buffered: true });
  });
  let historyRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("researchArchiveHistory")) historyRequests++;
  });
  await page.goto(base + "/reports/report/report-124");
  await page.getByText("合成报告摘要", { exact: true }).waitFor();
  await page.waitForTimeout(4500);
  const readPersisted = () =>
    page.evaluate(async () => {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("guanlan-query-cache");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("queries")) {
            db.close();
            resolve({ bytes: 0, containsDetail: false });
            return;
          }
          const read = db
            .transaction("queries")
            .objectStore("queries")
            .get("trpc");
          read.onsuccess = () => {
            const text = read.result ?? "";
            db.close();
            resolve({
              bytes: new TextEncoder().encode(text).length,
              containsDetail: text.includes("archivedReport"),
              keys: (text ? JSON.parse(text).json.clientState.queries : [])
                .map((q) => JSON.stringify(q.queryKey))
                .sort(),
            });
          };
          read.onerror = () => reject(read.error);
        };
      });
    });
  const persisted = await readPersisted();
  if (phase.startsWith("cache-")) {
    if (phase === "cache-after") assert.equal(persisted.containsDetail, false);
    writeFileSync(
      join(dir, `${phase}.json`),
      JSON.stringify(persisted, null, 2),
    );
    console.log(JSON.stringify(persisted));
  } else {
    assert.equal(
      persisted.containsDetail,
      false,
      "Full report must not enter persistent cache",
    );
    const coldClient = [],
      firstPaint = [],
      filterMs = [],
      paginationMs = [],
      detailMs = [],
      expandMs = [];
    for (let i = 0; i < 10; i++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const fresh = await context.newPage();
      const start = performance.now();
      await fresh.goto(base + "/reports");
      await fresh
        .getByRole("link", { name: "档案研究 124", exact: true })
        .waitFor();
      coldClient.push(performance.now() - start);
      await context.close();
    }
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await page.goto(base + "/reports");
      await page
        .getByRole("link", { name: "档案研究 124", exact: true })
        .waitFor();
      firstPaint.push(performance.now() - start);
    }
    async function measured(action, target) {
      if (action !== "submit")
        await page.waitForFunction(
          (name) =>
            [...document.querySelectorAll("button")].some(
              (button) =>
                button.textContent === name &&
                !button.closest("[hidden]") &&
                !button.disabled,
            ),
          action,
        );
      return page.evaluate(
        ({ action, target }) =>
          new Promise((resolve, reject) => {
            const start = performance.now();
            let done = false;
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(Error("DOM timing timeout: " + target));
            }, 10000);
            const check = () => {
              const list = document.querySelector(
                '[aria-label="研究报告列表"]',
              );
              if (done || !list?.textContent?.includes(target)) return;
              done = true;
              observer.disconnect();
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  clearTimeout(timer);
                  resolve(performance.now() - start);
                }),
              );
            };
            const observer = new MutationObserver(check);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });
            if (action === "submit")
              document
                .querySelector('[aria-label="研究报告"] form')
                .requestSubmit();
            else
              [...document.querySelectorAll("button")]
                .find((b) => b.textContent === action && !b.closest("[hidden]"))
                .click();
            check();
          }),
        { action, target },
      );
    }
    for (let i = 0; i < 35; i++) {
      const keyword = i % 2 ? "123" : "124";
      await page.getByLabel("标题或报告 ID").fill(keyword);
      const value = await measured("submit", `档案研究 ${keyword}`);
      if (i >= 5) filterMs.push(value);
    }
    await page.getByRole("button", { name: "清空条件", exact: true }).click();
    await page
      .getByRole("link", { name: "档案研究 124", exact: true })
      .waitFor();
    for (let i = 0; i < 35; i++) {
      const next = i % 2 === 0;
      const value = await measured(
        next ? "下一页报告" : "上一页报告",
        next ? "档案研究 104" : "档案研究 124",
      );
      if (i >= 5) paginationMs.push(value);
    }
    await page.getByRole("button", { name: "回到最新", exact: true }).click();
    await page.waitForTimeout(4500);
    const beforeRoundTrips = await readPersisted();
    for (let i = 0; i < 20; i++) {
      await page
        .getByRole("link", { name: "档案研究 124", exact: true })
        .waitFor();
      const start = performance.now();
      await page
        .getByRole("link", { name: "档案研究 124", exact: true })
        .click();
      await page.getByText("合成报告摘要", { exact: true }).waitFor();
      detailMs.push(performance.now() - start);
      const duration = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const start = performance.now();
            const summary = [...document.querySelectorAll("summary")].find(
              (s) => s.textContent === "查看证据与版本",
            );
            summary.click();
            const check = () => {
              if (document.querySelector(".report-card pre"))
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    resolve(performance.now() - start),
                  ),
                );
              else requestAnimationFrame(check);
            };
            check();
          }),
      );
      expandMs.push(duration);
      await page
        .getByRole("link", { name: "返回研究档案", exact: true })
        .click();
    }
    await page
      .getByRole("link", { name: "档案研究 124", exact: true })
      .waitFor();
    // Cached panel remains mounted behind the detail page; no archive polling.
    await page.getByRole("link", { name: "档案研究 124", exact: true }).click();
    await page.getByText("合成报告摘要", { exact: true }).waitFor();
    const hiddenStart = historyRequests;
    console.log("Measuring hidden archive for 60 seconds");
    await page.waitForTimeout(60000);
    assert.equal(historyRequests, hiddenStart);
    await page.getByRole("link", { name: "返回研究档案", exact: true }).click();
    await page
      .getByRole("link", { name: "档案研究 124", exact: true })
      .waitFor();
    await page.waitForTimeout(500);
    const restoreRequests = historyRequests - hiddenStart;
    assert.ok(restoreRequests <= 1, `Restore requests: ${restoreRequests}`);
    const stats = (samples) => ({
      samples,
      p95: [...samples].sort((a, b) => a - b)[
        Math.ceil(samples.length * 0.95) - 1
      ],
    });
    const result = {
      persisted,
      firstPaint: stats(firstPaint),
      filter: stats(filterMs),
      pagination: stats(paginationMs),
      detail: stats(detailMs),
      expand: stats(expandMs),
      hiddenRequests: 0,
      restoreRequests,
      browser: browser.version(),
      coldClient: stats(coldClient),
      beforeRoundTrips,
      afterRoundTrips: await readPersisted(),
      rendering: await page.evaluate(() => ({
        domNodes: document.querySelectorAll("*").length,
        longTasks: window.archiveLongTasks,
      })),
    };
    assert.deepEqual(result.afterRoundTrips.keys, beforeRoundTrips.keys);
    assert.equal(result.afterRoundTrips.containsDetail, false);
    writeFileSync(
      join(dir, "browser-performance.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({
        ...result,
        firstPaint: result.firstPaint.p95,
        filter: result.filter.p95,
        pagination: result.pagination.p95,
        detail: result.detail.p95,
        expand: result.expand.p95,
      }),
    );
  }
} finally {
  await browser.close();
}
