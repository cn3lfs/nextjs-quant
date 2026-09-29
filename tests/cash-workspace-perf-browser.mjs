import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { armCashTiming, cashTiming } from "./helpers/cash-browser-timing.mjs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3231";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [],
    requests = [],
    phases = [];
  const requestStarts = new Map();
  page.on("request", (request) =>
    requestStarts.set(request, performance.now()),
  );
  page.on("requestfinished", (request) => {
    if (request.url().includes("cashWorkspace"))
      requests.push({
        route: new URL(request.url()).pathname,
        ms: performance.now() - requestStarts.get(request),
      });
    requestStarts.delete(request);
  });
  let rowReads = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.url().includes("/api/trpc/") &&
      request.url().includes("cashWorkspaceRows")
    )
      rowReads++;
  });
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.getByLabel("复盘账户别名").fill(fixture.accounts.stress);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const cash = page.getByRole("region", { name: "现金核对", exact: true });
  const table = cash.getByRole("region", { name: "逐日现金核对", exact: true });
  const detail = cash.getByRole("region", {
    name: "现金核对详情",
    exact: true,
  });
  await table.locator("tbody tr").first().waitFor({ timeout: 60000 });
  const times = { filter: [], page: [], back: [] };
  const driverTimes = { filter: [], page: [], back: [] };
  for (let i = 0; i < 35; i++) {
    const offset = i % 2;
    await cash
      .getByLabel("现金起始日期", { exact: true })
      .fill(fixture.calendar[offset]);
    await armCashTiming(page, { kind: "filter", count: 10000 - offset });
    let start = performance.now();
    await cash
      .getByRole("button", { name: "查询现金日期", exact: true })
      .click();
    await cash
      .getByText(new RegExp(`当前筛选匹配 ${10000 - offset} 天`))
      .waitFor();
    if (i >= 5) driverTimes.filter.push(performance.now() - start);
    const filterMs = await cashTiming(page);
    if (i >= 5) times.filter.push(filterMs);
    await armCashTiming(page, { kind: "page", date: fixture.calendar[9979] });
    start = performance.now();
    await table.getByRole("button", { name: "下一页", exact: true }).click();
    await table
      .getByRole("button", { name: fixture.calendar[9979], exact: true })
      .waitFor();
    if (i >= 5) driverTimes.page.push(performance.now() - start);
    const pageMs = await cashTiming(page);
    if (i >= 5) times.page.push(pageMs);
    await table
      .getByRole("button", { name: fixture.calendar[9979], exact: true })
      .click();
    await detail.getByRole("heading", { level: 3 }).waitFor();
    await armCashTiming(page, { kind: "back" });
    start = performance.now();
    await detail
      .getByRole("button", { name: "返回日期列表", exact: true })
      .click();
    await detail.waitFor({ state: "detached" });
    if (i >= 5) driverTimes.back.push(performance.now() - start);
    const backMs = await cashTiming(page);
    if (i >= 5) times.back.push(backMs);
  }
  const summaryNodes = await cash.locator("*").count();
  assert.ok(summaryNodes < 1000);
  await page.getByLabel("复盘账户别名").fill(fixture.accounts.large);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  await table
    .getByRole("button", { name: fixture.calendar[19], exact: true })
    .waitFor();
  const cdp = await page.context().newCDPSession(page);
  const heap = [],
    opens = [];
  const sample = async (visits) => {
    await cdp.send("HeapProfiler.collectGarbage");
    heap.push({ visits, ...(await cdp.send("Runtime.getHeapUsage")) });
  };
  await page.evaluate(() => {
    globalThis.cashBlobs = { created: 0, revoked: 0 };
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (...args) => {
      globalThis.cashBlobs.created++;
      return create(...args);
    };
    URL.revokeObjectURL = (...args) => {
      globalThis.cashBlobs.revoked++;
      return revoke(...args);
    };
  });
  await sample(0);
  const beforeReads = rowReads;
  for (let i = 0; i < 35; i++) {
    const date = fixture.calendar[i % 20];
    await armCashTiming(page, { kind: "date", date });
    const start = performance.now();
    await table.getByRole("button", { name: date, exact: true }).click();
    const sourceButton = detail
      .locator("li")
      .filter({ hasText: "cash-pressure-large" })
      .getByRole("button", { name: "查看逐行证据", exact: true });
    await sourceButton.waitFor();
    const dateReadyMs = performance.now() - start;
    const datePaintMs = await cashTiming(page);
    await armCashTiming(page, { kind: "rows" });
    await sourceButton.click();
    const rows = cash.getByRole("region", {
      name: "结构化余额证据",
      exact: true,
    });
    await rows.locator("tbody tr").first().waitFor();
    phases.push({
      visit: i + 1,
      dateReadyMs,
      rowReadyMs: performance.now() - start,
    });
    assert.equal(await rows.locator("tbody tr").count(), 20);
    const rowsPaintMs = await cashTiming(page);
    if (i >= 5) opens.push(datePaintMs + rowsPaintMs);
    await detail
      .getByRole("button", { name: "返回日期列表", exact: true })
      .click();
    if (i === 0) {
      const event = page.waitForEvent("download");
      await cash
        .getByRole("button", { name: "导出全部日期证据", exact: true })
        .click();
      const exported = JSON.parse(
        readFileSync(await (await event).path(), "utf8"),
      );
      assert.equal(
        exported.evidence.days
          .flatMap((day) => day.evidence)
          .filter((source) => source.batchId === "cash-pressure-large")
          .reduce((sum, source) => sum + source.rows.length, 0),
        400000,
      );
      await page.waitForFunction(
        () => globalThis.cashBlobs.created === globalThis.cashBlobs.revoked,
      );
    }
    await page.waitForTimeout(30);
    if ([5, 10, 20, 35].includes(i + 1)) await sample(i + 1);
  }
  assert.equal(
    rowReads - beforeReads,
    35,
    "each closed evidence view must release its observer and query",
  );
  const growth =
    heap.at(-1).usedSize - heap.find((sample) => sample.visits === 10).usedSize;
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert.ok(!storage.includes("cash-pressure-large"));
  const persisted = await page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (value) => value.name === "guanlan-query-cache",
      )
    )
      return [];
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("guanlan-query-cache");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("queries")) {
          database.close();
          resolve([]);
          return;
        }
        const read = database
          .transaction("queries")
          .objectStore("queries")
          .getAll();
        read.onsuccess = () => {
          database.close();
          resolve(read.result);
        };
        read.onerror = () => {
          database.close();
          reject(read.error);
        };
      };
    });
  });
  assert.ok(!JSON.stringify(persisted).includes("cashWorkspace"));
  const blobs = await page.evaluate(() => globalThis.cashBlobs);
  assert.equal(blobs.created, blobs.revoked);
  assert.deepEqual(errors, []);
  const measurements = Object.fromEntries(
    Object.entries(times).map(([name, values]) => [name, stats(values)]),
  );
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    measurements,
    driverMeasurements: Object.fromEntries(
      Object.entries(driverTimes).map(([name, values]) => [
        name,
        stats(values),
      ]),
    ),
    timing:
      "dispatched click to next painted usable DOM; largeFirstPage sums two explicit interactions; driver and end-to-end phases retained separately",
    largeFirstPage: stats(opens),
    summaryNodes,
    heap,
    growth10to35: growth,
    evidenceReads: rowReads - beforeReads,
    blobs,
    errors,
    phases,
    requests,
    persistedCashEvidence: false,
  };
  writeFileSync(
    join(logs, "q3-perf-memory.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  for (const value of Object.values(measurements))
    assert.ok(value.p95 <= 300, JSON.stringify(value));
  assert.ok(stats(opens).p95 <= 1000);
  assert.ok(growth <= 8 * 1024 * 1024, `closed evidence growth ${growth}`);
} finally {
  await browser.close();
}
