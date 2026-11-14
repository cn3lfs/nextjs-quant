import { expect, test } from "@playwright/test";
import { trpcHeaders } from "./helpers";

test("chart settings persist and compact text navigation reaches real pages", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/market?symbol=sh600000");
  const indicators = page.getByRole("button", { name: /^指标设置/ });
  await indicators.click();
  const settings = page.getByRole("dialog", { name: "指标设置", exact: true });
  const rps = settings.getByRole("button", { name: "RPS", exact: true });
  if ((await rps.getAttribute("aria-pressed")) !== "true") await rps.click();
  await page.keyboard.press("Escape");
  await expect(indicators).toBeFocused();
  await page.getByRole("button", { name: "RPS 设置", exact: true }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("saveChartView") &&
      response.ok() &&
      /"threshold"\s*:\s*93/.test(response.request().postData() ?? ""),
  );
  await page.getByLabel("RPS参考阈值").fill("93");
  await page.keyboard.press("Escape");
  await saved;
  await page.reload();
  await page.getByRole("button", { name: "RPS 设置", exact: true }).click();
  await expect(page.getByLabel("RPS参考阈值")).toHaveValue("93");
  await page.keyboard.press("Escape");
  await page
    .getByTestId("chart-legend")
    .getByRole("button", { name: /^MA\(/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "MA 参数", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await indicators.click();
  await page.evaluate(() =>
    history.pushState(null, "", "/market?symbol=sh600000&view=financial"),
  );
  await expect(
    page.getByRole("region", { name: "本地财务工作台" }),
  ).toBeVisible();
  await expect(settings).toBeHidden();
  await page.goBack();
  await expect(indicators).toBeVisible();
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: "关键位说明", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "双突破关键位与趋势线" }),
  ).toContainText("波段");
  await page.keyboard.press("Escape");
  const viewportMeasurements = [];
  for (const width of [1440, 1024, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (width === 1440) {
      await expect
        .poll(
          async () => {
            const box = await page.getByRole("application").boundingBox();
            return box
              ? Math.max(
                  0,
                  Math.min(box.y + box.height, 900) - Math.max(box.y, 0),
                )
              : 0;
          },
          {
            message:
              "Chart must occupy at least 60% of the first 900px viewport",
          },
        )
        .toBeGreaterThanOrEqual(540);
    }
    const quoteControls = page.locator(".nc-market-workspace .panel-toolbar");
    expect((await quoteControls.boundingBox())!.height).toBeLessThan(180);
    expect(
      (await quoteControls.locator(".security-select input").boundingBox())!
        .width,
    ).toBeGreaterThan(160);
    await expect(
      quoteControls.getByRole("combobox", { name: "行情周期", exact: true }),
    ).toContainText("日 K");
    for (const id of ["chart-primary-controls", "chart-secondary-controls"])
      await expect
        .poll(() =>
          page
            .getByTestId(id)
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        )
        .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    const box = (await page.getByRole("application").boundingBox())!;
    viewportMeasurements.push({
      width,
      chart: box,
      visibleHeight: Math.max(
        0,
        Math.min(box.y + box.height, 900) - Math.max(box.y, 0),
      ),
    });
    await page.screenshot({
      path: testInfo.outputPath(`chart-${width}.png`),
      fullPage: true,
    });
    if (width === 1440) continue;
    const trigger = page.getByRole("button", { name: "展开全部页面导航" });
    await trigger.click();
    const menu = page.getByRole("navigation", {
      name: "全部页面导航",
      exact: true,
    });
    await expect(
      menu.getByRole("link", { name: "任务中心", exact: false }),
    ).toBeVisible();
    await menu.getByRole("link", { name: "任务中心", exact: false }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(
      page.getByRole("heading", { name: "任务中心", exact: true }),
    ).toBeVisible();
    await expect(menu).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/\/market\?symbol=sh600000/);
    await expect(
      page.getByRole("button", { name: "RPS 设置", exact: true }),
    ).toBeVisible();
  }
  await testInfo.attach("market-viewport", {
    body: JSON.stringify(viewportMeasurements, null, 2),
    contentType: "application/json",
  });
  const period = page.getByRole("combobox", { name: "行情周期", exact: true });
  await period.click();
  await page.getByRole("option", { name: "周线", exact: true }).click();
  await expect(page.getByTestId("market-chart").first()).toHaveAttribute(
    "data-period",
    "week",
  );
  await indicators.click();
  await expect(
    settings.getByRole("button", { name: "RPS", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("application").focus();
  await page.keyboard.press("F8");
  await expect(page.getByTestId("market-chart").first()).toHaveAttribute(
    "data-period",
    "month",
  );
  await period.click();
  await page.getByRole("option", { name: "日 K", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "RPS 设置", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续研究", exact: true }).click();
  await page
    .getByRole("navigation", { name: "继续研究", exact: true })
    .getByRole("link", { name: "证据分析", exact: true })
    .click();
  await expect(page).toHaveURL(/\/analysis$/);
  await expect(
    page.getByRole("dialog", { name: "继续研究", exact: true }),
  ).toBeHidden();
  expect(errors).toEqual([]);
});

test("financial details are a lazy security subview and preserve chart state", async ({
  page,
}, testInfo) => {
  const financial: string[] = [],
    bars: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const names =
      new URL(request.url()).pathname.split("/api/trpc/")[1]?.split(",") ?? [];
    if (names.includes("localFinancialView")) financial.push(request.url());
    if (names.includes("chartBars")) bars.push(request.url());
  });
  await page.goto("/market?symbol=sh600000");
  const logarithmic = page.getByRole("checkbox", {
    name: "对数坐标",
    exact: true,
  });
  await expect(logarithmic).toBeVisible();
  await logarithmic.check();
  await expect(
    page.getByRole("region", { name: "本地财务工作台" }),
  ).toHaveCount(0);
  expect(financial).toEqual([]);
  await page.getByRole("tab", { name: "财务资料", exact: true }).click();
  await expect(page).toHaveURL(/view=financial/);
  const finance = page.getByRole("region", { name: "本地财务工作台" });
  await expect(finance).toBeVisible();
  await expect(
    finance.getByRole("heading", { name: "本地财务 · SH600000", exact: true }),
  ).toBeVisible();
  await expect.poll(() => financial.length).toBeGreaterThan(0);
  await expect(logarithmic).toBeHidden();
  await page.getByRole("tab", { name: "行情图表", exact: true }).click();
  await expect(logarithmic).toBeChecked();
  await expect(finance).toBeHidden();
  await page.keyboard.press("F10");
  await expect(finance).toBeVisible();
  const before = bars.length;
  await page.evaluate(() =>
    history.pushState(null, "", "/market?symbol=sh600040&view=financial"),
  );
  await expect(
    finance.getByRole("heading", { name: "本地财务 · SH600040", exact: true }),
  ).toBeVisible();
  expect(bars.length).toBe(before);
  await page.reload();
  await expect(
    finance.getByRole("heading", { name: "本地财务 · SH600040", exact: true }),
  ).toBeVisible();
  expect(bars.length).toBe(before);
  await expect(
    page.getByRole("table", { name: "我的自选", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "自选与候选", exact: true }),
  ).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(finance.getByRole("alert")).toHaveCount(0);
  await expect(
    finance.getByText("本地财务数据尚未准备好", { exact: false }),
  ).toBeVisible();
  const listToggle = page.getByRole("button", {
    name: "自选与候选",
    exact: true,
  });
  await expect(listToggle).toHaveAttribute("aria-expanded", "false");
  const watchlist = page.getByRole("table", { name: "我的自选", exact: true });
  await expect(watchlist).toBeHidden();
  await listToggle.click();
  await expect(watchlist).toBeVisible();
  await listToggle.click();
  await expect(watchlist).toBeHidden();
  expect(
    await page
      .locator(".chart-panel")
      .evaluate((el) => el.getBoundingClientRect().top),
  ).toBeLessThan(180);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("financial-1024.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "行情图表", exact: true }).click();
  await expect(logarithmic).toBeVisible();
  await expect.poll(() => bars.length).toBeGreaterThan(before);
  await page.screenshot({
    path: testInfo.outputPath("chart-1024.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("non-chart pages do not load a default snapshot; chart navigation owns selection", async ({
  page,
}) => {
  const snapshots: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname
        .split("/api/trpc/")[1]
        ?.split(",")
        .includes("snapshot")
    )
      snapshots.push(request.postData() ?? request.url());
  });
  for (const [route, heading] of [
    ["/rps", "RPS 排名与数据管理"],
    ["/", "今日总览"],
    ["/analysis", "证据分析"],
    ["/backtest", "策略实验"],
    ["/screen", "条件选股"],
  ]) {
    await page.goto(route!);
    await expect(
      page.getByRole("heading", { name: heading!, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "工作台导航" }),
    ).toBeVisible();
    // Exercise a client state change: SSR markup alone does not prove hydration.
    const discovery = page.getByRole("button", { name: "发现", exact: true });
    const expanded = await discovery.getAttribute("aria-expanded");
    await discovery.click();
    await expect(discovery).toHaveAttribute(
      "aria-expanded",
      expanded === "true" ? "false" : "true",
    );
    await discovery.click();
    await expect(discovery).toHaveAttribute("aria-expanded", expanded!);
    expect(snapshots, route).toEqual([]);
  }
  await page.goto("/market?symbol=sh600000");
  await expect(
    page.getByRole("checkbox", { name: "双突破", exact: true }),
  ).toBeChecked();
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toContain("sh600000");
  await page.evaluate(() =>
    window.history.pushState(null, "", "/market?symbol=sh600040"),
  );
  await expect.poll(() => snapshots.length).toBe(2);
  expect(snapshots[1]).toContain("sh600040");
  await page.goBack();
  await expect.poll(() => snapshots.length).toBe(3);
  expect(snapshots[2]).toContain("sh600000");
  await page.getByRole("link", { name: "RPS 排名", exact: true }).click();
  await expect(page).toHaveURL(/\/rps$/);
  await page.getByRole("link", { name: "行情图表", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "双突破", exact: true }),
  ).toBeChecked();
  expect(snapshots).toHaveLength(3);
  await expect(
    page.getByText("所选数据源读取失败", { exact: false }),
  ).toHaveCount(0);
});

test("missing RPS warmup is waiting in the real worker, pool, RPS page and overview", async ({
  page,
}, testInfo) => {
  await page.goto("/stock-pool");
  const start = page.getByRole("button", {
    name: "计算最近交易日RPS",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await start.click();
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/trpc/rpsStatus", {
        headers: trpcHeaders,
      });
      expect(response.ok()).toBe(true);
      const data = (await response.json()).result.data.json;
      return {
        status: data.progress?.status,
        code: data.progress?.waiting?.code,
        latest: data.latest,
      };
    })
    .toEqual({ status: "waiting", code: "calendar-history", latest: null });
  await expect(page.getByText("RPS等待条件：", { exact: false })).toBeVisible({
    timeout: 45000,
  });
  await expect(page.getByText("RPS计算失败：", { exact: false })).toHaveCount(
    0,
  );
  await expect(start).toBeEnabled();
  await page.goto("/rps");
  const status = page.getByRole("region", { name: "RPS运行状态" });
  await expect(status.getByText("等待条件", { exact: true })).toBeVisible();
  await expect(
    status.getByText("120个参考交易日", { exact: false }),
  ).toBeVisible();
  await expect(status.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "回填最近250个交易日", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("rps-waiting.png"),
    fullPage: true,
  });
  await page.goto("/");
  await page
    .getByText("数据与调度状态 · 展开查看各自时点", { exact: true })
    .click();
  const health = page.locator("details").filter({
    has: page.getByText("数据与调度状态 · 展开查看各自时点", { exact: true }),
  });
  await expect(health.getByText("等待条件", { exact: true })).toBeVisible();
  await expect(
    health.getByText("RPS日历不足：", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("overview-rps-waiting.png"),
    fullPage: true,
  });
});

