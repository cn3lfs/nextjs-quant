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
const logs = join(tmpdir(), "logs/quant-signals"),
  directory = join(tmpdir(), "quant-signals-s0");
const db = new Database(join(directory, "quant.sqlite"));
const originals = db
  .prepare(
    "SELECT * FROM records WHERE id IN ('channel-fixture-0','channel-fixture-1','scheduler-owner')",
  )
  .all();
const restoreRow = db.prepare(
  "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at",
);
const runTag = `隔离UI信号-${Date.now()}`,
  requests = [];
const count = () =>
  db
    .prepare(
      "SELECT count(*) n FROM records WHERE kind IN ('monitor','signal','delivery')",
    )
    .get().n;
const originalCount = count();
let browser;
try {
  restoreRow.run(
    "scheduler-owner",
    "lease",
    JSON.stringify({ owner: "signals-browser-fixture", pid: process.pid }),
    Date.now(),
  );
  for (const row of originals.filter((row) => row.kind === "channel"))
    restoreRow.run(
      row.id,
      row.kind,
      JSON.stringify({
        ...JSON.parse(row.payload),
        enabled: true,
        configured: true,
        target: "",
        thread: "",
      }),
      row.updated_at,
    );
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("deliveryWorkspaceConfirm")
    ) {
      const body = request.postDataJSON();
      for (const value of Object.values(body)) {
        if (value?.json?.requestId) requests.push(value.json.requestId);
      }
      if (body?.json?.requestId) requests.push(body.json.requestId);
    }
  });
  await page.goto("http://127.0.0.1:3225/signals");
  await page
    .getByLabel("订阅列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  await page.getByRole("button", { name: "新建订阅", exact: true }).click();
  await page.getByLabel("订阅名称", { exact: true }).fill(runTag + " A");
  await page
    .getByLabel("证券代码（留空使用当前自选）", { exact: true })
    .fill("sh600519");
  await page.getByRole("button", { name: "保存订阅", exact: true }).click();
  await page
    .getByText(`已保存订阅“${runTag} A”，当前暂停。`, { exact: true })
    .waitFor();
  const created = JSON.parse(
    db
      .prepare(
        "SELECT payload FROM records WHERE kind='monitor' AND json_extract(payload,'$.name')=?",
      )
      .get(runTag + " A").payload,
  );
  assert.equal(created.enabled, false);
  await page.getByRole("button", { name: "返回订阅", exact: true }).click();
  await page.getByRole("button", { name: "新建订阅", exact: true }).click();
  assert.equal(
    await page.getByLabel("订阅名称", { exact: true }).inputValue(),
    "趋势跟踪",
  );
  assert.equal(
    await page
      .getByLabel("证券代码（留空使用当前自选）", { exact: true })
      .inputValue(),
    "",
  );
  await page.getByRole("button", { name: "返回订阅", exact: true }).click();
  await page
    .getByLabel("订阅列表", { exact: true })
    .getByRole("button", { name: new RegExp("^" + runTag + " A") })
    .click();
  const detail = page.getByRole("region", {
    name: "监控记录详情",
    exact: true,
  });
  await detail
    .getByRole("button", { name: "恢复订阅并重建基线", exact: true })
    .click();
  await detail.getByRole("button", { name: "暂停订阅", exact: true }).waitFor();
  assert.equal(
    JSON.parse(
      db.prepare("SELECT payload FROM records WHERE id=?").get(created.id)
        .payload,
    ).enabled,
    true,
  );
  await detail.getByRole("button", { name: "暂停订阅", exact: true }).click();
  await detail
    .getByRole("button", { name: "恢复订阅并重建基线", exact: true })
    .waitFor();
  await detail.getByRole("button", { name: "编辑订阅", exact: true }).click();
  await page.getByLabel("订阅名称", { exact: true }).fill(runTag + " A edited");
  await page.getByRole("tab", { name: "信号", exact: true }).click();
  const signals = page.getByLabel("信号列表", { exact: true });
  await signals.getByRole("button").first().waitFor();
  assert.match(await signals.getByRole("button").first().innerText(), /失败 1/);
  await signals.getByRole("button").first().click();
  await detail
    .getByRole("button", { name: "查看全部关联投递", exact: true })
    .click();
  const deliveries = page.getByLabel("投递列表", { exact: true });
  await deliveries.getByRole("button").first().waitFor();
  assert.equal(await deliveries.getByRole("button").count(), 5);
  await deliveries.getByRole("button", { name: /^合成通知 9999-1/ }).click();
  await detail
    .getByRole("button", { name: "核对并人工重发", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(count(), originalCount + 1);
  await detail
    .getByRole("button", { name: "核对并人工重发", exact: true })
    .click();
  const channelRow = db
    .prepare("SELECT payload FROM records WHERE id='channel-fixture-1'")
    .get();
  db.prepare("UPDATE records SET payload=? WHERE id='channel-fixture-1'").run(
    JSON.stringify({
      ...JSON.parse(channelRow.payload),
      revision: "changed-while-confirming",
    }),
  );
  await dialog.getByRole("button", { name: "确认重发", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "渠道目标已变化" })
    .waitFor();
  assert.equal(
    count(),
    originalCount + 1,
    "changed target rejects the frozen confirmation",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  const refreshed = page.waitForResponse((response) =>
    response.url().includes("deliveryWorkspaceDetail"),
  );
  await detail.getByRole("button", { name: "刷新详情", exact: true }).click();
  await refreshed;
  await detail.getByRole("button", { name: "刷新详情", exact: true }).waitFor();
  await detail
    .getByRole("button", { name: "核对并人工重发", exact: true })
    .click();
  await page.route("**/api/trpc/deliveryWorkspaceConfirm*", async (route) => {
    await route.fetch();
    // Simulate the server committing while the acknowledgement is lost.
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "确认重发", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(count(), originalCount + 2);
  await page.unroute("**/api/trpc/deliveryWorkspaceConfirm*");
  await dialog.getByRole("button", { name: "确认重发", exact: true }).click();
  await detail.getByText(/已加入人工重发队列/).waitFor();
  assert.equal(requests.length, 3);
  assert.equal(
    requests[1],
    requests[2],
    "retry keeps the frozen confirmation identity",
  );
  assert.equal(count(), originalCount + 2);
  assert.equal(
    JSON.parse(
      db
        .prepare(
          "SELECT payload FROM records WHERE id='delivery-fixture-09999-1'",
        )
        .get().payload,
    ).status,
    "failed",
  );
  const downloaded = page.waitForEvent("download");
  await detail
    .getByRole("button", { name: "导出完整证据", exact: true })
    .click();
  const file = await downloaded;
  const exported = JSON.parse(readFileSync(await file.path(), "utf8"));
  assert.equal(exported.value.id, "delivery-fixture-09999-1");
  assert.match(exported.value.body, /证据 9999/);
  assert.ok(!("secret" in exported.value.channel));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(logs, "workspace-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(
    await deliveries.isVisible(),
    false,
    "collapsed panel grid shows the selected detail without stacking it below history",
  );
  await page.screenshot({
    path: join(logs, "workspace-1024.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await deliveries.isVisible(), false);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(logs, "workspace-390.png"),
    fullPage: true,
  });
  await detail.getByRole("button", { name: "返回列表", exact: true }).click();
  await deliveries.waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("tab", { name: "订阅", exact: true }).click();
  await detail.getByRole("button", { name: "编辑订阅", exact: true }).click();
  assert.equal(
    await page.getByLabel("订阅名称", { exact: true }).inputValue(),
    runTag + " A edited",
  );
  assert.ok(
    (
      await page
        .getByRole("region", { name: "订阅编辑", exact: true })
        .innerText()
    ).includes("未保存"),
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "workspace-browser.json"),
    JSON.stringify(
      {
        checks: [
          "create paused monitor and toggle with run version",
          "new after saved starts a fresh subscription, not editing saved identity",
          "unsaved monitor draft survives tabs",
          "all-channel outcomes and related deliveries",
          "cancel sends nothing; confirmation creates a separate delivery",
          "lost acknowledgement retries same requestId without a second delivery",
          "channel changes while confirming reject; explicit refresh and new confirmation use latest destination",
          "complete export",
          "1440/1024/390 layout and return",
        ],
        errors,
        originalCount,
      },
      null,
      2,
    ),
  );
  console.log("Signals workspace functional browser passed");
} finally {
  if (browser) await browser.close();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM records WHERE kind='monitor' AND json_extract(payload,'$.name') LIKE ?",
    ).run(runTag + "%");
    for (const requestId of requests) {
      const id =
        "manual-" +
        createHash("sha256").update(JSON.stringify(requestId)).digest("hex");
      db.prepare(
        "DELETE FROM records WHERE kind='delivery' AND id=? AND json_extract(payload,'$.requestId')=?",
      ).run(id, requestId);
    }
    db.prepare("DELETE FROM records WHERE id='scheduler-owner'").run();
    for (const row of originals)
      restoreRow.run(row.id, row.kind, row.payload, row.updated_at);
  })();
  assert.equal(
    count(),
    originalCount,
    "restore exactly owned fixture additions",
  );
  db.close();
}
