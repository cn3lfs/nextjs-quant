import { basename, dirname, join } from "node:path";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import {
  diagnoseArchiveDetailSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseScenarioMetrics,
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
};
const blockedError = "合成诊断数据缺少原始日线";
const sleeveIds = ["chan", "growth", "wyckoff", "volume"];
const archiveTitle = (id: string) => `合成诊断 · ${id}`;
const archiveHref = (id: string) => `/lab/backtest?archive=${id}`;

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
      trades: 11,
      fees: 100,
    },
    doubledCost: {
      return: 0.0987,
      excess: 0.04,
      drawdown: -0.06,
      sharpe: 0.9,
      trades: 11,
      fees: 200,
    },
    delayed: {
      return: 0.0654,
      excess: 0.03,
      drawdown: -0.07,
      sharpe: 0.8,
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
  const strategyKey = withDisclosures ? "core-4" : "dual-ma";
  const candidates = withDisclosures
    ? symbols.slice(0, 4)
    : symbols.slice(0, 1);
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
    ...(withDisclosures && { timeHoldout, sleeveAttribution }),
  };
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
      scenarios: ["strict"],
      statusCounts: {
        ok: blocked ? 0 : 1,
        blocked: blocked ? 1 : 0,
        zeroSignal: boundaryState === "zero-signal" ? 1 : 0,
        failed: 0,
      },
      driftWarnings: [],
      missingFiles: [],
    },
    cells: [
      {
        strategyKey,
        symbols: candidates,
        mode: withDisclosures ? "portfolio" : "per-symbol",
        start: "2020-01-01",
        end: "2026-10-12",
        scenarios: [metrics],
      },
    ],
    pagination: { page: 1, pageSize: 1, totalCells: 1 },
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
  "workspacePreferences",
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
        new Set(["saveWorkspacePreferences"]),
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
  const sleeves = page.getByTestId("diagnose-sleeve-attribution-card");
  await expect(sleeves).toBeVisible();
  for (const id of sleeveIds) await expect(sleeves).toContainText(id);
  await expect(sleeves).toContainText("相关性");
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