test("pool route keeps filters and pagination through chart navigation, back and reload", async ({
  page,
}, testInfo) => {
  const snapshots: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname
        .split("/api/trpc/")[1]
        ?.split(",")
        .includes("snapshot")
    )
      snapshots.push(request.postData() ?? request.url());
  });
  const response = await page.goto("/stock-pool");
  expect(response?.status()).toBe(200);
  const pool = page.getByRole("region", { name: "股票池浏览" });
  const table = page.getByLabel("股票池成分", { exact: true }).first();
  await expect(pool).toBeVisible();
  await expect(
    table.getByRole("button", { name: "P0_FIXTURE · SH600000", exact: true }),
  ).toBeVisible();
  expect(snapshots).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("pool-1440.png"),
    fullPage: true,
  });
  await page.getByLabel("搜索股票代码或名称", { exact: true }).fill("6000");
  await page.getByRole("combobox", { name: "RPS周期", exact: true }).click();
  await page.getByRole("option", { name: "RPS20", exact: true }).click();
  await page.getByRole("combobox", { name: "股票排序", exact: true }).click();
  await page.getByRole("option", { name: "代码顺序", exact: true }).click();
  await expect(page).toHaveURL(/sort=symbol/);
  await table.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=1/);
  await table.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await table
    .getByRole("button", { name: "P1_POOL_40 · SH600040", exact: true })
    .click();
  await expect(page).toHaveURL(/\/market\?symbol=sh600040$/);
  await expect(
    page.getByRole("checkbox", { name: "双突破", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("region", { name: "股票池浏览" })).toHaveCount(0);
  await expect(
    page.getByText("所选数据源读取失败", { exact: false }),
  ).toHaveCount(0);
  expect(snapshots.length).toBe(1);
  expect(snapshots[0]).toContain("sh600040");
  expect(snapshots[0]).toContain("local");
  await page.screenshot({
    path: testInfo.outputPath("chart-from-pool-1440.png"),
    fullPage: true,
  });
  await page.goBack();
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page.getByLabel("搜索股票代码或名称", { exact: true }),
  ).toHaveValue("6000");
  await expect(
    page.getByRole("combobox", { name: "RPS周期", exact: true }),
  ).toContainText("RPS20");
  await expect(
    table.getByRole("button", { name: "P1_POOL_40 · SH600040", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    table.getByRole("button", { name: "P1_POOL_40 · SH600040", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "股票排序", exact: true }),
  ).toContainText("代码顺序");
  expect(snapshots.length).toBe(1);
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page
      .getByRole("navigation", { name: "工作台导航" })
      .getByRole("link", { name: "证券池", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "工作台导航" })
      .getByRole("link", { name: "RPS 排名", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("pool-1024.png"),
    fullPage: true,
  });
});
