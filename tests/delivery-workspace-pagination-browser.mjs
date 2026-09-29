import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-delivery-import"),
  base = "http://127.0.0.1:3228";
const fixture = JSON.parse(readFileSync(join(logs, "fixture.json"), "utf8"));
assert.equal(
  resolve(fixture.directory),
  resolve(join(tmpdir(), "quant-delivery-import-browser")),
);
const db = new Database(join(fixture.directory, "quant.sqlite"));
const hash = () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        db.prepare("SELECT * FROM import_batches ORDER BY id").all(),
      ),
    )
    .digest("hex");
assert.equal(hash(), fixture.hash);
const account = "分页恢复专用验收",
  prefix = "pagination-check-";
assert.equal(
  db
    .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
    .get(account).n,
  0,
);
const insert = db.prepare("INSERT INTO import_batches VALUES (?,?,?,?,?,?,?)");
db.transaction(() => {
  for (let i = 0; i < 21; i++)
    insert.run(
      `${prefix}${i}`,
      account,
      "generic",
      `${prefix}hash-${i}`,
      `page-${i}.csv`,
      1700000000000 + i,
      JSON.stringify({
        statistics: { fills: 0, cashFlows: 0, unresolved: 0, anomalies: 0 },
        rawRows: [[String(i)]],
        unresolved: [],
        diagnostics: [],
      }),
    );
})();
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
  const body = await response.text();
  assert.equal(response.status, 200, body.slice(0, 400));
  return JSON.parse(body).result.data.json;
}
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  errors = [],
  checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/trade-review`);
  await page.getByRole("button", { name: "历史批次", exact: true }).click();
  await page.getByLabel("批次账户", { exact: true }).fill(account);
  await page.getByRole("button", { name: "检索批次", exact: true }).click();
  await page.getByText("第 1 页 · 21 批", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页批次", exact: true }).click();
  await page.getByText("第 2 页 · 21 批", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "查看批次 page-0.csv", exact: true })
    .click();
  await page.getByRole("button", { name: "核对撤销影响", exact: true }).click();
  await page.getByRole("button", { name: "确认撤销", exact: true }).click();
  await page.getByText("第 1 页 · 20 批", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "下一页批次", exact: true })
      .isDisabled(),
    true,
  );
  checks.push("last-page-revoke-clamps-to-valid-page");
  const open = page.getByRole("button", {
    name: "查看批次 page-20.csv",
    exact: true,
  });
  await open.click();
  const detail = page.getByLabel("批次证据详情", { exact: true });
  await detail
    .getByRole("heading", { name: `page-20.csv · ${account}`, exact: true })
    .waitFor();
  await detail
    .getByRole("button", { name: "核对撤销影响", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "核对撤销影响",
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM import_batches WHERE account=?")
      .get(account).n,
    20,
  );
  checks.push("cancel-revoke-restores-trigger-focus-and-writes-nothing");
  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(
    await page
      .getByRole("table", { name: "历史导入批次", exact: true })
      .isVisible(),
    false,
  );
  await detail.focus();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.activeElement?.id === "delivery-batch-pagination-check-20",
  );
  checks.push("1024-detail-replaces-list-and-escape-restores-focus");
  await open.click();
  await detail
    .getByRole("heading", { name: `page-20.csv · ${account}`, exact: true })
    .waitFor();
  await api(
    "deliveryRevokeChecked",
    await api("deliveryBatchDetail", `${prefix}20`),
    true,
  );
  await page.getByRole("button", { name: "刷新批次", exact: true }).click();
  await detail.getByText("批次不存在或已撤销。", { exact: true }).waitFor();
  assert.equal(
    await detail
      .getByRole("button", { name: "核对撤销影响", exact: true })
      .count(),
    0,
  );
  checks.push("external-revoke-refresh-clears-stale-detail");
  assert.deepEqual(errors, []);
  const report = {
    checks,
    errors,
    build: readFileSync(".next/BUILD_ID", "utf8").trim(),
  };
  writeFileSync(
    join(logs, "workspace-pagination-browser.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  db.prepare(
    "DELETE FROM import_batches WHERE account=? AND substr(id,1,?)=?",
  ).run(account, prefix.length, prefix);
  assert.equal(hash(), fixture.hash);
  db.close();
}
