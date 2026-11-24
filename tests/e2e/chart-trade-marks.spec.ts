import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  diagnoseArchiveDetailSchema,
  type DiagnoseScenarioMetrics,
} from "../../src/lib/research/diagnose-contract";
import type { Bar } from "../../src/lib/domain";
import { fixtureDirectory } from "./fixture-directory";
import { trpcHeaders } from "./helpers";
import { installOfflineVisualApi } from "./offline-visual-api";

const archiveId = "lab-chart-marks-e2e";
const title = "合成诊断 · K 线成交复盘";
const scenarioLabel = "Clamp 成交复盘";
const symbol = "sh600000";
const daily = JSON.parse(
  readFileSync(
    new URL("../fixtures/breakout-valid.json", import.meta.url),
    "utf8",
  ),
) as { bars: Bar[] };
const at = daily.bars[95]!.date;
const stopAt = daily.bars[105]!.date;

function archiveFixture() {
  const identity = {
    symbol,
    strategyId: "dual-ma",
    sleeve: "main",
    signalAt: at,
  };
  const sampleFills = [
    {
      ...identity,
      side: "buy" as const,
      orderId: 1,
      date: at,
      price: 10,
      quantity: 100,
      fee: 1,
      cashAfter: 8999,
      holdingAfter: 100,
    },
    {
      ...identity,
      side: "sell" as const,
      orderId: 2,
      date: stopAt,
      price: 9,
      quantity: 100,
      fee: 1,
      cashAfter: 9898,
      holdingAfter: 0,
    },
  ];
  const scenario: DiagnoseScenarioMetrics = {
    scenarioId: "clamp",
    label: scenarioLabel,
    executionProfile: "clamp",
    maxParticipation: null,
    capacityPolicy: null,
    capacityActive: false,
    status: "ok",
    counts: {
      bars: daily.bars.length,
      warmup: 0,
      signals: 2,
      orders: 2,
      fills: 2,
      rejections: 0,
      closedTrades: 1,
    },
    rejectionReasons: [],
    totalFees: 2,
    totalReturn: -0.0102,
    maxDrawdown: -0.0102,
    checks: [],
    findings: [],
    sampleOrders: sampleFills.map((fill) => ({
      ...identity,
      id: fill.orderId,
      side: fill.side,
      due: fill.date,
      status: "filled",
      reason: null,
      attempts: 1,
      trigger: fill.side === "sell" ? "stop" : "signal",
    })),
    sampleFills,
    sampleRejections: [],
  };
  return diagnoseArchiveDetailSchema.parse({
    summary: {
      id: archiveId,
      source: "lab-archive",
      title,
      generatedAt: "2026-11-24T00:00:00.000Z",
      strategyKeys: ["dual-ma"],
      symbols: [symbol],
      scenarios: ["strict", "clamp"],
      statusCounts: { ok: 1, blocked: 0, zeroSignal: 0, failed: 0 },
      driftWarnings: [],
      missingFiles: [],
    },
    cells: [
      {
        strategyKey: "dual-ma",
        symbols: [symbol],
        mode: "per-symbol",
        start: daily.bars[0]!.date,
        end: daily.bars.at(-1)!.date,
        scenarios: [
          {
            ...scenario,
            scenarioId: "strict",
            label: "Strict 基线",
            executionProfile: "strict",
            sampleOrders: [],
            sampleFills: [],
          },
          scenario,
        ],
      },
    ],
    pagination: { page: 1, pageSize: 1, totalCells: 1 },
    boundaryState: "ok",
  });
}

const localArchiveReads = new Set([
  "strategyLabDiagnoseArchives",
  "strategyLabDiagnoseArchiveDetail",
  "workspacePreferences",
  "simAccountsList",
]);
const otherLocalReads = new Set([
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
  "chartBars",
  "chartView",
  "chartPosition",
  "chartSharedDrawings",
  "rpsCurve",
  "czscSchema",
  "czsc",
  "breakout",
  "intelEvents",
]);
async function allowArchiveReads(page: Page) {
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const names = decodeURIComponent(
      url.pathname.split("/api/trpc/")[1] ?? "",
    ).split(",");
    if (
      request.method() === "GET" &&
      url.origin === new URL(page.url()).origin &&
      names.some((name) => localArchiveReads.has(name)) &&
      names.every(
        (name) => localArchiveReads.has(name) || otherLocalReads.has(name),
      )
    )
      return route.continue();
    return route.fallback();
  });
}

