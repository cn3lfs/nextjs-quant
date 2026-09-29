import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3230";
assert.equal(new URL(base).hostname, "127.0.0.1");
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q0-fixture.json"), "utf8"));
const input = { account: fixture.account, pageIndex: 0, pageSize: 20 };
const times = [];
let bytes = 0,
  coldMs = 0;
for (let i = 0; i < 36; i++) {
  const start = performance.now();
  const response = await fetch(
    `${base}/api/trpc/tradeReviewCashReconciliation?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
    { headers: { "x-quant-client": "workbench", origin: base } },
  );
  const body = await response.text();
  assert.equal(response.status, 200, body.slice(0, 500));
  const result = JSON.parse(body).result.data.json;
  assert.equal(result.total, 1000);
  assert.equal(result.rows[0].evidence[0].rows.length, 20000);
  const elapsed = performance.now() - start;
  if (i === 0) coldMs = elapsed;
  if (i >= 6) times.push(elapsed);
  bytes = Buffer.byteLength(body);
}
times.sort((a, b) => a - b);
const http = {
  n: times.length,
  p50: times[15],
  p95: times[28],
  max: times.at(-1),
  bytes,
  firstRequestMs: coldMs,
};
writeFileSync(join(logs, "q0-http.json"), JSON.stringify(http, null, 2));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.getByLabel("复盘账户别名").fill(fixture.account);
  const start = performance.now();
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const section = page.getByRole("region", { name: "现金核对", exact: true });
  await section
    .getByRole("button", { name: "导出完整核对证据" })
    .waitFor({ timeout: 120000 });
  await section.locator("tbody tr").first().waitFor({ timeout: 120000 });
  const reviewMs = performance.now() - start;
  const nodes = await section.locator("*").count();
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    fixtureHash: fixture.hash,
    http,
    browser: { reviewMs, nodes, errors },
    scope:
      "first HTTP may reuse existing process cache; browser uses warmed accountReview; synthetic cash-only account",
  };
  writeFileSync(
    join(logs, "q0-http-browser.json"),
    JSON.stringify(result, null, 2),
  );
  await section.evaluate((element) => element.scrollIntoView());
  await page.screenshot({
    path: join(logs, "q0-cash-1440.png"),
    timeout: 15000,
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
