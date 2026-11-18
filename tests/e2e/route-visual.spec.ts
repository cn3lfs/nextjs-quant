import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import SuperJSON from "superjson";
import { navItems } from "../../src/components/workbench/navigation";
import { installOfflineVisualApi } from "./offline-visual-api";
import type { RouterOutputs } from "../../src/trpc/react";
import { trpcHeaders } from "./helpers";

// Presentation fixtures only. Server availability and export behavior are
// exercised separately by market-pool-service.test.ts with an in-memory DB.
function loadedPool(
  data: RouterOutputs["marketPoolPage"],
): RouterOutputs["marketPoolPage"] {
  return {
    ...data,
    availability: { rps: "ready", dailyIndex: "ready" },
    rps: {
      date: "2026-11-12",
      mode: "backfill",
      count: 10,
      inputHash: "visual-fixture",
      observation: null,
    },
    total: 3,
    previous: null,
    next: null,
    rows: [
      {
        symbol: "sh600000",
        name: "有排名样本",
        localDay: true,
        value: { return: 0.119, rank: 1, rps: 90 },
        reason: null,
      },
      {
        symbol: "sh600001",
        name: "退市缓存样本",
        localDay: false,
        fullDayCache: true,
        value: null,
        reason: "停牌",
        identity: {
          status: "delisted",
          date: "2009-12-29",
          source: "visual-fixture",
          fetchedAt: "2026-11-12",
        },
      },
      {
        symbol: "sz000022",
        name: "代码变更样本",
        localDay: false,
        value: null,
        reason: "上市不足250个交易日",
        identity: {
          status: "code-changed",
          date: "2018-12-26",
          successor: "sz001872",
          source: "visual-fixture",
          fetchedAt: "2026-11-12",
        },
      },
    ],
  };
}

