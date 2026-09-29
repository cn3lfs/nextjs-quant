import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
const { chromium } = createRequire(
  join(homedir(), ".agent-tools/playwright/package.json"),
)("playwright");
const logs = join(tmpdir(), "logs", "quant-news");
const base = process.env.BASE ?? "http://127.0.0.1:3223";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [],
  errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  const filter = {
    cutoff: Date.parse("2025-01-07T16:00:00+08:00"),
    query: "",
    historical: true,
  };
  await page.goto(
    base + "/news?newsQuery=" + encodeURIComponent(JSON.stringify(filter)),
  );
  await page.getByText(/匹配 10000 条/).waitFor();
  assert.equal(await page.locator("[data-news-original]").count(), 50);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: join(logs, `news-list-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const first = page.locator("[data-news-original]").first();
  const id = await first.getAttribute("data-news-original");
  await first.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "下载完整新闻原文", exact: true })
    .waitFor();
  const dl = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载完整新闻原文", exact: true })
    .click();
  const downloaded = await dl;
  const full = JSON.parse(readFileSync(await downloaded.path(), "utf8"));
  assert.ok(full.item.content.length > 1000);
  await page.goBack();
  await page.locator("[data-news-original]").first().waitFor();
  await page.goForward();
  await page
    .getByRole("button", { name: "下载完整新闻原文", exact: true })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "返回新闻列表", exact: true }).click();
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-news-original") === id,
    id,
  );
  checks.push("original detail reload/full export/keyboard and return focus");
  await page.getByRole("button", { name: "下一页新闻", exact: true }).click();
  await page.getByText("10000条 · 第2页", { exact: true }).waitFor();
  await page.getByLabel("新闻关键词", { exact: true }).fill("末尾关键词");
  assert.equal(
    await page
      .getByRole("button", {
        name: "AI 分类与影响分析（本页全部）",
        exact: true,
      })
      .isDisabled(),
    true,
  );
  await page.getByLabel("新闻关键词", { exact: true }).press("Enter");
  await page.getByText(/匹配 1000 条/).waitFor();
  await page.getByText("1000条 · 第1页", { exact: true }).waitFor();
  checks.push(
    "submitted full-content search resets page and disables stale analysis",
  );
  await page.getByRole("button", { name: "分析历史", exact: true }).click();
  await page.getByText("121条 · 第1页", { exact: true }).waitFor();
  const ids = [];
  for (let i = 1; i <= 7; i++) {
    await page.locator("[data-news-archive]").first().waitFor();
    ids.push(
      ...(await page
        .locator("[data-news-archive]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-news-archive")),
        )),
    );
    if (i < 7) {
      await page
        .getByRole("button", { name: "下一页分析", exact: true })
        .click();
      await page.getByText(`121条 · 第${i + 1}页`, { exact: true }).waitFor();
    }
  }
  assert.equal(new Set(ids).size, 121);
  const archive = page.locator("[data-news-archive]").first();
  const aid = await archive.getAttribute("data-news-archive");
  await archive.click();
  await page
    .getByRole("button", { name: "下载新闻分析与原文", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "检查续作版本", exact: true }).click();
  await page
    .getByRole("button", { name: "按当前版本重新分析原新闻", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "返回新闻列表", exact: true }).click();
  await page.getByText("121条 · 第7页", { exact: true }).waitFor();
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-news-archive") === id,
    aid,
  );
  checks.push(
    "121 full archive history and explicit changed-version preflight",
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: join(logs, `after-${width}.png`),
      fullPage: true,
    });
  }
  await page.goto(base + "/news?newsQuery=invalid-json");
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await page
    .getByText("所选范围没有新闻，不代表该时期没有事件。", { exact: true })
    .waitFor();
  await page.goto(base + "/news?analysis=news-analysis-" + "0".repeat(64));
  await page
    .getByText("该分析记录已不存在，请返回历史列表。", { exact: true })
    .waitFor();
  checks.push(
    "browser back/forward; invalid URL recovery; missing archive distinguished from loading",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(logs, "browser-query.json"),
    JSON.stringify({ checks, errors, browser: browser.version() }, null, 2),
  );
} catch (error) {
  writeFileSync(
    join(logs, "browser-query-failure.json"),
    JSON.stringify({ checks, errors, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
