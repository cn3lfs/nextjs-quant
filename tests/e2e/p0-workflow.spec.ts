import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { expect, test, type Page, type Response } from "@playwright/test";
import { trpcHeaders } from "./helpers";
import type { ScoreboardRow } from "../../src/server/research/validation-model";
import { jsonlStreamProducer } from "@trpc/server/unstable-core-do-not-import";
import SuperJSON from "superjson";

async function openWorkspacePage(page: Page, label: string) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "搜索页面" }).fill(label);
  await page
    .getByRole("option", { name: new RegExp("^" + label) })
    .first()
    .click();
}
function procedure(response: Response, name: string) {
  return (
    new URL(response.url()).pathname
      .split("/api/trpc/")[1]
      ?.split(",")
      .includes(name) ?? false
  );
}
async function result(page: Page, response: Response, name: string) {
  const names = new URL(response.url()).pathname
    .split("/api/trpc/")[1]!
    .split(",");
  expect(response.status()).toBe(200);
  // tRPC's streaming response body is not always retained by Chrome CDP.
  // Re-read this exact read-only query with normal JSON headers for inspection.
  const json = await page.request.get(response.url(), { headers: trpcHeaders });
  const body = await json.json();
  const envelope = Array.isArray(body) ? body[names.indexOf(name)] : body;
  expect(envelope.error, `${name} failed`).toBeUndefined();
  return envelope.result.data.json;
}
async function download(page: Page, button: string) {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const file = await waiting;
  expect(await file.failure()).toBeNull();
  return JSON.parse(await readFile((await file.path())!, "utf8"));
}
test.beforeAll(async ({ request }) => {
  const response = await request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await response.json()).result.data.json.settings;
  expect(settings.marketDataSource).toBe("local");
  expect(settings).not.toHaveProperty("autoAnalysis");
  expect(settings).not.toHaveProperty("analysisLimit");
  expect(settings.autoNewsAnalysis).toBe(false);
  expect(settings.tdxRoot.replaceAll("\\", "/")).toMatch(
    /\/\.test-data\/.+\/fixture-[^/]+\/tdx$/,
  );
});