const routes = [
  ...navItems.map((item) => ({
    path: item.href,
    // The topbar resolves the shared /scan workspace by pathname, so the RPS
    // tab shows that workspace title rather than its own sidebar label.
    heading:
      item.href === "/scan?tab=rps" ? "扫描与图表" : (item.title ?? item.label),
  })),
  { path: "/system/ui-gallery", heading: null },
  { path: "/lab/reports/report/visual-missing", heading: "研究报告详情" },
];
for (const width of [1440, 1024]) {
  for (const route of routes) {
    test(`${width} ${route.path}`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const api = await installOfflineVisualApi(page);
      await page.setViewportSize({ width, height: 900 });
      const clock = new Date();
      await page.clock.setFixedTime(clock);
      const response = await page.goto(
        route.path === "/scan"
          ? "/scan?symbol=sh600000"
          : route.path === "/lab"
            ? "/lab?tab=catalog"
            : route.path,
      );
      if (route.path === "/system/ui-gallery")
        expect(response?.status()).toBe(404);
      else expect(response?.status()).toBeLessThan(400);
      if (route.heading)
        await expect(page.locator(".topbar h1")).toHaveText(route.heading);
      await page.waitForLoadState("networkidle");
      // The fixture deliberately has no CLS archive. Wait through query retries
      // so this audit captures the missing-source state, not a loading frame.
      if (route.path === "/intel") {
        await expect(page.getByRole("alert")).toBeVisible();
        await expect(
          page.getByText("正在读取新闻…", { exact: true }),
        ).toHaveCount(0);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (["/scan", "/scan?tab=formula", "/lab/reports"].includes(route.path))
        expect(api.calls.has("securityNames")).toBe(true);
      if (route.path === "/lab/data-guide")
        expect(api.calls.has("securityNames")).toBe(false);
      if (
        ["/scan?tab=formula", "/system", "/system/tasks"].includes(route.path)
      ) {
        expect(api.calls.has("taskOverview")).toBe(true);
        expect(api.calls.has("jobs")).toBe(route.path === "/scan?tab=formula");
      }
      if (route.path === "/") {
        const intraday = page.getByRole("region", {
          name: "盘中预选",
          exact: true,
        });
        await expect(intraday).toContainText("暂停期间不生成新候选");
        await expect(
          intraday.getByRole("link", { name: "查看记录" }),
        ).toBeVisible();
        await expect(intraday).not.toContainText("去设置");
      }
      if (route.path === "/?tab=intraday") {
        await expect(
          page.getByText("暂无匹配批次；预选已暂停，不会生成新批次。"),
        ).toBeVisible();
        await expect(
          page.getByText("尚未启用或未到窗口", { exact: false }),
        ).toHaveCount(0);
      }
      if (route.path === "/lab/reports") {
        await expect(
          page.getByText("暂无通用研究报告。", { exact: false }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "前往证据分析", exact: true }),
        ).toHaveAttribute("href", "/lab/analysis");
        await expect(page.locator("main")).not.toContainText("四类研究");
        await expect(page.locator("main")).not.toContainText(
          "CAN SLIM、缠论与威科夫",
        );
      }
      if (route.path === "/accounts/alerts") {
        await expect(
          page.getByText("尚无信号记录；台账生成已暂停，不会自动产生新记录。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.locator("main")).not.toContainText(
          "15:05后保持应用运行",
        );
      }
      if (route.path === "/lab/data-guide") {
        await expect(page.getByRole("main")).toHaveCount(1);
        for (const title of [
          "选择研究入口",
          "准备本地数据",
          "日期、预热与缺失",
          "结果与证据边界",
        ]) {
          await expect(
            page.getByRole("heading", { name: title, exact: true }),
          ).toBeVisible();
        }
        for (const href of [
          "/system",
          "/lab",
          "/lab/backtest",
          "/lab/analysis",
        ]) {
          await expect(
            page.locator(`main a[href="${href}"]`).first(),
          ).toBeVisible();
        }
        await expect(page.locator('main a[href="/research"]')).toHaveCount(0);
        await expect(page.locator("main")).not.toContainText(
          "research-market-evidence-1",
        );
        await expect(page.locator("main")).not.toContainText("按原快照重跑");
      }
      if (route.path === "/lab") {
        await expect(page.getByLabel("结束日期", { exact: true })).toHaveValue(
          "2026-10-12",
        );
        await expect(page.getByLabel("开始日期", { exact: true })).toHaveValue(
          "2025-10-12",
        );
        await expect(
          page.getByRole("combobox", { name: "搜索实验证券" }),
        ).toBeVisible();
        await expect(
          page.getByText("本地最近已结束交易日：2026-10-12。", {
            exact: false,
          }),
        ).toBeVisible();
      }
      if (route.path === "/scan?tab=pool" || route.path === "/scan?tab=rps") {
        await expect(
          page.getByText(
            "当前数据源尚未计算 RPS，排名与涨幅暂缺。请先计算 RPS。",
            { exact: true },
          ),
        ).toHaveCount(1);
        const table = page.getByRole("table", {
          name: route.path === "/scan?tab=pool" ? "股票池成分" : "个股RPS排名",
          exact: true,
        });
        await expect(table.getByRole("row")).toHaveCount(21);
        await expect(table).not.toContainText("尚无当前数据源的RPS");
        await expect(table).not.toContainText("未扫描到日线");
        if (route.path === "/scan?tab=pool") {
          await expect(
            page.getByText(
              "当前数据源尚未扫描日线；可到数据与连接扫描已保存目录。已有完整包缓存仍按证券标注。",
              { exact: true },
            ),
          ).toHaveCount(1);
        } else {
          await expect(
            table.getByRole("columnheader", { name: "未排名原因" }),
          ).toHaveCount(0);
        }
      }
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        background: getComputedStyle(document.body).backgroundColor,
        font: getComputedStyle(document.body).fontFamily,
        alerts: [...document.querySelectorAll('[role="alert"]')]
          .filter((el) => el.getClientRects().length)
          .map((el) => el.textContent),
        overflowing: [...document.querySelectorAll("main *")]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return (
              box.width > 0 &&
              (box.right > innerWidth + 1 || box.left < -1) &&
              getComputedStyle(el).position !== "fixed"
            );
          })
          .slice(0, 12)
          .map((el) => ({
            tag: el.tagName,
            class: el.className,
            text: el.textContent?.slice(0, 100),
          })),
      }));
      await writeFile(
        testInfo.outputPath("audit.json"),
        JSON.stringify(
          {
            route: route.path,
            clock: clock.toISOString(),
            layout,
            errors,
            calls: [...api.calls].sort(),
            unknown: [...api.unknown].sort(),
            blocked: [...api.blocked].sort(),
          },
          null,
          2,
        ),
      );
      await page.screenshot({
        path: testInfo.outputPath("page.png"),
        fullPage: true,
        animations: "disabled",
        caret: "hide",
      });
      expect(errors).toEqual([]);
      expect(
        [...api.unknown],
        "All called procedures need an explicit local/external classification",
      ).toEqual([]);
      expect(
        layout.scrollWidth,
        JSON.stringify(layout.overflowing),
      ).toBeLessThanOrEqual(width);
    });
  }
}

