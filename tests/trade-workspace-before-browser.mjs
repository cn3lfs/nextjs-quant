import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-trade-ledger"),
  base = "http://127.0.0.1:3226";
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const http = [];
let bytes = 0;
for (let i = 0; i < 35; i++) {
  const start = performance.now(),
    response = await fetch(`${base}/trade-ledger`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.includes("交易日志"));
  bytes = Buffer.byteLength(body);
  if (i >= 5) http.push(performance.now() - start);
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const cold = [],
  errors = [];
try {
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const start = performance.now();
    await page.goto(`${base}/trade-ledger`, { timeout: 120000 });
    await page
      .getByRole("button", { name: "仅保存本地交易", exact: true })
      .waitFor();
    cold.push(performance.now() - start);
    if (i === 0) {
      await page.screenshot({
        path: join(logs, "before-1440.png"),
        fullPage: false,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(logs, "before-390.png"),
        fullPage: false,
      });
    }
    await context.close();
  }
  const result = {
    http: stats(http),
    bytes,
    coldPage: stats(cold),
    errors,
    browser: browser.version(),
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    note: "cold samples use fresh browser contexts; server remains warm",
  };
  writeFileSync(
    join(logs, "baseline-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
