import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import {
  diagnoseArchiveDetailSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseScenarioMetrics,
  type DiagnoseSleeveTrades,
  type DiagnoseTimeHoldoutResult,
  type SleeveAttribution,
} from "../../src/lib/research/diagnose-contract";
import { batchCandidatesToLabHref } from "../../src/lib/screening/screen-candidate-navigation";
import { fixtureDirectory } from "./fixture-directory";
import { trpcHeaders } from "./helpers";
import { installOfflineVisualApi } from "./offline-visual-api";

const symbols = Array.from({ length: 13 }, (_, i) => `sh${600000 + i}`);
const archiveIds = {
  ok: "lab-e2e-ok-1",
  compare: "lab-e2e-ok-2",
  zero: "lab-e2e-zero",
  blocked: "lab-e2e-blocked",
  missing: "lab-e2e-missing",
  export: "lab-e2e-export",
};
const blockedError = "合成诊断数据缺少原始日线";
const sleeveIds = ["chan", "growth", "wyckoff", "volume"];
const archiveTitle = (id: string) => `合成诊断 · ${id}`;
const archiveHref = (id: string) => `/lab/backtest?archive=${id}`;
const archiveFillSymbol = symbols[11]!;
const archiveFillDate = "2026-10-12";
const archiveFillScenario = "Clamp 成交样本";

const devLeg = {
  meanReturn: 0.03,
  meanSharpe: 0.8,
  worstDrawdown: -0.05,
  trades: 8,
};
const timeHoldout: DiagnoseTimeHoldoutResult = {
  status: "reviewed",
  classification: "historical-holdout-review",
  holdoutStart: "2023-01-01",
  disclosure: "合成样本的历史留出复核",
  reasons: [],
  statistics: {
    dsr: 0.96,
    dsrThreshold: 0.95,
    pbo: 0.15,
    effectiveTrials: 3,
    note: "合成试验",
  },
  passed: true,
  devWindowRange: { start: "2020-01-01", end: "2022-12-30", windowCount: 3 },
  devSummary: {
    windowCount: 3,
    positiveWindows: 3,
    base: devLeg,
    doubledCost: devLeg,
    delayed: devLeg,
  },
  holdoutRange: { start: "2023-01-01", end: "2026-10-12" },
  holdout: {
    base: {
      return: 0.1234,
      excess: 0.06,
      drawdown: -0.06,
      sharpe: 1,
      calmar: 0.82,
      trades: 11,
      fees: 100,
    },
    doubledCost: {
      return: 0.0987,
      excess: 0.04,
      drawdown: -0.06,
      sharpe: 0.9,
      calmar: 0.74,
      trades: 11,
      fees: 200,
    },
    delayed: {
      return: 0.0654,
      excess: 0.03,
      drawdown: -0.07,
      sharpe: 0.8,
      calmar: null,
      trades: 10,
      fees: 90,
    },
  },
};

const sleeveAttribution: SleeveAttribution = {
  sleeves: sleeveIds.map((id) => ({
    id,
    initialEquity: 25_000,
    finalEquity: 26_000,
    return: 0.04,
    maxDrawdown: -0.05,
    trades: 4,
    averageWeight: 0.25,
    drawdownContribution: 0.01,
  })),
  correlations: sleeveIds.flatMap((left, i) =>
    sleeveIds.slice(i + 1).map((right, j) => ({
      left,
      right,
      overlap: 80,
      correlation: 0.21 + (3 * i + j) * 0.01,
      reason: null,
    })),
  ),
  peakDate: "2024-04-01",
  troughDate: "2024-04-18",
  peakEquity: 105_000,
  troughEquity: 100_800,
  maxDrawdown: 0.04,
  contributionSum: 0.04,
  transferBasis: "合成峰谷归因",
};

const tradeMetrics: DiagnoseSleeveTrades["portfolio"] = {
  roundTrips: 4,
  winRate: 0.75,
  profitLossRatio: 1.25,
  profitFactor: 3.75,
  holdingPeriod: { p25: 2, p50: 4, p75: 6, p90: 7 },
  cashRatio: 0.1,
  oneSidedTurnover: 0.37,
  costs: {
    commission: 7,
    stampDuty: 5,
    transferFee: 2,
    slippage: null,
    slippageMissingFills: 1,
    totalFees: 14,
  },
};

