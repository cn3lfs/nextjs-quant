import { expect, test } from "./workbench-test";
import { budgets, trpcHeaders, waitForIdleServer } from "./helpers";
import { workbenchFixturePeriod } from "./workbench-fixture";

// These historical-data scenarios must keep automatic model calls disabled.
test.beforeAll(async ({ request }) => {
  const status = await request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await status.json()).result.data.json.settings as {
    autoNewsAnalysis: boolean;
  };
  expect(settings.autoNewsAnalysis, "关闭 E2E 数据目录的自动新闻分析").toBe(
    false,
  );
  expect(settings).not.toHaveProperty("autoAnalysis");
});

test("current baseline backtest renders a real worker report within budget", async ({
  page,
}, testInfo) => {
  await waitForIdleServer(page);
  await page.goto("/lab/backtest?view=compose&template=ma-baseline-5m", {
    waitUntil: "networkidle",
  });
  await page.getByLabel("基线证券代码").fill("sh600000");
  await page.getByRole("button", { name: "读取本地覆盖", exact: true }).click();
  await expect(page.getByLabel("基线结束日期")).toHaveValue("2026-10-12");
  await page.getByLabel("基线开始日期").fill("2026-10-12");
  const started = Date.now();
  await page.getByRole("button", { name: "开始回测", exact: true }).click();
  const report = page.getByRole("region", { name: "实验报告", exact: true });
  await expect(report).toContainText("SMA 5 / 20 · 已完成");
  const elapsedMs = Date.now() - started;
  await testInfo.attach("baseline-result-ms", {
    body: String(elapsedMs),
    contentType: "text/plain",
  });
  expect(elapsedMs).toBeLessThanOrEqual(budgets.backtestClickToResultMs);
  await expect(
    page.getByRole("tab", { name: "结果", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(report).toContainText("规则自检");
  await expect(report).toContainText("1 笔");
});

test("trade review of 2222 fills (account big) computes within budget", async ({
  page,
}, testInfo) => {
  // Warm the server process on another account (module load, calendar,
  // gbbq); the budget is for a review computed by a running app.
  const warm = await page.request.get(
    `/api/trpc/tradeReviewExecution?input=${encodeURIComponent(JSON.stringify({ json: { account: "big10k" } }))}`,
    { headers: trpcHeaders, timeout: 5 * 60 * 1000 },
  );
  expect(warm.ok()).toBe(true);
  expect((await warm.json()).error).toBeUndefined();
  await waitForIdleServer(page);
  await page.goto("/accounts/review", { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: "账户复盘", exact: true }).click();
  await page.getByLabel("复盘账户别名").fill("big");
  const started = Date.now();
  await page.getByRole("button", { name: "查看复盘" }).click();
  await expect(
    page
      .getByRole("table", { name: "月度收益", exact: true })
      .getByRole("row")
      .nth(1),
  ).toBeVisible();
  const elapsedMs = Date.now() - started;
  await testInfo.attach("trade-review-result-ms", {
    body: String(elapsedMs),
    contentType: "text/plain",
  });
  expect(elapsedMs).toBeLessThanOrEqual(budgets.tradeReviewBig2222Ms);
});

test("factor evaluation over three years and 6154 securities reports IC and quantiles", async ({
  page,
}, testInfo) => {
  await page.goto("/scan?tab=formula", { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: "单因子评估", exact: true }).click();
  await page
    .getByLabel("因子评估开始日期")
    .fill(workbenchFixturePeriod.factorStart);
  await page.getByLabel("因子评估结束日期").fill(workbenchFixturePeriod.end);
  const started = Date.now();
  await page.getByRole("button", { name: "评估因子" }).click();
  const result = page.getByLabel("因子评估结果");
  await result.waitFor({ timeout: budgets.factorEval3yMs });
  const elapsedMs = Date.now() - started;
  await testInfo.attach("factor-evaluation", {
    body: JSON.stringify({
      elapsedMs,
      summary: await result.locator("p").first().innerText(),
    }),
    contentType: "application/json",
  });
  expect(elapsedMs).toBeLessThanOrEqual(budgets.factorEval3yMs);
  await expect(result).toContainText("证券池 6154 只（有效 6154");
  await expect(result).toContainText("读取失败 0");
  await expect(
    result
      .getByRole("table", { name: "因子IC统计" })
      .getByRole("row")
      .nth(1)
      .getByRole("cell")
      .nth(1),
  ).toHaveText(/^-?\d+\.\d+$/);
  await expect(result).toContainText("T+20");
  await expect(result).toContainText("Q5");
});

test("retired sample research has no page or navigation entry", async ({
  page,
}) => {
  const response = await page.goto("/research", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(404);
  await page.goto("/lab", { waitUntil: "networkidle" });
  await expect(page.locator('a[href="/research"]')).toHaveCount(0);
});
