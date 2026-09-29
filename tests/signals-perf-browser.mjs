import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = "http://127.0.0.1:3225",
  logs = join(tmpdir(), "logs/quant-signals");
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const measurements = [];
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
  assert.equal(response.status, 200, text.slice(0, 200));
  return {
    value: JSON.parse(text).result.data.json,
    bytes: Buffer.byteLength(text),
  };
}
const first = await query("deliveryWorkspacePage", {});
for (const [name, input, label] of [
  ["monitorWorkspacePage", {}, "monitors"],
  ["signalWorkspacePage", {}, "signals"],
  ["deliveryWorkspacePage", {}, "deliveries"],
  ["monitorWorkspaceSummary", undefined, "summary"],
  ["deliveryWorkspacePage", { signalId: "signal-fixture-09999" }, "related"],
  ["deliveryWorkspacePage", { cursor: first.value.nextCursor }, "next-page"],
  [
    "signalWorkspacePage",
    { query: "no-matching-signal" },
    "signal-filter-miss",
  ],
  [
    "deliveryWorkspacePage",
    { query: "no-matching-message" },
    "delivery-filter-miss",
  ],
]) {
  const times = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const result = await query(name, input);
    bytes = result.bytes;
    if (label === "related") assert.equal(result.value.items.length, 5);
    if (i >= 5) times.push(performance.now() - start);
  }
  measurements.push({ label, ...stats(times), bytes });
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const coldStart = performance.now();
  await page.goto(base + "/signals");
  const list = page.getByLabel("订阅列表", { exact: true });
  await list.getByRole("button").first().waitFor();
  const coldPageMs = performance.now() - coldStart;
  const filters = [],
    paging = [],
    returns = [];
  for (let i = 0; i < 35; i++) {
    const prefix = i % 2 ? "98" : "99",
      last = i % 2 ? 989 : 999;
    await page
      .getByLabel("历史关键词", { exact: true })
      .fill("合成订阅 " + prefix);
    const start = performance.now();
    await page.getByRole("button", { name: "查询历史", exact: true }).click();
    await list
      .getByRole("button", { name: new RegExp("^合成订阅 " + last + " ") })
      .waitFor();
    if (i >= 5) filters.push(performance.now() - start);
  }
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await list.getByRole("button", { name: /^合成订阅 999 / }).waitFor();
  for (let i = 0; i < 35; i++) {
    const next = i % 2 === 0,
      start = performance.now();
    await page
      .getByRole("button", { name: next ? "下一页" : "上一页", exact: true })
      .click();
    await page
      .getByText(next ? "第 2 页" : "第 1 页", { exact: true })
      .waitFor();
    await list
      .getByRole("button", { name: next ? /^合成订阅 979 / : /^合成订阅 999 / })
      .waitFor();
    if (i >= 5) paging.push(performance.now() - start);
  }
  for (let i = 0; i < 35; i++) {
    await list.getByRole("button").first().click();
    const detail = page.getByRole("region", {
      name: "监控记录详情",
      exact: true,
    });
    await detail
      .getByRole("button", { name: "编辑订阅", exact: true })
      .waitFor();
    const start = performance.now();
    await detail.getByRole("button", { name: "返回列表", exact: true }).click();
    assert.equal(await detail.count(), 0);
    assert.ok(await list.getByRole("button").first().isVisible());
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
    coldPageMs,
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
    assert.ok(
      m.p95 <= (m.label === "summary" ? 300 : 200),
      m.label + " budget",
    );
    assert.ok(m.bytes <= 65536, m.label + " payload");
  }
  for (const m of Object.values(result.browser))
    assert.ok(m.p95 <= 300, JSON.stringify(m));
} finally {
  await browser.close();
}