test("R2a4 Binance history config persists and the explicit backfill entry sends native intervals without live side effects", async ({
  page,
}) => {
  const r = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await r.json()).result.data.json.settings;
  const root = resolve(settings.tdxRoot, "../binance-history");
  await page.goto("/system");
  await page.getByRole("radio", { name: "数字货币", exact: true }).click();
  await expect(
    page.getByText("BTC、ETH 历史行情", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("币安历史行情保存目录").fill(root);
  const saved = page.waitForResponse((response) =>
    procedure(response, "configureBinancePublicDataRoot"),
  );
  await page.getByRole("button", { name: "保存目录", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await page.getByRole("radio", { name: "数字货币", exact: true }).click();
  await expect(page.getByLabel("币安历史行情保存目录")).toHaveValue(root);
  await expect(
    page.getByText("历史尚未补齐，请按需回填后再开展长区间研究。", {
      exact: true,
    }),
  ).toBeVisible();
  let starts = 0,
    body = "";
  await page.route(
    "**/api/trpc/startBinancePublicDataBackfill*",
    async (route) => {
      starts++;
      body = route.request().postData() ?? "";
      // Match the installed httpBatchStreamLink transport, including its head
      // and nested promises. Never forward this mutation to the real worker.
      const stream = jsonlStreamProducer({
        maxDepth: Infinity,
        data: [
          Promise.resolve({
            result: Promise.resolve({
              data: Promise.resolve({
                id: "job-r2a4-browser-stub",
                status: "queued",
              }),
            }),
          }),
        ],
        serialize: (value) => SuperJSON.serialize(value),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: await new globalThis.Response(stream).text(),
      });
    },
  );
  await expect(
    page.getByLabel("同时下载 1 分钟（占用更多空间）"),
  ).not.toBeChecked();
  expect(starts).toBe(0);
  await page
    .getByRole("button", { name: "回填/补齐 BTC、ETH 历史", exact: true })
    .click();
  await expect(
    page.getByText(/已创建任务 job-r2a4-browser-stub/),
  ).toBeVisible();
  expect(starts).toBe(1);
  expect(body).toContain('"includeOneMinute":false');
  await expect(
    page.getByRole("link", { name: "查看任务进度与取消" }),
  ).toHaveAttribute("href", "/system/tasks");
});

test("R2a scoreboard keeps bias labels, server pages, keyboard market switch and zero delivery", async ({
  page,
}, testInfo) => {
  const response = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await response.json()).result.data.json.settings;
  const parent = await realpath(
    resolve(process.env.E2E_DATA_DIR ?? ".test-data/p0-acceptance"),
  );
  const directory = await realpath(resolve(settings.tdxRoot, ".."));
  expect(directory.startsWith(parent + sep)).toBe(true);
  const database = new Database(resolve(directory, "quant.sqlite"), {
    fileMustExist: true,
  });
  const prefix = "r2a-ui-fixture-";
  const rows: ScoreboardRow[] = Array.from({ length: 25 }, (_, i) => ({
    id: `${prefix}${String(i).padStart(2, "0")}`,
    level: "strategy",
    market: "cn-equity",
    sleeve: "swing",
    rule: `固定输入候选 ${i}`,
    status: "research",
    return: 0.01,
    excess: i / 100,
    drawdown: 0.1,
    trades: i,
    oosWindows: 6,
    positiveWindows: 2,
    biasTags: [
      {
        code: "historical-universe-incomplete",
        severity: "high",
        detail: "QA免费数据缺口",
      },
    ],
    riskAdjusted: {
      sharpe: 1.2,
      benchmarkSharpe: 1,
      sharpeDifference: i === 0 ? null : 0.2,
      calmar: 0.5,
      benchmarkCalmar: 0.6,
      calmarDifference: i === 0 ? null : -0.1,
      basis: "QA同窗252观测/2%无风险，非策略业绩",
    },
    bias: {
      universe: "历史证券池不完整",
      adjustment: "信号前复权，成交原价",
      financial: "未使用财务",
      execution: "历史成交未核验",
    },
    reasons: ["oos-positive-excess-majority"],
  }));
  rows[0]!.status = "shadow-candidate";
  rows[0]!.dsr = { value: 0.91, reason: null };
  rows[0]!.globalDsr = { value: 0.13, reason: null };
  const shadowKey = `alerts:shadow:${rows[0]!.id}:1`,
    progressKey = `alerts:shadow-summary:${rows[0]!.id}:1`;
  try {
    const state = database.prepare(
      "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'alert-state',?,?)",
    );
    state.run(
      shadowKey,
      JSON.stringify({
        startedAt: Date.UTC(2026, 10, 15, 9),
        status: "shadow-candidate",
        active: true,
      }),
      1,
    );
    state.run(
      progressKey,
      JSON.stringify({
        samples: [],
        days: 3,
        signals: 12,
        paused: false,
        assessment: null,
      }),
      1,
    );
    database
      .prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'validation-scoreboard',?,?)",
      )
      .run(
        "validation-scoreboard-cn-equity",
        JSON.stringify({
          market: "cn-equity",
          inputHash: "a".repeat(64),
          resultHash: "b".repeat(64),
          buildHash: "c".repeat(64),
          rows,
          missing: [],
          createdAt: 1,
          runtimeMs: 1,
          universe: "QA固定输入",
          gaps: ["历史池缺口"],
        }),
        1,
      );
    await page.goto("/lab?tab=catalog");
    await page.getByRole("radio", { name: "研究成绩单", exact: true }).click();
    const region = page.getByRole("region", {
      name: "策略研究成绩单",
      exact: true,
    });
    await expect(region).toContainText("历史证券池不完整");
    await expect(region).toContainText("历史成交未核验");
    await expect(region).toContainText("偏差（高）：QA免费数据缺口");
    await expect(region).toContainText("夏普差 0.200");
    await expect(region).toContainText("Calmar 差 -0.100");
    const firstRow = region.getByRole("row").filter({ hasText: `${prefix}00` });
    await expect(firstRow).toContainText("夏普差 —");
    await expect(firstRow).toContainText("Calmar 差 —");
    await expect(firstRow).not.toContainText("夏普差 0.000");
    await expect(firstRow).toContainText("影子前推中");
    await expect(firstRow).toContainText("开始 2026/11/15");
    await expect(firstRow).toContainText("前推 12 个信号 / 3 日");
    await expect(firstRow).toContainText("市场DSR 0.910");
    await expect(firstRow).toContainText("全局DSR 0.130");
    await page.setViewportSize({ width: 1024, height: 768 });
    await region
      .getByText(/夏普差 0\.200/)
      .first()
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("r2a2-scoreboard-populated-1024.png"),
    });
    await expect(
      region.getByText(`${prefix}00`, { exact: true }),
    ).toBeVisible();
    await expect(region.getByText(`${prefix}20`, { exact: true })).toHaveCount(
      0,
    );
    await region.getByRole("button", { name: /下一页/ }).click();
    await expect(
      region.getByText(`${prefix}20`, { exact: true }),
    ).toBeVisible();
    await expect(region.getByText(`${prefix}00`, { exact: true })).toHaveCount(
      0,
    );
    const market = region.getByRole("radiogroup", { name: "研究市场" });
    await market.getByRole("radio", { name: "A 股", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(region).toContainText("尚无已完成的研究成绩单");
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({
      path: testInfo.outputPath("r2a-scoreboard-1024.png"),
      fullPage: true,
    });
    expect(
      database
        .prepare("SELECT count(*) n FROM records WHERE kind='delivery'")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    database
      .prepare("DELETE FROM records WHERE id='validation-scoreboard-cn-equity'")
      .run();
    database
      .prepare("DELETE FROM records WHERE id IN (?,?)")
      .run(shadowKey, progressKey);
    database.close();
  }
});

test("sidebar counts old active tasks beyond the recent list and refreshes their completion", async ({
  page,
}, testInfo) => {
  const response = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await response.json()).result.data.json.settings;
  // Only the disposable server fixture may be seeded while the server is live.
  // Startup recovery would correctly interrupt a pre-seeded active task.
  const parent = await realpath(
    resolve(process.env.E2E_DATA_DIR ?? ".test-data/p0-acceptance"),
  );
  const directory = await realpath(resolve(settings.tdxRoot, ".."));
  expect(parent).toContain(`${sep}.test-data${sep}`);
  expect(directory.startsWith(parent + sep)).toBe(true);
  const database = new Database(resolve(directory, "quant.sqlite"), {
    fileMustExist: true,
  });
  const prefix = "p3-overview-fixture-";
  const insert = database.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'job',?,?)",
  );
  const makeJob = (
    id: string,
    status: string,
    updatedAt: number,
    type = "research",
  ) => ({
    id,
    type,
    status,
    progress: status === "completed" ? 100 : 0,
    createdAt: updatedAt,
    updatedAt,
    input: {},
  });
  const running = makeJob(prefix + "running", "running", 2);
  const queued = makeJob(prefix + "queued", "queued", 3);
  const scan = makeJob(prefix + "scan", "completed", 4, "scan");
  expect(
    database
      .prepare("SELECT count(*) n FROM records WHERE id LIKE ?")
      .get(prefix + "%"),
  ).toEqual({ n: 0 });
  try {
    database.transaction(() => {
      for (const job of [
        running,
        queued,
        scan,
        ...Array.from({ length: 100 }, (_, i) =>
          makeJob(prefix + i, "completed", 100 + i),
        ),
      ]) {
        insert.run(job.id, JSON.stringify(job), job.updatedAt);
      }
    })();
    const overviewResponse = await page.request.get("/api/trpc/taskOverview", {
      headers: trpcHeaders,
    });
    const overview = (await overviewResponse.json()).result.data.json;
    expect(overview).toMatchObject({
      running: 1,
      queued: 1,
      latestCompletedScan: { id: scan.id, updatedAt: 4 },
    });
    expect(JSON.stringify(overview).length).toBeLessThan(1200);
    const recentResponse = await page.request.get("/api/trpc/jobs", {
      headers: trpcHeaders,
    });
    const recent = (await recentResponse.json()).result.data.json as {
      id: string;
    }[];
    expect(recent).toHaveLength(80);
    expect(
      recent.some((job) => [running.id, queued.id, scan.id].includes(job.id)),
    ).toBe(false);
    const taskRows: string[] = [];
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname
          .split("/api/trpc/")[1]
          ?.split(",")
          .includes("jobs")
      )
        taskRows.push(request.url());
    });
    await page.goto("/lab/backtest");
    const badge = page
      .getByRole("navigation", { name: "工作台导航" })
      .getByRole("link", { name: /系统/ })
      .locator(".nav-badge");
    await expect(badge).toHaveText("2");
    await badge.scrollIntoViewIfNeeded();
    await expect(badge).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("full-task-count.png") });
    expect(taskRows).toEqual([]);
    database.transaction(() => {
      const update = database.prepare(
        "UPDATE records SET payload=?,updated_at=? WHERE id=?",
      );
      for (const job of [running, queued])
        update.run(
          JSON.stringify({ ...job, status: "completed", updatedAt: 500 }),
          500,
          job.id,
        );
    })();
    await expect(badge).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("completed-task-count.png"),
    });
    expect(taskRows).toEqual([]);
  } finally {
    database.prepare("DELETE FROM records WHERE id LIKE ?").run(prefix + "%");
    database.close();
  }
});

