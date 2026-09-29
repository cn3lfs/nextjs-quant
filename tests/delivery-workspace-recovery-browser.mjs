import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-delivery-import"),
  base = "http://127.0.0.1:3228";
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
const file = join(fixture.files, "recovery-fixture.csv"),
  account = "响应恢复验收";
assert.equal(existsSync(file), false, "do not overwrite another fixture");
const content =
  "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额,成交编号\n20240301,600000,买入,10,100,1000,-1000,recovery-unique";
writeFileSync(file, content);
const db = new Database(join(fixture.directory, "quant.sqlite"), {
  readonly: true,
});
const browser = await chromium.launch({ channel: "chrome", headless: true });
async function api(name, input, mutation = false) {
  const payload = JSON.stringify({ json: input });
  const response = await fetch(
    `${base}/api/trpc/${name}${mutation ? "" : `?input=${encodeURIComponent(payload)}`}`,
    {
      method: mutation ? "POST" : "GET",
      headers: {
        "x-quant-client": "workbench",
        origin: base,
        "content-type": "application/json",
      },
      ...(mutation ? { body: payload } : {}),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 400));
  return JSON.parse(text).result.data.json;
}
const checks = [],
  errors = [];
try {
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
      .get(account).n,
    0,
  );
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-review`);
  await page
    .getByLabel("交割单目录（只读）", { exact: true })
    .fill(fixture.files);
  await page
    .getByLabel("文件名关键词", { exact: true })
    .fill("recovery-fixture");
  await page.getByRole("button", { name: "检索文件", exact: true }).click();
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page.getByLabel("账户别名", { exact: true }).fill(account);
  await page.getByRole("button", { name: "预览并核对", exact: true }).click();
  await page
    .getByRole("button", { name: "核对第 1 行", exact: true })
    .waitFor();
  let intercepted = false;
  await page.route("**/api/trpc/deliveryPreviewConfirm*", async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    intercepted = true;
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: `确认导入到 ${account}`, exact: true })
    .click();
  await page
    .getByText("结果待核对，请查询收据；不要更换文件重复导入。", {
      exact: true,
    })
    .waitFor();
  assert.equal(intercepted, true);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
      .get(account).n,
    1,
  );
  unlinkSync(file);
  await page.reload();
  await page
    .getByText("上次提交结果待核对，请先查询收据。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "核对提交结果", exact: true }).click();
  await page.getByLabel("导入收据", { exact: true }).waitFor();
  assert.match(
    await page.getByLabel("导入收据", { exact: true }).innerText(),
    /首次新增成交 1/,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
      .get(account).n,
    1,
  );
  checks.push(
    "commit-response-aborted-after-save; reload-pending; source-deleted; receipt-recovered-without-duplicate",
  );
  await page.route("**/api/trpc/deliveryBatchPage*", (route) =>
    route.abort("failed"),
  );
  await page.getByRole("button", { name: "历史批次", exact: true }).click();
  await page
    .getByRole("table", { name: "历史导入批次", exact: true })
    .getByRole("alert")
    .waitFor();
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  await page.getByLabel("导入收据", { exact: true }).waitFor();
  assert.match(
    await page.getByLabel("导入收据", { exact: true }).innerText(),
    /首次新增成交 1/,
  );
  await page.unroute("**/api/trpc/deliveryBatchPage*");
  await page.getByRole("button", { name: "历史批次", exact: true }).click();
  await page.getByRole("button", { name: "刷新批次", exact: true }).click();
  await page
    .getByRole("button", { name: "查看批次 recovery-fixture.csv", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  checks.push(
    "saved-receipt-survives-list-failure; explicit-refresh-recovers-list",
  );
  const id = db
    .prepare("SELECT id FROM import_batches WHERE account=?")
    .get(account).id;
  await api(
    "deliveryRevokeChecked",
    await api("deliveryBatchDetail", id),
    true,
  );
  writeFileSync(file, content);
  await page.unroute("**/api/trpc/deliveryPreviewConfirm*");
  await page.getByRole("button", { name: "继续导入", exact: true }).click();
  await page.getByRole("button", { name: "预览并核对", exact: true }).click();
  await page
    .getByRole("button", { name: "核对第 1 行", exact: true })
    .waitFor();
  writeFileSync(file, content.replace("recovery-unique", "changed-file"));
  await page
    .getByRole("button", { name: `确认导入到 ${account}`, exact: true })
    .click();
  await page
    .getByText("文件已改变，请重新预览后确认导入", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "核对提交结果", exact: true }).click();
  await page.getByText(/目前未找到批次/).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: `确认导入到 ${account}`, exact: true })
      .count(),
    0,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
      .get(account).n,
    0,
  );
  checks.push(
    "changed-file-rejected; not-found-does-not-retry; old-confirmation-cleared",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "workspace-recovery-browser.json"),
    JSON.stringify(
      { checks, errors, build: readFileSync(".next/BUILD_ID", "utf8").trim() },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, errors }));
} finally {
  for (const row of db
    .prepare("SELECT id FROM import_batches WHERE account=?")
    .all(account))
    await api(
      "deliveryRevokeChecked",
      await api("deliveryBatchDetail", row.id),
      true,
    );
  if (existsSync(file)) unlinkSync(file);
  const actual = createHash("sha256")
    .update(
      JSON.stringify(
        db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
      ),
    )
    .digest("hex");
  assert.equal(actual, fixture.hash);
  await browser.close();
  db.close();
}
