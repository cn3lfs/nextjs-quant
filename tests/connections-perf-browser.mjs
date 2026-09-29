/** Production-server measurement with isolated data. No settings are saved.
 * BASE=http://127.0.0.1:3218 CONNECTIONS_PHASE=before|after node tests/connections-perf-browser.mjs
 */
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3218";
const phase = process.env.CONNECTIONS_PHASE ?? "after";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = {
  phase,
  cold: [],
  input: [],
  hiddenBudgetRequests: 0,
  requests: [],
  errors: [],
};
try {
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    page.on("request", (request) => {
      if (i === 2 && request.url().includes("/api/trpc/"))
        report.requests.push({
          path: new URL(request.url()).pathname,
          at: Date.now(),
        });
    });
    const start = performance.now();
    await page.goto(`${base}/settings`);
    const root = page.getByLabel("通达信安装目录", { exact: true });
    await root.waitFor();
    report.cold.push(Math.round(performance.now() - start));
    if (i < 2) {
      await context.close();
      continue;
    }
    await page.waitForTimeout(1500);
    for (let sample = 0; sample < 13; sample++) {
      const at = performance.now();
      await root.fill(`C:/synthetic/interaction-${sample}`);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      if (sample >= 3) report.input.push(Math.round(performance.now() - at));
    }
    await page.screenshot({
      path: join(tmpdir(), `quant-connections-${phase}.png`),
      fullPage: true,
    });
    const resource = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/api/trpc/"))
        .map((entry) => ({
          path: new URL(entry.name).pathname,
          bytes: entry.encodedBodySize,
          ms: Math.round(entry.duration),
        })),
    );
    report.resources = resource;
    await page.locator('a[href="/tasks"]').first().click();
    await page.waitForURL(`${base}/tasks`);
    const hideAt = Date.now();
    console.log(`hidden-watch-started ${phase}`);
    await page.waitForTimeout(65000);
    report.hiddenBudgetRequests = report.requests.filter(
      (request) =>
        request.at > hideAt &&
        request.path.split(/[\/,]/).includes("newsBudget"),
    ).length;
    if (phase === "after") assert.equal(report.hiddenBudgetRequests, 0);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  const dir = join(tmpdir(), "logs", "quant-connections");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `production-${phase}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
