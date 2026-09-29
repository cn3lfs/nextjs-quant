import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3223";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const filter = {
  cutoff: Date.parse("2025-01-07T16:00:00+08:00"),
  query: "",
  historical: true,
};
const url =
  base + "/news?newsQuery=" + encodeURIComponent(JSON.stringify(filter));
const summary = (values) => {
  values.sort((a, b) => a - b);
  return {
    n: values.length,
    p50: values[Math.floor(values.length * 0.5)],
    p95: values[Math.ceil(values.length * 0.95) - 1],
  };
};
const ready = (page) => page.locator("[data-news-original]").first().waitFor();
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
const results = {},
  errors = [];
try {
  const warm = await browser.newPage();
  await warm.goto(url);
  await ready(warm);
  await warm.close();
  const cold = [];
  for (let i = 0; i < 10; i++) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const start = performance.now();
    await page.goto(url);
    await ready(page);
    cold.push(performance.now() - start);
    await context.close();
  }
  results.coldClientWarmServer = summary(cold);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const navigations = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await page.goto(url);
    await ready(page);
    navigations.push(performance.now() - start);
  }
  results.warmNavigation = summary(navigations);
  await page.evaluate(() => {
    window.longTasks = [];
    new PerformanceObserver((list) =>
      window.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: "longtask" });
  });
  const filters = [],
    pages = [];
  for (let i = 0; i < 30; i++) {
    await page
      .getByLabel("新闻关键词", { exact: true })
      .fill(i % 2 ? "" : "末尾关键词");
    await page.evaluate(() => {
      window.started = performance.now();
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "查询新闻")
        .click();
    });
    await page.getByText(i % 2 ? /匹配 10000 条/ : /匹配 1000 条/).waitFor();
    await ready(page);
    filters.push(await frames(page));
  }
  results.filterEventToTwoFrames = summary(filters);
  for (let i = 0; i < 30; i++) {
    await page.evaluate(
      (name) => {
        window.started = performance.now();
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === name)
          .click();
      },
      i % 2 ? "上一页新闻" : "下一页新闻",
    );
    await page
      .getByText(`10000条 · 第${i % 2 ? 1 : 2}页`, { exact: true })
      .waitFor();
    await ready(page);
    // Page label updates with state; first row proves the corresponding data has arrived.
    await page.waitForFunction(
      (id) =>
        document
          .querySelector("[data-news-original]")
          ?.getAttribute("data-news-original") === id,
      i % 2 ? "3" : "49",
    );
    pages.push(await frames(page));
  }
  results.paginationEventToTwoFrames = summary(pages);
  results.dom = await page.locator("*").count();
  results.longTasks = await page.evaluate(() => window.longTasks);
  results.browser = browser.version();
  results.errors = errors;
  results.note =
    "10000 indexed 4KiB news,121 archives; 10 cold-client/warm-service and10 warm navigations;30 alternating filters/pages; event-to-two-frames is not field INP; page row identity checked";
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs", "quant-news", "browser-performance.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
}
