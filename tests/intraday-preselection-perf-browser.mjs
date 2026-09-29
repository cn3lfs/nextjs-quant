/** Production browser timings and request evidence; server is already warm. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
assert.ok(
  resolve(process.env.QUANT_DATA_DIR ?? "").startsWith(
    resolve(tmpdir()) + "\\quant-intraday-",
  ),
);
const base = process.env.BASE ?? "http://127.0.0.1:3221";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const url = base + "/intraday?preselect=" + encodeURIComponent("{}"),
  browser = await chromium.launch({ channel: "chrome", headless: true });
const results = {};
const summarize = (values) => {
  values.sort((a, b) => a - b);
  return {
    n: values.length,
    p50: values[Math.floor(values.length * 0.5)],
    p95: values[Math.ceil(values.length * 0.95) - 1],
  };
};
try {
  const warmup = await browser.newPage();
  await warmup.goto(url);
  await warmup.locator("button[data-observation]").first().waitFor();
  await warmup.close();
  const cold = [];
  for (let i = 0; i < 10; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const at = performance.now();
    await page.goto(url);
    await page.locator("button[data-observation]").first().waitFor();
    cold.push(performance.now() - at);
    await context.close();
  }
  results.coldClientWarmServer = summarize(cold);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.addInitScript(() => {
    window.longTasks = [];
    new PerformanceObserver((list) =>
      window.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: "longtask", buffered: true });
  });
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const at = performance.now();
    await page.goto(url);
    await page.locator("button[data-observation]").first().waitFor();
    warm.push(performance.now() - at);
  }
  results.warmNavigation = summarize(warm);
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(performance.now() - window.eventStart),
            ),
          ),
        ),
    );
  const filter = [];
  for (let i = 0; i < 30; i++) {
    const symbol = i % 2 ? "sh600000" : "sz000001";
    await page.getByLabel("证券代码", { exact: true }).fill(symbol);
    await page.evaluate(() => {
      window.eventStart = performance.now();
      const input = document.querySelector('input[placeholder="如 sh600000"]');
      input.form.requestSubmit();
    });
    if (i % 2) await page.locator("button[data-observation]").first().waitFor();
    else await page.getByText(/当前范围没有观测记录/).waitFor();
    filter.push(await frames());
  }
  results.filterEventToTwoFrames = summarize(filter);
  await page.getByRole("button", { name: "全部历史", exact: true }).click();
  await page.locator("button[data-observation]").first().waitFor();
  const pagination = [];
  for (let i = 0; i < 30; i++) {
    const name = i % 2 ? "上一页" : "下一页";
    await page.evaluate((name) => {
      window.eventStart = performance.now();
      Array.from(document.querySelectorAll("button"))
        .find((b) => b.textContent === name)
        .click();
    }, name);
    await page
      .getByText(`第 ${i % 2 ? 1 : 2} 页 · 每页20条`, { exact: true })
      .waitFor();
    await page.waitForFunction(
      () => !document.body.textContent.includes("更新中"),
    );
    pagination.push(await frames());
  }
  results.paginationEventToTwoFrames = summarize(pagination);
  const detail = [],
    expand = [];
  for (let i = 0; i < 20; i++) {
    let at = performance.now();
    await page.locator("button[data-observation]").nth(i).click();
    await page.getByRole("button", { name: "导出完整依据" }).waitFor();
    detail.push(performance.now() - at);
    await page.evaluate(() => {
      window.eventStart = performance.now();
      Array.from(document.querySelectorAll("summary"))
        .find((e) => e.textContent === "原始行情与完整依据")
        .click();
    });
    await page.locator("pre").waitFor();
    expand.push(await frames());
    await page.getByRole("button", { name: "返回结果", exact: true }).click();
  }
  results.detailAutomation = summarize(detail);
  results.expandEventToTwoFrames = summarize(expand);
  results.browser = browser.version();
  results.viewport = { width: 1440, height: 1000 };
  results.dom = await page.locator("*").count();
  results.longTasks = await page.evaluate(() => window.longTasks);
  results.note =
    "41 observation fixture; cold client is not Node cold start; local event-to-two-frames is not field INP";
  writeFileSync(
    join(tmpdir(), "logs", "quant-intraday", "browser-performance.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
}
