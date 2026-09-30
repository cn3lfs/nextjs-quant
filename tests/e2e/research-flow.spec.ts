import { expect, test } from "@playwright/test";
import { budgets, trpcHeaders, waitForIdleServer } from "./helpers";

// A finished backtest triggers an AI write-up when autoAnalysis is on: a real
// model call on the user's quota. The e2e data directory must have it off.
test.beforeAll(async ({ request }) => {
  const status = await request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await status.json()).result.data.json.settings as {
    autoAnalysis: boolean;
  };
  expect(settings.autoAnalysis, "关闭 E2E 数据目录的回测后自动 AI 解读").toBe(
    false,
  );
});

test("a full-history backtest renders its equity chart promptly", async ({
  page,
}) => {
  await page.goto("/backtest", { waitUntil: "networkidle" });
  // Warm once: the first run pays worker start and gbbq decoding.
  for (const warm of [true, false]) {
    await page
      .locator("[data-testid=equity-chart] > div")
      .evaluateAll((els) =>
        els.forEach((el) => ((el as HTMLElement).dataset.stale = "1")),
      );
    const started = Date.now();
    await page.getByRole("button", { name: "运行回测" }).click();
    await page.waitForSelector(
      "[data-testid=equity-chart] > div:not([data-stale])",
      {
        timeout: 5 * 60 * 1000,
      },
    );
    if (!warm)
      expect(Date.now() - started).toBeLessThanOrEqual(
        budgets.backtestClickToResultMs,
      );
  }
});

test("trade review of 2222 fills (account big) computes within budget", async ({
  page,
}) => {
  // Warm the server process on another account (module load, calendar,
  // gbbq); the budget is for a review computed by a running app.
  await page.request.get(
    `/api/trpc/tradeReviewExecution?input=${encodeURIComponent(JSON.stringify({ json: { account: "big10k" } }))}`,
    { headers: trpcHeaders, timeout: 5 * 60 * 1000 },
  );
  await waitForIdleServer(page);
  await page.goto("/trade-review", { waitUntil: "networkidle" });
  await page.getByLabel("复盘账户别名").fill("big");
  const started = Date.now();
  await page.getByRole("button", { name: "查看复盘" }).click();
  const busy = page.getByText("正在读取行情并计算复盘…");
  await busy.waitFor({ timeout: 5000 }).catch(() => {});
  await busy.waitFor({ state: "detached", timeout: 5 * 60 * 1000 });
  expect(Date.now() - started).toBeLessThanOrEqual(
    budgets.tradeReviewBig2222Ms,
  );
});

test("factor evaluation over three years reports IC and quantiles", async ({
  page,
}) => {
  await page.goto("/screen", { waitUntil: "networkidle" });
  const started = Date.now();
  await page.getByRole("button", { name: "评估因子" }).click();
  const result = page.getByLabel("因子评估结果");
  await result.waitFor({ timeout: 5 * 60 * 1000 });
  expect(Date.now() - started).toBeLessThanOrEqual(budgets.factorEval3yMs);
  await expect(result).toContainText("T+20");
  await expect(result).toContainText("Q5");
});

test("backtest rounds page, open on a candle chart and step with PageDown", async ({
  page,
}) => {
  await page.goto("/backtest", { waitUntil: "networkidle" });
  // A previous run's result may still be on screen: wait for this run's table.
  await page
    .locator('[role="table"][aria-label="交易回合"]')
    .evaluateAll((els) =>
      els.forEach((el) => ((el as HTMLElement).dataset.stale = "1")),
    );
  await page.getByRole("button", { name: "运行回测" }).click();
  await page.waitForSelector(
    '[role="table"][aria-label="交易回合"]:not([data-stale])',
    { timeout: 5 * 60 * 1000 },
  );
  const rounds = page.getByRole("table", { name: "交易回合" });
  // One page of rounds, not every trade.
  expect(await rounds.getByRole("row").count()).toBeLessThanOrEqual(21);
  // The result settles (details load, lists refresh) before it is clicked.
  await page.waitForLoadState("networkidle");
  await rounds.getByRole("row").nth(1).click();
  const status = page
    .getByRole("status")
    .filter({ hasText: "回合 · PageUp/PageDown" });
  await expect(status).toContainText("第 1/");
  await expect(page.getByRole("img", { name: /回合 K 线：/ })).toBeVisible();
  await page.keyboard.press("PageDown");
  await expect(status).toContainText("第 2/");
  await expect(page.getByRole("table", { name: "分期收益" })).toBeVisible();
});
