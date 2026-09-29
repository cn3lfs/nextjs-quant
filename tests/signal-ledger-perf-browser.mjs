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
    resolve(tmpdir()) + "\\quant-signal-ledger-",
  ),
);
const base = process.env.BASE ?? "http://127.0.0.1:3222";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = {},
  summarize = (values) => {
    values.sort((a, b) => a - b);
    return {
      n: values.length,
      p50: values[Math.floor(values.length * 0.5)],
      p95: values[Math.ceil(values.length * 0.95) - 1],
    };
  };
const ready = (page) =>
  page.locator("button[data-ledger-signal]").first().waitFor();
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(performance.now() - window.started),
          ),
        ),
      ),
  );
try {
  const warmup = await browser.newPage();
  await warmup.goto(base + "/signal-ledger");
  await ready(warmup);
  await warmup.close();
  const cold = [];
  for (let i = 0; i < 10; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const at = performance.now();
    await page.goto(base + "/signal-ledger");
    await ready(page);
    cold.push(performance.now() - at);
    await context.close();
  }
  results.coldClientWarmServer = summarize(cold);
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    warm = [];
  for (let i = 0; i < 10; i++) {
    const at = performance.now();
    await page.goto(base + "/signal-ledger");
    await ready(page);
    warm.push(performance.now() - at);
  }
  results.warmNavigation = summarize(warm);
  await page.evaluate(() => {
    window.longTasks = [];
    new PerformanceObserver((list) =>
      window.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: "longtask" });
  });
  const filters = [];
  for (let i = 0; i < 30; i++) {
    await page
      .getByLabel("证券代码", { exact: true })
      .fill(i % 2 ? "" : "sh600004");
    await page.evaluate(() => {
      window.started = performance.now();
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "查询信号")
        .click();
    });
    await page.getByText(i % 2 ? /匹配 121 条/ : /匹配 2 条/).waitFor();
    await ready(page);
    filters.push(await frames(page));
  }
  results.filterEventToTwoFrames = summarize(filters);
  const pages = [];
  for (let i = 0; i < 30; i++) {
    await page.evaluate(
      (name) => {
        window.started = performance.now();
        Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent === name)
          .click();
      },
      i % 2 ? "上一页信号" : "下一页信号",
    );
    await page
      .getByText(`121条信号 · 第${i % 2 ? 1 : 2}页 · 每页20条`, { exact: true })
      .waitFor();
    await ready(page);
    pages.push(await frames(page));
  }
  results.paginationEventToTwoFrames = summarize(pages);
  const details = [];
  for (let i = 0; i < 20; i++) {
    const at = performance.now();
    await page.locator("button[data-ledger-signal]").nth(i).click();
    await page
      .getByRole("button", { name: "导出完整信号依据", exact: true })
      .waitFor();
    details.push(performance.now() - at);
    await page
      .getByRole("button", { name: "返回信号列表", exact: true })
      .click();
    await ready(page);
  }
  results.detailAutomation = summarize(details);
  results.dom = await page.locator("*").count();
  results.longTasks = await page.evaluate(() => window.longTasks);
  results.browser = browser.version();
  results.note =
    "121 signal fixture, warm service; event-to-two-frames is not field INP; cold client is not service cold start";
  writeFileSync(
    join(tmpdir(), "logs", "quant-signal-ledger", "browser-performance.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
}
