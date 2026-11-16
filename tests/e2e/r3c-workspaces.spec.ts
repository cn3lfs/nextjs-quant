import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { trpcHeaders } from "./helpers";

for (const width of [1440, 1024]) {
  test(`R3c 完整日常路径与键盘 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const outbound: string[] = [],
      effects: string[] = [];
    const readPlans = async () => {
      const response = await page.request.get(
        "/api/trpc/alertPlans?input=" +
          encodeURIComponent(JSON.stringify({ json: { page: 0 } })),
        { headers: trpcHeaders },
      );
      expect(response.ok()).toBe(true);
      return (await response.json()).result.data.json as {
        total: number;
        items: { id: string; status: string }[];
      };
    };
    page.on("request", (r) => {
      if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
        outbound.push(r.url());
      if (
        /strategyLab(Action|Mode)|saveAlertSubscription|configurePaperMirror/.test(
          r.url(),
        ) &&
        r.method() === "POST"
      )
        effects.push(r.url());
    });
    await page.goto("/");
    await expect(
      page.getByRole("region", { name: "明日计划", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "持仓与计划情报" }),
    ).toContainText("sh600000 今日QA公告");
    const candidate = page
      .getByRole("region", { name: "明日计划", exact: true })
      .getByRole("link", { name: /sh600000 · 打开图表/ });
    await candidate.first().focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/scan\?.*candidate=/);
    await expect(
      page.getByRole("application", { name: /行情图：/ }),
    ).toBeVisible();
    const annotations = page.getByRole("region", { name: "图表新闻事件" });
    await expect(annotations).toContainText("sh600000 图表QA事件");
    await annotations
      .getByRole("button", { name: /sh600000 图表QA事件/ })
      .click();
    await expect(page.getByRole("dialog")).toContainText("图表事件原文QA");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "加入计划", exact: true }).focus();
    await page.keyboard.press("Enter");
    const plansBefore = await readPlans();
    await page
      .getByRole("button", { name: "保存交易计划", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    // Unlike the standalone daily positive path, this mixed historical book
    // has unknown current holding cost/protection and must fail admission.
    await expect(
      page.getByRole("alert").filter({
        hasText: "同标的既有持仓缺少成本或止损依据，不能计算剩余风险",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "已保存交易计划" }),
    ).toHaveCount(0);
    expect(await readPlans()).toEqual(plansBefore);
    await page
      .getByRole("navigation", { name: "工作台导航" })
      .getByRole("link", { name: "账户与复盘", exact: true })
      .click();
    const positions = page.getByRole("region", {
      name: "统一持仓列表",
      exact: true,
    });
    await expect(positions).toContainText("sh600000");
    await positions
      .getByRole("link", { name: /sh600000/ })
      .first()
      .click();
    const sources = page.getByRole("table", {
      name: "成交来源明细",
      exact: true,
    });
    await expect(sources.getByRole("row")).toHaveCount(21);
    await expect(sources).toContainText("入场候选");
    await expect(sources).not.toContainText('["QA-r3b-decay"');
    await sources
      .getByRole("link", { name: /QA-r3b-decay · sh600000/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/accounts\/alerts\?event=/);
    await expect(
      page
        .getByRole("table", { name: "提醒历史", exact: true })
        .getByRole("row"),
    ).toHaveCount(2);
    await page
      .getByRole("navigation", { name: "工作区子页" })
      .getByRole("link", { name: "交割单与交易复盘", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/accounts\/review$/);
    await expect(
      page.getByRole("heading", { name: /交割单与交易复盘/ }),
    ).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索页面" }).fill("策略中心");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "实验室策略列表" }),
    ).toBeVisible();
    await page.getByRole("link", { name: /QA日常路径策略/ }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "实验室策略详情" }),
    ).toContainText("12 信号 / 18 实际观察市场日");
    await expect(
      page.getByRole("button", { name: "晋级策略", exact: true }),
    ).toBeDisabled();
    // Manual live is available, but an unqualified strategy cannot execute it
    // without explicit risk acceptance and the final confirmation.
    const live = page.getByRole("button", {
      name: "开启 live 提醒",
      exact: true,
    });
    await expect(live).toBeEnabled();
    await live.focus();
    await page.keyboard.press("Enter");
    const liveDialog = page.getByRole("dialog");
    await expect(liveDialog).toContainText("当前门槛未通过");
    await expect(
      liveDialog.getByRole("checkbox", {
        name: "接受未验证策略提醒风险",
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(
      liveDialog.getByRole("button", { name: "确认执行", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByText(/Walk-forward 1/).click();
    await expect(page.getByText(/成本×2：收益 2.0%/).first()).toBeVisible();
    await page
      .getByRole("button", { name: "开启影子前推", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("确认开启影子前推");
    await page.keyboard.press("Escape");
    expect(effects).toEqual([]);
    expect(outbound).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const screens = resolve(
      process.env.E2E_DATA_DIR ?? ".test-data/r3c/e2e-workspaces",
      "..",
      "screens",
    );
    await mkdir(screens, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: resolve(screens, `lab-${width}.png`),
      fullPage: true,
    });
    expect(await readPlans()).toEqual(plansBefore);
  });
  test(`R3c 系统备份与安全研究入口 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/system");
    const backup = page.getByRole("region", {
      name: "数据库与备份",
      exact: true,
    });
    await expect(backup).toContainText("当前库版本 19");
    await expect(
      backup.getByRole("spinbutton", { name: "备份保留份数" }),
    ).toHaveValue("3");
    await backup.getByRole("button", { name: "立即备份", exact: true }).click();
    await expect(
      backup.getByRole("status").filter({ hasText: "数据库备份已完成" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "数字货币", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "校验本地归档" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "UI 组件", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/system/ui-gallery")).status()).toBe(404);
    const screens = resolve(
      process.env.E2E_DATA_DIR ?? ".test-data/r3c/e2e-workspaces",
      "..",
      "screens",
    );
    await mkdir(screens, { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: resolve(screens, `system-${width}.png`),
      fullPage: true,
    });
    await page.goto("/lab?tab=tasks");
    await page
      .getByRole("button", { name: "检查已有成绩单", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "研究任务已创建" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "查看结果与取消" }).click();
    await expect(page).toHaveURL(/\/system\/tasks\?id=/);
    await expect(
      page.getByRole("heading", { name: "任务中心", exact: true }),
    ).toBeVisible();
    await page
      .locator('button[aria-controls^="task-detail-"][aria-expanded="false"]')
      .first()
      .click();
    await expect(
      page.getByRole("region", { name: "任务结果摘要" }),
    ).toContainText("检查已有成绩单");
  });
}

test("R3c 本地归档校验与策略对象回测结果", async ({ page }) => {
  const outbound: string[] = [];
  page.on("request", (r) => {
    if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      outbound.push(r.url());
  });
  await page.goto("/system");
  await page.getByRole("radio", { name: "数字货币", exact: true }).click();
  await page.getByRole("button", { name: "校验本地归档", exact: true }).click();
  await page.getByRole("link", { name: "查看校验结果", exact: true }).click();
  await page
    .locator('button[aria-controls^="task-detail-"][aria-expanded="false"]')
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "任务结果摘要" }),
  ).toContainText("未回填");
  await expect(
    page.getByRole("region", { name: "任务结果摘要" }),
  ).toContainText("BTCUSDT");
  await page.goto("/lab/backtest");
  await page
    .getByText("策略对象组合回测（A股 / BTC、ETH）", { exact: true })
    .click();
  await page.getByRole("textbox", { name: "回测策略对象", exact: true }).fill(
    JSON.stringify({
      id: "QA-r3c-object",
      version: 1,
      market: "cn-equity",
      period: "day",
      universe: { kind: "symbols", symbols: ["sh600000"] },
      entry: { kind: "constant", value: true },
      exit: { maxBars: 2 },
      sizing: { kind: "weight", weight: 0.1 },
      sleeve: "swing",
    }),
  );
  await page.getByLabel("对象回测开始日期", { exact: true }).fill("2023-08-16");
  await page.getByLabel("对象回测结束日期", { exact: true }).fill("2025-03-07");
  await page
    .getByRole("button", { name: "登记此版本到策略列表", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "策略对象已登记" }),
  ).toBeVisible();
  const registered = await page.request.get(
    "/api/trpc/strategyLabDetail?input=" +
      encodeURIComponent(
        JSON.stringify({ json: { id: "QA-r3c-object", version: 1 } }),
      ),
    { headers: trpcHeaders },
  );
  const definition = (await registered.json()).result.data.json;
  expect(definition.shadow).toBeNull();
  expect(definition.promotion).toBeNull();
  expect(definition.live).toBe(false);
  await page
    .getByRole("button", { name: "提交策略对象回测", exact: true })
    .click();
  await page
    .getByRole("link", { name: "查看进度、结果与取消", exact: true })
    .click();
  await page
    .locator('button[aria-controls^="task-detail-"][aria-expanded="false"]')
    .first()
    .click();
  const summary = page.getByRole("region", { name: "任务结果摘要" });
  await expect(summary).toContainText("规则自检");
  await expect(summary).toContainText("最大回撤");
  const download = page.waitForEvent("download");
  await summary
    .getByRole("button", { name: "导出冻结输入与结果", exact: true })
    .click();
  await expect((await download).suggestedFilename()).toMatch(
    /^本地任务-.*\.json$/,
  );
  expect(outbound).toEqual([]);
});