function archiveFixture(
  id: string,
  boundaryState: Exclude<
    DiagnoseArchiveDetail["boundaryState"],
    "missing-files"
  >,
) {
  const ok = boundaryState === "ok";
  const blocked = boundaryState === "blocked";
  const withDisclosures = id === archiveIds.ok;
  const exportFixture = id === archiveIds.export;
  const cellCount = exportFixture ? 12 : 1;
  const strategyKey = withDisclosures ? "core-4" : "dual-ma";
  const candidates = symbols.slice(0, withDisclosures ? 4 : cellCount);
  const metrics: DiagnoseScenarioMetrics = {
    scenarioId: "strict",
    label: "Strict 基线",
    executionProfile: "strict",
    maxParticipation: null,
    capacityPolicy: null,
    capacityActive: false,
    status: blocked ? "blocked" : "ok",
    ...(blocked && { layer: "data", error: blockedError }),
    counts: {
      bars: blocked ? 0 : 120,
      warmup: blocked ? 0 : 25,
      signals: ok ? 16 : 0,
      orders: ok ? 16 : 0,
      fills: ok ? 16 : 0,
      rejections: 0,
      closedTrades: ok ? 8 : 0,
    },
    rejectionReasons: [],
    totalFees: ok ? 16 : null,
    totalReturn: ok ? 0.04 : null,
    maxDrawdown: ok ? -0.04 : null,
    checks: [],
    findings: [],
    sampleOrders: [],
    sampleFills: [],
    sampleRejections: [],
    ...(withDisclosures && {
      timeHoldout,
      sleeveAttribution,
      sessionEvidence: {
        symbolSuspensionDays: 6,
        portfolioAffectedDays: 4,
        unknownDays: 2,
        certificates: [],
      },
      familyHoldout: {
        family: "CH14",
        pbo: 0.125,
        dsr: 0.96,
        dsrThreshold: 0.95,
        effectiveTrials: 2,
        rawCandidateCount: 4,
        clusters: [["CH14-a", "CH14-b"], ["CH14-c"]],
        excluded: [{ id: "CH14-d", reason: "开发期证据缺失" }],
      },
      sleeveInvestment: {
        sleeves: sleeveIds.map((id) => ({
          id,
          investmentReturn: 0.0231,
          investmentMaxDrawdown: -0.04,
          tradingPnlContribution: 580,
          dailyInvestmentReturns: [],
        })),
        correlations: sleeveAttribution.correlations.map(
          ({ left, right, overlap, correlation }) => ({
            left,
            right,
            overlap,
            correlation: correlation!,
            reason: null,
          }),
        ),
      },
      sleeveTrades: {
        portfolio: tradeMetrics,
        sleeves: sleeveIds.map((id) => ({ id, ...tradeMetrics })),
      },
    }),
  };
  const fillScenario: DiagnoseScenarioMetrics = {
    ...metrics,
    scenarioId: "clamp",
    label: archiveFillScenario,
    executionProfile: "clamp",
    sampleFills: [
      {
        symbol: archiveFillSymbol,
        strategyId: strategyKey,
        sleeve: "main",
        side: "buy",
        signalAt: archiveFillDate,
        orderId: 1,
        date: archiveFillDate,
        price: 10,
        quantity: 100,
        fee: 1,
        cashAfter: 8999,
        holdingAfter: 100,
      },
    ],
  };
  const cells = Array.from({ length: cellCount }, (_, index) => ({
    strategyKey,
    symbols: exportFixture ? [candidates[index]!] : candidates,
    mode: withDisclosures ? "portfolio" : "per-symbol",
    start: "2020-01-01",
    end: "2026-10-12",
    scenarios:
      exportFixture && candidates[index] === archiveFillSymbol
        ? [metrics, fillScenario]
        : [metrics],
  }));
  const scenarioCount = cells.reduce(
    (sum, cell) => sum + cell.scenarios.length,
    0,
  );
  return diagnoseArchiveDetailSchema.parse({
    summary: {
      id,
      source: "lab-archive",
      title: archiveTitle(id),
      generatedAt: "2026-11-24T00:00:00.000Z",
      ...(withDisclosures && {
        bookPreset: "core-4",
        holdoutStart: timeHoldout.holdoutStart,
      }),
      strategyKeys: [strategyKey],
      symbols: candidates,
      scenarios: exportFixture ? ["strict", "clamp"] : ["strict"],
      statusCounts: {
        ok: blocked ? 0 : scenarioCount,
        blocked: blocked ? scenarioCount : 0,
        zeroSignal: boundaryState === "zero-signal" ? scenarioCount : 0,
        failed: 0,
      },
      driftWarnings: [],
      missingFiles: [],
    },
    cells,
    pagination: {
      page: 1,
      pageSize: 1,
      totalCells: cellCount,
    },
    boundaryState,
  });
}

