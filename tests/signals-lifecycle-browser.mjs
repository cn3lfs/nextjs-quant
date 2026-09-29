import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const db = new Database(join(tmpdir(), "quant-signals-s0/quant.sqlite"));
const deliveryId = `delivery-hidden-lifecycle-${process.pid}`;
const requests = [],
  errors = [],
  checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/"))
      requests.push(
        ...new URL(request.url()).pathname
          .split("/api/trpc/")[1]
          .split(",")
          .filter(
            (name) =>
              /^(monitorWorkspace|signalWorkspace|deliveryWorkspace)/.test(
                name,
              ) || name === "channels",
          ),
      );
  });
  await page.goto("http://127.0.0.1:3225/signals");
  await page
    .getByLabel("订阅列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  // Observe live polling before hiding, so zero is meaningful.
  const liveStart = requests.length;
  await page.waitForTimeout(16000);
  assert.ok(requests.length > liveStart, "visible polling is active");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(300);
  const hiddenStart = requests.length;
  const hiddenAt = Date.now();
  const channel = JSON.parse(
    db.prepare("SELECT payload FROM records WHERE id='channel-fixture-0'").get()
      .payload,
  );
  assert.equal(channel.enabled, false);
  db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
    deliveryId,
    "delivery",
    JSON.stringify({
      id: deliveryId,
      signalId: "missing-lifecycle-signal",
      channelId: channel.id,
      kind: "signal",
      title: "隔离隐藏页取消验证",
      body: "No external sending",
      status: "pending",
      attempts: 0,
      nextAt: hiddenAt,
      createdAt: hiddenAt,
      expiresAt: hiddenAt + 600000,
    }),
    hiddenAt,
  );
  await page.waitForTimeout(60000);
  assert.equal(requests.length, hiddenStart, "hidden module automatic reads");
  checks.push({
    name: "controlled hidden 60s",
    reads: requests.length - hiddenStart,
  });
  const cancelled = JSON.parse(
    db.prepare("SELECT payload FROM records WHERE id=?").get(deliveryId)
      .payload,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.attempts, 0);
  assert.match(cancelled.error, /缺少原信号/);
  const lease = db
    .prepare("SELECT updated_at FROM records WHERE id='scheduler-owner'")
    .get();
  assert.ok(lease.updated_at > hiddenAt);
  checks.push({
    name: "background scheduler and outbox continue while hidden",
    status: cancelled.status,
    attempts: 0,
    leaseAdvanced: true,
  });
  console.log("Hidden 60s passed");
  // Sensitivity control: deliberately issue one module request and prove the zero-read guard fails.
  const url = "http://127.0.0.1:3225/api/trpc/monitorWorkspaceSummary";
  await page.evaluate(async (url) => {
    await fetch(url, { headers: { "x-quant-client": "workbench" } });
  }, url);
  assert.throws(() => assert.equal(requests.length, hiddenStart));
  checks.push({
    name: "negative control forced hidden request",
    detected: true,
  });
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator('a[href="/reports"]').first().click();
  await page.waitForTimeout(700);
  const leftStart = requests.length;
  await page.waitForTimeout(60000);
  const offroute = requests.slice(leftStart);
  assert.deepEqual(
    offroute.filter(
      (name) => name !== "monitorWorkspaceSummary" && name !== "channels",
    ),
    [],
  );
  checks.push({
    name: "offroute 60s",
    historyAndDetailReads: 0,
    globalSummaryReads: offroute.filter(
      (name) => name === "monitorWorkspaceSummary",
    ).length,
    sharedChannelReads: offroute.filter((name) => name === "channels").length,
  });
  console.log("Offroute 60s passed");
  await page.locator('a[href="/signals"]').first().click();
  await page
    .getByLabel("订阅列表", { exact: true })
    .getByRole("button")
    .first()
    .waitFor();
  assert.deepEqual(errors, []);
  writeFileSync(
    join(tmpdir(), "logs/quant-signals/lifecycle.json"),
    JSON.stringify({ checks, errors, requests }, null, 2),
  );
} finally {
  await browser.close();
  db.prepare("DELETE FROM records WHERE id=? AND kind='delivery'").run(
    deliveryId,
  );
  db.close();
}
