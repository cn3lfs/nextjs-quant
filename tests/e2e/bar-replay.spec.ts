import { expect, test, type Locator, type Page } from "@playwright/test";
import { installOfflineVisualApi } from "./offline-visual-api";
import { workbenchFixturePeriod } from "./workbench-fixture";

async function enableReplayApi(page: Page) {
  const offline = await installOfflineVisualApi(page);
  const cutoffs: string[] = [];
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const names = decodeURIComponent(
      url.pathname.split("/api/trpc/")[1] ?? "",
    ).split(",");
    if (names.includes("barReplayFrame")) {
      const inputs = JSON.parse(
        url.searchParams.get("input") ?? "{}",
      ) as Record<string, { json: { cutoffDate: string } }>;
      cutoffs.push(inputs[names.indexOf("barReplayFrame")]!.json.cutoffDate);
    }
    if (
      names.some((name) => name.startsWith("barReplay")) ||
      (request.method() === "GET" && names.includes("workspacePreferences"))
    )
      return route.continue();
    return route.fallback();
  });
  return { ...offline, cutoffs };
}

async function visibleDates(page: Page, chart: Locator) {
  const canvas = chart.getByRole("application");
  const legend = chart.getByTestId("chart-legend").locator("span").first();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const result: string[] = [];
  for (const fraction of [0.25, 0.6]) {
    await page.mouse.move(bounds!.x + fraction * bounds!.width, bounds!.y + 90);
    const date = await legend.innerText();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    result.push(date);
  }
  return result;
}