// The ordinary workbench guard still handles the scan and shell requests.
// Archive reads reach the real fixture filesystem through tRPC. Preferences
// is also a local read, issued by the workbench shell on every entry.
const additionalLocalReads = new Set([
  "strategyLabDiagnoseArchives",
  "strategyLabDiagnoseArchiveDetail",
  "strategyLabDiagnoseCompare",
  "strategyLabDiagnoseExport",
  "strategyLabDiagnoseResult",
  "workspacePreferences",
  "simAccountsList",
]);
const localLabReads = new Set([
  "status",
  "jobs",
  "taskOverview",
  "alertStatus",
  "monitorWorkspaceSummary",
  "maBaselineHistory",
  "maBaselineCoverage",
  "strategyLab",
  "strategyLabDetail",
  "localDailyAsOf",
  "securityNames",
  "todayWorkspace",
  "workspaceCandidates",
  "accountMonthlyReview",
]);
const test = base.extend<{ offlineGuard: void }>({
  offlineGuard: [
    async ({ page }, use) => {
      const offline = await installOfflineVisualApi(
        page,
        new Set(),
        (data, input) => {
          const rows = symbols
            .filter((symbol) => symbol.includes(input.search ?? ""))
            .map((symbol, i) => ({
              symbol,
              name: `合成候选 ${i + 1}`,
              localDay: true,
              value: { rank: i + 1, rps: 99 - i, return: 0.1 },
              reason: null,
            }));
          return {
            ...data,
            total: rows.length,
            rows,
            availability: { ...data.availability, rps: "ready" },
            rps: {
              date: "2026-10-12",
              mode: "forward",
              count: rows.length,
              inputHash: "lab-e2e-rps",
              observation: null,
            },
          };
        },
        new Set(["saveWorkspacePreferences", "strategyLabDiagnoseRun"]),
      );
      await page.route("**/api/trpc/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const names = decodeURIComponent(
          url.pathname.split("/api/trpc/")[1] ?? "",
        ).split(",");
        if (
          url.origin === new URL(page.url()).origin &&
          request.method() === "GET" &&
          names.some((name) => additionalLocalReads.has(name)) &&
          names.every(
            (name) => additionalLocalReads.has(name) || localLabReads.has(name),
          )
        ) {
          return route.continue();
        }
        return route.fallback();
      });
      await use();
      expect([...offline.unknown], "Unclassified application requests").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

const ownedArchives: string[] = [];
test.beforeAll(async ({ request }, testInfo) => {
  // E2E_DATA_DIR is the parent. p0-server creates a fresh fixture-* child,
  // and status identifies the exact server that Playwright just started.
  const response = await request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  expect(response.ok()).toBe(true);
  const tdxRoot = (await response.json()).result.data.json.settings
    .tdxRoot as string;
  const fixtureRoot = fixtureDirectory(dirname(tdxRoot));
  expect(basename(tdxRoot)).toBe("tdx");
  expect(basename(fixtureRoot)).toMatch(/^fixture-/);
  expect(dirname(fixtureRoot)).toBe(dirname(testInfo.project.outputDir));
  const root = fixtureDirectory(join(fixtureRoot, "diagnose-archives"));
  await mkdir(root, { recursive: true });
  const fixtures = [
    [archiveIds.ok, "ok"],
    [archiveIds.compare, "ok"],
    [archiveIds.zero, "zero-signal"],
    [archiveIds.blocked, "blocked"],
    [archiveIds.missing, "missing-files"],
    [archiveIds.export, "ok"],
  ] as const;
  for (const [id, boundary] of fixtures) {
    const directory = fixtureDirectory(join(root, id));
    await mkdir(directory);
    ownedArchives.push(directory);
    if (boundary !== "missing-files")
      await writeFile(
        join(directory, "diagnose-group.json"),
        JSON.stringify(archiveFixture(id, boundary)),
        { flag: "wx" },
      );
  }
});

test.afterAll(async () => {
  await Promise.all(
    ownedArchives.splice(0).map(async (directory) => {
      fixtureDirectory(directory);
      await unlink(join(directory, "diagnose-group.json")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await rmdir(directory);
    }),
  );
});

test("archive deep link opens holdout and four-sleeve evidence and compares two archives", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.ok));
  const holdout = page.getByTestId("diagnose-time-holdout-card");
  await expect(holdout).toBeVisible();
  await expect(holdout).toContainText("历史留出复核");
  for (const value of ["12.34%", "9.87%", "6.54%"])
    await expect(holdout).toContainText(value);
  await expect(holdout.getByRole("row", { name: /Calmar/ })).toHaveText(
    /Calmar\s*0\.82\s*0\.74\s*—/,
  );
  await expect(holdout).toContainText(
    "标的停牌 6 标的日 · 组合受影响 4 日 · 未知日数 2",
  );
  await expect(holdout).toContainText("PBO(Sharpe) 0.125");
  await holdout.getByText("聚类成员（2 组）", { exact: true }).click();
  await expect(
    holdout.getByText("CH14-a、CH14-b", { exact: true }),
  ).toBeVisible();
  await holdout.getByText("排除原因（1 项）", { exact: true }).click();
  await expect(
    holdout.getByText("CH14-d · 开发期证据缺失", { exact: true }),
  ).toBeVisible();
  const sleeves = page.getByTestId("diagnose-sleeve-attribution-card");
  await expect(sleeves).toBeVisible();
  for (const id of sleeveIds) await expect(sleeves).toContainText(id);
  await expect(sleeves).toContainText("相关性");
  await expect(sleeves).toContainText("+2.31%");
  await expect(sleeves).toContainText("3.75");
  await expect(sleeves).toContainText("缺 1 笔");
  for (const { correlation } of sleeveAttribution.correlations)
    await expect(sleeves).toContainText(correlation!.toFixed(2));

  await page.getByRole("combobox", { name: "诊断归档来源" }).click();
  await page.getByRole("option", { name: "Lab 诊断运行", exact: true }).click();
  await page.getByRole("button", { name: "应用筛选", exact: true }).click();
  await page.getByTestId(`diagnose-compare-toggle-${archiveIds.ok}`).click();
  await page
    .getByTestId(`diagnose-compare-toggle-${archiveIds.compare}`)
    .click();
  await page.getByTestId("diagnose-compare-open").click();
  const compare = page.getByTestId("diagnose-compare-panel");
  await expect(compare).toBeVisible();
  await expect(compare).toContainText(archiveTitle(archiveIds.ok));
  await expect(compare).toContainText(archiveTitle(archiveIds.compare));
});

