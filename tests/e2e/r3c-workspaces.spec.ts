import { expect, test, type Route } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import SuperJSON from "superjson";
import { jsonlStreamConsumer } from "@trpc/server/unstable-core-do-not-import";
import { trpcHeaders, waitForJob } from "./helpers";
import { fixtureDirectory } from "./fixture-directory";
import daily from "../fixtures/breakout-valid.json" with { type: "json" };

type BatchEntry = { result: { data: unknown } } | { error: unknown };
function procedurePaths(url: string) {
  const after = new URL(url).pathname.split("/api/trpc/")[1] ?? "";
  return after.split(",").map(decodeURIComponent);
}
async function resolveBatchValue(value: unknown): Promise<unknown> {
  if (value && typeof (value as { then?: unknown }).then === "function")
    return resolveBatchValue(await (value as Promise<unknown>));
  if (Array.isArray(value))
    return Promise.all(value.map((item) => resolveBatchValue(item)));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      output[key] = await resolveBatchValue(item);
    return output;
  }
  return value;
}
/** Decode the live JSONL batch so one procedure slot can change without others. */
async function decodeBatch(response: {
  text(): Promise<string>;
}): Promise<BatchEntry[]> {
  const text = await response.text();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const [head] = await jsonlStreamConsumer({
    from: stream,
    deserialize: (data) => SuperJSON.deserialize(data as never),
    abortController: new AbortController(),
  });
  const entries = await Promise.all(
    Object.entries(head as Record<string, unknown>).map(
      async ([index, value]) =>
        [Number(index), (await resolveBatchValue(value)) as BatchEntry] as const,
    ),
  );
  return entries.sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}
function encodeBatch(entries: readonly BatchEntry[]) {
  return (
    SuperJSON.stringify(
      Object.fromEntries(entries.map((entry, index) => [index, [[entry]]])),
    ) + "\n"
  );
}
async function rewriteBatch(
  route: Route,
  procedure: string,
  change: (entry: BatchEntry, input: unknown) => BatchEntry | void,
) {
  const url = route.request().url();
  const paths = procedurePaths(url);
  const slot = paths.indexOf(procedure);
  if (slot < 0) return route.continue();
  const response = await route.fetch();
  const entries = await decodeBatch(response);
  const raw = new URL(url).searchParams.get("input");
  const inputs = raw
    ? (JSON.parse(raw) as Record<string, { json?: unknown }>)
    : {};
  const changed = change(entries[slot]!, inputs[String(slot)]?.json);
  if (changed) entries[slot] = changed;
  await route.fulfill({ response, body: encodeBatch(entries) });
}
function syntheticLabPage(page: number, market: string) {
  const base = {
    market,
    sleeve: "swing",
    status: "research",
    row: null,
    forwardVerdict: "insufficient",
    unvalidatedLive: false,
  };
  return page === 1
    ? {
        total: 21,
        items: [
          { ...base, id: "r3a-shadow-qa", version: 1, rule: "R3a合成策略" },
        ],
      }
    : {
        total: 21,
        items: Array.from({ length: 20 }, (_, index) => ({
          ...base,
          id: `qa-list-${String(index).padStart(2, "0")}`,
          version: 1,
          rule: `QA分页策略 ${index}`,
        })),
      };
}
function dayBytes(
  bars: readonly {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    amount: number;
    volume: number;
  }[],
) {
  return Buffer.concat(
    bars.map((bar) => {
      const row = Buffer.alloc(32);
      row.writeUInt32LE(Number(bar.date.replaceAll("-", "")), 0);
      [bar.open, bar.high, bar.low, bar.close].forEach((value, index) =>
        row.writeUInt32LE(Math.round(value * 100), 4 + index * 4),
      );
      row.writeFloatLE(bar.amount, 20);
      row.writeUInt32LE(bar.volume, 24);
      return row;
    }),
  );
}

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

