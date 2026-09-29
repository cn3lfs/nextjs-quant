import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = "http://127.0.0.1:3226",
  logs = join(tmpdir(), "logs/quant-trade-ledger");
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
async function query(name, input) {
  const url = new URL(base + "/api/trpc/" + name);
  if (input !== undefined)
    url.searchParams.set("input", JSON.stringify({ json: input }));
  const response = await fetch(url, {
    headers: {
      "x-quant-client": "workbench",
      origin: base,
      connection: "close",
    },
  });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 300));
  return {
    value: JSON.parse(text).result.data.json,
    bytes: Buffer.byteLength(text),
  };
}
const measurements = [];
const first = await query("tradeWorkspacePage", {});
assert.equal(first.value.items.length, 20);
for (const [name, input, label, budget] of [
  ["tradeWorkspacePage", {}, "history", 200],
  ["tradeWorkspacePage", { symbol: "sh600000" }, "filtered", 200],
  ["tradeWorkspacePage", { cursor: first.value.nextCursor }, "next-page", 200],
  ["tradeWorkspacePositions", {}, "holdings", 500],
  [
    "tradeWorkspaceSignals",
    { symbol: "sh600000", date: "2026-09-07" },
    "signal-picker",
    200,
  ],
  ["tradeWorkspaceAdjustments", {}, "adjustments", 200],
]) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now(),
      result = await query(name, input);
    bytes = result.bytes;
    if (label === "holdings") {
      assert.equal(result.value.summary.trades, 10000);
      assert.equal(result.value.summary.marketValue, null);
      assert.equal(result.value.summary.missingQuotes, 1);
    }
    if (i >= 5) times.push(performance.now() - start);
  }
  measurements.push({ label, budget, ...stats(times), bytes });
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const start = performance.now();
  await page.goto(base + "/trade-ledger?view=history");
  const list = page.getByLabel("交易历史列表", { exact: true }),
    rows = list.getByRole("button");
  await rows.first().waitFor();
  const warmServerNewContextMs = performance.now() - start;
  const filters = [],
    paging = [],
    returns = [];
  for (let i = 0; i < 35; i++) {
    const symbol = i % 2 ? "sh600001" : "sh600000";
    await page.getByLabel("精确证券代码", { exact: true }).fill(symbol);
    const start = performance.now();
    await page.getByRole("button", { name: "查询交易", exact: true }).click();
    await rows.first().filter({ hasText: symbol }).waitFor();
    if (i >= 5) filters.push(performance.now() - start);
  }
  for (let i = 0; i < 35; i++) {
    const old = await rows.first().getAttribute("data-trade-row"),
      start = performance.now();
    await page
      .getByRole("button", {
        name: i % 2 ? "上一页交易" : "下一页交易",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('[aria-label="交易历史列表"] button')
          ?.getAttribute("data-trade-row") !== id,
      old,
    );
    if (i >= 5) paging.push(performance.now() - start);
  }
  for (let i = 0; i < 35; i++) {
    await rows.first().click();
    const detail = page.getByLabel("账本记录详情", { exact: true });
    await detail
      .getByRole("button", { name: "导出完整记录", exact: true })
      .waitFor();
    const start = performance.now();
    await detail.getByRole("button", { name: "返回列表", exact: true }).click();
    assert.equal(await detail.count(), 0);
    assert.ok(await rows.first().isVisible());
    if (i >= 5) returns.push(performance.now() - start);
  }
  const result = {
    environment: {
      node: process.version,
      browser: browser.version(),
      cpu: cpus()[0].model,
      ram: totalmem(),
      build: readFileSync(".next/BUILD_ID", "utf8"),
    },
    measurements,
    warmServerNewContextMs,
    browser: {
      filter: stats(filters),
      paging: stats(paging),
      return: stats(returns),
    },
    errors,
  };
  writeFileSync(
    join(logs, "final-http-browser-perf.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  for (const m of measurements) {
    assert.ok(m.p95 <= m.budget, m.label + " latency " + m.p95);
    assert.ok(m.bytes <= 65536, m.label + " payload " + m.bytes);
  }
  for (const m of Object.values(result.browser))
    assert.ok(m.p95 <= 300, JSON.stringify(m));
} finally {
  await browser.close();
}