test("a zero-signal deep link explains the zero fills without presenting a successful return", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.zero));
  const evidence = page.getByRole("region", { name: "执行情景对比" });
  await expect(evidence.getByText("零信号", { exact: true })).toBeVisible();
  await expect(evidence).toContainText("窗口内无规则信号");
  await expect(evidence).toContainText("当前样本 0 成交");
  await expect(evidence).not.toContainText(/\d(?:\.\d+)?%/);
});

test("a blocked deep link identifies the failed layer and reason", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.blocked));
  const evidence = page.getByRole("region", { name: "执行情景对比" });
  await expect(
    evidence.getByText("阻断", { exact: true }).first(),
  ).toBeVisible();
  await expect(evidence.getByRole("alert")).toContainText(
    `data · ${blockedError}`,
  );
});

test("an archive with a missing group file remains inspectable", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.missing));
  const evidence = page.getByRole("region", { name: "执行情景对比" });
  await expect(evidence.getByText("产物缺失", { exact: true })).toBeVisible();
  await expect(evidence.getByRole("alert")).toContainText(
    "diagnose-group.json",
  );
});

const diagnosisSymbols = (page: Page) =>
  page.locator(
    '[data-testid="diagnose-run-symbols"]:is(input,textarea), [data-testid="diagnose-run-symbols"] :is(input,textarea)',
  );
async function expectDiagnosisSymbols(page: Page, expected: string[]) {
  const field = diagnosisSymbols(page);
  await expect(field).toBeVisible();
  await expect
    .poll(async () => (await field.inputValue()).trim().split(/[\s,，]+/))
    .toEqual(expected);
}