test("home distinguishes failed reads from empty records and retries each panel", async ({
  page,
}, testInfo) => {
  const failed = new Set([
    "signalWorkspacePage",
    "intradayStatus",
    "industryRpsPage",
  ]);
  const api = await installOfflineVisualApi(page, failed);
  await page.goto("/");
  const panels = [
    { name: "今日信号", empty: "今日没有信号记录" },
    { name: "盘中预选", empty: "今日没有预选记录" },
    { name: "RPS 强度", empty: "尚未计算板块 RPS" },
  ];
  for (const { name, empty } of panels) {
    const region = page.getByRole("region", { name, exact: true });
    await expect(region.getByRole("alert")).toContainText("读取失败");
    await expect(region).not.toContainText(empty);
  }
  await page.screenshot({
    path: testInfo.outputPath("failed-reads.png"),
    fullPage: true,
  });
  failed.clear();
  for (const { name, empty } of panels) {
    const region = page.getByRole("region", { name, exact: true });
    await region.getByRole("button", { name: "重新加载" }).click();
    await expect(region).toContainText(empty);
    await expect(region.getByRole("alert")).toHaveCount(0);
  }
  expect([...api.unknown]).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("recovered-reads.png"),
    fullPage: true,
  });
});

test("offline audit refuses writes and nonlocal snapshots before forwarding", async ({
  page,
}) => {
  const api = await installOfflineVisualApi(page);
  await page.goto("/system/ui-gallery");
  for (const call of [
    { name: "status", input: {}, status: 412 },
    {
      name: "snapshot",
      input: { symbol: "sh600000", period: "day", source: "online" },
      status: 503,
    },
    {
      name: "snapshot",
      input: { symbol: "cxBTCUSDT", period: "day", source: "local" },
      status: 503,
    },
  ]) {
    const response = await page.evaluate(
      async ({ name, data }) => {
        const response = await fetch(`/api/trpc/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        return { status: response.status, body: await response.json() };
      },
      { name: call.name, data: SuperJSON.serialize(call.input) },
    );
    expect(response.status).toBe(call.status);
    expect(
      SuperJSON.deserialize<{ message: string }>(response.body.error).message,
    ).toMatch(/验收接口尚未分类|离线验收：外部行情不可用/);
  }
  expect([...api.unknown]).toEqual(["status"]);
  expect([...api.blocked]).toEqual(["snapshot"]);
});

test("limit sentiment hydrates with a browser date different from the server", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installOfflineVisualApi(page);
  const future = new Date(Date.now() + 2 * 86400000);
  const date = new Date(future.getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  await page.clock.setFixedTime(future);
  await page.goto("/scan?tab=sentiment");
  await expect(page.locator('input[type="date"]')).toHaveValue(date);
  await expect(page.getByText(`已查询 ${date}`, { exact: true })).toBeVisible();
  await expect(
    page.getByText("读取失败：离线验收：外部行情不可用", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("pool status keeps security-specific reasons, identity and cached daily bars", async ({
  page,
}, testInfo) => {
  let emptyScan = false;
  const api = await installOfflineVisualApi(page, new Set(), (data) => {
    const fixture = loadedPool(data);
    if (emptyScan) {
      fixture.availability.dailyIndex = "empty";
      fixture.rows.forEach((row) => {
        row.localDay = false;
      });
    }
    return fixture;
  });
  await page.goto("/scan?tab=pool");
  const table = page.getByRole("table", { name: "股票池成分", exact: true });
  await expect(table).toContainText("11.90%");
  await expect(
    table.getByRole("row").filter({ hasText: "退市缓存样本" }),
  ).toContainText("已退市（2009-12-29）；完整包缓存日线可用；停牌");
  await expect(
    table.getByRole("row").filter({ hasText: "代码变更样本" }),
  ).toContainText(
    "历史代码，2018-12-26起变更为SZ001872；未扫描到日线；上市不足250个交易日",
  );
  await expect(
    page.getByText("当前数据源尚未计算 RPS", { exact: false }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("loaded-pool.png"),
    fullPage: true,
  });
  emptyScan = true;
  await page.reload();
  await expect(
    page.getByText(
      "当前扫描未发现日线文件；请核对已保存目录及本地文件。已有完整包缓存仍按证券标注。",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(table).not.toContainText("未扫描到日线");
  await expect(table).toContainText("完整包缓存日线可用");
  await expect(table).toContainText("停牌");
  await page.screenshot({
    path: testInfo.outputPath("empty-scan.png"),
    fullPage: true,
  });
  expect([...api.unknown]).toEqual([]);
});

test("RPS period change never relabels old values and summarizes a missing period once", async ({
  page,
}, testInfo) => {
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const api = await installOfflineVisualApi(page, new Set(), async (data) => {
    const fixture = loadedPool(data);
    if (data.period === 1) {
      requested();
      await gate;
      fixture.availability.rps = "period-missing";
      fixture.rps!.count = null;
      fixture.rows.forEach((row) => {
        row.value = null;
        row.reason = "该历史批次未计算此周期，等待新批次";
      });
    }
    return fixture;
  });
  await page.goto("/scan?tab=rps");
  const table = page.getByRole("table", { name: "个股RPS排名", exact: true });
  await expect(table).toContainText("11.90%");
  await expect(
    table.getByRole("columnheader", { name: "未排名原因" }),
  ).toBeVisible();
  await expect(table).toContainText("停牌");
  await page.getByRole("combobox", { name: "个股RPS周期" }).click();
  await page.getByRole("option", { name: "当日（RPS1）", exact: true }).click();
  await pending;
  try {
    await expect(table).not.toContainText("11.90%");
    await expect(
      table.getByRole("columnheader", { name: "RPS1 排名" }),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(
    page.getByText(
      "当前批次未计算 RPS1，该周期排名与涨幅暂缺；需要包含此周期的新批次。",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(table).not.toContainText("该历史批次未计算此周期");
  await expect(
    table.getByRole("columnheader", { name: "未排名原因" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("period-missing.png"),
    fullPage: true,
  });
  expect([...api.unknown]).toEqual([]);
});

test("RPS table never shows the previous page while a same-period query key loads", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const api = await installOfflineVisualApi(
    page,
    new Set(),
    async (data, input) => {
      const fixture = loadedPool(data);
      if (input.search === "600002") {
        requested();
        await gate;
        fixture.rows = [
          {
            symbol: "sh600002",
            name: "新查询样本",
            localDay: true,
            value: { return: 0.05, rank: 2, rps: 80 },
            reason: null,
          },
          {
            symbol: "sh600003",
            name: "新查询样本二",
            localDay: true,
            value: { return: 0.02, rank: 3, rps: 70 },
            reason: null,
          },
        ];
        fixture.total = 2;
        fixture.rps!.date = "2026-11-13";
      }
      return fixture;
    },
  );
  await page.goto("/scan?tab=rps");
  const table = page.getByRole("table", { name: "个股RPS排名", exact: true });
  const rankingPanel = page.getByRole("region", {
    name: "个股RPS排名",
    exact: true,
  });
  await expect(table).toContainText("11.90%");
  await expect(
    page.getByText("RPS基准日：2026-11-12", { exact: false }),
  ).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "搜索股票代码或名称" })
    .fill("600002");
  await pending;
  try {
    await expect(table).toContainText("正在加载…");
    await expect(table).not.toContainText("11.90%");
    await expect(table.getByRole("link", { name: /有排名样本/ })).toHaveCount(
      0,
    );
    await expect(page.getByText("RPS基准日", { exact: false })).toHaveCount(0);
    // Hidden industry/concept tabs also mount DataTables; only this ranking's
    // footer may not appear as an empty page while its new key loads.
    await expect(
      rankingPanel.getByText("共 0 条", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.getByText("没有符合条件的证券", { exact: false }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    table.getByRole("link", { name: "新查询样本 · SH600002" }),
  ).toBeVisible();
  await expect(table.getByRole("row").nth(1)).toContainText(
    "新查询样本 · SH600002",
  );
  await expect(table.getByRole("row").nth(2)).toContainText(
    "新查询样本二 · SH600003",
  );
  await expect(
    page.getByText("RPS基准日：2026-11-13", { exact: false }),
  ).toHaveCount(1);
  await expect(
    page.getByText("RPS基准日：2026-11-12", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByText("共 2 条", { exact: false })).toBeVisible();
  expect([...api.unknown]).toEqual([]);
});

test("research archive distinguishes read failure, empty history and unmatched filters", async ({
  page,
}) => {
  const failed = new Set(["researchArchiveHistory"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = await installOfflineVisualApi(page, failed);
  await page.goto("/lab/reports");
  await expect(
    page.getByRole("alert").filter({ hasText: "档案读取失败" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "前往证据分析", exact: true }),
  ).toHaveCount(0);
  failed.clear();
  await page.getByRole("button", { name: "重试列表", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "前往证据分析", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "标题或报告 ID", exact: true })
    .fill("no-matching-report");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(
    page.getByText("无匹配结果，请调整或清空条件。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "前往证据分析", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "标题或报告 ID", exact: true }),
  ).toHaveValue("no-matching-report");
  await expect(
    page.getByText("无匹配结果，请调整或清空条件。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清空条件", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "前往证据分析", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect([...api.unknown]).toEqual([]);
});

test("strategy inputs search local stocks, reject unsupported codes and submit the selected dates", async ({
  page,
}, testInfo) => {
  // The server owns a newly generated fixture directory; this scans only its
  // synthetic TDX files, so name/code search exercises the actual API.
  const scan = await page.request.post("/api/trpc/scan", {
    headers: trpcHeaders,
    data: SuperJSON.serialize(undefined),
  });
  expect(scan.ok()).toBe(true);
  const job = SuperJSON.deserialize<{ id: string }>(
    (await scan.json()).result.data,
  );
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/trpc/job", {
        headers: trpcHeaders,
        params: { input: JSON.stringify(SuperJSON.serialize({ id: job.id })) },
      });
      return SuperJSON.deserialize<{ status: string }>(
        (await response.json()).result.data,
      )?.status;
    })
    .toBe("completed");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = await installOfflineVisualApi(page);
  await page.goto("/lab?tab=catalog");
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("strategyCenterRun"))
      submissions.push(request.postData() ?? "");
  });
  const selector = page.getByRole("combobox", { name: "搜索实验证券" });
  const submit = page.getByRole("button", {
    name: "创建本地日线实验",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  for (const code of [
    "sh000001",
    "sh688001",
    "bj920748",
    "pt880001",
    "not-a-security",
  ]) {
    await selector.fill(code);
    await expect(page.getByText("正在搜索…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(0);
    await selector.press("Enter");
    expect([...api.unknown]).toEqual([]);
  }
  await selector.fill("P0_FIXTURE");
  await expect(page.getByRole("option", { name: /P0_FIXTURE/ })).toBeVisible();
  await selector.press("Enter");
  await expect(selector).toHaveValue("P0_FIXTURE · SH600000");
  await selector.fill("600040");
  await expect(page.getByRole("option", { name: /P1_POOL_40/ })).toBeVisible();
  await selector.press("Enter");
  await expect(selector).toHaveValue("P1_POOL_40 · SH600040");
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-13");
  await expect(submit).toBeDisabled();
  await expect(
    page.getByText("开始日期不能晚于结束日期", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-10-01");
  const today = await page.evaluate(() =>
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  );
  await page.getByLabel("结束日期", { exact: true }).fill(today);
  await expect(submit).toBeDisabled();
  await page.getByLabel("结束日期", { exact: true }).fill("2026-10-09");
  await expect(submit).toBeEnabled();
  const request = page.waitForRequest((r) =>
    r.url().includes("strategyCenterRun"),
  );
  await submit.click();
  const body = (await request).postDataJSON();
  expect(SuperJSON.deserialize(body["0"] ?? body)).toMatchObject({
    symbol: "sh600040",
    start: "2026-10-01",
    end: "2026-10-09",
    initial: 1000000,
  });
  // Submission is captured and rejected by the offline policy, not executed.
  await expect(
    page.getByText("验收接口尚未分类：strategyCenterRun", { exact: true }),
  ).toBeVisible();
  expect([...api.unknown]).toEqual(["strategyCenterRun"]);
  expect(submissions).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("strategy-input.png"),
    fullPage: true,
  });
});

test("strategy date read failure preserves manual dates with a different browser date", async ({
  page,
}, testInfo) => {
  const failed = new Set(["localDailyAsOf"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = await installOfflineVisualApi(page, failed);
  await page.clock.setFixedTime(new Date("2030-06-16T16:30:00Z"));
  await page.goto("/lab?tab=catalog");
  await expect(
    page
      .getByRole("region", { name: "策略详情", exact: true })
      .getByRole("alert"),
  ).toContainText("本地历史日期读取失败");
  const start = page.getByLabel("开始日期", { exact: true });
  const end = page.getByLabel("结束日期", { exact: true });
  await expect(end).toHaveValue("");
  await expect(end).toHaveAttribute("max", "2030-06-16");
  await start.fill("2026-01-05");
  await end.fill("2026-10-09");
  failed.clear();
  await page.getByRole("button", { name: "重试日期", exact: true }).click();
  await expect(
    page.getByText("本地最近已结束交易日：2026-10-12。", { exact: false }),
  ).toBeVisible();
  await expect(start).toHaveValue("2026-01-05");
  await expect(end).toHaveValue("2026-10-09");
  expect(errors).toEqual([]);
  expect([...api.unknown]).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("manual-dates.png"),
    fullPage: true,
  });
});

test("chart security search keeps index and period-code choices", async ({
  page,
}) => {
  const api = await installOfflineVisualApi(page);
  await page.goto("/scan?symbol=sh600000");
  // Route entry starts a snapshot load after hydration, disabling the selector.
  // Exercise search after that initial load, rather than filling the SSR input.
  await expect(page.getByTestId("market-chart").first()).toBeVisible();
  const selector = page.getByRole("combobox", {
    name: "搜索品种名称或代码",
    exact: true,
  });
  await expect(selector).toBeEnabled();
  await selector.fill("sh000001");
  await expect(page.getByRole("option", { name: /SH000001/ })).toBeVisible();
  await selector.fill("W");
  await expect(page.getByRole("option", { name: /切换到周线/ })).toBeVisible();
  await selector.press("Enter");
  await expect(page.getByTestId("market-chart").first()).toHaveAttribute(
    "data-period",
    "week",
  );
  expect([...api.unknown]).toEqual([]);
});

test("strategy weight results keep their date and identity across automatic and manual selection", async ({
  page,
}) => {
  const api = await installOfflineVisualApi(page);
  await page.goto("/lab?tab=catalog");
  const search = page.getByRole("textbox", { name: "搜索策略", exact: true });
  const detail = page.getByRole("region", { name: "策略详情", exact: true });
  await search.fill("allocation-equal");
  await page.getByLabel("决策日期", { exact: true }).fill("2026-10-09");
  await page
    .getByRole("textbox", { name: "时点候选快照JSON", exact: true })
    .fill(
      JSON.stringify([
        { symbol: "sh600000", availableAt: "2026-10-08", values: {} },
      ]),
    );
  await page.getByRole("button", { name: "计算目标权重", exact: true }).click();
  await expect(detail.locator("pre")).toContainText("sh600000");
  await expect(detail).toContainText("截至 2026-10-09");
  await page.getByLabel("决策日期", { exact: true }).fill("2026-10-12");
  await expect(detail).toContainText("截至 2026-10-09");
  await search.fill("research-breakout");
  await expect(detail.locator("pre")).toHaveCount(0);
  await search.fill("no-matching-strategy");
  await expect(detail).toHaveCount(0);
  await search.fill("allocation-equal");
  await expect(detail.locator("pre")).toContainText("sh600000");
  // Explicit selection clears the prior result, even on the same strategy.
  await page.locator('[aria-label="策略列表"]').getByRole("button").click();
  await expect(detail.locator("pre")).toHaveCount(0);
  expect([...api.unknown]).toEqual([]);
});

test("E form lifecycle: ordinary strategy page resets drafts and errors without replaying a pending submit", async ({
  page,
}) => {
  const audit = await installOfflineVisualApi(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submissions = 0;
  await page.route("**/api/trpc/strategyCenterRun**", async (route) => {
    submissions++;
    await held;
    await route.abort("failed");
  });
  await page.goto("/lab?tab=catalog");
  const search = page.getByRole("textbox", { name: "搜索策略", exact: true });
  const start = page.getByLabel("开始日期", { exact: true });
  const end = page.getByLabel("结束日期", { exact: true });
  const submit = page.getByRole("button", {
    name: "创建本地日线实验",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  const initialStart = await start.inputValue();
  await start.fill("2099-01-01");
  await expect(submit).toBeDisabled();
  await page.locator('a[href="/system/tasks"]').first().click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(
    page.getByRole("heading", { name: "任务中心", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(start).toHaveValue(initialStart);
  await expect(submit).toBeEnabled();
  await search.fill("ma");
  await start.fill("2026-10-01");
  await end.fill("2026-10-09");
  await submit.click();
  await expect.poll(() => submissions).toBe(1);
  await expect(submit).toBeDisabled();
  await page.locator('a[href="/system/tasks"]').first().click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(
    page.getByRole("heading", { name: "任务中心", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue("");
  await expect(start).toHaveValue(initialStart);
  await expect(submit).toBeEnabled();
  expect(submissions).toBe(1);
  release();
  await search.fill("temporary");
  await page.reload();
  await expect(search).toHaveValue("");
  expect(submissions).toBe(1);
  expect([...audit.unknown]).toEqual([]);
});

test("E form lifecycle: valuation draft and validation are local to the reports route", async ({
  page,
}) => {
  const audit = await installOfflineVisualApi(page);
  await page.goto("/lab/reports");
  const open = async () => {
    await page.getByRole("radio", { name: "估值假设", exact: true }).click();
    await page.getByText("创建估值情景", { exact: true }).click();
  };
  await open();
  const title = page.getByRole("textbox", { name: "报告名称", exact: true });
  await title.fill("E 未提交估值草稿");
  await title.evaluate((element) => {
    element.closest("form")!.noValidate = true;
  });
  await page.getByRole("button", { name: "计算并保存", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "请填写全部金额" }),
  ).toBeVisible();
  await page.locator('a[href="/system/tasks"]').first().click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(
    page.getByRole("heading", { name: "任务中心", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await open();
  await expect(title).toHaveValue("");
  await expect(
    page.getByRole("alert").filter({ hasText: "请填写全部金额" }),
  ).toHaveCount(0);
  await title.fill("E 刷新草稿");
  await page.reload();
  await open();
  await expect(title).toHaveValue("");
  expect(audit.calls.has("valuationSave")).toBe(false);
  expect([...audit.unknown]).toEqual([]);
});

test("RPS ranked stocks keep the same ranking, period and base date after chart browsing and return", async ({
  page,
}) => {
  const api = await installOfflineVisualApi(page, new Set(), (data, input) => {
    // The pool profile has no RPS day, so this test substitutes only the
    // searched ranking. Both symbols have real local .day files, so opening
    // and PgDn still read the ordinary local chart.
    if (input.search !== "6000") return data;
    const fixture = loadedPool(data);
    fixture.rows = [
      {
        symbol: "sh600000",
        name: "P0_FIXTURE",
        localDay: true,
        value: { return: 0.119, rank: 1, rps: 90 },
        reason: null,
      },
      {
        symbol: "sh600040",
        name: "P1_POOL_40",
        localDay: true,
        value: { return: 0.05, rank: 2, rps: 80 },
        reason: null,
      },
    ];
    fixture.total = 2;
    return fixture;
  });
  await page.goto("/scan?tab=rps", { waitUntil: "networkidle" });
  const search = page.getByRole("textbox", {
    name: "搜索股票代码或名称",
    exact: true,
  });
  await search.fill("6000");
  const table = page.getByRole("table", { name: "个股RPS排名", exact: true });
  const returned = page.getByRole("link", {
    name: "返回个股 RPS 排名",
    exact: true,
  });
  await expect(
    page.getByText("RPS基准日：2026-11-12", { exact: false }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "P0_FIXTURE · SH600000" }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "P1_POOL_40 · SH600040" }),
  ).toBeVisible();
  await table.getByRole("link", { name: "P0_FIXTURE · SH600000" }).click();
  const chart = page.locator(".chart-panel").first();
  await expect(chart).toContainText("SH600000");
  // The chart toolbar carries the ranking source date as well as the list.
  await expect(
    chart.getByText("RPS50排名 · 2026-11-12", { exact: false }),
  ).toBeVisible();
  await expect(returned).toBeVisible();
  // PageDown keeps the original ranking membership, so the return link stays.
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.keyboard.press("PageDown");
  await expect(chart).toContainText("SH600040");
  await expect(returned).toBeVisible();
  await returned.click();
  await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "rps");
  // The existing panel cache restores the same search, period, page and day.
  await expect(search).toHaveValue("6000");
  await expect(
    page.getByRole("combobox", { name: "个股RPS周期", exact: true }),
  ).toContainText("RPS50");
  await expect(
    page.getByText("RPS基准日：2026-11-12", { exact: false }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "P0_FIXTURE · SH600000" }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "P1_POOL_40 · SH600040" }),
  ).toBeVisible();
  expect([...api.unknown]).toEqual([]);
});
