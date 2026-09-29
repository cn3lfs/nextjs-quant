import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-delivery-import"),
  base = "http://127.0.0.1:3228";
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
const db = new Database(join(fixture.directory, "quant.sqlite"), {
  readonly: true,
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [],
  checks = [],
  timings = {};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-review`);
  await page
    .getByLabel("交割单目录（只读）", { exact: true })
    .fill(fixture.files);
  await page.getByRole("button", { name: "检索文件", exact: true }).click();
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByLabel("账户别名", { exact: true }).fill("浏览器交割单验收");
  let started = performance.now();
  await page.getByRole("button", { name: "预览并核对", exact: true }).click();
  await page
    .getByRole("button", { name: "核对第 20 行", exact: true })
    .waitFor({ timeout: 120000 });
  timings.previewMs = performance.now() - started;
  assert.equal(
    await page
      .getByLabel("预览核对行", { exact: true })
      .getByRole("button", { name: /^核对第/ })
      .count(),
    20,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM trade_fills").get().n, 0);
  await page.getByRole("button", { name: "下一页核对", exact: true }).click();
  await page
    .getByRole("button", { name: "核对第 40 行", exact: true })
    .waitFor();
  await page.getByLabel("核对关键词", { exact: true }).fill("fixture-9999");
  await page
    .getByRole("button", { name: "核对第 10000 行", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "核对第 10000 行", exact: true })
    .click();
  assert.match(
    await page.getByLabel("单行证据", { exact: true }).innerText(),
    /fixture-9999/,
  );
  checks.push(
    "twenty-row-page; second-page; last-row-search-and-evidence; preview-zero-writes",
  );
  let downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出完整核对证据", exact: true })
    .click();
  const previewDownload = await downloadPromise;
  const previewEvidence = JSON.parse(
    readFileSync(await previewDownload.path(), "utf8"),
  );
  assert.equal(previewEvidence.preview.rawRows.length, 10000);
  assert.equal(previewEvidence.preview.sourceHeader[0], "成交日期");
  await page.getByText("列映射、诊断与范围统计", { exact: true }).click();
  const mapping = page.getByLabel("列映射结果", { exact: true });
  assert.match(await mapping.innerText(), /第 1 列「成交日期」/);
  assert.match(await mapping.innerText(), /资金发生额/);
  assert.equal((await mapping.innerText()).includes("tradeDate"), false);
  await page.screenshot({ path: join(logs, "workspace-preview-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: join(logs, "workspace-preview-390.png") });
  assert.equal(
    await page
      .getByRole("table", { name: "预览核对行", exact: true })
      .isVisible(),
    false,
  );
  await page.getByLabel("单行证据", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "核对第 10000 行", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "核对第 10000 行",
    null,
    { timeout: 5000 },
  );
  await page.keyboard.press("Enter");
  await page.getByLabel("单行证据", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回核对列表", exact: true }).click();
  await page
    .getByRole("button", { name: "核对第 10000 行", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "核对第 10000 行",
    null,
    { timeout: 5000 },
  );
  checks.push(
    "chinese-original-column-mapping; mobile-detail-replaces-list; escape-and-focus-return",
  );
  await page
    .getByRole("button", { name: "确认导入到 浏览器交割单验收", exact: true })
    .click();
  await page
    .getByLabel("导入收据", { exact: true })
    .waitFor({ timeout: 120000 });
  assert.match(
    await page.getByLabel("导入收据", { exact: true }).innerText(),
    /首次新增成交 10000/,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM trade_fills").get().n, 10000);
  assert.equal(
    await page.getByLabel("复盘账户别名", { exact: true }).inputValue(),
    "",
  );
  await page.getByRole("button", { name: "查看该批次", exact: true }).click();
  await page
    .getByRole("button", { name: "核对撤销影响", exact: true })
    .waitFor();
  downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出本批完整 JSON", exact: true })
    .click();
  const batchDownload = await downloadPromise;
  const saved = JSON.parse(readFileSync(await batchDownload.path(), "utf8"));
  assert.equal(saved.fills.length, 10000);
  assert.equal(saved.evidence.rawRows.length, 10000);
  checks.push(
    "full-preview-export; receipt-actual-count; review-not-auto-started; full-batch-export",
  );
  await page.getByRole("button", { name: "核对撤销影响", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.match(await page.getByRole("dialog").innerText(), /不会自动补回/);
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await page
    .getByText("撤销完成：实际删除成交 10000 笔、现金流 0 笔。", {
      exact: true,
    })
    .waitFor({ timeout: 120000 });
  assert.equal(db.prepare("SELECT count(*) n FROM trade_fills").get().n, 0);
  const actualHash = createHash("sha256")
    .update(
      JSON.stringify(
        db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
      ),
    )
    .digest("hex");
  assert.equal(actualHash, fixture.hash);
  checks.push("exact-revoke; original-batches-restored");
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  assert.equal(
    await page.getByLabel("导入收据", { exact: true }).count(),
    0,
    "revoked batch must not retain a success receipt",
  );
  await page.getByRole("button", { name: "核对提交结果", exact: true }).click();
  await page.getByText(/目前未找到批次/).waitFor();
  checks.push("revoke-invalidates-import-receipt");
  await page.screenshot({ path: join(logs, "workspace-batches-390.png") });
  const result = {
    checks,
    timings,
    errors,
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
    browser: browser.version(),
    hash: actualHash,
  };
  writeFileSync(
    join(logs, "workspace-browser.json"),
    JSON.stringify(result, null, 2),
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page)
    await page.screenshot({
      path: join(logs, "workspace-browser-failure.png"),
    });
  throw error;
} finally {
  await browser.close();
  db.close();
}