test("RPS batch handoff preserves the existing KeepAlive object draft", async ({
  page,
}) => {
  await page.goto("/lab/backtest?mode=object");
  await page.locator('[data-lab-ready="true"]').waitFor();
  const start = page.getByLabel("对象回测开始日期", { exact: true });
  const draftDate = "2022-04-08";
  await start.fill(draftDate);
  const draft = page.getByLabel("回测策略对象", { exact: true });
  const draftJson = (await draft.inputValue()).replace(/^(\s*\{)/, "$1\n  ");
  await draft.fill(draftJson);
  await expect(draft).toHaveValue(draftJson);

  const rpsLink = page.locator('a[href="/scan?tab=rps"]').first();
  if (!(await rpsLink.isVisible()))
    await page.getByRole("button", { name: "选股筛选", exact: true }).click();
  await rpsLink.click();
  await expect(page).toHaveURL(/\/scan\?tab=rps$/);
  const table = page.getByRole("table", { name: "个股RPS排名", exact: true });
  const checkbox = (symbol: string) =>
    table.getByRole("checkbox", { name: `选择 ${symbol}`, exact: true });
  const batch = (count: number) =>
    page.getByRole("button", {
      name: `批量带入组合诊断 (${count}/12)`,
      exact: true,
    });
  await expect(batch(0)).toBeDisabled();
  for (const symbol of symbols.slice(0, 12)) await checkbox(symbol).click();
  await expect(batch(12)).toBeEnabled();
  await expect(checkbox(symbols[12]!)).toBeDisabled();
  await expect(table).toContainText("组合诊断单次最多选择 12 只标的");
  await page.getByRole("button", { name: "清空已选", exact: true }).click();
  await expect(batch(0)).toBeDisabled();
  const expected = symbols.slice(0, 2);
  await checkbox(expected[0]!).click();
  await page.getByLabel("搜索股票代码或名称").fill("60000");
  await expect(batch(0)).toBeDisabled();
  await expect(checkbox(expected[0]!)).not.toBeChecked();
  for (const symbol of expected) await checkbox(symbol).click();
  await batch(2).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/lab/backtest" &&
      url.searchParams.get("scope") === "portfolio-diagnose" &&
      url.searchParams.get("returnTo") ===
        "/scan?tab=rps&period=50&search=60000",
  );
  await expectDiagnosisSymbols(page, expected);
  await expect(start).toHaveValue(draftDate);
  await expect(draft).toHaveValue(draftJson);
});

test("13 unique candidates plus a duplicate prefill exactly the first 12 symbols", async ({
  page,
}) => {
  const handoff = batchCandidatesToLabHref({
    symbols: [symbols[0]!, ...symbols],
    handoffSource: "rps",
    frozenDate: "2026-10-12",
    returnTo: "/scan?tab=rps",
  });
  expect(handoff?.truncatedCount).toBe(1);
  await page.goto(handoff!.href);
  await expectDiagnosisSymbols(page, symbols.slice(0, 12));
});