test("Bar Replay settles the next open, reveals only observed days and preserves the main zoom", async ({
  page,
}) => {
  const { unknown, cutoffs } = await enableReplayApi(page);
  await page.goto("/scan?symbol=sh600000&period=day&source=local");
  const main = page.getByTestId("market-chart").first();
  const mainCanvas = main.getByRole("application");
  await expect(mainCanvas).toBeVisible({ timeout: 30_000 });
  await mainCanvas.scrollIntoViewIfNeeded();
  const initialDates = await visibleDates(page, main);
  for (let index = 0; index < 4; index++) await mainCanvas.press("ArrowUp");
  const zoomed = await visibleDates(page, main);
  expect(zoomed).not.toEqual(initialDates);

  const launch = page.getByRole("button", { name: "Bar Replay 盲测训练" });
  await launch.click();
  const training = page.getByRole("dialog", { name: "Bar Replay 盲测训练" });
  await training.getByLabel("起始截断日").fill("2024-01-05");
  await training.getByLabel("训练结束日").fill("2024-01-10");
  await training.getByRole("button", { name: "开始训练" }).click();
  const cutoff = training.getByTestId("bar-replay-cutoff");
  await expect(cutoff).toHaveAttribute("data-date", "2024-01-05");
  await expect(training.getByText("理论信号对照")).toHaveCount(0);

  const replayCanvas = training.getByRole("application");
  await replayCanvas.press("Space");
  await expect(
    training.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible();
  await replayCanvas.press("Space");
  await expect(
    training.getByRole("button", { name: "播放", exact: true }),
  ).toBeVisible();
  await training.getByLabel("倍速").selectOption("5");
  for (let index = 0; index < 7; index++) await replayCanvas.press("ArrowUp");

  const buy = training.getByRole("button", { name: "模拟买入" });
  const sell = training.getByRole("button", { name: "模拟卖出" });
  const next = training.getByRole("button", { name: "前进一根" });
  await training.getByLabel("模拟数量").fill("101");
  await expect(buy).toBeDisabled();
  await training.getByLabel("模拟数量").fill("100");
  await buy.click();
  await expect(training.getByText("待下一交易日开盘 1 笔")).toBeVisible();
  await expect(sell).toBeDisabled();
  await expect(
    training.getByTestId("chart-legend").locator("span").first(),
  ).toHaveText("2024-01-05");
  await next.click();
  await expect(cutoff).toHaveAttribute("data-date", "2024-01-08");
  await expect(training.getByText(/模拟买入成交 100 股/)).toBeVisible();
  await expect(training.getByTestId("bar-replay-position")).toContainText(
    "模拟持仓 100 股 · 今日可卖 0 股",
  );
  await sell.click();
  await next.click();
  await expect(cutoff).toHaveAttribute("data-date", "2024-01-09");
  await expect(training.getByText(/模拟卖出成交 100 股/)).toBeVisible();
  await expect(training.getByTestId("bar-replay-position")).toContainText(
    "模拟持仓 0 股",
  );

  await training.getByRole("button", { name: "结束并揭晓" }).click();
  const score = training.getByRole("region", { name: "揭晓评分" });
  await expect(score).toContainText("揭晓评分 · 截至 2024-01-09");
  await expect(score).toContainText("时机 F1");
  await expect(score).toContainText("规则纪律分");
  await expect(score).toContainText("收益差");
  await expect(score).toContainText("回撤差");
  await expect(score.getByRole("table", { name: "漏做明细" })).toBeVisible();
  await expect(next).toBeDisabled();
  expect(cutoffs.every((date) => date <= "2024-01-09")).toBe(true);

  await training.getByRole("button", { name: "退出训练" }).click();
  await expect(training).toHaveCount(0);
  await mainCanvas.scrollIntoViewIfNeeded();
  expect(await visibleDates(page, main)).toEqual(zoomed);
  await page.getByRole("button", { name: "周 K", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("period") === "week",
  );
  await expect(main).toHaveAttribute("data-period", "week");
  await page.getByRole("button", { name: "日 K", exact: true }).click();
  await expect(main).toHaveAttribute("data-period", "day");
  await mainCanvas.scrollIntoViewIfNeeded();
  await expect.poll(() => visibleDates(page, main)).toEqual(zoomed);
  expect([...unknown]).toEqual([]);
});

test("Bar Replay ending on a non-trading day never requests the following session", async ({
  page,
}) => {
  const { cutoffs } = await enableReplayApi(page);
  await page.goto("/scan?symbol=sh600000&period=day&source=local");
  await page.getByRole("button", { name: "Bar Replay 盲测训练" }).click();
  const training = page.getByRole("dialog", { name: "Bar Replay 盲测训练" });
  await training.getByLabel("起始截断日").fill("2024-01-05");
  await training.getByLabel("训练结束日").fill("2024-01-07");
  await training.getByRole("button", { name: "开始训练" }).click();
  const next = training.getByRole("button", { name: "前进一根" });
  await next.click();
  await expect(training.getByText(/已到训练末端/)).toBeVisible();
  await expect(training.getByTestId("bar-replay-cutoff")).toHaveAttribute(
    "data-date",
    "2024-01-07",
  );
  expect(cutoffs).toEqual(["2024-01-05", "2024-01-06", "2024-01-07"]);
});

test("Bar Replay with no chosen end discloses the last date only on its own step", async ({
  page,
}) => {
  await enableReplayApi(page);
  const finalDate = workbenchFixturePeriod.end;
  const previousDay = new Date(`${finalDate}T00:00:00Z`);
  do {
    previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  } while ([0, 6].includes(previousDay.getUTCDay()));
  const startDate = previousDay.toISOString().slice(0, 10);
  await page.goto("/scan?symbol=sh600000&period=day&source=local");
  await page.getByRole("button", { name: "Bar Replay 盲测训练" }).click();
  const training = page.getByRole("dialog", { name: "Bar Replay 盲测训练" });
  await expect(training.getByText(/最早起始截断日/)).toBeVisible();
  await expect(training).not.toContainText(finalDate);
  const start = training.getByLabel("起始截断日");
  const end = training.getByLabel("训练结束日");
  expect(await start.getAttribute("max")).toBeNull();
  expect(await end.getAttribute("max")).toBeNull();
  await start.fill(startDate);
  await training.getByRole("button", { name: "开始训练" }).click();
  const cutoff = training.getByTestId("bar-replay-cutoff");
  await expect(cutoff).toHaveAttribute("data-date", startDate);
  await expect(training).not.toContainText(finalDate);
  const next = training.getByRole("button", { name: "前进一根" });
  await next.click();
  await expect(cutoff).toHaveAttribute("data-date", finalDate);
  await expect(next).toBeDisabled();
});
