import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-trade-ledger"),
  base = "http://127.0.0.1:3226";
const db = new Database(join(tmpdir(), "quant-trade-ledger-s0b/quant.sqlite"));
const tag = `隔离账本UI-${Date.now()}`;
const facts = () =>
  JSON.stringify(db.prepare("SELECT * FROM trade_ledger ORDER BY id").all());
const before = createHash("sha256").update(facts()).digest("hex");
const originalStop = db
  .prepare("SELECT * FROM records WHERE id='trade-stop-sh600000'")
  .get();
const owned = () =>
  db
    .prepare(
      "SELECT id,payload FROM trade_ledger WHERE json_extract(payload,'$.note') LIKE ?",
    )
    .all(tag + "%");
let browser;
const errors = [],
  checks = [];
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/trade-ledger`);
  const summary = page.getByLabel("全部持仓摘要", { exact: true });
  await summary.getByText("10000笔", { exact: true }).waitFor();
  const positions = page.getByLabel("持仓列表", { exact: true });
  assert.equal(await positions.locator("article").count(), 20);
  await page.getByRole("button", { name: "下一页持仓", exact: true }).click();
  await positions
    .getByRole("heading", { name: "sh600020 · 持有", exact: true })
    .waitFor();
  assert.match(await summary.innerText(), /10000笔/);
  await page.getByRole("button", { name: "上一页持仓", exact: true }).click();
  await page.getByLabel("sh600000 止损价", { exact: true }).fill("9.3");
  await positions
    .locator("article")
    .first()
    .getByRole("button", { name: "保存止损", exact: true })
    .click();
  await page
    .getByText("已保存止损价 9.3；不自动卖出。", { exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(
      db
        .prepare("SELECT payload FROM records WHERE id='trade-stop-sh600000'")
        .get().payload,
    ).stop,
    9.3,
  );
  checks.push(
    "position paging retains full totals; per-security stop save is independent",
  );
  await page.getByRole("tab", { name: "交易历史", exact: true }).click();
  await page
    .getByLabel("交易历史列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  await page.getByLabel("精确证券代码", { exact: true }).fill("sh600000");
  await page.getByRole("button", { name: "查询交易", exact: true }).click();
  await page.getByText(/筛选全部匹配 50笔/).waitFor();
  const rows = page
    .getByLabel("交易历史列表", { exact: true })
    .getByRole("button");
  const firstId = await rows.first().getAttribute("data-trade-row");
  await page.getByRole("button", { name: "下一页交易", exact: true }).click();
  await page.waitForFunction(
    (id) =>
      document
        .querySelector('[aria-label="交易历史列表"] button')
        ?.getAttribute("data-trade-row") !== id,
    firstId,
  );
  const selectedId = await rows.first().getAttribute("data-trade-row");
  await rows.first().click();
  const detail = page.getByLabel("账本记录详情", { exact: true });
  await detail.getByRole("heading", { name: /sh600000/ }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await detail
    .getByRole("button", { name: "导出完整记录", exact: true })
    .click();
  const download = await downloadPromise;
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  const stored = JSON.parse(
    db.prepare("SELECT payload FROM trade_ledger WHERE id=?").get(selectedId)
      .payload,
  );
  assert.deepEqual(exported.data.trade, stored);
  await detail.getByRole("button", { name: "返回列表", exact: true }).click();
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-trade-row") === id,
    selectedId,
  );
  assert.equal(await rows.first().getAttribute("data-trade-row"), selectedId);
  const allPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出筛选全集 JSON", exact: true })
    .click();
  const all = await allPromise,
    allData = JSON.parse(readFileSync(await all.path(), "utf8"));
  assert.equal(allData.count, 50);
  assert.equal(allData.trades.length, 50);
  checks.push(
    "stable history filters/pages, complete single and filtered export, return focus",
  );
  await page
    .getByRole("button", { name: "新增本地交易 / 恢复草稿", exact: true })
    .click();
  const editor = page.getByLabel("本地交易草稿", { exact: true });
  async function fill(note) {
    for (const [label, value] of [
      ["证券代码", "sh600199"],
      ["交易日期", "2026-09-07"],
      ["成交价格", "10"],
      ["成交股数（100的整数倍）", "100"],
      ["当日跌停价", "9"],
      ["当日涨停价", "11"],
      ["涨跌停依据", "隔离终端"],
      ["交易备注", note],
    ])
      await editor.getByLabel(label, { exact: true }).fill(value);
  }
  await fill(`${tag}-A`);
  await page.getByRole("tab", { name: "除权依据", exact: true }).click();
  await page
    .getByLabel("除权依据列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "新增本地交易 / 恢复草稿", exact: true })
    .click();
  assert.equal(
    await editor.getByLabel("交易备注", { exact: true }).inputValue(),
    `${tag}-A`,
  );
  await editor
    .getByRole("button", { name: "仅保存本地交易", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "查看已保存交易", exact: true })
    .waitFor();
  assert.equal(owned().length, 1);
  await editor.getByRole("button", { name: "新增下一笔", exact: true }).click();
  assert.equal(
    await editor.getByLabel("证券代码", { exact: true }).inputValue(),
    "",
  );
  await fill(`${tag}-B`);
  let abortOnce = true,
    postCount = 0;
  await page.route("**/trade-ledger*", async (route) => {
    if (
      route.request().method() !== "POST" ||
      !route.request().headers()["next-action"]
    ) {
      await route.continue();
      return;
    }
    postCount++;
    if (abortOnce) {
      abortOnce = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await editor
    .getByRole("button", { name: "仅保存本地交易", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "重试这份提交（相同编号）", exact: true })
    .waitFor();
  assert.equal(owned().length, 2);
  const unknownId = owned().find(
    (row) => JSON.parse(row.payload).note === `${tag}-B`,
  ).id;
  await editor
    .getByRole("button", { name: "重试这份提交（相同编号）", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "查看已保存交易", exact: true })
    .waitFor();
  assert.equal(postCount, 2);
  assert.equal(owned().length, 2);
  assert.equal(
    owned().find((row) => JSON.parse(row.payload).note === `${tag}-B`).id,
    unknownId,
  );
  await page.unroute("**/trade-ledger*");
  checks.push(
    "draft survives tabs; new after saved is fresh; lost acknowledgement retries same ID exactly once",
  );
  await editor
    .getByRole("button", { name: "查看已保存交易", exact: true })
    .click();
  await detail.getByRole("heading", { name: /sh600199/ }).waitFor();
  await page.getByText(/筛选全部匹配 50笔/).waitFor();
  assert.equal(
    await page
      .getByText("账本已更新，请刷新后重新检索", { exact: true })
      .count(),
    0,
    "own writes reset inactive history cursor",
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    if (width < 1240)
      assert.equal(
        await page.getByLabel("交易历史列表", { exact: true }).isVisible(),
        false,
      );
    await page.screenshot({
      path: join(logs, `workspace-${width}.png`),
      fullPage: true,
    });
  }
  await detail.getByRole("button", { name: "返回列表", exact: true }).click();
  await page
    .getByRole("button", { name: "展开同花顺模拟盘", exact: true })
    .click();
  await page.getByRole("button", { name: "开启模拟盘", exact: true }).waitFor();
  assert.equal(
    db
      .prepare("SELECT payload FROM records WHERE id='mock-trading-config'")
      .get(),
    undefined,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "确认发送这笔模拟委托", exact: true })
      .count(),
    0,
  );
  checks.push(
    "three widths without overflow, narrow detail replaces list, remote integration stays disabled",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "workspace-browser.json"),
    JSON.stringify(
      { checks, errors, build: readFileSync(".next/BUILD_ID", "utf8").trim() },
      null,
      2,
    ),
  );
  console.log("Trade workspace functional browser passed");
} finally {
  await browser?.close();
  db.transaction(() => {
    for (const row of owned())
      db.prepare("DELETE FROM trade_ledger WHERE id=?").run(row.id);
    db.prepare("DELETE FROM records WHERE id='trade-stop-sh600000'").run();
    if (originalStop)
      db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
        originalStop.id,
        originalStop.kind,
        originalStop.payload,
        originalStop.updated_at,
      );
  })();
  assert.equal(createHash("sha256").update(facts()).digest("hex"), before);
  db.close();
}