test("current backtest reports missing warmup, recovers, restores and exports real worker output", async ({
  page,
}) => {
  await page.goto("/lab/backtest");
  await expect(
    page.getByRole("button", { name: "开始回测", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("基线证券代码").fill("sh600000");
  await page.getByRole("button", { name: "读取本地覆盖", exact: true }).click();
  await expect(page.getByLabel("基线开始日期")).toHaveValue("2026-10-09");
  await page.getByRole("button", { name: "开始回测", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "不足 20 根预热行情" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "实验报告", exact: true }),
  ).toHaveCount(0);

  await page.getByLabel("基线开始日期").fill("2026-10-12");
  await page.getByRole("button", { name: "开始回测", exact: true }).click();
  const report = page.getByRole("region", { name: "实验报告", exact: true });
  await expect(report).toContainText("SMA 5 / 20 · 已完成");
  const history = await page.request.get("/api/trpc/maBaselineHistory", {
    headers: trpcHeaders,
  });
  const job = (await history.json()).result.data.json[0];
  expect(job.status).toBe("completed");
  await expect(report).toContainText(job.id);
  await expect(report).toContainText("1 笔");
  await expect(
    report
      .getByRole("region", { name: "日末收益与回撤" })
      .locator("canvas")
      .first(),
  ).toBeVisible();
  const archive = await download(page, "导出完整实验");
  expect(archive.result.input).toMatchObject({
    symbol: "sh600000",
    start: "2026-10-12",
    end: "2026-10-12",
  });
  expect(archive.result.fills).toHaveLength(1);
  expect(archive.result.fills[0]).toMatchObject({ side: "buy" });
  expect(archive.inputSnapshot.bars).toHaveLength(68);
  expect(archive.manifest.warmupBars).toBe(20);
  await page.reload();
  await page
    .getByRole("button", { name: `恢复实验 ${job.id}`, exact: true })
    .click();
  await expect(report).toContainText(job.id);
  await page.getByRole("tab", { name: "成交与订单", exact: true }).click();
  await expect(
    report.getByRole("button", { name: "成交记录 · 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "复现依据", exact: true }).click();
  await expect(report).toContainText(archive.manifest.dataHash);
  await expect(
    page.getByRole("button", { name: "运行回测", exact: true }),
  ).toHaveCount(0);
});

test("formula editor waits for hydration before accepting edits or checking future functions", async ({
  page,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
    await ready;
    await route.continue();
  });
  try {
    await page.goto("/scan?tab=formula", { waitUntil: "commit" });
    const source = page.getByLabel("公式源码", { exact: true });
    const check = page.getByRole("button", {
      name: "语法检查与未来函数门禁",
      exact: true,
    });
    const run = page.getByRole("button", {
      name: "全市场执行公式",
      exact: true,
    });
    await expect(source).toBeDisabled();
    await expect(check).toBeDisabled();
    release();
    await expect(source).toBeEnabled();
    await source.fill("选股:REF(C,-1)>0;");
    await check.click();
    await expect(source).toHaveValue("选股:REF(C,-1)>0;");
    await expect(run).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("formula save and execution open a clean candidate chart with real breakout data", async ({
  page,
}) => {
  await page.goto("/scan?tab=formula");
  const source = page.getByLabel("公式源码", { exact: true });
  const check = page.getByRole("button", {
    name: "语法检查与未来函数门禁",
    exact: true,
  });
  const run = page.getByRole("button", { name: "全市场执行公式", exact: true });
  await source.fill("选股:REF(C,-1)>0;");
  await check.click();
  await expect(run).toBeDisabled();
  await page.getByLabel("公式名称", { exact: true }).fill("P0 本地正收盘");
  await source.fill("选股:C>0;");
  await check.click();
  await page.getByRole("button", { name: "保存公式", exact: true }).click();
  await expect(page.getByText("公式已保存", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("combobox", { name: "已保存公式", exact: true }).click();
  await page
    .getByRole("option", { name: "P0 本地正收盘", exact: true })
    .click();
  await expect(source).toHaveValue("选股:C>0;");
  await check.click();
  await run.click();
  const candidates = page.getByRole("table", { name: "候选结果", exact: true });
  await expect(candidates).toContainText("P0_FIXTURE");
  await expect(candidates.getByRole("row")).toHaveCount(2);
  await expect(
    candidates.getByRole("columnheader", { name: "AI 快评" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "公式选股进度" }),
  ).toBeVisible();
  await expect(
    page.getByText("本次规则任务尚未创建自动快评任务。"),
  ).toHaveCount(0);
  const exported = await download(page, "导出本次完整结果");
  expect(exported.format).toBe("quant-formula-screen-export-1");
  expect(exported.candidates).toHaveLength(1);
  expect(exported.candidates[0].symbol).toBe("sh600000");
  // Only the chart route requests the absent default security. Keep the actual
  // prior-error recovery check while screen cold entry remains free of chart IO.
  await openWorkspacePage(page, "扫描与图表");
  await expect(
    page.getByText("所选数据源读取失败", { exact: false }),
  ).toBeVisible();
  await openWorkspacePage(page, "条件选股");
  const breakout = page.waitForResponse((response) =>
    procedure(response, "breakout"),
  );
  await candidates.getByRole("button", { name: "个股研究" }).click();
  await expect(page).toHaveURL(
    /\/scan\?(?:tab=formula&)?symbol=sh600000(?:&|$)/,
  );
  await expect(
    page.getByText("所选数据源读取失败", { exact: false }),
  ).toHaveCount(0);
  const overlay = await result(page, await breakout, "breakout");
  expect(overlay.points.length).toBeGreaterThan(0);
  expect(overlay.latest).not.toBeNull();
  await expect(
    page.getByRole("checkbox", { name: "双突破", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("双突破计算失败", { exact: false })).toHaveCount(
    0,
  );
  const frozenId = exported.candidates[0].snapshotId as string;
  const restoredChart = page.waitForResponse(
    (response) =>
      procedure(response, "chartBars") &&
      decodeURIComponent(response.url()).includes(frozenId),
  );
  await page.reload();
  expect((await restoredChart).status()).toBe(200);
  await expect(
    page.getByRole("combobox", { name: "搜索品种名称或代码" }),
  ).toHaveValue(/SH600000/i);
});

test("older formula results reopen from task history and survive refresh without changing identity", async ({
  page,
}) => {
  async function createFormula(
    name: string,
    source: string,
    status = "completed",
  ) {
    const response = await page.request.post("/api/trpc/formulaScreen", {
      headers: trpcHeaders,
      data: { json: { name, source, parameters: {} } },
    });
    expect(response.status()).toBe(200);
    const job = (await response.json()).result.data.json;
    await expect
      .poll(async () => {
        const state = await page.request.get(
          `/api/trpc/jobSummary?input=${encodeURIComponent(JSON.stringify({ json: { id: job.id } }))}`,
          { headers: trpcHeaders },
        );
        return (await state.json()).result.data.json?.status;
      })
      .toBe(status);
    return job.id as string;
  }
  const older = await createFormula("P0 历史候选", "选股:C>0;");
  const newer = await createFormula("P0 最新空结果", "选股:C<0;");
  expect(newer).not.toBe(older);
  // Fresh shell with completed formula history must leave result loading to
  // the screening panel. Other routes only need aggregate task metadata.
  const screenReads: string[] = [];
  const trackScreenReads = (response: Response) => {
    if (procedure(response, "screenResults")) screenReads.push(response.url());
    if (procedure(response, "jobs")) screenReads.push(response.url());
  };
  page.on("response", trackScreenReads);
  const overview = page.waitForResponse((response) =>
    procedure(response, "taskOverview"),
  );
  await page.goto("/lab/backtest");
  await overview;
  await page.waitForLoadState("networkidle");
  expect(screenReads).toEqual([]);
  page.off("response", trackScreenReads);
  await page.goto("/system/tasks");
  await page.getByRole("textbox", { name: "精确任务编号" }).fill(older);
  await page.getByRole("button", { name: "查询任务", exact: true }).click();
  await page.locator(`#task-trigger-${older}`).click();
  await page.getByRole("link", { name: "查看选股结果", exact: true }).click();
  await expect(page).toHaveURL(`/scan?tab=formula&job=${older}`);
  await expect(
    page.getByRole("table", { name: "候选结果", exact: true }),
  ).toContainText("P0_FIXTURE");
  await page.reload();
  const restored = await download(page, "导出本次完整结果");
  expect(restored.jobId).toBe(older);
  expect(restored.parameters.formula.name).toBe("P0 历史候选");
  expect(restored.candidates).toHaveLength(1);
  await page.goto(`/scan?tab=formula&job=${newer}`);
  const empty = await download(page, "导出本次完整结果");
  expect(empty.jobId).toBe(newer);
  expect(empty.candidates).toHaveLength(0);
  await expect(
    page.getByRole("table", { name: "候选结果", exact: true }),
  ).not.toContainText("P0_FIXTURE");
  await page.goBack();
  expect((await download(page, "导出本次完整结果")).jobId).toBe(older);
  await page.goForward();
  expect((await download(page, "导出本次完整结果")).jobId).toBe(newer);
  await page.goto("/scan?tab=formula&job=p0-retired-screen");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "不是公式选股任务",
  );
  await expect(
    page.getByRole("button", { name: "导出本次完整结果", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("table", { name: "候选结果", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("LEGACY_SHOULD_NOT_RENDER")).toHaveCount(0);
  await page.goto("/scan?tab=formula&job=job-missing-fixture");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "任务不存在",
  );
  await expect(
    page.getByRole("button", { name: "导出本次完整结果", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("table", { name: "候选结果", exact: true }),
  ).toHaveCount(0);
  const failed = await createFormula(
    "P0 运行失败",
    "选股:DMA(C,C/2)>0;",
    "failed",
  );
  await page.goto(`/scan?tab=formula&job=${failed}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("DMA");
  await expect(
    page.getByRole("button", { name: "导出本次完整结果", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("table", { name: "候选结果", exact: true }),
  ).toHaveCount(0);
});

test("formula result pages search and sort the whole persisted result and export every row", async ({
  page,
}) => {
  const response = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await response.json()).result.data.json.settings;
  const parent = await realpath(
    resolve(process.env.E2E_DATA_DIR ?? ".test-data/p0-acceptance"),
  );
  const directory = await realpath(resolve(settings.tdxRoot, ".."));
  expect(parent).toContain(`${sep}.test-data${sep}`);
  expect(directory.startsWith(parent + sep)).toBe(true);
  const database = new Database(resolve(directory, "quant.sqlite"), {
    fileMustExist: true,
  });
  const id = "p3-result-paging-fixture";
  const formula = { name: "分页验收", source: "选股:C>0;", parameters: {} };
  const candidates = Array.from({ length: 201 }, (_, i) => ({
    symbol: `sh${610000 + i}`,
    name: `归档候选${i}`,
    snapshotId: `paging-${i}`,
    metrics: {
      close: i + 1,
      change: 1,
      volumeRatio: 1,
      fast: 1,
      slow: 1,
      matched: true,
      date: "2026-11-13",
      score: i,
    },
  }));
  const job = {
    id,
    type: "screen",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { type: "formula-screen", formula, root: "fixture", now: 1 },
    result: {
      formula,
      candidates,
      excluded: [],
      errors: [],
      total: candidates.length,
      asOf: "2026-11-13",
      elapsedMs: 1,
      period: "day",
      researchMode: "latest-local",
      universeSource: "fixture",
      researchWarnings: [],
      snapshots: ["ARCHIVE-ONLY-".repeat(100000)],
    },
  };
  let inserted = false;
  try {
    database
      .prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'job',?,?)",
      )
      .run(id, JSON.stringify(job), job.updatedAt);
    inserted = true;
    await page.goto(`/scan?tab=formula&job=${id}`);
    const table = page.getByRole("table", { name: "候选结果", exact: true });
    await expect(table.getByRole("row")).toHaveCount(51);
    await expect(table.getByRole("row").nth(1)).toContainText("sh610000");
    await expect(
      page.getByText("第 1 / 5 页 · 201 条", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(table.getByRole("row").nth(1)).toContainText("sh610050");
    await page.getByRole("combobox", { name: "候选排序字段" }).click();
    await page.getByRole("option", { name: "收盘价", exact: true }).click();
    await expect(table.getByRole("row").nth(1)).toContainText("sh610200");
    await page.getByLabel("筛选候选名称或代码").fill("归档候选200");
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table).toContainText("sh610200");
    await expect(
      page.getByText("第 1 / 1 页 · 1 条", { exact: true }),
    ).toBeVisible();
    const exported = await download(page, "导出本次完整结果");
    expect(
      exported.candidates.map(
        (candidate: { symbol: string }) => candidate.symbol,
      ),
    ).toEqual(candidates.map((candidate) => candidate.symbol));
    expect(exported).not.toHaveProperty("snapshots");
  } finally {
    if (inserted)
      database.prepare("DELETE FROM records WHERE kind='job' AND id=?").run(id);
    database.close();
  }
});

test("research draft survives framework navigation and settings owns its controls", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/trpc/"))
      mutations.push(new URL(request.url()).pathname);
  });
  await page.goto("/lab/analysis");
  const question = page.getByRole("textbox", { name: "研究问题", exact: true });
  await expect(
    page.getByRole("button", { name: "开始研究", exact: true }),
  ).toBeDisabled();
  await question.fill("P2 保留当前研究问题");
  await page.getByRole("combobox", { name: "研究方法", exact: true }).click();
  await page
    .getByRole("option", { name: "SEPA 分阶段研究", exact: true })
    .click();
  await page.getByRole("link", { name: "查看研究档案" }).click();
  await expect(page).toHaveURL(/\/lab\/reports$/);
  await page.goBack();
  await expect(question).toHaveValue("P2 保留当前研究问题");
  await expect(
    page.getByRole("combobox", { name: "研究方法", exact: true }),
  ).toContainText("SEPA");
  const navigation = page.getByRole("navigation", { name: "工作台导航" });
  const systemGroup = navigation.getByRole("link", {
    name: "系统",
    exact: true,
  });
  await expect(systemGroup).toBeVisible();
  await expect(navigation.getByRole("link")).toHaveCount(6);
  await systemGroup.click();
  await expect(page).toHaveURL(/\/system$/);
  await expect(
    page.getByRole("button", { name: "扫描已保存目录", exact: true }),
  ).toBeEnabled();
  await openWorkspacePage(page, "证据分析");
  await expect(question).toHaveValue("P2 保留当前研究问题");
  await expect(
    page.getByRole("button", { name: "开始研究", exact: true }),
  ).toBeDisabled();
  expect(mutations.filter((path) => /\b(analyze|scan)\b/.test(path))).toEqual(
    [],
  );
});

test("settings read failure is recoverable and its draft survives navigation", async ({
  page,
}) => {
  let failStatus = true;
  const statusCalls: string[] = [];
  await page.route("**/api/trpc/**", async (route) => {
    const names =
      new URL(route.request().url()).pathname
        .split("/api/trpc/")[1]
        ?.split(",") ?? [];
    if (names.includes("status")) {
      statusCalls.push(route.request().url());
      if (failStatus) return route.abort("connectionrefused");
    }
    await route.continue();
  });
  await page.goto("/system/tasks", { waitUntil: "networkidle" });
  expect(statusCalls).toEqual([]);
  await openWorkspacePage(page, "数据与连接");
  await expect(
    page.getByRole("button", { name: "重试设置", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("通达信安装目录", { exact: true })).toHaveCount(
    0,
  );
  failStatus = false;
  await page.getByRole("button", { name: "重试设置", exact: true }).click();
  const directory = page.getByLabel("通达信安装目录", { exact: true });
  await expect(directory).toBeVisible();
  const saved = await directory.inputValue();
  await directory.fill(saved + "\\draft-only");
  await openWorkspacePage(page, "任务中心");
  const calls = statusCalls.length;
  await expect(page).toHaveURL("/system/tasks");
  await page.waitForLoadState("networkidle");
  expect(statusCalls).toHaveLength(calls);
  await openWorkspacePage(page, "数据与连接");
  await expect(directory).toHaveValue(saved + "\\draft-only");
  await directory.fill(saved);
});

test("market watchlist updates reach the monitor page and preserve chart selection", async ({
  page,
}) => {
  await page.goto("/scan?symbol=sh600000");
  const add = page.getByRole("button", { name: "加入自选", exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  await page.getByRole("button", { name: "自选与候选", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移除 sh600000", exact: true }),
  ).toBeVisible();
  await expect(add).toBeDisabled();
  await openWorkspacePage(page, "信号与通知");
  await page.getByRole("button", { name: "新建订阅", exact: true }).click();
  await expect(page.getByText(/本次将使用自选快照/)).toContainText("sh600000");
  await page.locator('a[href="/scan"]').first().click();
  await expect(page).toHaveURL(
    /\/scan\?(?:tab=formula&)?symbol=sh600000(?:&|$)/,
  );
  await page
    .getByRole("button", { name: "移除 sh600000", exact: true })
    .click();
  await expect(add).toBeEnabled();
  await openWorkspacePage(page, "信号与通知");
  // Ordinary routes close page-local dialogs when leaving. Reopen the form to
  // verify the fresh shared watchlist, rather than relying on hidden page DOM.
  await page.getByRole("button", { name: "新建订阅", exact: true }).click();
  await expect(page.getByText(/本次将使用自选快照/)).not.toContainText(
    "sh600000",
  );
});

test("retired research route is absent and unified alerts expose their real shadow mode", async ({
  page,
}) => {
  const oldCatalog = await page.request.get("/api/trpc/strategyLifecycle", {
    headers: trpcHeaders,
  });
  expect(oldCatalog.status()).toBe(404);
  const response = await page.goto("/research");
  expect(response?.status()).toBe(404);
  for (const path of [
    "/",
    "/lab",
    "/system/notifications",
    "/accounts/alerts",
    "/?tab=intraday",
  ]) {
    await page.goto(path);
    await expect(page.locator('a[href="/research"]')).toHaveCount(0);
    if (
      ["/system/notifications", "/accounts/alerts", "/?tab=intraday"].includes(
        path,
      )
    )
      await expect(
        page
          .getByRole("main")
          .getByText(/提醒引擎：影子/)
          .first(),
      ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "立即运行", exact: true }),
  ).toHaveCount(0);
});

test("task route renders filter controls and URL state in its initial HTML", async ({
  page,
  request,
}) => {
  for (const status of ["completed", "failed"]) {
    const id = `server-filter-${status}`;
    const response = await request.get(
      `/system/tasks?status=${status}&id=${id}`,
    );
    expect(response.ok()).toBe(true);
    const initial = await page.evaluate(
      (html) => {
        const document = new DOMParser().parseFromString(html, "text/html");
        return {
          type: !!document.querySelector(
            '[role="combobox"][aria-label="任务类型"]',
          ),
          status: !!document.querySelector(
            '[role="combobox"][aria-label="历史任务状态"]',
          ),
          id: document
            .querySelector('input[aria-label="精确任务编号"]')
            ?.getAttribute("value"),
          text: document.body.textContent,
        };
      },
      await response.text(),
    );
    expect(initial.type).toBe(true);
    expect(initial.status).toBe(true);
    expect(initial.id).toBe(id);
    expect(initial.text).toContain(
      `已应用：${status === "completed" ? "已完成" : "失败"}`,
    );
  }
});

test("task route restores URL filters and drafts without retaining a hidden task page", async ({
  page,
}) => {
  await page.goto("/system/tasks?status=completed");
  await expect(
    page.getByRole("status").filter({ hasText: "已应用：已完成" }),
  ).toBeVisible();
  await expect(page.getByLabel("历史任务状态")).toContainText("已完成");
  await page.getByLabel("精确任务编号").fill("unapplied-task-draft");
  await page.locator('a[href="/system"]').first().click();
  await expect(page).toHaveURL("/system");
  await expect(page.locator('[aria-label="任务列表"]')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL("/system/tasks?status=completed");
  await expect(page.getByLabel("精确任务编号")).toHaveValue(
    "unapplied-task-draft",
  );
  await page.reload();
  await expect(page.getByLabel("历史任务状态")).toContainText("已完成");
  await expect(page.getByLabel("精确任务编号")).toHaveValue("");
  await page.getByLabel("精确任务编号").fill("missing-task-route");
  await page.getByRole("button", { name: "查询任务", exact: true }).click();
  await expect(page).toHaveURL(
    "/system/tasks?status=completed&id=missing-task-route",
  );
  await expect(
    page.getByText("没有符合该状态的任务。可切换为全部查看。"),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/system/tasks?status=completed");
  await expect(
    page.getByRole("status").filter({ hasText: "已应用：已完成" }),
  ).not.toContainText("编号 missing-task-route");
  await page.goto("/system/tasks?status=unknown");
  await expect(
    page.getByText("任务筛选链接无效，请清除筛选后重试。"),
  ).toBeVisible();
  await expect(page.locator('[aria-label="任务列表"]')).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page).toHaveURL("/system/tasks");
  await expect(page.locator('[aria-label="任务列表"]')).toBeVisible();
});

test("overview uses its framework route and restores the ranking selection from URL", async ({
  page,
}) => {
  // Quotes are intentionally offline in this fixture. Never let this route
  // validation initiate an external TDX connection, even in a mixed batch.
  await page.route("**/api/trpc/**", async (route) => {
    const names =
      new URL(route.request().url()).pathname
        .split("/api/trpc/")[1]
        ?.split(",") ?? [];
    if (names.includes("tdxQuotes")) await route.abort("connectionrefused");
    else await route.continue();
  });
  await page.goto("/system/tasks");
  await expect(page.locator('[aria-label="任务列表"]')).toBeVisible();
  await page.locator('a[href="/"]').first().click();
  await page
    .getByRole("radio", { name: "市场与数据总览", exact: true })
    .click();
  const ranking = page.getByRole("radiogroup", {
    name: "RPS 口径",
    exact: true,
  });
  await expect(ranking).toBeVisible();
  await ranking.getByRole("radio", { name: "概念", exact: true }).click();
  await expect(page).toHaveURL("/?tab=overview&rank=concept");
  await expect(
    ranking.getByRole("radio", { name: "概念", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await openWorkspacePage(page, "任务中心");
  await expect(page).toHaveURL("/system/tasks");
  await expect(ranking).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL("/?tab=overview&rank=concept");
  await expect(
    ranking.getByRole("radio", { name: "概念", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(
    ranking.getByRole("radio", { name: "概念", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await ranking.getByRole("radio", { name: "行业", exact: true }).click();
  await expect(page).toHaveURL("/?tab=overview");
  await expect(
    ranking.getByRole("radio", { name: "行业", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});

test("R2b shadow history filters, exports and creates then cancels a staged plan", async ({
  page,
}, testInfo) => {
  const status = await page.request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  const settings = (await status.json()).result.data.json.settings;
  expect(settings.alerts.mode).toBe("shadow");
  const registration = await page.request.post(
    "/api/trpc/strategyLabRegister",
    {
      headers: trpcHeaders,
      data: {
        json: {
          id: "p0-r2b-alert",
          version: 1,
          market: "cn-equity",
          period: "day",
          universe: { kind: "symbols", symbols: ["sh600000"] },
          entry: { kind: "constant", value: false },
          exit: {},
          sizing: { kind: "weight", weight: 1 },
          sleeve: "swing",
        },
      },
    },
  );
  expect(registration.status()).toBe(200);
  const parent = await realpath(
    resolve(process.env.E2E_DATA_DIR ?? ".test-data/p0-acceptance"),
  );
  const directory = await realpath(resolve(settings.tdxRoot, ".."));
  expect(directory.startsWith(parent + sep)).toBe(true);
  const database = new Database(resolve(directory, "quant.sqlite"), {
    fileMustExist: true,
  });
  try {
    const insert = database.prepare(
      "INSERT INTO watch_events VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < 25; i++) {
      const bar = `2026-10-${String(i + 1).padStart(2, "0")}`;
      const key = JSON.stringify([
        "p0-r2b-alert",
        1,
        "cn-equity",
        "sh600000",
        bar,
      ]);
      const event = {
        key,
        strategyId: "p0-r2b-alert",
        version: 1,
        market: "cn-equity",
        symbol: "sh600000",
        bar,
        type: "entry",
        price: 10,
        sleeve: "swing",
        stop: 9,
        target: 13,
        observedAt: Date.now(),
        mode: "shadow",
        status: "shadow",
        wouldSend: true,
        outcomes: [],
        reason: "P0合成候选，不是真实行情信号",
        source: "QA fixture",
      };
      insert.run(
        key,
        event.strategyId,
        1,
        event.symbol,
        bar,
        event.type,
        10,
        "shadow",
        null,
        JSON.stringify(event),
      );
    }
    database
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(
        "alerts:exposure",
        "alert-state",
        JSON.stringify([
          {
            market: "cn-equity",
            sleeve: "__checked__",
            value: 0,
            at: Date.now(),
          },
        ]),
        Date.now(),
      );
    await page.goto("/system");
    await page.getByLabel("A股资金（元）", { exact: true }).fill("100000");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator('[data-settings-state="saved"]')).toBeVisible();
    await page.goto("/accounts/alerts");
    await expect(
      page
        .getByRole("main")
        .getByText(/提醒引擎：影子/)
        .first(),
    ).toBeVisible();
    await page.getByLabel("来源策略", { exact: true }).fill("p0-r2b-alert");
    const history = page.getByRole("region", { name: "提醒历史", exact: true });
    await expect(history).toContainText("25");
    await history.getByRole("button", { name: /下一页/ }).click();
    await expect(
      history.getByRole("button", { name: "加入计划", exact: true }),
    ).toHaveCount(5);
    const archive = await download(page, "导出提醒历史");
    expect(archive.items).toHaveLength(25);
    expect(
      archive.items.every((e: { mode: string }) => e.mode === "shadow"),
    ).toBe(true);
    await history
      .getByRole("button", { name: "加入计划", exact: true })
      .first()
      .click();
    await page.getByLabel("分批入场价（逗号分隔）").fill("10,11");
    await page.getByLabel("计划止损", { exact: true }).fill("9");
    await page.getByLabel("计划目标（可空）").fill("13");
    const future = new Date(Date.now() + 86400000);
    future.setMinutes(0);
    const local = new Date(
      future.getTime() - future.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16);
    await page.getByLabel("计划到期时间").fill(local);
    await page
      .getByRole("button", { name: "保存交易计划", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "交易计划已保存" }),
    ).toBeVisible();
    const plans = page.getByRole("region", { name: "交易计划", exact: true });
    await expect(plans).toContainText("700");
    await plans.getByRole("button", { name: "取消计划", exact: true }).click();
    await expect(plans).toContainText("已取消");
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("r2b-alert-history-1024.png"),
      fullPage: true,
    });
    expect(
      database
        .prepare("SELECT count(*) n FROM records WHERE kind='delivery'")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    database.close();
  }
});
