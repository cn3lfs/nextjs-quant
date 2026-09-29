import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-research-archive-"));
const base = process.env.BASE ?? "http://127.0.0.1:3220";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const dir = join(tmpdir(), "logs", "quant-research-archive");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [],
  requests = [],
  checks = [];
checks.push = function (...items) {
  console.log(items.join("; "));
  return Array.prototype.push.apply(this, items);
};
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.url().includes("/api/trpc/"))
    requests.push({ url: r.url(), method: r.method() });
});
const count = () =>
  requests.filter((r) => r.url.includes("researchArchiveHistory")).length;
const rows = () =>
  page.getByRole("list", { name: "研究报告列表" }).getByRole("listitem");
try {
  await page.goto(base + "/reports");
  await page.getByRole("link", { name: "档案研究 124", exact: true }).waitFor();
  const before = count();
  const methodCheckbox = page.getByRole("checkbox", {
    name: "缠论",
    exact: true,
  });
  await methodCheckbox.focus();
  await page.keyboard.press("Space");
  assert.equal(await methodCheckbox.isChecked(), false);
  await page.keyboard.press("Space");
  assert.equal(await methodCheckbox.isChecked(), true);
  await page.getByLabel("标题或报告 ID").fill("099");
  await page.waitForTimeout(250);
  assert.equal(count(), before, "Draft typing must not query the archive");
  await page.getByLabel("标题或报告 ID").press("Enter");
  await page.getByRole("link", { name: "档案研究 099", exact: true }).waitFor();
  assert.equal(await rows().count(), 1);
  assert.ok(page.url().includes("keyword=099"));
  checks.push("submitted filtering");
  await page
    .getByRole("link", { name: "档案研究 099", exact: true })
    .press("Enter");
  await page.getByText("合成报告摘要", { exact: true }).waitFor();
  await page.getByRole("link", { name: "返回研究档案", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 099", exact: true }).waitFor();
  assert.ok(page.url().includes("keyword=099"));
  await page.reload();
  await page.getByRole("link", { name: "档案研究 099", exact: true }).waitFor();
  assert.equal(await rows().count(), 1);
  checks.push("keyboard controls and committed-filter deep link/reload");
  await page.getByRole("button", { name: "清空条件", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 124", exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页报告", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 104", exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新当前页", exact: true }).click();
  await page
    .getByRole("button", { name: "刷新当前页", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.getByRole("link", { name: "档案研究 124", exact: true }).count(),
    0,
  );
  const row = page.getByRole("link", { name: "档案研究 100", exact: true });
  await row.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY);
  await row.click();
  await page.getByText("合成报告摘要", { exact: true }).waitFor();
  await page.getByRole("link", { name: "返回研究档案", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 100", exact: true }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.id === "archive-report-100",
  );
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - scroll) < 5);
  checks.push("refresh preserves page; return restores page, focus and scroll");
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 124", exact: true }).click();
  await page.getByText("合成报告摘要", { exact: true }).waitFor();
  assert.equal(await page.locator(".report-card pre").count(), 0);
  await page.getByText("查看证据与版本", { exact: true }).click();
  await page.locator(".report-card pre").first().waitFor();
  assert.ok(
    (await page.locator(".report-card pre").first().textContent()).length <=
      8000,
  );
  await page.getByRole("button", { name: "下一段证据", exact: true }).click();
  await page.getByText(/证据第 2 \/ /).waitFor();
  await page.getByText("查看证据与版本", { exact: true }).click();
  await page.locator(".report-card pre").first().waitFor({ state: "detached" });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告", exact: true }).click();
  const download = await downloadPromise;
  const exported = readFileSync(await download.path(), "utf8");
  assert.ok(
    exported.includes("档案研究 124") &&
      exported.includes("fixture-v1") &&
      exported.includes("fixture-source") &&
      exported.includes("合成证据".repeat(250000)),
  );
  checks.push("deferred evidence and complete Markdown export");
  await page.evaluate(() => {
    window.originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw Error("fixture export failure");
    };
  });
  await page.getByRole("button", { name: "导出报告", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "导出未成功" }).waitFor();
  await page.evaluate(() => {
    URL.createObjectURL = window.originalCreateObjectURL;
  });
  const retryDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报告", exact: true }).click();
  await retryDownload;
  assert.equal(
    await page.getByRole("alert").filter({ hasText: "导出未成功" }).count(),
    0,
  );
  checks.push("export failure recovery");
  await page.getByRole("link", { name: "返回研究档案", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 124", exact: true }).waitFor();
  await page.route("**/api/trpc/researchArchiveHistory*", (route) =>
    route.abort(),
  );
  await page.getByRole("button", { name: "刷新当前页", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "刷新未成功" }).waitFor();
  assert.equal(await rows().count(), 20);
  await page.unroute("**/api/trpc/researchArchiveHistory*");
  await page.getByRole("button", { name: "重试列表", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "刷新未成功" })
    .waitFor({ state: "detached" });
  checks.push("refresh failure retains data and retries");
  await page.route("**/api/trpc/researchArchiveHistory*", async (route) => {
    if (decodeURIComponent(route.request().url()).includes('"keyword":"120"')) {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await page.getByLabel("标题或报告 ID").fill("120");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByLabel("标题或报告 ID").fill("121");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 121", exact: true }).waitFor();
  await page.waitForTimeout(800);
  assert.equal(await rows().count(), 1);
  assert.equal(
    await page.getByRole("link", { name: "档案研究 120", exact: true }).count(),
    0,
  );
  await page.unroute("**/api/trpc/researchArchiveHistory*");
  await page.getByLabel("标题或报告 ID").fill("NO-MATCH-FIXTURE");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page
    .getByText("无匹配结果，请调整或清空条件。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "清空条件", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 124", exact: true }).waitFor();
  checks.push("late response does not overwrite latest filter");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: join(dir, `archive-${width}.png`),
      fullPage: true,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(dir, `archive-viewport-${width}.png`) });
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
  }
  checks.push("three responsive viewports");
  await page.goto(base + "/reports/report/not-found");
  await page.getByText("报告不存在或已被清理。", { exact: true }).waitFor();
  checks.push("missing detail");
  // Method fixtures are deliberately synthetic: rendering/export contracts, no research claims.
  const db = new Database(join(data, "quant.sqlite"));
  const insert = db.prepare(
    "INSERT OR REPLACE INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  );
  const methods = [
    [
      "chan-report",
      {
        evidence: {
          symbol: "sh600519",
          period: "day",
          asOf: "2026-09-28",
          bars: [],
        },
        method: {
          version: "method-v1",
          source: "fixture",
          files: [],
          passages: [],
        },
      },
      "下载缠论证据档案",
      "方法版本与完整证据",
    ],
    [
      "canslim-report",
      {
        dossier: {
          symbol: "sh600519",
          evidence: [],
          scorecard: {
            checks: [],
            computedPoints: 0,
            maxPoints: 114,
            computedCapacity: 0,
          },
        },
        method: { version: "method-v1", files: [] },
      },
      "下载 CAN SLIM 证据档案",
      "证据与方法版本",
    ],
    [
      "wyckoff-report",
      {
        frames: {
          symbol: "sh600519",
          asOf: "2026-09-28",
          daily: { bars: [], missingDays: [] },
          weekly: { bars: [], excluded: [] },
          hourly: {
            bars: [],
            missingHours: [],
            status: "missing",
            noHourly: true,
          },
        },
        method: { version: "method-v1", source: "fixture" },
      },
      "下载威科夫证据档案",
      "完整方法与证据",
    ],
  ];
  for (const [kind, extra, button, disclosure] of methods) {
    const id = `${kind}-${"f".repeat(64)}`;
    const payload = {
      id,
      createdAt: 1780000000000,
      title: "fixture",
      model: "fixture",
      result: {
        title: `fixture-${kind}`,
        summary: "方法摘要",
        stages: [],
        events: [],
        risks: [],
        nextSteps: [],
      },
      ...extra,
    };
    insert.run(id, kind, JSON.stringify(payload), 1780000000000);
    const at = count();
    await page.goto(`${base}/reports/${kind}/${id}`);
    await page.getByText(`fixture-${kind}`, { exact: true }).waitFor();
    assert.equal(count(), at, "Deep link must not read list");
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    assert.deepEqual(
      JSON.parse(readFileSync(await (await pending).path(), "utf8")),
      payload,
    );
    await page.getByText(disclosure, { exact: true }).click();
    await page.locator("section pre").last().waitFor();
  }
  const corruptId = "archive-corrupt-fixture";
  insert.run(
    corruptId,
    "report",
    JSON.stringify({
      id: corruptId,
      contextId: "archive-source",
      title: "损坏fixture",
      createdAt: 1,
    }),
    1,
  );
  try {
    await page.goto(`${base}/reports/report/${corruptId}`);
    await page
      .getByRole("alert")
      .filter({ hasText: "报告格式无法读取" })
      .waitFor();
    checks.push("damaged report is contained by the local read boundary");
  } finally {
    db.prepare("DELETE FROM records WHERE id=? AND kind='report'").run(
      corruptId,
    );
  }
  const saved = db
    .prepare(
      "SELECT * FROM records WHERE kind IN ('report','chan-report','canslim-report','wyckoff-report')",
    )
    .all();
  try {
    db.prepare(
      "DELETE FROM records WHERE kind IN ('report','chan-report','canslim-report','wyckoff-report')",
    ).run();
    await page.goto(base + "/reports");
    await page
      .getByText("暂无四类研究报告。估值与财务质量在下方独立区域。", {
        exact: true,
      })
      .waitFor();
    checks.push("empty library distinct from no matching results");
  } finally {
    db.transaction(() => {
      for (const row of saved)
        insert.run(row.id, row.kind, row.payload, row.updated_at);
    })();
    db.close();
  }
  checks.push("three method deep links and exact JSON export");
  assert.deepEqual(errors, []);
  assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  const snapshotRequest = page.waitForRequest((r) =>
    r.url().includes("/api/trpc/snapshot"),
  );
  await page.getByRole("link", { name: "行情图表", exact: true }).click();
  await snapshotRequest;
  await page.getByRole("link", { name: "研究档案", exact: true }).click();
  await page.getByRole("link", { name: "档案研究 124", exact: true }).waitFor();
  assert.equal(
    requests.filter((r) => r.url.includes("/api/trpc/snapshot")).length,
    1,
  );
  checks.push("archive never starts a snapshot; leaving for market loads once");
  console.log(JSON.stringify({ checks, errors, requests: requests.length }));
} catch (error) {
  await page
    .screenshot({
      path: join(dir, "acceptance-failure.png"),
      fullPage: false,
      timeout: 5000,
    })
    .catch(() => {});
  throw error;
} finally {
  writeFileSync(
    join(dir, "browser-acceptance.json"),
    JSON.stringify({ checks, errors, requests }, null, 2),
  );
  await browser.close();
}
