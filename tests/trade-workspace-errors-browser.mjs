import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [],
  errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3226/trade-ledger?view=history");
  const list = page.getByLabel("交易历史列表", { exact: true }),
    rows = list.getByRole("button");
  await rows.first().waitFor();
  await page
    .getByLabel("全部持仓摘要", { exact: true })
    .getByText("10000笔", { exact: true })
    .waitFor();
  let fail = "tradeWorkspacePage",
    blocked = 0;
  await page.route("**/api/trpc/**", async (route) => {
    if (fail && route.request().url().includes(fail)) {
      blocked++;
      return route.abort("failed");
    }
    return route.continue();
  });
  const id = await rows.first().getAttribute("data-trade-row");
  await page.getByRole("button", { name: "刷新当前视图", exact: true }).click();
  await page.getByRole("button", { name: "重试原请求", exact: true }).waitFor();
  assert.equal(await rows.first().getAttribute("data-trade-row"), id);
  fail = "";
  await page.getByRole("button", { name: "重试原请求", exact: true }).click();
  await page
    .getByRole("button", { name: "重试原请求", exact: true })
    .waitFor({ state: "hidden" });
  checks.push(
    "history refresh failure retains rows; retry recovers original query",
  );
  fail = "tradeWorkspaceDetail";
  await rows.first().click();
  const detail = page.getByLabel("账本记录详情", { exact: true });
  await detail
    .getByRole("button", { name: "重试原请求", exact: true })
    .waitFor();
  assert.equal(
    await detail
      .getByRole("button", { name: "导出完整记录", exact: true })
      .isEnabled(),
    false,
  );
  fail = "";
  await detail.getByRole("button", { name: "重试原请求", exact: true }).click();
  await detail.getByRole("heading").waitFor();
  await detail.getByRole("button", { name: "返回列表", exact: true }).click();
  checks.push(
    "detail failure cannot export nonexistent or previous record; retry recovers",
  );
  await page.getByLabel("精确证券代码", { exact: true }).fill("sh600000");
  await page.getByRole("button", { name: "查询交易", exact: true }).click();
  await page.getByText(/筛选全部匹配 50笔/).waitFor();
  fail = "tradeWorkspaceExport";
  await page
    .getByRole("button", { name: "导出筛选全集 JSON", exact: true })
    .click();
  await page.getByRole("alert").waitFor();
  fail = "";
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出筛选全集 JSON", exact: true })
    .click();
  const saved = JSON.parse(readFileSync(await (await download).path(), "utf8"));
  assert.equal(saved.count, 50);
  assert.ok(saved.trades.every((row) => row.symbol === "sh600000"));
  assert.equal(blocked, 3);
  checks.push(
    "export failure is visible and retry exports all 50 matching facts",
  );
  // A slow/failed holdings refresh must remain visible even after switching to history.
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const received = new Promise((resolve) => {
    started = resolve;
  });
  await page.unroute("**/api/trpc/**");
  await page.route("**/api/trpc/**", async (route) => {
    if (route.request().url().includes("tradeWorkspacePositions")) {
      started();
      await held;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("tab", { name: "持仓", exact: true }).click();
  await page.getByRole("button", { name: "刷新当前视图", exact: true }).click();
  await received;
  await page.getByRole("tab", { name: "交易历史", exact: true }).click();
  await page
    .getByText("正在核算完整持仓；交易历史可独立查询，已有摘要尚未更新。", {
      exact: true,
    })
    .waitFor();
  assert.ok(await rows.first().isVisible());
  release();
  await page.getByRole("button", { name: "重试原请求", exact: true }).waitFor();
  assert.ok(await rows.first().isVisible());
  await page.unroute("**/api/trpc/**");
  await page.getByRole("button", { name: "重试原请求", exact: true }).click();
  await page
    .getByRole("button", { name: "重试原请求", exact: true })
    .waitFor({ state: "hidden" });
  checks.push(
    "holdings progress and failure remain visible on history; history stays usable; retry recovers",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs/quant-trade-ledger/errors-browser.json"),
    JSON.stringify(
      {
        checks,
        blocked,
        errors,
        build: readFileSync(".next/BUILD_ID", "utf8"),
      },
      null,
      2,
    ),
  );
  console.log(checks);
} finally {
  await browser.close();
}