test("custom sleeves validate, save a local preset, run a real job and restore its archived parameters", async ({
  page,
}) => {
  await page.goto("/lab/backtest");
  const workspace = page.getByRole("region", { name: "诊断工作台" });
  const openCustom = async () => {
    await workspace.getByRole("tab", { name: "成组情景诊断运行" }).click();
    await workspace.getByRole("combobox", { name: "诊断模式" }).click();
    await page.getByRole("option", { name: "自定义组合（2–6 策略）" }).click();
  };
  await openCustom();
  const add = workspace.getByRole("button", { name: "添加分仓" });
  const remove = (index: number) =>
    workspace.getByRole("button", { name: `移除分仓 ${index}`, exact: true });
  const strategy = (index: number) =>
    workspace.getByLabel(`分仓 ${index} 策略键`, { exact: true });
  const weight = (index: number) =>
    workspace.getByLabel(`分仓 ${index} 权重`, { exact: true });
  await expect(remove(1)).toBeDisabled();
  for (let i = 2; i < 6; i++) await add.click();
  await expect(add).toBeDisabled();
  for (let i = 6; i > 2; i--) await remove(i).click();

  await strategy(1).fill("dual-ma");
  await strategy(2).fill("unknown-strategy-key");
  await expect(workspace.getByText(/请检查分仓策略键与分仓编号/)).toBeVisible();
  await strategy(2).fill("double-breakout");
  await weight(1).fill("0.4");
  await expect(workspace.getByText(/权重合计 90\.00%/)).toBeVisible();
  const confirm = workspace.getByRole("checkbox", { name: /确认以诊断专用/ });
  await confirm.click();
  const run = workspace.getByRole("button", { name: "运行成组情景诊断" });
  await expect(run).toBeDisabled();
  await workspace.getByRole("button", { name: "均分权重" }).click();
  await expect(weight(1)).toHaveValue("0.5");
  await expect(weight(2)).toHaveValue("0.5");
  await expect(run).toBeEnabled();

  await workspace.getByLabel("本地组合预设名称").fill("双策略预设");
  await workspace.getByRole("button", { name: "保存本地预设" }).click();
  await page.reload();
  await openCustom();
  await workspace.getByRole("combobox", { name: "本地组合预设" }).click();
  await page.getByRole("option", { name: "双策略预设" }).click();
  await workspace.getByRole("button", { name: "加载本地预设" }).click();
  await expect(strategy(1)).toHaveValue("dual-ma");
  await expect(strategy(2)).toHaveValue("double-breakout");
  await workspace.getByRole("button", { name: "删除本地预设" }).click();
  await expect(
    workspace.getByRole("combobox", { name: "本地组合预设" }),
  ).toHaveText("本地预设 (0/5)");

  await diagnosisSymbols(page).fill("sh600000, sh600001");
  await weight(1).fill("0.4");
  await weight(2).fill("0.6");
  await workspace.getByLabel("诊断开始日期").fill("2024-01-02");
  await workspace.getByLabel("诊断结束日期").fill("2024-09-30");
  await workspace.getByLabel("诊断独立本金").fill("123456");
  const costs = workspace.getByRole("combobox", { name: "诊断成本情景" });
  await costs.click();
  await page.getByRole("option", { name: "base · 历史印花税" }).click();
  await workspace.getByRole("checkbox", { name: "Clamp 滑点钳位" }).click();
  await workspace.getByRole("checkbox", { name: "0.5% 容量裁剪" }).click();
  await confirm.click();
  await run.click();
  const receipt = workspace.getByTestId("diagnose-run-receipt");
  await expect(receipt).toContainText(/诊断完成.*归档 lab-/s, {
    timeout: 60_000,
  });
  await receipt.getByRole("button", { name: "查看归档" }).click();
  const rerun = workspace.getByRole("button", { name: "用相同参数复跑" });
  await rerun.click();
  await expect(workspace.getByText(/复跑参数来自归档/)).toBeVisible();
  await expectDiagnosisSymbols(page, ["sh600000", "sh600001"]);
  await expect(
    workspace.getByRole("combobox", { name: "诊断模式" }),
  ).toHaveText("自定义组合（2–6 策略）");
  await expect(strategy(1)).toHaveValue("dual-ma");
  await expect(strategy(2)).toHaveValue("double-breakout");
  await expect(weight(1)).toHaveValue("0.4");
  await expect(weight(2)).toHaveValue("0.6");
  await expect(workspace.getByLabel("诊断开始日期")).toHaveValue("2024-01-02");
  await expect(workspace.getByLabel("诊断结束日期")).toHaveValue("2024-09-30");
  await expect(workspace.getByLabel("诊断独立本金")).toHaveValue("123456");
  await expect(costs).toHaveText("base · 历史印花税");
  await expect(
    workspace.getByRole("checkbox", { name: "Strict 基线" }),
  ).toBeChecked();
  await expect(
    workspace.getByRole("checkbox", { name: "Clamp 滑点钳位" }),
  ).not.toBeChecked();
  await expect(confirm).not.toBeChecked();
});

test("a legacy archive explicitly requests missing rerun parameters", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.compare));
  await page.getByRole("button", { name: "用相同参数复跑" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "未记录，需重填" }),
  ).toContainText("本金、成本情景");
  await expect(diagnosisSymbols(page)).toHaveValue("");
  await expect(page.getByLabel("诊断开始日期")).toHaveValue("");
  await expect(page.getByLabel("诊断独立本金")).toHaveValue("");
});

test("archive downloads Markdown and all twelve JSON cells from a paginated archive", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.export));
  const workspace = page.getByRole("region", { name: "诊断工作台" });
  await expect(workspace.getByText("第 1 / 2 页 · 共 12 个单元")).toBeVisible();
  const download = async (label: string, extension: string) => {
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      workspace.getByRole("button", { name: label, exact: true }).click(),
    ]);
    expect(file.suggestedFilename()).toBe(`${archiveIds.export}.${extension}`);
    expect(await file.failure()).toBeNull();
    return readFile(await file.path(), "utf8");
  };
  const markdown = await download("导出 Markdown", "md");
  expect(markdown).toContain("## 归档信息");
  expect(markdown).toContain(archiveTitle(archiveIds.export));
  expect(markdown).toContain(archiveFillSymbol);
  const json = JSON.parse(await download("导出全量 JSON", "json"));
  expect(json.summary.id).toBe(archiveIds.export);
  expect(
    json.allCells.map((cell: { symbols: string[] }) => cell.symbols[0]),
  ).toEqual(symbols.slice(0, 12));
  await expect(
    workspace.getByRole("button", { name: /删除|移除|清理|清除归档/ }),
  ).toHaveCount(0);
  await expect(workspace.getByRole("alert")).toHaveCount(0);
});

