import { expect, test, type Locator, type Page } from "@playwright/test";
import { trpcCalls, trpcHeaders } from "./helpers";
import { installOfflineVisualApi } from "./offline-visual-api";

const defaultConfig = {
  enabled: false,
  dllPath: "",
  guestModeEnabled: false,
  allowAutoFallback: false,
};
const offlineMessage = "离线验收：外部行情不可用";
const thsdkCallsExceptStatus = (calls: string[]) =>
  calls.filter((name) => name.startsWith("thsdk") && name !== "thsdkStatus");

test.use({ viewport: { width: 1440, height: 900 } });

async function readThsdkStatus(page: Page) {
  const response = await page.request.get("/api/trpc/thsdkStatus", {
    headers: trpcHeaders,
  });
  await expect(response).toBeOK();
  const body = (await response.json()) as {
    result: { data: { json: Record<string, unknown> } };
  };
  return body.result.data.json;
}

async function openPage(page: Page, path: string, ready: Locator) {
  expect((await page.goto(path))?.ok(), path).toBe(true);
  await expect(ready).toBeVisible();
  await page.waitForLoadState("networkidle");
}

const systemHeading = (page: Page) =>
  page.getByRole("heading", { name: "数据源设置", level: 1, exact: true });

async function selectThsdkSettings(page: Page) {
  await page.getByRole("radio", { name: "同花顺行情", exact: true }).click();
  const settings = page.getByRole("region", {
    name: "同花顺行情（THSDK）",
    exact: true,
  });
  await expect(
    settings.getByRole("switch", { name: "启用同花顺行情" }),
  ).toBeVisible();
  return settings;
}

async function expectNoHorizontalOverflow(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const { content, width } = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(content, `${page.url()} at ${width}px`).toBeLessThanOrEqual(width + 1);
}

