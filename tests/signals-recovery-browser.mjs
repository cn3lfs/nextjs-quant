import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs/quant-signals");
const db = new Database(join(tmpdir(), "quant-signals-s0/quant.sqlite"));
const ids = ["monitor-fixture-999", "monitor-fixture-998", "scheduler-owner"];
// Record all owned originals before touching this isolated fixture.
const originals = db
  .prepare("SELECT * FROM records WHERE id IN (?,?,?)")
  .all(...ids);
assert.equal(originals.filter((row) => row.kind === "monitor").length, 2);
const restore = db.prepare(
  "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at",
);
let browser;
const checks = [],
  errors = [];
try {
  restore.run(
    "scheduler-owner",
    "lease",
    JSON.stringify({ owner: "signals-recovery", pid: process.pid }),
    Date.now(),
  );
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3225/signals");
  const list = page.getByLabel("订阅列表", { exact: true });
  const name = page.getByLabel("订阅名称", { exact: true });
  const edit = async (pattern) => {
    await list.getByRole("button", { name: pattern }).click();
    await page.getByRole("button", { name: "编辑订阅", exact: true }).click();
  };
  await edit(/^合成订阅 999 /);
  await name.fill("保存中A");
  let release, received;
  const held = new Promise((resolve) => (release = resolve));
  const responseReceived = new Promise((resolve) => (received = resolve));
  await page.route("**/api/trpc/monitorWorkspaceSave*", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await responseReceived;
  await name.fill("A的新输入");
  await edit(/^合成订阅 998 /);
  await name.fill("B的独立草稿");
  const hiddenRequests = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && /Workspace/.test(request.url()))
      hiddenRequests.push(request.url());
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  const hiddenStart = hiddenRequests.length;
  release();
  await page
    .getByText("已保存订阅“保存中A”，当前暂停。", { exact: true })
    .waitFor();
  assert.equal(await name.inputValue(), "B的独立草稿");
  await page.waitForTimeout(300);
  assert.equal(
    hiddenRequests.length,
    hiddenStart,
    "late save cannot refetch a hidden module",
  );
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.unroute("**/api/trpc/monitorWorkspaceSave*");
  await edit(/^保存中A /);
  assert.equal(await name.inputValue(), "A的新输入");
  checks.push("late A save preserves newer A revision and independent B draft");
  checks.push(
    "save acknowledgement while hidden performs zero follow-up reads",
  );

  await page.route("**/api/trpc/monitorWorkspaceSave*", (route) =>
    route.abort("failed"),
  );
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await page
    .getByRole("region", { name: "订阅编辑", exact: true })
    .getByRole("alert")
    .waitFor();
  assert.equal(await name.inputValue(), "A的新输入");
  await page.unroute("**/api/trpc/monitorWorkspaceSave*");
  // A separate writer changes the server configuration while the local draft is dirty.
  const original = JSON.parse(
    db.prepare("SELECT payload FROM records WHERE id=?").get(ids[0]).payload,
  );
  db.prepare("UPDATE records SET payload=? WHERE id=?").run(
    JSON.stringify({
      ...original,
      name: "服务器新配置",
      revision: "external-fixture-version",
    }),
    ids[0],
  );
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /配置.*变化|已被.*修改|冲突/ })
    .waitFor();
  assert.equal(await name.inputValue(), "A的新输入");
  await page
    .getByRole("button", { name: "重新读取配置（保留草稿）", exact: true })
    .click();
  await page
    .getByText("已读取最新配置，请对照下方服务端配置核对草稿后再保存。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await name.inputValue(), "A的新输入");
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await page
    .getByText("已保存订阅“A的新输入”，当前暂停。", { exact: true })
    .waitFor();
  checks.push(
    "failed save retains input; revision conflict rejects overwrite; explicit reload preserves draft then saves",
  );
  await name.fill("刷新后草稿");
  const prompt = page.waitForEvent("dialog");
  const reload = page.reload();
  const dialog = await prompt;
  assert.equal(dialog.type(), "beforeunload");
  await dialog.accept();
  await reload;
  await edit(/^A的新输入 /);
  assert.equal(await name.inputValue(), "刷新后草稿");
  checks.push("refresh warns and restores session draft");
  await page.getByRole("button", { name: "返回订阅", exact: true }).click();
  await page.getByRole("tab", { name: "订阅", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("tab", { name: "信号", exact: true })
    .getAttribute("aria-selected")
    .then((value) => assert.equal(value, "true"));
  await page.keyboard.press("End");
  assert.equal(
    await page
      .getByRole("tab", { name: "投递", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  const deliveries = page.getByLabel("投递列表", { exact: true });
  await deliveries.getByRole("button").first().click();
  const detail = page.getByRole("region", {
    name: "监控记录详情",
    exact: true,
  });
  await detail
    .getByRole("button", { name: "导出完整证据", exact: true })
    .waitFor();
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = () => {
      URL.createObjectURL = original;
      throw new Error("fixture export failure");
    };
  });
  await detail
    .getByRole("button", { name: "导出完整证据", exact: true })
    .click();
  await detail
    .getByRole("alert")
    .filter({ hasText: "fixture export failure" })
    .waitFor();
  const downloadPromise = page.waitForEvent("download");
  await detail
    .getByRole("button", { name: "导出完整证据", exact: true })
    .click();
  const exported = JSON.parse(
    readFileSync(await (await downloadPromise).path(), "utf8"),
  );
  assert.equal(exported.kind, "delivery");
  assert.equal(
    await detail
      .getByRole("alert")
      .filter({ hasText: "fixture export failure" })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  assert.equal(await detail.count(), 0);
  await page.waitForFunction(
    () => document.activeElement?.closest('[aria-label="投递列表"]') !== null,
  );
  assert.ok(
    await page.evaluate(
      () => document.activeElement?.closest('[aria-label="投递列表"]') !== null,
    ),
  );
  checks.push(
    "keyboard tabs, Escape and return focus; failed export retries and clears error",
  );

  // New browser context avoids carrying dirty drafts into URL and query recovery checks.
  const other = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await other.goto(
    "http://127.0.0.1:3225/signals?monitorTab=deliveries&monitorRecord=missing-fixture",
  );
  await other
    .getByText("记录不存在或已被清理，请返回列表刷新。", { exact: true })
    .waitFor();
  await other.getByRole("button", { name: "返回列表", exact: true }).click();
  assert.equal(
    await other
      .getByLabel("历史关键词", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await other.route("**/api/trpc/*deliveryWorkspacePage*", (route) =>
    route.abort("failed"),
  );
  await other.getByLabel("历史关键词", { exact: true }).fill("retry-fixture");
  await other.getByRole("button", { name: "查询历史", exact: true }).click();
  await other.getByRole("button", { name: "重试读取", exact: true }).waitFor();
  await other.unroute("**/api/trpc/*deliveryWorkspacePage*");
  await other.getByRole("button", { name: "重试读取", exact: true }).click();
  await other
    .getByText("当前条件下没有投递记录，可重置筛选。", { exact: true })
    .waitFor();
  await other.getByRole("button", { name: "重置筛选", exact: true }).click();
  await other
    .getByLabel("投递列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  checks.push(
    "missing record recovers with focus; list network failure retries original filters; reset restores rows",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "recovery-browser.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await browser?.close();
  db.transaction(() => {
    for (const id of ids) db.prepare("DELETE FROM records WHERE id=?").run(id);
    for (const row of originals)
      restore.run(row.id, row.kind, row.payload, row.updated_at);
  })();
  for (const row of originals)
    assert.deepEqual(
      db.prepare("SELECT * FROM records WHERE id=?").get(row.id),
      row,
    );
  db.close();
}
