import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const base = process.env.BASE ?? "http://127.0.0.1:3230";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q0-fixture.json"), "utf8"));
assert.ok(
  fixture.directory.startsWith(join(tmpdir(), "quant-cash-reconciliation-")),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const db = new Database(join(fixture.directory, "quant.sqlite"), {
  fileMustExist: true,
});
const batch = db
  .prepare(
    "SELECT id,file_name FROM import_batches WHERE account=? ORDER BY id LIMIT 1",
  )
  .get(fixture.account);
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto(`${base}/trade-review`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.getByLabel("复盘账户别名").fill(fixture.account);
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  const cash = page.getByRole("region", { name: "现金核对", exact: true });
  const table = cash.getByRole("region", { name: "逐日现金核对", exact: true });
  await table.locator("tbody tr").first().waitFor({ timeout: 60000 });
  const rowDate = await table
    .locator("tbody tr")
    .first()
    .getByRole("button")
    .textContent();
  const detailsPattern = /\/api\/trpc\/.*cashWorkspaceDate/;
  await page.route(detailsPattern, (route) => route.abort("failed"), {
    times: 1,
  });
  await cash.getByRole("button", { name: rowDate, exact: true }).click();
  const detail = cash.getByRole("region", {
    name: "现金核对详情",
    exact: true,
  });
  await detail.getByRole("alert").waitFor();
  await detail.getByRole("button", { name: "重试原请求", exact: true }).click();
  await detail
    .getByRole("button", { name: "查看逐行证据", exact: true })
    .waitFor();
  await detail
    .getByRole("button", { name: "返回日期列表", exact: true })
    .click();
  const exportPattern = /\/api\/trpc\/.*cashWorkspaceExport/;
  await page.route(exportPattern, (route) => route.abort("failed"), {
    times: 1,
  });
  await cash
    .getByRole("button", { name: "导出全部日期证据", exact: true })
    .click();
  await cash.getByRole("alert").waitFor();
  assert.equal(await table.locator("tbody tr").count(), 20);
  const downloaded = page.waitForEvent("download");
  await cash.getByRole("button", { name: "重试原请求", exact: true }).click();
  await downloaded;
  // Allocation can fail even after the server export succeeded. Restore the
  // browser API immediately after one injected failure, then retry unchanged.
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (...args) {
      URL.createObjectURL = original;
      throw new Error("cash test Blob allocation failure");
    };
  });
  await cash
    .getByRole("button", { name: "导出全部日期证据", exact: true })
    .click();
  await cash
    .getByRole("alert")
    .filter({ hasText: "cash test Blob allocation failure" })
    .waitFor();
  assert.equal(await table.locator("tbody tr").count(), 20);
  const allocationRetry = page.waitForEvent("download");
  await cash.getByRole("button", { name: "重试原请求", exact: true }).click();
  await allocationRetry;
  // A real independent connection changes identity without changing the count.
  await cash.getByRole("button", { name: rowDate, exact: true }).click();
  await detail
    .getByRole("button", { name: "查看逐行证据", exact: true })
    .waitFor();
  // Headless Chrome keeps both tabs visible/focused on this host. Exercise the
  // application visibility subscriber explicitly; the DB writer remains real.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  db.prepare("UPDATE import_batches SET file_name=? WHERE id=?").run(
    "external-cash-test.csv",
    batch.id,
  );
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await cash
    .getByText("账户数据已更新，原详情版本已过期。筛选和日期选择已保留。", {
      exact: true,
    })
    .waitFor();
  await cash.getByRole("button", { name: "更新当前详情", exact: true }).click();
  await detail
    .getByRole("button", { name: "查看逐行证据", exact: true })
    .waitFor();
  await detail
    .getByRole("button", { name: "返回日期列表", exact: true })
    .click();
  // An old account export may finish, but must never download or report success
  // after the user has switched accounts.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let intercepted;
  const ready = new Promise((resolve) => {
    intercepted = resolve;
  });
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  await page.route(
    exportPattern,
    async (route) => {
      const response = await route.fetch();
      intercepted();
      await gate;
      await route.fulfill({ response });
      finished();
    },
    { times: 1 },
  );
  const lateDownloads = [];
  page.on("download", (download) =>
    lateDownloads.push(download.suggestedFilename()),
  );
  await cash
    .getByRole("button", { name: "导出全部日期证据", exact: true })
    .click();
  await ready;
  await page.getByLabel("复盘账户别名").fill("现金空账户");
  await page.getByRole("button", { name: "查看复盘", exact: true }).click();
  await cash
    .getByRole("heading", { name: "现金核对 · 现金空账户", exact: true })
    .waitFor();
  release();
  await done;
  await cash.getByRole("alert").waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(lateDownloads, []);
  assert.equal(await cash.getByText(/已触发账户/).count(), 0);
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    detailFailureRetry: true,
    exportFailureRetry: true,
    blobAllocationFailureRetry: true,
    realExternalChange: true,
    visibilityMode:
      "controlled DOM visibilitychange; headless tabs remain focused on this host",
    staleDetailRefresh: true,
    accountSwitchLateExport: true,
    emptyAccountOwnError: true,
  };
  writeFileSync(join(logs, "q2-errors.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  db.prepare("UPDATE import_batches SET file_name=? WHERE id=?").run(
    batch.file_name,
    batch.id,
  );
  db.close();
  await browser.close();
}