test("Back from an archive fill preserves page two, the selected cell and the selected scenario", async ({
  page,
}) => {
  await page.goto(archiveHref(archiveIds.export));
  const workspace = page.getByRole("region", { name: "诊断工作台" });
  const secondPage = workspace.getByText("第 2 / 2 页 · 共 12 个单元");
  await workspace.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(secondPage).toBeVisible();
  const cell = workspace.getByRole("button", {
    name: `dual-ma · ${archiveFillSymbol} · per-symbol`,
    exact: true,
  });
  const scenario = workspace.getByRole("button", {
    name: archiveFillScenario,
    exact: true,
  });
  const fill = workspace.getByRole("button", {
    name: `看K线 ${archiveFillSymbol} ${archiveFillDate}`,
    exact: true,
  });
  await cell.click();
  await scenario.click();
  await fill.click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/scan" &&
      url.searchParams.get("diagnose") === archiveIds.export &&
      url.searchParams.get("cell") === "11" &&
      url.searchParams.get("scenario") === "clamp",
  );
  await expect(workspace).toBeHidden();

  await page.goBack();
  await expect(page).toHaveURL(archiveHref(archiveIds.export));
  await expect(secondPage).toBeVisible();
  await expect(cell).toHaveAttribute("aria-pressed", "true");
  await expect(scenario).toHaveAttribute("aria-pressed", "true");
  await expect(fill).toBeVisible();
});

for (const source of ["watchlist", "pool"] as const) {
  test(`${source} row selection caps at twelve and passes the selected symbols to the Lab`, async ({
    page,
    request,
  }) => {
    if (source === "watchlist") {
      const groups = await request.get("/api/trpc/watchlistGroups", {
        headers: trpcHeaders,
      });
      expect(groups.ok()).toBe(true);
      const { defaultGroupId } = (await groups.json()).result.data.json;
      const seeded = await request.post("/api/trpc/watchlistGroupSetSymbols", {
        headers: trpcHeaders,
        data: { json: { groupId: defaultGroupId, symbols } },
      });
      expect(seeded.ok()).toBe(true);
    }
    await page.goto(`/scan?tab=${source}`);
    const table = page.getByRole("table", {
      name: source === "watchlist" ? "我的自选列表" : "股票池成分",
    });
    const choose = (index: number) =>
      table.getByRole("checkbox", {
        name: `选择 ${symbols[index]}`,
        exact: true,
      });
    await expect(
      page.getByRole("button", { name: "批量带入组合诊断 (0/12)" }),
    ).toBeDisabled();
    for (let index = 0; index < 12; index++) await choose(index).click();
    await expect(choose(12)).toBeDisabled();
    await expect(
      page.getByText("组合诊断单次最多选择 12 只标的", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "批量带入组合诊断 (12/12)" })
      .click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/lab/backtest" &&
        url.searchParams.get("handoffSource") === source &&
        url.searchParams.get("returnTo") === `/scan?tab=${source}`,
    );
    await expectDiagnosisSymbols(page, symbols.slice(0, 12));
  });
}

test("monthly review brings its fixture A-share rounds from accounts to portfolio diagnose", async ({
  page,
}) => {
  await page.goto("/accounts?tab=monthly");
  // The server-rendered month input is visible before React can handle edits.
  await expect(
    page.getByText(/回合计数覆盖沪深真实\/手工/).filter({ visible: true }),
  ).toBeVisible({ timeout: 30_000 });
  const month = page.getByLabel("自查月份").filter({ visible: true });
  await month.fill("2019-01");
  await expect(month).toHaveValue("2019-01");
  const link = page
    .getByTestId("monthly-review-diagnose-link")
    .filter({ visible: true });
  await expect(link).toHaveText("用当月标的跑组合诊断（12 只）", {
    timeout: 30_000,
  });
  await link.click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/lab/backtest" &&
      url.searchParams.get("handoffSource") === "account-review" &&
      url.searchParams.get("scope") === "portfolio-diagnose",
  );
  await expect(diagnosisSymbols(page)).toBeVisible();
  const selected = (await diagnosisSymbols(page).inputValue()).split(", ");
  expect(new Set(selected).size).toBe(12);
  expect(selected.every((symbol) => /^sh60\d{4}$/.test(symbol))).toBe(true);
});