test("R3c 实验室集成 登记链接与回执", async ({ page, context }) => {
  const loadingPage = await context.newPage();
  const loadingPosts: string[] = [];
  loadingPage.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("strategyLabBacktest")
    )
      loadingPosts.push(request.url());
  });
  await loadingPage.route("**/api/trpc/**", async (route) => {
    if (!procedurePaths(route.request().url()).includes("strategyLabDetail"))
      return route.continue();
    await new Promise((done) => setTimeout(done, 1200));
    return route.continue();
  });
  await loadingPage.goto("/lab/backtest?strategy=r3a-shadow-qa&version=1");
  await expect(
    loadingPage.getByRole("status").filter({
      hasText: "正在读取策略 r3a-shadow-qa v1",
    }),
  ).toBeVisible();
  await expect(
    loadingPage.getByRole("button", { name: "提交策略对象回测", exact: true }),
  ).toHaveCount(0);
  await expect(
    loadingPage.getByText("从 r3a-shadow-qa v1 载入", { exact: false }),
  ).toBeVisible({ timeout: 15000 });
  expect(loadingPosts).toEqual([]);
  await loadingPage.close();

  const mismatchPage = await context.newPage();
  const mismatchPosts: string[] = [];
  mismatchPage.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("strategyLabBacktest")
    )
      mismatchPosts.push(request.url());
  });
  await mismatchPage.route("**/api/trpc/**", (route) =>
    rewriteBatch(route, "strategyLabDetail", (entry) => {
      if (!("result" in entry)) return;
      const data = entry.result.data as {
        strategy?: { id: string; version: number };
      } | null;
      if (data?.strategy)
        data.strategy = { ...data.strategy, id: "mismatch-qa" };
    }),
  );
  await mismatchPage.goto("/lab/backtest?strategy=r3a-shadow-qa&version=1");
  await expect(
    mismatchPage.getByRole("alert").filter({ hasText: "不一致，未载入表单" }),
  ).toContainText("mismatch-qa");
  await expect(
    mismatchPage.getByRole("button", { name: "提交策略对象回测", exact: true }),
  ).toHaveCount(0);
  expect(mismatchPosts).toEqual([]);
  await mismatchPage.close();

  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("strategyLabBacktest")
    )
      posts.push(request.url());
  });
  await page.goto("/lab/backtest?strategy=r3a-shadow-qa&version=1");
  await expect(
    page.getByText("从 r3a-shadow-qa v1 载入", { exact: false }),
  ).toBeVisible();
  const object = page.getByLabel("回测策略对象", { exact: true });
  await expect(object).toHaveValue(/"id": "r3a-shadow-qa"/);
  await expect(object).toHaveValue(/"version": 1/);
  await page.getByLabel("对象回测开始日期", { exact: true }).fill("2024-01-02");
  await page.getByLabel("对象回测结束日期", { exact: true }).fill("2023-12-29");
  await page.getByLabel("对象回测本金", { exact: true }).fill("777777");
  await page
    .getByRole("button", { name: "提交策略对象回测", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "开始须早于结束" }),
  ).toBeVisible();
  expect(posts).toHaveLength(0);

  await page.getByLabel("对象回测结束日期", { exact: true }).fill("2024-03-01");
  await page.evaluate(() => {
    const form = document.querySelector("form");
    form?.requestSubmit();
    form?.requestSubmit();
  });
  const receipt = page.getByRole("status").filter({
    hasText: "最近一次已创建的回测任务",
  });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText(
    "r3a-shadow-qa v1 · A股 · 2024-01-02 至 2024-03-01 · 本金 777777 · 交易成本 fixed",
  );
  expect(posts).toHaveLength(1);
  const href = await receipt
    .getByRole("link", { name: "查看进度、结果与取消" })
    .getAttribute("href");
  expect(href).toBeTruthy();
  const jobId = new URL(href!, "http://fixture").searchParams.get("id");
  expect(jobId).toBeTruthy();
  expect((await waitForJob(page, jobId!, 60000)).status).toBe("completed");

  await page.route("**/api/trpc/**", async (route) => {
    if (
      !procedurePaths(route.request().url()).includes("strategyLabBacktest")
    )
      return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: SuperJSON.serialize({
          message: "注入的提交失败",
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
        }),
      }),
    });
  });
  await expect(
    page.getByRole("button", { name: "提交策略对象回测", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("对象回测开始日期", { exact: true }).fill("2024-01-03");
  await page
    .getByRole("button", { name: "提交策略对象回测", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "注入的提交失败" }),
  ).toBeVisible();
  await expect(receipt).toContainText("2024-01-02 至 2024-03-01");
  await expect(
    receipt.getByRole("link", { name: "查看进度、结果与取消" }),
  ).toHaveAttribute("href", href!);
  await page.unroute("**/api/trpc/**");
});

