/** Controlled old-UI comparison on the same host and isolated 41-row fixture. */
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
const browser = await chromium.launch({ channel: "chrome", headless: true });
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
  const ready = async (page) => {
    await page.getByText("SH600000", { exact: true }).first().waitFor();
  };
  const warmup = await browser.newPage();
  await warmup.goto(base + "/intraday");
  await ready(warmup);
  await warmup.close();
  const cold = [];
  for (let i = 0; i < 10; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const at = performance.now();
    await page.goto(base + "/intraday");
    await ready(page);
    cold.push(performance.now() - at);
    await context.close();
  }
  results.coldClientWarmServer = summarize(cold);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const warm = [];
  for (let i = 0; i < 10; i++) {
    const at = performance.now();
    await page.goto(base + "/intraday");
    await ready(page);
    warm.push(performance.now() - at);
  }
  results.warmNavigation = summarize(warm);
  const pages = [];
  for (let i = 0; i < 30; i++) {
    await page.evaluate(
      (name) => {
        window.eventStart = performance.now();
        Array.from(document.querySelectorAll("button"))
          .find((b) => b.textContent === name)
          .click();
      },
      i % 2 ? "上一页" : "下一页",
    );
    await page
      .getByText(`第 ${i % 2 ? 1 : 2} 页 · 每页 20 条`, { exact: true })
      .waitFor();
    await ready(page);
    pages.push(
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve(performance.now() - window.eventStart),
              ),
            ),
          ),
      ),
    );
  }
  results.paginationEventToTwoFrames = summarize(pages);
  results.browser = browser.version();
  results.note =
    "Controlled HEAD intraday-controls.tsx on current host/schema v11; legacy intradayStatus retained; same 41-row fixture; new filters/detail reading did not exist in old UI and have no direct before timing";
  writeFileSync(
    join(tmpdir(), "logs", "quant-intraday", "browser-before-controlled.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
}
