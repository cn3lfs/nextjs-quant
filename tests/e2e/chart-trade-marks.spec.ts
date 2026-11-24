import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import SuperJSON from "superjson";
import {
  diagnoseArchiveDetailSchema,
  type DiagnoseScenarioMetrics,
} from "../../src/lib/research/diagnose-contract";
import type { Bar } from "../../src/lib/domain";
import { tradeChartHref } from "../../src/lib/chart/chart-trade-marks";
import { chartColor } from "../../src/lib/chart/chart-theme";
import {
  tradeReviewRefSchema,
  tradeReviewSourceKinds,
  type ChartTradeReview,
  type TradeReviewBox,
} from "../../src/lib/chart/trade-review-ref";
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
  "studioArchiveDetail",
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
    const fill = page
      .getByRole("region", { name: "诊断归档详情", exact: true })
      .getByRole("button", {
        name: `看K线 ${symbol} ${at}`,
        exact: true,
      })
      .first();
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

test("five evidence sources share the daily chart overlay and bracket navigation", async ({
  page,
}) => {
  const offline = await installOfflineVisualApi(page);
  await allowArchiveReads(page);
  const received = new Set<string>();
  const frame = await page.request.get("/api/trpc/barReplayFrame", {
    headers: trpcHeaders,
    params: {
      input: JSON.stringify(
        SuperJSON.serialize({
          symbol,
          cutoffDate: daily.bars[132]!.date,
        }),
      ),
    },
  });
  expect(frame.ok()).toBe(true);
  const { bars } = SuperJSON.deserialize<{ bars: Bar[] }>(
    (await frame.json()).result.data,
  );
  await page.addInitScript(
    ({ gain, loss }) => {
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.fillText = function (
        text,
        x,
        y,
        maxWidth,
      ) {
        if (text === "MAE" || text === "MFE")
          this.canvas.setAttribute(`data-drew-${text.toLowerCase()}`, "");
        fillText.call(this, text, x, y, maxWidth);
      };
      CanvasRenderingContext2D.prototype.strokeRect = function (
        x,
        y,
        width,
        height,
      ) {
        if (this.strokeStyle === gain || this.strokeStyle === loss)
          this.canvas.setAttribute("data-drew-pnl-box", "");
        strokeRect.call(this, x, y, width, height);
      };
    },
    { gain: chartColor.up, loss: chartColor.down },
  );
  const t = initTRPC.create({ transformer: SuperJSON });
  const chartTradeReview = t.procedure
    .input(tradeReviewRefSchema)
    .query(({ input: ref }): ChartTradeReview => {
      received.add(ref.source);
      const boxes: TradeReviewBox[] = [
        { start: 95, end: 105, pnl: -120 },
        { start: 125, end: 132, pnl: 205 },
      ].map(({ start, end, pnl }, index) => {
        const entry = bars.find((bar) => bar.date === daily.bars[start]!.date)!;
        const exit = bars.find((bar) => bar.date === daily.bars[end]!.date)!;
        const range = bars.filter(
          (bar) => bar.date >= entry.date && bar.date <= exit.date,
        );
        const low = range.reduce((a, b) => (a.low < b.low ? a : b));
        const high = range.reduce((a, b) => (a.high > b.high ? a : b));
        return {
          entryDate: entry.date,
          entryPrice: entry.close,
          exitDate: exit.date,
          exitPrice: exit.close,
          pnlAmount: pnl,
          pnlPct: pnl / entry.close,
          maeDate: low.date,
          maePrice: low.low,
          maePct: (low.low / entry.close - 1) * 100,
          mfeDate: high.date,
          mfePrice: high.high,
          mfePct: (high.high / entry.close - 1) * 100,
          holdingDays: end - start + 1,
          excursionReason: null,
          pnlReason: null,
          backHref: `${ref.backHref}#round-${index + 1}`,
          tradeIds: [`buy-${index}`, `sell-${index}`],
        };
      });
      return {
        ref,
        adjustment: "none",
        boxes,
        warnings: [],
        fills: boxes.flatMap((box) => [
          {
            symbol,
            side: "buy",
            date: box.entryDate,
            price: box.entryPrice,
            quantity: 100,
            tradeId: box.tradeIds[0]!,
            backHref: box.backHref,
          },
          {
            symbol,
            side: "sell",
            date: box.exitDate,
            price: box.exitPrice,
            quantity: 100,
            tradeId: box.tradeIds[1]!,
            backHref: box.backHref,
          },
        ]),
      };
    });
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const names = decodeURIComponent(
      new URL(request.url()).pathname.split("/api/trpc/")[1] ?? "",
    ).split(",");
    if (!names.includes("chartTradeReview")) return route.fallback();
    const router = t.router(
      Object.fromEntries(
        names.map((name) => [
          name,
          name === "chartTradeReview"
            ? chartTradeReview
            : t.procedure
                .input((input: unknown) => input)
                .query(async ({ input }) => {
                  const read = await page.request.get(`/api/trpc/${name}`, {
                    headers: trpcHeaders,
                    params: {
                      input: JSON.stringify(SuperJSON.serialize(input)),
                    },
                  });
                  expect(read.ok()).toBe(true);
                  return SuperJSON.deserialize((await read.json()).result.data);
                }),
        ]),
      ),
    );
    const reply = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(request.url(), { headers: request.headers() }),
      router,
      createContext: () => ({}),
    });
    await route.fulfill({
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
      body: await reply.text(),
    });
  });

  for (const source of tradeReviewSourceKinds) {
    const backHref = `/accounts?tab=trades&trade=${source}`;
    await page.goto(
      tradeChartHref({
        symbol,
        at,
        review: {
          source,
          symbol,
          label: `验收 ${source}`,
          refId: source,
          backHref,
        },
      }),
    );
    const review = page.getByRole("region", { name: "交易复盘", exact: true });
    await expect(review).toContainText(`验收 ${source}`, { timeout: 30_000 });
    const overlay = review.getByTestId("chart-trade-review-overlay");
    await expect(overlay).toHaveAttribute("data-box-count", "2");
    await expect(overlay).toHaveAttribute("data-extreme-count", "4");
    await expect(page.getByTestId("chart-trade-marks")).toHaveAttribute(
      "data-mark-count",
      "4",
    );
    await expect(
      page
        .getByTestId("market-chart")
        .locator("canvas[data-drew-pnl-box][data-drew-mae][data-drew-mfe]"),
    ).toHaveCount(1);
    const round = review.getByTestId("trade-review-round");
    const back = review.getByRole("link", { name: "返回原证据 / 原批次" });
    await expect(round).toContainText("盈亏 -120.00");
    await expect(round).toContainText("MAE");
    await expect(round).toContainText("MFE");
    await expect(back).toHaveAttribute("href", `${backHref}#round-1`);
    await page.keyboard.press("]");
    await expect(round).toContainText("盈亏 205.00");
    await expect(back).toHaveAttribute("href", `${backHref}#round-2`);
    await page.keyboard.press("[");
    await expect(round).toContainText("盈亏 -120.00");
  }
  expect([...received]).toEqual([...tradeReviewSourceKinds]);
  expect([...offline.unknown]).toEqual([]);
});