test("archive fill opens the main chart and preserves the selected scenario on Back", async ({
  page,
  request,
}, testInfo) => {
  const status = await request.get("/api/trpc/status", {
    headers: trpcHeaders,
  });
  expect(status.ok()).toBe(true);
  const tdxRoot = (await status.json()).result.data.json.settings
    .tdxRoot as string;
  const fixtureRoot = fixtureDirectory(dirname(tdxRoot));
  expect(basename(tdxRoot)).toBe("tdx");
  expect(basename(fixtureRoot)).toMatch(/^fixture-/);
  expect(dirname(fixtureRoot)).toBe(dirname(testInfo.project.outputDir));
  const root = fixtureDirectory(join(fixtureRoot, "diagnose-archives"));
  const directory = fixtureDirectory(join(root, archiveId));
  const archiveFile = join(directory, "diagnose-group.json");
  await mkdir(root, { recursive: true });
  await mkdir(directory);
  await writeFile(archiveFile, JSON.stringify(archiveFixture()), {
    flag: "wx",
  });
  try {
    const offline = await installOfflineVisualApi(page);
    await allowArchiveReads(page);
    await page.goto(`/lab/backtest?archive=${archiveId}`);
    const scenario = page.getByRole("button", {
      name: scenarioLabel,
      exact: true,
    });
    await scenario.click();
    await expect(scenario).toHaveAttribute("aria-pressed", "true");
    const fill = page.getByRole("button", {
      name: `看K线 ${symbol} ${at}`,
      exact: true,
    });
    await fill.click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/scan" &&
        url.searchParams.get("at") === at &&
        url.searchParams.get("diagnose") === archiveId &&
        url.searchParams.get("cell") === "0" &&
        url.searchParams.get("scenario") === "clamp",
    );
    const statusLine = page.getByTestId("chart-trade-marks");
    const toggle = page.getByRole("checkbox", {
      name: "回测买卖点",
      exact: true,
    });
    await expect(statusLine).toHaveAttribute("data-mark-count", "2", {
      timeout: 30_000,
    });
    await expect(toggle).toBeChecked();
    await page.getByRole("button", { name: "周 K", exact: true }).click();
    await expect(statusLine).toContainText("仅日线显示回测买卖点");
    await expect(statusLine).toHaveAttribute("data-mark-count", "0");
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("at") === at &&
        url.searchParams.get("period") === "week",
    );
    await page.getByRole("button", { name: "日 K", exact: true }).click();
    await expect(statusLine).toHaveAttribute("data-mark-count", "2");
    await toggle.click();
    await expect(statusLine).toContainText("回测买卖点已关闭");
    await expect(statusLine).toHaveAttribute("data-mark-count", "0");
    await expect(page).toHaveURL((url) =>
      ["at", "diagnose", "cell", "scenario"].every(
        (key) => !url.searchParams.has(key),
      ),
    );
    await toggle.click();
    await expect(statusLine).toHaveAttribute("data-mark-count", "2");
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("diagnose") === archiveId,
    );
    await page.goBack();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/lab/backtest" &&
        url.searchParams.get("archive") === archiveId,
    );
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(scenario).toHaveAttribute("aria-pressed", "true");
    await expect(fill).toBeVisible();
    expect([...offline.unknown]).toEqual([]);
  } finally {
    await unlink(archiveFile);
    await rmdir(directory);
  }
});

test("RPS columns and the last loaded page survive reload without replaying page one", async ({
  page,
}) => {
  const requestedPages: number[] = [];
  const offline = await installOfflineVisualApi(
    page,
    new Set(),
    (data, input) => {
      const index = input.page ?? 0;
      requestedPages.push(index);
      const rows = Array.from({ length: 23 }, (_, index) => ({
        symbol: `sh${600000 + index}`,
        name: `排名样本 ${index + 1}`,
        localDay: true,
        value: { rank: index + 1, rps: 99 - index, return: 0.1 },
        reason: null,
      }));
      return {
        ...data,
        total: rows.length,
        rows: rows.slice(index * 20, (index + 1) * 20),
        availability: { ...data.availability, rps: "ready" },
        rps: {
          date: "2026-10-12",
          mode: "forward",
          count: rows.length,
          inputHash: "chart-e2e-rps",
          observation: null,
        },
      };
    },
  );
  await allowArchiveReads(page);
  await page.setViewportSize({ width: 1600, height: 650 });
  await page.goto("/scan?tab=rps&period=50&sortPeriod=120&rpsCols=10,20");
  const table = page.getByRole("table", { name: "个股RPS排名", exact: true });
  const firstRow = table.getByRole("link", {
    name: "排名样本 1 · SH600000",
    exact: true,
  });
  const nextPageRow = table.getByRole("link", {
    name: "排名样本 21 · SH600020",
    exact: true,
  });
  await expect(firstRow).toBeVisible({ timeout: 30_000 });
  const columnPicker = page.getByRole("button", { name: /RPS列/ });
  await columnPicker.click();
  const picker = page.getByLabel("选择显示的RPS列");
  await expect(
    picker.getByRole("checkbox", { name: "RPS50 (主)", exact: true }),
  ).toBeDisabled();
  await expect(
    picker.getByRole("checkbox", { name: "RPS120", exact: true }),
  ).toBeDisabled();
  await picker.getByRole("checkbox", { name: "RPS5", exact: true }).click();
  await picker.getByRole("checkbox", { name: "RPS20", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("rpsCols") === "5,10,50,120",
  );
  const more = page.getByRole("button", { name: "加载更多", exact: true });
  if (!(await nextPageRow.isVisible())) {
    if (await more.isVisible()) await more.click();
  }
  await expect(nextPageRow).toBeVisible();
  await expect(page).toHaveURL((url) => url.searchParams.get("page") === "2");
  requestedPages.length = 0;
  await page.reload();
  await expect(nextPageRow).toBeVisible();
  await expect(firstRow).toHaveCount(0);
  await expect(page.getByText(/从第 21 条起/)).toBeVisible();
  expect([...new Set(requestedPages)]).toEqual([1]);
  await columnPicker.click();
  await expect(
    picker.getByRole("checkbox", { name: "RPS5", exact: true }),
  ).toBeChecked();
  await expect(
    picker.getByRole("checkbox", { name: "RPS20", exact: true }),
  ).not.toBeChecked();
  await expect(
    picker.getByRole("checkbox", { name: "RPS50 (主)", exact: true }),
  ).toBeChecked();
  await expect(
    picker.getByRole("checkbox", { name: "RPS120", exact: true }),
  ).toBeChecked();
  expect([...offline.unknown]).toEqual([]);
});
