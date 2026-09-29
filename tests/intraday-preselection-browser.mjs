/** Runs only against an explicitly isolated local production build. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-intraday-"));
const base = process.env.BASE ?? "http://127.0.0.1:3221";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const phase = process.env.INTRADAY_PHASE ?? "before";
const dir = join(tmpdir(), "logs", "quant-intraday");
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/intraday");
  await page
    .getByText("保存设置", { exact: true })
    .waitFor({ state: "attached" });
  const db = new Database(join(data, "quant.sqlite"));
  db.pragma("busy_timeout=5000");
  const insert = db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)");
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const runId = "intraday-run:" + "a".repeat(64);
  const config = {
    enabled: false,
    source: "tdx-local",
    pool: null,
    rpsPeriod: 50,
    minimumRps: 90,
    czscConfig: 0,
    noon: "11:20",
    late: "14:40",
  };
  insert.run(
    "intraday-config",
    "intraday-config",
    JSON.stringify(config),
    Date.now(),
  );
  const results = [];
  for (let i = 0; i < 41; i++) {
    const id = "intraday-preview:" + i.toString(16).padStart(64, "0");
    const signals =
      i % 2 === 0
        ? [
            {
              key: "buy",
              strategy: "czsc",
              endpointDate: date,
              strategyVersion: "fixture",
              evidence: "fixture",
            },
          ]
        : [];
    const value = {
      sessionId: runId,
      engineVersion: "fixture",
      rpsDate: "2026-09-25",
      rps: 95,
      poolHash: "fixture",
      observedAt: Date.now() + i,
      capturedAt: Date.now(),
      barCutoff: date + "T11:20:00+08:00",
      snapshotHash: "fixture",
      snapshot: {
        symbol: "sh600000",
        source: "tdx-local",
        adjustment: "none",
        bars: [
          {
            date,
            open: 10,
            high: 12,
            low: 9,
            close: 11,
            volume: 1000,
            amount: 11000,
          },
        ],
      },
      signals,
    };
    insert.run(id, "intraday-preview", JSON.stringify(value), value.observedAt);
    results.push({ symbol: "sh600000", observationId: id, reason: null });
    if (i < 10)
      insert.run(
        "intraday-close:" + i.toString(16).padStart(64, "0"),
        "intraday-close",
        JSON.stringify({
          observationId: id,
          close: {
            observedAt: Date.now(),
            signalKeys: i < 5 ? null : ["buy"],
            snapshotHash: i < 5 ? null : "close",
            reason: i < 5 ? "缺少完整收盘分钟线" : null,
            snapshot: value.snapshot,
          },
          signals: signals.map((s) => ({
            key: s.key,
            status: i < 5 ? "unavailable" : "confirmed",
          })),
        }),
        Date.now(),
      );
  }
  insert.run(
    runId,
    "intraday-run",
    JSON.stringify({
      id: runId,
      date,
      slot: "noon",
      config,
      status: "complete",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      owner: "fixture",
      leaseUntil: 0,
      previousTradingDay: "2026-09-25",
      calendarSource: "fixture",
      pool: {
        rows: results.map((r) => ({ symbol: r.symbol, rps: 95 })),
        hash: "fixture",
        rpsDay: { date: "2026-09-25" },
      },
      results,
      error: null,
    }),
    Date.now(),
  );
  db.close();
  await page.reload();
  await page
    .getByText("保存设置", { exact: true })
    .waitFor({ state: "attached" });
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: join(dir, `intraday-${phase}-1440.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(dir, `intraday-${phase}-390.png`),
    fullPage: true,
  });
  if (phase === "after") {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.getByText("第 2 页 · 每页20条", { exact: true }).waitFor();
    await page
      .getByText(/匹配 41 条 · 有信号 21 · 未核对 31 · 待重试 5 · 已核对 5/)
      .waitFor();
    assert.match(
      await page.locator("body").innerText(),
      /匹配 41 条 · 有信号 21 · 未核对 31 · 待重试 5 · 已核对 5/,
    );
    await page
      .getByRole("button", { name: "查看依据", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "导出完整依据", exact: true })
      .waitFor();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出完整依据", exact: true })
      .click();
    const file = await downloaded;
    const payload = JSON.parse(readFileSync(await file.path(), "utf8"));
    assert.equal(payload.schemaVersion, 1);
    assert.ok(payload.observation.snapshot.bars.length);
    await page.getByRole("button", { name: "返回结果", exact: true }).click();
    assert.match(await page.locator(":focus").innerText(), /查看依据/);
    await page.reload();
    await page.getByText("第 2 页 · 每页20条", { exact: true }).waitFor();
    await page.getByLabel("证券代码", { exact: true }).fill("sz000001");
    await page.getByLabel("证券代码", { exact: true }).press("Enter");
    await page
      .getByText(
        "当前范围没有观测记录。可切换全部历史；缺少行情或尚未执行的原因请查看批次。",
        { exact: true },
      )
      .waitFor();
    await page.getByRole("button", { name: "全部历史", exact: true }).click();
    await page
      .getByRole("button", { name: "查看依据", exact: true })
      .first()
      .waitFor();
    await page.getByText("编辑参数", { exact: true }).click();
    await page.getByLabel("最低RPS", { exact: true }).fill("91");
    assert.equal(
      await page
        .getByRole("button", { name: "检查并执行当前时段", exact: true })
        .isDisabled(),
      true,
    );
    assert.ok(await page.getByText("RPS50 ≥ 90", { exact: true }).isVisible());
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    assert.equal(
      await page.getByLabel("最低RPS", { exact: true }).inputValue(),
      "90",
    );
    await page.getByLabel("最低RPS", { exact: true }).fill("91");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.getByText("设置已保存", { exact: true }).waitFor();
    await page.getByText("RPS50 ≥ 91", { exact: true }).waitFor();
  }
  writeFileSync(
    join(dir, `browser-${phase}.json`),
    JSON.stringify(
      {
        errors,
        date,
        acceptance:
          phase === "after"
            ? "pagination/statistics/export/focus/reload/filter/config passed"
            : "baseline screenshot",
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
