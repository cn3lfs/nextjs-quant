import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const db = new Database(join(tmpdir(), "quant-trade-ledger-s0b/quant.sqlite"));
const digest = () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        db.prepare("SELECT * FROM trade_ledger ORDER BY id").all(),
      ),
    )
    .digest("hex");
const before = digest(),
  tag = `隔离恢复-${randomUUID()}`,
  base = "http://127.0.0.1:3226",
  checks = [],
  errors = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });
let release;
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto(base + "/trade-ledger");
  const open = () =>
    page
      .getByRole("button", { name: "新增本地交易 / 恢复草稿", exact: true })
      .click();
  await open();
  const editor = page.getByLabel("本地交易草稿", { exact: true });
  for (const [label, value] of [
    ["证券代码", "sh600199"],
    ["交易日期", "2026-09-07"],
    ["成交价格", "10"],
    ["成交股数（100的整数倍）", "100"],
    ["当日跌停价", "9"],
    ["当日涨停价", "11"],
    ["涨跌停依据", "隔离恢复"],
    ["交易备注", tag + "-A"],
  ])
    await editor.getByLabel(label, { exact: true }).fill(value);
  let received;
  const pending = new Promise((r) => (release = r)),
    sent = new Promise((r) => (received = r));
  const saveRoute = async (route) => {
    if (
      route.request().method() !== "POST" ||
      !route.request().headers()["next-action"]
    )
      return route.continue();
    const response = await route.fetch();
    received();
    await pending;
    await route.fulfill({ response });
  };
  await page.route("**/trade-ledger**", saveRoute);
  await editor
    .getByRole("button", { name: "仅保存本地交易", exact: true })
    .click();
  await sent;
  const frozen = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("trade-workspace-draft-v1")).attempt
        .input.id,
  );
  await editor.getByLabel("交易备注", { exact: true }).fill(tag + "-B");
  const newId = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("trade-workspace-draft-v1")).draft.id,
  );
  assert.notEqual(newId, frozen);
  await page.getByRole("tab", { name: "交易历史", exact: true }).click();
  release();
  await open();
  await editor
    .getByRole("button", { name: "查看已保存交易", exact: true })
    .waitFor();
  assert.equal(
    await editor.getByLabel("交易备注", { exact: true }).inputValue(),
    tag + "-B",
  );
  assert.equal(
    JSON.parse(
      db.prepare("SELECT payload FROM trade_ledger WHERE id=?").get(frozen)
        .payload,
    ).note,
    tag + "-A",
  );
  assert.equal(
    db.prepare("SELECT id FROM trade_ledger WHERE id=?").get(newId),
    undefined,
  );
  await page.unroute("**/trade-ledger**", saveRoute);
  checks.push(
    "late A acknowledgement preserves edited B identity and contents across tabs",
  );
  await page.route("**/trade-ledger**", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    )
      await route.abort("failed");
    else await route.continue();
  });
  await editor
    .getByRole("button", { name: "仅保存本地交易", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "重试这份提交（相同编号）", exact: true })
    .waitFor();
  assert.equal(
    await editor.getByLabel("交易备注", { exact: true }).inputValue(),
    tag + "-B",
  );
  await page.unroute("**/trade-ledger**");
  await page.reload();
  await open();
  await editor
    .getByRole("button", { name: "重试这份提交（相同编号）", exact: true })
    .waitFor();
  assert.equal(
    await editor.getByLabel("交易备注", { exact: true }).inputValue(),
    tag + "-B",
  );
  const restored = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("trade-workspace-draft-v1")),
  );
  assert.equal(restored.attempt.input.id, newId);
  assert.equal(restored.attempt.state, "unknown");
  await editor
    .getByRole("button", { name: "重试这份提交（相同编号）", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "查看已保存交易", exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(
      db.prepare("SELECT payload FROM trade_ledger WHERE id=?").get(newId)
        .payload,
    ).note,
    tag + "-B",
  );
  checks.push(
    "failed save retains input; reload restores unknown frozen identity; same-ID retry saves once",
  );
  await page.evaluate(() =>
    sessionStorage.setItem("trade-workspace-draft-v1", '{"schemaVersion":99}'),
  );
  await page.reload();
  await page
    .getByText("上次草稿无法校验，未自动使用；请重新核对输入。", {
      exact: true,
    })
    .waitFor();
  checks.push("corrupted session is rejected visibly");
  await page.goto(base + "/trade-ledger?view=history&record=" + randomUUID());
  await page
    .getByLabel("账本记录详情", { exact: true })
    .getByText(/不存在/)
    .waitFor();
  await page
    .getByLabel("账本记录详情", { exact: true })
    .getByRole("button", { name: "返回列表", exact: true })
    .click();
  const list = page.getByLabel("交易历史列表", { exact: true });
  await list.getByRole("button").first().click();
  await page
    .getByRole("button", { name: "导出完整记录", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByLabel("账本记录详情", { exact: true }).count(),
    0,
  );
  assert.equal(
    await list
      .getByRole("button")
      .first()
      .evaluate((e) => e === document.activeElement),
    true,
  );
  checks.push("missing record and Escape restore list focus");
  await open();
  const previousDate = await editor
    .getByLabel("交易日期", { exact: true })
    .inputValue();
  await page.evaluate(() => {
    Date.now = () => Date.parse("2026-09-30T00:01:00+08:00");
  });
  assert.equal(
    await editor.getByLabel("交易日期", { exact: true }).inputValue(),
    previousDate,
  );
  await editor.getByRole("button", { name: "新增下一笔", exact: true }).click();
  assert.equal(
    await editor.getByLabel("交易日期", { exact: true }).inputValue(),
    "2026-09-30",
  );
  checks.push(
    "Beijing day rollover preserves existing draft and dates a new draft on the new day",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs/quant-trade-ledger/recovery-browser.json"),
    JSON.stringify(
      { checks, errors, build: readFileSync(".next/BUILD_ID", "utf8") },
      null,
      2,
    ),
  );
  console.log(checks);
} finally {
  release?.();
  await browser.close();
  db.prepare(
    "DELETE FROM trade_ledger WHERE json_extract(payload,'$.note') LIKE ?",
  ).run(tag + "%");
  assert.equal(digest(), before);
  db.close();
}