test("THSDK defaults to disabled and makes no data requests during initial navigation", async ({
  page,
}) => {
  expect(await readThsdkStatus(page)).toMatchObject({
    ...defaultConfig,
    state: "disabled",
  });
  await installOfflineVisualApi(page);

  const routes = [
    [
      "/scan?symbol=sh600519&source=local",
      page.getByRole("button", { name: "刷新行情" }),
    ],
    [
      "/scan?tab=sentiment",
      page.getByRole("radiogroup", { name: "打板数据源" }),
    ],
    [
      "/scan?tab=formula",
      page.getByRole("combobox", { name: "数据源", exact: true }),
    ],
    [
      "/lab/backtest",
      page.getByRole("heading", { name: "研究工作室", exact: true }),
    ],
    [
      "/lab/backtest?mode=object",
      page.getByRole("region", { name: "策略对象组合回测", exact: true }),
    ],
    ["/system", systemHeading(page)],
    ["/intel", page.getByRole("heading", { name: "新闻存档与分析" })],
  ] as const;
  for (const [path, ready] of routes) {
    const calls = await trpcCalls(page, () => openPage(page, path, ready));
    expect(thsdkCallsExceptStatus(calls), path).toEqual([]);
    if (path === "/lab/backtest") {
      await expect(
        page.getByRole("tab", { name: "编排", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("combobox", { name: "研究模板" }),
      ).toHaveValue("ma-baseline-5m");
    }
  }

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await openPage(page, "/system", systemHeading(page));
    await expectNoHorizontalOverflow(page);
    await selectThsdkSettings(page);
    await expectNoHorizontalOverflow(page);
    await openPage(
      page,
      "/scan?tab=wencai",
      page.getByRole("heading", { name: "问财热门板块" }),
    );
    await expectNoHorizontalOverflow(page);
    await openPage(
      page,
      "/intel?tab=thsdk",
      page.getByRole("heading", { name: "个股研报速览" }),
    );
    await expectNoHorizontalOverflow(page);
  }
});

test("THSDK settings save locally, disclose guest-mode limits and keep credentials private", async ({
  page,
}) => {
  try {
    await openPage(page, "/system", systemHeading(page));
    const panel = await selectThsdkSettings(page);
    const enabled = panel.getByRole("switch", { name: "启用同花顺行情" });
    await expect(enabled).not.toBeChecked();
    await expect(panel.getByText("已停用", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("switch", { name: "允许显式游客登录" }),
    ).not.toBeChecked();
    await expect(
      panel.getByText(/严格限频与并发限制.*不会自动登录/),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "一键游客登录" }),
    ).toBeDisabled();

    const password = panel.getByLabel("密码", { exact: true });
    const fixturePassword = "wave5-unsaved-password-marker";
    await expect(password).toHaveAttribute("type", "password");
    await password.fill(fixturePassword);

    let savePostData = "";
    let saveResponseBody = "";
    let saveStatus = 0;
    const captureSave = async (route: import("@playwright/test").Route) => {
      savePostData = route.request().postData() ?? "";
      const response = await route.fetch();
      saveStatus = response.status();
      saveResponseBody = await response.text();
      await route.fulfill({ response, body: saveResponseBody });
    };
    await page.route("**/api/trpc/thsdkSaveConfig*", captureSave);
    const calls = await trpcCalls(page, async () => {
      try {
        await enabled.click();
        await expect(panel.getByRole("status")).toHaveText("配置已保存");
        expect(saveStatus).toBe(200);
        expect(savePostData.includes(fixturePassword)).toBe(false);
        expect(saveResponseBody.includes(fixturePassword)).toBe(false);
      } finally {
        await page.unroute("**/api/trpc/thsdkSaveConfig*", captureSave);
      }
      await expect(enabled).toBeChecked();
      await expect(panel.getByText("未配置", { exact: true })).toBeVisible();
      await expect(
        panel.getByText("未配置 hq.dll", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByText("尚未认证", { exact: true })).toBeVisible();
      await expect(panel.getByRole("alert")).toHaveCount(0);
    });
    expect(thsdkCallsExceptStatus(calls)).toEqual(["thsdkSaveConfig"]);
    await expect(panel).not.toContainText(fixturePassword);

    const status = await readThsdkStatus(page);
    expect(status).toMatchObject({
      ...defaultConfig,
      enabled: true,
      state: "unconfigured",
      hasSavedCredentials: false,
    });
    expect(
      Object.keys(status).filter((key) =>
        /password|username|secret|token/i.test(key),
      ),
    ).toEqual([]);
    expect(JSON.stringify(status).includes(fixturePassword)).toBe(false);
  } finally {
    const response = await page.request.post("/api/trpc/thsdkSaveConfig", {
      headers: trpcHeaders,
      data: { json: defaultConfig },
    });
    await expect(response).toBeOK();
    expect(await readThsdkStatus(page)).toMatchObject({
      ...defaultConfig,
      state: "disabled",
    });
  }
});

test("THSDK sentiment, Wencai, news, formula and backtest surfaces work offline", async ({
  page,
}) => {
  await installOfflineVisualApi(page);

  const sourcePicker = page.getByRole("radiogroup", { name: "打板数据源" });
  const thsdkSource = sourcePicker.getByRole("radio", {
    name: "同花顺",
    exact: true,
  });
  const eastmoney = page.getByRole("heading", {
    name: "打板情绪",
    exact: true,
  });
  const eastmoneyCalls = await trpcCalls(page, async () => {
    await openPage(page, "/scan?tab=sentiment", sourcePicker);
    await expect(thsdkSource).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByRole("radiogroup", { name: "同花顺参考视图" }),
    ).toBeHidden();
    await expect(eastmoney).toBeVisible();
    await expect(
      page.getByText(`读取失败：${offlineMessage}`, { exact: true }),
    ).toBeVisible();
  });
  expect(eastmoneyCalls).toContain("limitSentiment");
  expect(thsdkCallsExceptStatus(eastmoneyCalls)).toEqual([]);

  const thsdkCalls = await trpcCalls(page, async () => {
    await thsdkSource.click();
    await expect(thsdkSource).toHaveAttribute("aria-checked", "true");
    const views = page.getByRole("radiogroup", { name: "同花顺参考视图" });
    for (const name of ["实时信号", "大盘异动", "竞价异动", "个股涨停归因"]) {
      await expect(
        views.getByRole("radio", { name, exact: true }),
      ).toBeVisible();
    }
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: `同花顺实时信号读取失败：${offlineMessage}` }),
    ).toBeVisible();
    await expect(eastmoney).toBeVisible();
    await expect(
      page.getByRole("button", { name: "查询日期", exact: true }),
    ).toBeEnabled();
  });
  expect(thsdkCallsExceptStatus(thsdkCalls)).toEqual(["thsdkRealtimeSignal"]);

  const wencaiCalls = await trpcCalls(page, async () => {
    const query = page.getByRole("textbox", { name: "问财选股条件" });
    await openPage(page, "/scan?tab=wencai", query);
    await expect(query).toHaveValue("");
    for (const name of [
      "连续3日上涨",
      "今日涨停且主力资金净流入",
      "换手率大于5%且站上20日线",
    ]) {
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("heading", { name: "问财热门板块" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: `热门板块读取失败：${offlineMessage}` }),
    ).toBeVisible();
  });
  expect(wencaiCalls).not.toContain("thsdkWencaiQuery");

  const newsCalls = await trpcCalls(page, async () => {
    await openPage(
      page,
      "/intel?tab=thsdk",
      page.getByRole("heading", { name: "同花顺 7×24 快讯" }),
    );
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: `快讯读取失败：${offlineMessage}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "个股研报速览" }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "研报证券代码" }),
    ).toHaveValue("");
    await expect(page.getByRole("button", { name: "查询研报" })).toBeDisabled();
  });
  expect(newsCalls).not.toContain("thsdkResearchReports");

  const formulaSource = page.getByRole("combobox", {
    name: "数据源",
    exact: true,
  });
  await page.goto("/scan?tab=formula", { waitUntil: "networkidle" });
  const expandFormula = page.getByRole("button", {
    name: "展开编辑公式",
    exact: true,
  });
  if (await expandFormula.isVisible()) await expandFormula.click();
  await expect(formulaSource).toBeVisible();
  await expect(formulaSource).toHaveText("本地通达信（默认）");
  await formulaSource.click();
  await page
    .getByRole("option", { name: "同花顺 (THSDK)", exact: true })
    .click();
  await expect(formulaSource).toHaveText("同花顺 (THSDK)");
  const symbols = page.getByRole("textbox", {
    name: "同花顺证券代码",
    exact: true,
  });
  await expect(symbols).toBeVisible();
  await page.getByRole("button", { name: "填入示例标的" }).click();
  await expect(symbols).toHaveValue(/\bsh600519\b/);
  await expect(
    page.getByRole("button", { name: "同花顺执行公式" }),
  ).toBeVisible();

  const objectBacktest = page.getByRole("region", {
    name: "策略对象组合回测",
    exact: true,
  });
  await openPage(page, "/lab/backtest?mode=object", objectBacktest);
  const backtestSource = objectBacktest.getByRole("combobox", {
    name: "行情数据源",
  });
  await expect(backtestSource).toHaveText("本地通达信（默认）");
  await backtestSource.click();
  await page
    .getByRole("option", { name: "同花顺 (THSDK · 仅A股)", exact: true })
    .click();
  await expect(backtestSource).toHaveText("同花顺 (THSDK · 仅A股)");
  await page.getByRole("button", { name: "数据源口径" }).click();
  const methodology = page
    .getByRole("dialog")
    .filter({ hasText: "回测数据源与复权口径" });
  await expect(methodology).toBeVisible();
  await expect(methodology).toContainText("仅支持 A 股策略");
});