test("single-symbol overwrite confirms explicitly and a mixed URL retains the edited diagnose form", async ({
  page,
}) => {
  await page.goto("/lab/backtest?mode=object");
  await page.locator('[data-lab-ready="true"]').waitFor();
  const start = page.getByLabel("对象回测开始日期", { exact: true });
  await start.fill("2022-04-08");
  const rpsLink = page.locator('a[href="/scan?tab=rps"]').first();
  if (!(await rpsLink.isVisible()))
    await page.getByRole("button", { name: "选股筛选", exact: true }).click();
  await rpsLink.click();
  await page
    .getByRole("link", { name: "带入回测", exact: true })
    .first()
    .click();
  const preview = page.getByRole("region", { name: "扫描候选交接预览" });
  const apply = preview.getByRole("button", { name: "应用到回测草稿" });
  await apply.click();
  await expect(preview.getByRole("alert")).toHaveText(
    "当前对象回测草稿有未保存修改，确认覆盖？",
  );
  await expect(start).toHaveValue("2022-04-08");
  await preview.getByRole("button", { name: "取消" }).click();
  await expect(start).toHaveValue("2022-04-08");
  await apply.click();
  await preview.getByRole("button", { name: "确认覆盖草稿" }).click();
  await expect(start).toHaveValue("2025-10-12");

  const firstBatch = batchCandidatesToLabHref({
    symbols: symbols.slice(0, 2),
    handoffSource: "rps",
    frozenDate: "2026-10-12",
    returnTo: "/scan?tab=rps",
  })!;
  const mixedHref = `${firstBatch.href}&archive=${archiveIds.ok}`;
  await page.evaluate((href) => history.pushState(null, "", href), mixedHref);
  await expectDiagnosisSymbols(page, symbols.slice(0, 2));
  await diagnosisSymbols(page).fill(symbols[3]!);
  await page.getByRole("link", { name: "返回原筛选列表" }).click();
  await expect(page).toHaveURL(/\/scan\?tab=rps$/);
  await page.goBack();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("archive") === archiveIds.ok,
  );
  await expectDiagnosisSymbols(page, [symbols[3]!]);
  await expect(
    page.getByRole("button", { name: "确认覆盖诊断草稿" }),
  ).toHaveCount(0);

  const secondBatch = batchCandidatesToLabHref({
    symbols: symbols.slice(4, 6),
    handoffSource: "rps",
  })!;
  await page.evaluate(
    (href) => history.pushState(null, "", href),
    secondBatch.href,
  );
  await expectDiagnosisSymbols(page, [symbols[3]!]);
  await page.getByRole("button", { name: "确认覆盖诊断草稿" }).click();
  await expectDiagnosisSymbols(page, symbols.slice(4, 6));
});

test("Today polls its main query with the recent archive card collapsed and queries archives only on expansion", async ({
  page,
}) => {
  const requests: string[][] = [];
  page.on("request", (request) => {
    const endpoint = new URL(request.url()).pathname.split("/api/trpc/")[1];
    if (endpoint) requests.push(decodeURIComponent(endpoint).split(","));
  });
  await page.clock.install();
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "最近诊断归档" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("group", { name: "今日交易摘要" })).toBeVisible({
    timeout: 20_000,
  });
  const todayRequests = () =>
    requests.filter((names) => names.includes("todayWorkspace")).length;
  await expect.poll(todayRequests).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward(31_000);
  await expect.poll(todayRequests).toBeGreaterThanOrEqual(2);
  expect(requests.flat()).not.toContain("strategyLabDiagnoseArchives");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() =>
      requests.some((names) => names.includes("strategyLabDiagnoseArchives")),
    )
    .toBe(true);
  const archive = page.locator(
    `#today-diagnose-archives a[href="${archiveHref(archiveIds.ok)}"]`,
  );
  await expect(archive).toHaveText(archiveTitle(archiveIds.ok), {
    timeout: 20_000,
  });
  await archive.click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/lab/backtest" &&
      url.searchParams.get("archive") === archiveIds.ok,
  );
  await expect(page.getByTestId("diagnose-time-holdout-card")).toBeVisible();
});
