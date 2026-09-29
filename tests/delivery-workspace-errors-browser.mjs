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
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  checks = [],
  errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/trade-review`);
  await page
    .getByLabel("交割单目录（只读）", { exact: true })
    .fill(fixture.files);
  await page.getByRole("button", { name: "检索文件", exact: true }).click();
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByLabel("账户别名", { exact: true }).fill("迟到预览旧账户");
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  let fetched;
  const fetchedPromise = new Promise((r) => {
    fetched = r;
  });
  await page.route("**/api/trpc/deliveryPreviewStart*", async (route) => {
    const response = await route.fetch();
    fetched();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "预览并核对", exact: true }).click();
  await fetchedPromise;
  await page.getByLabel("账户别名", { exact: true }).fill("迟到预览新账户");
  const done = page.waitForResponse((r) =>
    r.url().includes("deliveryPreviewStart"),
  );
  release();
  await done;
  await page.getByRole("button", { name: "预览并核对", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "确认导入到 迟到预览旧账户", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByLabel("账户别名", { exact: true }).inputValue(),
    "迟到预览新账户",
  );
  await page.unroute("**/api/trpc/deliveryPreviewStart*");
  checks.push("late-preview-does-not-overwrite-edited-account");
  await page.getByRole("button", { name: "预览并核对", exact: true }).click();
  await page
    .getByRole("button", { name: "确认导入到 迟到预览新账户", exact: true })
    .waitFor();
  for (let i = 0; i < 5; i++) {
    const response = await fetch(`${base}/api/trpc/deliveryPreviewStart`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-quant-client": "workbench",
        origin: base,
      },
      body: JSON.stringify({
        json: {
          path: join(fixture.files, "large.csv"),
          account: `逐出预览-${i}`,
          source: "generic",
        },
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  await page
    .getByRole("button", { name: "确认导入到 迟到预览新账户", exact: true })
    .click();
  await page
    .getByText("预览已过期或服务已重启，请重新预览", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "核对提交结果", exact: true }).click();
  await page.getByText(/目前未找到批次/).waitFor();
  checks.push("evicted-preview-blocks-confirm-and-recovers-without-writing");
  assert.equal(db.prepare("SELECT count(*) n FROM trade_fills").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM cash_flows").get().n, 0);
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify(
          db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
        ),
      )
      .digest("hex"),
    fixture.hash,
  );
  assert.deepEqual(errors, []);
  const report = {
    checks,
    errors,
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
  };
  writeFileSync(
    join(logs, "workspace-errors-browser.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  db.close();
}
