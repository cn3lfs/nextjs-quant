import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const db = new Database(join(tmpdir(), "quant-trade-ledger-s0b/quant.sqlite"));
const original = db
  .prepare(
    "SELECT * FROM records WHERE id IN ('settings','mock-trading-config')",
  )
  .all();
const settings = original.find((r) => r.id === "settings"),
  tag = "预览隔离-" + randomUUID();
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const config = JSON.parse(settings.payload);
db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
  JSON.stringify({
    ...config,
    calendar: [...new Set([...config.calendar, today])].sort(),
  }),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto("http://127.0.0.1:3226/trade-ledger");
  await page
    .getByRole("button", { name: "新增本地交易 / 恢复草稿", exact: true })
    .click();
  const editor = page.getByLabel("本地交易草稿", { exact: true });
  for (const [label, value] of [
    ["证券代码", "sh600199"],
    ["交易日期", today],
    ["成交价格", "10"],
    ["成交股数（100的整数倍）", "100"],
    ["当日跌停价", "9"],
    ["当日涨停价", "11"],
    ["涨跌停依据", "隔离本地预览"],
    ["交易备注", tag],
  ])
    await editor.getByLabel(label, { exact: true }).fill(value);
  await page
    .getByRole("button", { name: "展开同花顺模拟盘", exact: true })
    .click();
  await page.getByRole("button", { name: "开启模拟盘", exact: true }).click();
  const preview = page.getByRole("button", {
    name: "用当前本地草稿预览模拟委托",
    exact: true,
  });
  await preview.click();
  const confirmation = page.getByRole("group", {
    name: "确认模拟委托",
    exact: true,
  });
  await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /100股 × 10/);
  await editor.getByLabel("成交价格", { exact: true }).fill("10.2");
  assert.match(await confirmation.innerText(), /100股 × 10/);
  assert.doesNotMatch(await confirmation.innerText(), /10\.2/);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes("用当前本地草稿预览模拟委托"),
  );
  await preview.click();
  await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /100股 × 10\.2/);
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes("用当前本地草稿预览模拟委托"),
  );
  const pending = db
    .prepare(
      "SELECT payload FROM records WHERE kind='mock-order' AND json_extract(payload,'$.input.note')=?",
    )
    .all(tag)
    .map((r) => JSON.parse(r.payload));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((p) => p.state === "pending"));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM trade_ledger WHERE json_extract(payload,'$.note')=?",
      )
      .get(tag).n,
    0,
  );
  const result = {
    build: readFileSync(".next/BUILD_ID", "utf8"),
    checks: [
      "preview freezes input despite subsequent local edits",
      "cancel and Escape restore preview button focus",
      "two previews remain pending; no confirmation or local trade",
    ],
    remoteConfirmationClicks: 0,
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-trade-ledger/mock-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  await browser.close();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM records WHERE kind='mock-order' AND json_extract(payload,'$.input.note')=?",
    ).run(tag);
    db.prepare(
      "DELETE FROM records WHERE id IN ('settings','mock-trading-config')",
    ).run();
    for (const row of original)
      db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
        row.id,
        row.kind,
        row.payload,
        row.updated_at,
      );
  })();
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM records WHERE id IN ('settings','mock-trading-config')",
      )
      .all(),
    original,
  );
  db.close();
}
