import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as preparation from "../../../scripts/lib/backtest-diagnose/prepare-request";
import type { PortfolioRequest } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  replayLabBacktest,
  type FrozenLabBacktest,
} from "~/server/research/lab-backtest";
import {
  resolveAutoStart,
  runDiagnose,
} from "../../../scripts/lib/backtest-diagnose/run";
import { runDiagnostics } from "../../../scripts/lib/backtest-diagnose/diagnostics";
import { reconcileFills } from "../../../scripts/lib/backtest-diagnose/reconcile";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const symbol = "sh600000";
function flatBars(length: number): Bar[] {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
    open: 10,
    high: 10.5,
    low: 9.5,
    close: 10,
    volume: 100_000,
    amount: 1_000_000,
  }));
}

function fixture(
  bars: Bar[],
  strategy: "dual-ma" | "hold" = "hold",
): PortfolioRequest {
  return {
    market: "cn-equity",
    initial: 2_500,
    observationDetail: "full",
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map(({ date }) => date),
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
    strategies: [buildStrategy(strategy, [symbol], "single")],
    sleeves: [{ id: "diag", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 3,
      minimumCommission: 5,
      sellTaxBps: 5,
      slippageBps: 0,
    },
  };
}

function freezeFixture(request: PortfolioRequest): FrozenLabBacktest {
  return {
    request,
    sources: [],
    dataSource: "local",
    corporateActionCoverage: "included",
    costScenario: "fixed",
    strategyBuildHash: "",
    executionBuildHash: "",
    boundary: "fixture",
    marketPolicy: {
      signalBars: "raw",
      executionBars: "raw",
      priceLimits: "scenario",
      quantityGrid: {
        kind: "fixture",
        minimumStepCells: ["100/100"],
        evidence: "fixture",
      },
    },
  };
}

function diagnose(request: PortfolioRequest) {
  const frozen = freezeFixture(request);
  const replay = replayLabBacktest(frozen);
  return {
    result: replay.result,
    report: runDiagnostics({ request, frozen, replay }),
  };
}

it("distinguishes an unwarmed rule from a warmed rule with no signals", () => {
  const cold = diagnose(fixture(flatBars(5), "dual-ma"));
  const quietInput = fixture(flatBars(26), "dual-ma");
  quietInput.start = quietInput.calendar[20]!;
  const quiet = diagnose(quietInput);
  expect(cold.result.observations).toHaveLength(5);
  expect(
    cold.result.observations.every(({ decision }) => decision.exit === null),
  ).toBe(true);
  expect(quiet.result.observations).toHaveLength(6);
  expect(
    quiet.result.observations.every(
      ({ decision }) => decision.entry === false && decision.exit === false,
    ),
  ).toBe(true);
  expect(cold.report.counts.signals).toBe(0);
  expect(quiet.report.counts.signals).toBe(0);
  expect(quiet.report.counts.warmup).toBe(20);
  const coldCheck = cold.report.checks.find(({ id }) => id === "signalCount");
  const quietCheck = quiet.report.checks.find(({ id }) => id === "signalCount");
  expect(coldCheck?.status).toMatch(/^(warn|fail)$/);
  expect(quietCheck?.status).toMatch(/^(warn|fail)$/);
  expect(quietCheck?.message).toMatch(/没有.*信号|no.*signal/i);
  expect(coldCheck?.message).toMatch(/预热|warmup/i);
  expect(coldCheck?.message).not.toBe(quietCheck?.message);
});

it("ranks the rejection reasons and attributes a no-fill tape to order or fill", () => {
  const bars = flatBars(5);
  for (const index of [1, 2, 4])
    Object.assign(bars[index]!, { volume: 0, amount: 0 });
  Object.assign(bars[3]!, { high: 10, low: 10 });
  const { report } = diagnose(fixture(bars));
  expect(report.counts).toMatchObject({
    signals: 5,
    orders: 5,
    fills: 0,
    rejections: 4,
  });
  expect(report.checks.find(({ id }) => id === "signalCount")?.status).toBe(
    "pass",
  );
  const reasons = report.checks.find(({ id }) => id === "ordersToFills");
  expect(reasons?.status).toMatch(/^(warn|fail)$/);
  expect(reasons?.message).toMatch(
    /停牌或缺少可交易行情×3.*一字行情，保守不成交×1/,
  );
  expect(report.layer).toEqual(expect.stringMatching(/^(order|fill)$/));
});

it("reports a valid next-open fill with a closed accounting identity and no P0", () => {
  const { result, report } = diagnose(fixture(flatBars(5)));
  expect(result.curve.at(-1)?.equity).toBe(2_495);
  expect(report.counts).toMatchObject({
    bars: 5,
    signals: 5,
    orders: 1,
    fills: 1,
    rejections: 0,
  });
  expect(report.status).toBe("ok");
  expect(report.layer).toBeUndefined();
  expect(report.checks.filter(({ status }) => status === "fail")).toHaveLength(
    0,
  );
});

it("does not report false equity failure when a dividend re-marks a suspended position", () => {
  const bars = flatBars(5);
  const input = fixture(bars);
  const suspended = bars[2]!.date;
  const tradingBars = bars
    .filter(({ date }) => date !== suspended)
    .map((bar) =>
      bar.date > suspended
        ? { ...bar, open: 9, high: 9.5, low: 8.5, close: 9 }
        : bar,
    );
  const actions = [
    {
      date: suspended,
      availableAt: suspended,
      cashAvailableAt: suspended,
      timingAssumption: "ex-date-research-scenario",
      dividend: 1,
      bonus: 0,
      evidence: "fixture dividend",
    },
  ] as const;
  input.instruments = [
    {
      ...input.instruments[0]!,
      bars: tradingBars,
      signalBars: tradingBars,
      actions,
    },
  ];
  const { result, report } = diagnose(input);
  // ¥495 cash + 200 × ¥1 dividend = ¥695. The adjusted stale close is ¥9.
  expect(result.curve.find(({ date }) => date === suspended)).toMatchObject({
    cash: 695,
    equity: 2_495,
  });
  expect(reconcileFills(input, result)).toHaveLength(0);
  expect(report.checks.find(({ id }) => id === "equityIdentity")?.status).toBe(
    "pass",
  );
  expect(report.status).toBe("ok");
});

it("starts the portfolio on its first ready member and aligns that start to the benchmark", async () => {
  const bars = flatBars(375);
  const late = bars.slice(55);
  const ready = late[140]!.date;
  const cache = new Map([
    ["sh600519", bars],
    ["sh688981", late],
    ["sh000001", bars.filter((b) => b.date !== ready)],
  ]);
  const symbols = ["sh600519", "sh688981"];
  const end = bars.at(-1)!.date;
  for (const key of ["research-chan", "research-chan-hold-cash"] as const)
    expect(
      await resolveAutoStart(key, symbols, "portfolio", "", end, cache),
    ).toBe(bars[140]!.date);
  expect(
    await resolveAutoStart(
      "research-chan",
      ["sh688981"],
      "portfolio",
      "",
      end,
      cache,
    ),
  ).toBe(late[141]!.date);
  expect(
    await resolveAutoStart(
      "research-growth",
      symbols,
      "portfolio",
      "",
      end,
      cache,
    ),
  ).toBe(bars[300]!.date);
  cache.set("sh688981", late.slice(0, 140));
  await expect(
    resolveAutoStart(
      "research-chan-second",
      symbols,
      "portfolio",
      "",
      end,
      cache,
    ),
  ).resolves.toBe(bars[140]!.date);
  cache.set(
    "sh000001",
    bars.filter((b) => b.date !== bars[140]!.date),
  );
  expect(
    await resolveAutoStart(
      "research-chan",
      symbols,
      "portfolio",
      "",
      end,
      cache,
    ),
  ).toBe(bars[141]!.date);
});

it("writes each Wyckoff profile's scored funnel to the cell, run.json and Markdown for preset and catalog keys", async () => {
  const bars = flatBars(180).map((bar, i) => ({
    ...bar,
    open: 10 + i,
    close: 10 + i,
    high: 10.5 + i,
    low: 9.5 + i,
  }));
  const start = bars[140]!.date;
  const end = bars.at(-1)!.date;
  const outDir = await mkdtemp(join(process.env.QUANT_DATA_DIR!, "wyckoff-"));
  const prepare = vi
    .spyOn(preparation, "prepareDiagnoseRequest")
    .mockImplementation(async ({ strategy }) => {
      const request = { ...fixture(bars), strategies: [strategy], start, end };
      return {
        frozen: freezeFixture(request),
        calendar: bars.map((b) => b.date),
        dataQuality: [],
      };
    });
  try {
    const strategies = [
      "wy-lps-daily",
      "wy-reaccumulation-daily",
      "wy-trend-pullback-daily",
      "research-wy-trend-pullback-protected",
    ];
    const { cells, reportPath } = await runDiagnose({
      strategies,
      controls: [],
      symbols: [symbol],
      mode: "per-symbol",
      start,
      end,
      cost: "fixed",
      initial: 2500,
      tdxRoot: outDir,
      outDir,
    });
    expect(cells).toHaveLength(4);
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("威科夫入场漏斗");
    for (const cell of cells) {
      const run = JSON.parse(
        await readFile(join(cell.runPath, "run.json"), "utf8"),
      );
      expect(cell.wyckoffFunnel).toMatchObject([
        {
          symbol,
          parentEvents: cell.strategy.includes("trend") ? 40 : 0,
          entrySignals: 0,
          buyOrders: 0,
          buyFills: 0,
        },
      ]);
      expect(run.wyckoffFunnel).toEqual(cell.wyckoffFunnel);
      expect(report).toContain(
        `per-symbol/${cell.strategy}/${symbol} | ${symbol} | ${cell.wyckoffFunnel![0]!.parentEvents} |`,
      );
    }
  } finally {
    prepare.mockRestore();
    await rm(outDir, { force: true, recursive: true });
  }
});