test("R3c 实验室集成 共同冻结输入下载", async ({ page }, testInfo) => {
  const status = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const tdxRoot = (await status.json()).result.data.json.settings
    .tdxRoot as string;
  // The runner only forwards the fixture root to the server, so derive the
  // expected parent from the config-validated project output directory.
  const expectedParent = dirname(testInfo.project.outputDir);
  const fixtureRoot = dirname(tdxRoot);
  expect(relative(expectedParent, dirname(fixtureRoot))).toBe("");
  expect(basename(fixtureRoot)).toMatch(/^fixture-/);
  expect(basename(tdxRoot)).toBe("tdx");
  fixtureDirectory(tdxRoot);
  // The pool fixture only has a two-day index calendar and mismatched stock
  // history. Extend the disposable fixture so the public strategy-center flow
  // can run two real same-input studies.
  const calendar = [...daily.bars].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const targets = ["sh600099.day", "sh000001.day"].map((name) =>
    join(tdxRoot, "vipdoc/sh/lday", name),
  );
  for (const target of targets) {
    fixtureDirectory(target);
    await writeFile(target, dayBytes(calendar));
  }
  const start = calendar[200]!.date;
  const end = calendar.at(-1)!.date;
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post("/api/trpc/strategyCenterRun", {
      headers: trpcHeaders,
      data: {
        json: {
          strategyId: "ma",
          symbol: "sh600099",
          start,
          end,
          initial: 1000000,
        },
      },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    const id = body.result.data.json.id as string;
    expect((await waitForJob(page, id, 120000)).status).toBe("completed");
    ids.push(id);
  }

  await page.goto("/lab?tab=catalog");
  await page.getByRole("radio", { name: "运行与比较", exact: true }).click();
  const choices = page.getByRole("checkbox", { name: "加入比较", exact: true });
  await expect(choices).toHaveCount(2);
  await choices.nth(0).check();
  await choices.nth(1).check();
  await page
    .getByRole("button", { name: "比较所选（2/12）", exact: true })
    .click();
  const comparison = page.locator("section").filter({
    has: page.getByRole("heading", { name: "同口径比较", exact: true }),
  });
  await expect(comparison.getByRole("row")).toHaveCount(3);
  await expect(comparison).toContainText(`共同冻结输入区间：${start} 至 ${end}`);
  await expect(comparison).toContainText("独立本金 1000000");
  await expect(comparison).toContainText("sh600099");
  const itemLinks = comparison.getByRole("link", { name: /^任务 / });
  await expect(itemLinks).toHaveCount(2);
  const orderedIds = (await itemLinks.allTextContents()).map((text) =>
    text.replace(/^任务\s*/, ""),
  );
  expect(new Set(orderedIds).size).toBe(2);
  expect([...orderedIds].sort()).toEqual([...ids].sort());

  await choices.nth(0).uncheck();
  await expect(
    comparison.getByText("选择已修改，请重新比较。", { exact: false }),
  ).toBeVisible();
  const exportButton = comparison.getByRole("button", {
    name: "导出比较摘要",
    exact: true,
  });
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("策略中心-同口径比较.json");
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = JSON.parse(await readFile(path!, "utf8")) as {
    format: string;
    basis: unknown;
    items: { id: string; strategyId: string; overview: unknown }[];
  };
  const response = await page.request.get(
    "/api/trpc/strategyCenterCompare?input=" +
      encodeURIComponent(JSON.stringify({ json: orderedIds })),
    { headers: trpcHeaders },
  );
  expect(response.ok()).toBe(true);
  const expected = (await response.json()).result.data.json as {
    id: string;
    strategyId: string;
    comparisonBasis: unknown;
    overview: unknown;
  }[];
  expect(exported.format).toBe("strategy-center-comparison-1");
  expect(exported.basis).toEqual(expected[0]!.comparisonBasis);
  expect(exported.items).toEqual(
    expected.map(({ id, strategyId, overview }) => ({
      id,
      strategyId,
      overview,
    })),
  );
  expect(exported.items.map((item) => item.id)).toEqual(orderedIds);
  expect(exported.items.map((item) => item.strategyId)).toEqual(["ma", "ma"]);
  for (const item of exported.items)
    expect(Object.keys(item).sort()).toEqual(["id", "overview", "strategyId"]);
  expect(JSON.stringify(exported)).not.toMatch(
    /sourceHash|benchmarkHash|calendarHash/,
  );
});

test("R3c 实验室集成 列表闭环", async ({ page, context }) => {
  const listInputs: { market: string; query: string; page: number }[] = [];
  await page.route("**/api/trpc/**", async (route) => {
    const paths = procedurePaths(route.request().url());
    const slot = paths.indexOf("strategyLab");
    if (slot < 0) return route.continue();
    const raw = new URL(route.request().url()).searchParams.get("input");
    const input = (
      JSON.parse(raw ?? "{}") as Record<
        string,
        { json?: { market: string; query: string; page: number } }
      >
    )[String(slot)]?.json;
    expect(input).toBeDefined();
    listInputs.push(input!);
    const response = await route.fetch();
    const entries = await decodeBatch(response);
    const entry = entries[slot]!;
    if ("result" in entry)
      entry.result.data = syntheticLabPage(input!.page, input!.market);
    await route.fulfill({ response, body: encodeBatch(entries) });
  });

  await page.goto("/lab");
  await expect(
    page.getByRole("region", { name: "实验室策略列表" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "BTC / ETH", exact: true }).click();
  await page.getByLabel("搜索实验室策略", { exact: true }).fill("QA");
  await expect
    .poll(() =>
      listInputs.some(
        (input) =>
          input.market === "crypto" &&
          input.query === "QA" &&
          input.page === 0,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();
  await expect
    .poll(() =>
      listInputs.some(
        (input) =>
          input.market === "crypto" &&
          input.query === "QA" &&
          input.page === 1,
      ),
    )
    .toBe(true);

  await page.getByRole("link", { name: /r3a-shadow-qa v1/ }).click();
  await expect(
    page.getByRole("region", { name: "实验室策略详情" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "返回策略列表" }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await expect(
    page.getByRole("region", { name: "实验室策略列表" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "BTC / ETH", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByLabel("搜索实验室策略", { exact: true }),
  ).toHaveValue("QA");
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();
  // The page-2 row is only present in the synthetic second page.
  await expect(page.getByRole("link", { name: /r3a-shadow-qa v1/ })).toBeVisible();

  await page.goBack();
  await expect(
    page.getByRole("region", { name: "实验室策略详情" }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/lab$/);
  await expect(page.getByText(/第 2 \/ 2 页/)).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "BTC / ETH", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  const fresh = await context.newPage();
  await fresh.goto("/lab?strategy=r3a-shadow-qa&version=1");
  await expect(
    fresh.getByRole("region", { name: "实验室策略详情" }),
  ).toBeVisible();
  await fresh.getByRole("link", { name: "返回策略列表" }).click();
  await expect(fresh).toHaveURL(/\/lab$/);
  await expect(
    fresh.getByRole("radio", { name: "A股中证800", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    fresh.getByLabel("搜索实验室策略", { exact: true }),
  ).toHaveValue("");
  await expect(fresh.getByText(/第 1 \/ 1 页/)).toBeVisible();
  await fresh.close();

  const detailPage = await context.newPage();
  await detailPage.route("**/api/trpc/**", async (route) => {
    if (!procedurePaths(route.request().url()).includes("strategyLabDetail"))
      return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    await new Promise((done) => setTimeout(done, 1200));
    await route.fulfill({ response, body });
  });
  await detailPage.goto("/lab?strategy=r3a-shadow-qa&version=1");
  await expect(
    detailPage.getByRole("status").filter({ hasText: "正在读取策略详情…" }),
  ).toBeVisible();
  await expect(
    detailPage.getByRole("link", { name: "返回策略列表" }),
  ).toBeVisible();
  await expect(
    detailPage.getByRole("region", { name: "实验室策略详情" }),
  ).toBeVisible({ timeout: 15000 });
  await detailPage.unroute("**/api/trpc/**");

  await detailPage.route("**/api/trpc/**", (route) =>
    rewriteBatch(route, "strategyLabDetail", () => ({
      error: {
        message: "注入的详情读取失败",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    })),
  );
  await detailPage.goto("/lab?strategy=r3a-shadow-qa&version=2");
  await expect(
    detailPage.getByRole("alert").filter({ hasText: "注入的详情读取失败" }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    detailPage.getByRole("link", { name: "返回策略列表" }),
  ).toBeVisible();
  await detailPage.unroute("**/api/trpc/**");
  await detailPage
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(
    detailPage.getByRole("region", { name: "实验室策略详情" }),
  ).toContainText("缺少对应版本的策略对象");
  await detailPage.close();
});
