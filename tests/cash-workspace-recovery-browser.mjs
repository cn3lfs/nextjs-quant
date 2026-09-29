import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3231";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(
  readFileSync(join(logs, "q3-recovery-fixture.json"), "utf8"),
);
assert.equal(
  resolve(fixture.directory),
  resolve(join(tmpdir(), "quant-cash-reconciliation-pressure")),
);
const db = new Database(join(fixture.directory, "quant.sqlite"), {
  fileMustExist: true,
});
const readFacts = () =>
  Object.fromEntries(
    ["import_batches", "trade_fills", "cash_flows"].map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table} WHERE account=? ORDER BY id`)
        .all(fixture.account),
    ]),
  );
const before = readFacts();
assert.equal(
  createHash("sha256").update(JSON.stringify(before)).digest("hex"),
  fixture.hash,
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const names = (name) => (url) =>
  new URL(url).pathname.split("/").at(-1).split(",").includes(name);
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.getByLabel("复盘账户别名").fill(fixture.account);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const cash = page.getByRole("region", { name: "现金核对", exact: true });
  const table = cash.getByRole("region", { name: "逐日现金核对", exact: true });
  await table.locator("tbody tr").first().waitFor({ timeout: 60000 });
  // List error must preserve the submitted filter and have its own recovery.
  await cash.getByLabel("现金起始日期", { exact: true }).fill(fixture.dates[0]);
  await page.route(names("cashWorkspace"), (route) => route.abort("failed"), {
    times: 1,
  });
  await cash.getByRole("button", { name: "查询现金日期", exact: true }).click();
  await cash.getByRole("alert").waitFor();
  assert.equal(
    await cash.getByLabel("现金起始日期", { exact: true }).inputValue(),
    fixture.dates[0],
  );
  await cash.getByRole("button", { name: "重试原请求", exact: true }).click();
  await table.locator("tbody tr").first().waitFor();
  // Delayed list response must not replace the newer filter response.
  let releaseList, listReady, listDone;
  const listGate = new Promise((resolve) => {
    releaseList = resolve;
  });
  const listStarted = new Promise((resolve) => {
    listReady = resolve;
  });
  const listFinished = new Promise((resolve) => {
    listDone = resolve;
  });
  await page.route(
    names("cashWorkspace"),
    async (route) => {
      const response = await route.fetch();
      listReady();
      await listGate;
      try {
        await route.fulfill({ response });
      } finally {
        listDone();
      }
    },
    { times: 1 },
  );
  await cash
    .getByLabel("现金起始日期", { exact: true })
    .fill(fixture.dates[37]);
  await cash.getByRole("button", { name: "查询现金日期", exact: true }).click();
  await listStarted;
  await cash
    .getByLabel("现金起始日期", { exact: true })
    .fill(fixture.dates[38]);
  await cash.getByRole("button", { name: "查询现金日期", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('section[aria-label="逐日现金核对"] tbody tr')
        .length === 2,
  );
  releaseList();
  await listFinished;
  await page.waitForTimeout(100);
  assert.equal(await table.locator("tbody tr").count(), 2);
  // Close a loading detail and open another date before its response arrives.
  let releaseDetail, detailReady, detailDone;
  const detailGate = new Promise((resolve) => {
    releaseDetail = resolve;
  });
  const detailStarted = new Promise((resolve) => {
    detailReady = resolve;
  });
  const detailFinished = new Promise((resolve) => {
    detailDone = resolve;
  });
  await page.route(
    names("cashWorkspaceDate"),
    async (route) => {
      const response = await route.fetch();
      detailReady();
      await detailGate;
      try {
        await route.fulfill({ response });
      } finally {
        detailDone();
      }
    },
    { times: 1 },
  );
  await table
    .getByRole("button", { name: fixture.dates[39], exact: true })
    .click();
  await detailStarted;
  let detail = cash.getByRole("region", { name: "现金核对详情", exact: true });
  await detail
    .getByRole("button", { name: "返回日期列表", exact: true })
    .click();
  await table
    .getByRole("button", { name: fixture.dates[38], exact: true })
    .click();
  await detail
    .getByRole("button", { name: "查看逐行证据", exact: true })
    .waitFor();
  releaseDetail();
  await detailFinished;
  assert.equal(
    await detail.getByRole("heading", { level: 3 }).textContent(),
    `${fixture.dates[38]} 现金核对`,
  );
  await detail
    .getByRole("button", { name: "返回日期列表", exact: true })
    .click();
  await cash.getByRole("button", { name: "重置现金筛选", exact: true }).click();
  await table.getByRole("button", { name: "下一页", exact: true }).click();
  await table
    .getByRole("button", { name: fixture.dates[19], exact: true })
    .waitFor();
  await table
    .getByRole("button", { name: fixture.dates[19], exact: true })
    .click();
  await detail
    .getByRole("button", { name: "查看逐行证据", exact: true })
    .waitFor();
  const revoked = await fetch(`${base}/api/trpc/deliveryRevoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-quant-client": "workbench",
      origin: base,
    },
    body: JSON.stringify({ json: fixture.ids[0] }),
  });
  assert.equal(revoked.status, 200, await revoked.text());
  await cash.getByRole("button", { name: "刷新现金核对", exact: true }).click();
  await detail
    .getByText("该日期已不存在，请刷新现金核对", { exact: true })
    .waitFor();
  await detail
    .getByRole("button", { name: "返回日期列表", exact: true })
    .click();
  assert.equal(await table.locator("tbody tr").count(), 20);
  assert.ok(
    await table
      .getByRole("button", { name: "上一页", exact: true })
      .isDisabled(),
  );
  assert.ok(
    await table
      .getByRole("button", { name: "下一页", exact: true })
      .isDisabled(),
  );
  assert.equal(
    await table
      .getByRole("button", { name: fixture.dates[19], exact: true })
      .count(),
    0,
  );
  assert.ok(
    await cash
      .getByRole("heading", { level: 2 })
      .evaluate((element) => element === document.activeElement),
  );
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    listFailurePreservesFilter: true,
    lateListIgnored: true,
    lateDetailIgnored: true,
    realRevokeRemovesSelectedDate: true,
    pageClamped: true,
    fallbackFocus: true,
  };
  writeFileSync(
    join(logs, "q3-recovery.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  db.transaction(() => {
    for (const table of ["import_batches", "trade_fills", "cash_flows"]) {
      for (const row of before[table]) {
        const values = Object.values(row);
        db.prepare(
          `INSERT OR REPLACE INTO ${table} VALUES (${values.map(() => "?").join(",")})`,
        ).run(...values);
      }
    }
  })();
  assert.equal(
    createHash("sha256").update(JSON.stringify(readFacts())).digest("hex"),
    fixture.hash,
  );
  db.close();
}
