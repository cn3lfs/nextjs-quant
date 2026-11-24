import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { NativeStudyIdentity } from "trading-strategies";
import type { readBars } from "~/server/market/bar-store/read-bars";
import { closeCzsc, projectCzsc } from "~/server/strategies/chan/czsc";
import type {
  CzscRawFamily,
  CzscRawSignal,
} from "~/server/strategies/chan/czsc-api";
import { parseArgs } from "../../../scripts/backtest-diagnose";
import { runDiagnose } from "~/server/research/diagnose/run";
import { prepareDiagnoseRequest } from "~/server/research/diagnose/prepare-request";
import { planDiagnoseCells } from "~/server/research/diagnose/strategy-specs";
import * as scoring from "~/server/research/lifecycle-score";

vi.mock("~/server/research/causal-price-basis", async (original) => ({
  ...(await original<typeof import("~/server/research/causal-price-basis")>()),
  readResearchPriceActions: async () => ({
    events: new Map(),
    issues: [],
    recordCount: 0,
    sourceSha256: "fixture",
  }),
}));
vi.mock("~/server/market/bar-store/corporate-actions", () => ({
  corporateActions: async () => ({ events: new Map() }),
}));
afterAll(closeCzsc);
const symbol = "sh600519";
const identity: NativeStudyIdentity = {
  dllHash: "a".repeat(64),
  apiVersion: 22,
  buildCommit: "fixture",
  configId: "defaults",
  config: 0,
  anchor: 1,
};

function signal(type: 2 | -2, confirmedAt: number): CzscRawSignal {
  return {
    type,
    index: confirmedAt - 1,
    confirmedAt,
    center: 0,
    hindsight: 1,
    quality: 1,
    revokedAt: -1,
    pivot: 1,
    movement: -1,
    breakout: -1,
    basedOn: -1,
    stop: 0,
    context: 0,
    secondBasePivot: -1,
    secondTurnPivot: -1,
    smallTurnBasePivot: -1,
    smallTurnLeavePivot: -1,
    smallTurnRetestPivot: -1,
    divergence: {
      semantic: 1,
      holds: 1,
      newExtreme: 1,
      weakSpace: 0,
      weakSpeed: 0,
      weakArea: 0,
      prevStart: -1,
      prevEnd: -1,
      curStart: -1,
      curEnd: -1,
      prevArea: 0,
      curArea: 0,
      prevSpace: 0,
      curSpace: 0,
      prevSpeed: 0,
      curSpeed: 0,
    },
  };
}

function projector() {
  return vi.fn<typeof projectCzsc>(async (input, request) => {
    expect(request).toEqual({ levels: [0], bars: false });
    const index = input.close.length - 1;
    const zd = 9.8;
    const family: CzscRawFamily = {
      pivots: [5, 10].map((i) => ({
        index: i,
        kind: 1,
        price: 10,
        extremeIndex: i,
        fractalAt: i,
        confirmedAt: i,
      })),
      centers: [
        {
          start: 5,
          end: 10,
          firstPivot: 0,
          lastPivot: 1,
          zg: 10,
          zd,
          gg: 11,
          dd: zd - 1,
          direction: 1,
          confirmedAt: 12,
          established: 11,
          relationToPrev: 0,
          lifecycle: 0,
        },
      ],
      signals:
        index % 12 === 1
          ? [signal(2, index)]
          : index % 12 === 8
            ? [signal(-2, index)]
            : [],
      movements: [],
      breakouts: [],
      events: [],
      bars: [],
      nodes: [],
      children: [],
      recursiveCenters: [],
      connections: [],
    };
    return {
      hash: identity.dllHash,
      apiVersion: identity.apiVersion,
      buildCommit: identity.buildCommit,
      configId: identity.configId,
      families: { 0: family },
      nested: [],
    };
  });
}

const series = Array.from({ length: 820 }, (_, i) => {
  const close = 10.1 + 0.3 * Math.sin(i * 0.15);
  return {
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: close,
    close,
    high: close + 0.2,
    low: close - 0.2,
    volume: 1e6,
    amount: close * 1e6,
  };
});
async function fixture(
  flags: string[],
  missing: number[] = [],
  last = 465,
  data: { lateStart?: number; corrupt?: number; ibsSwings?: boolean } = {},
) {
  const root = await mkdtemp(join(process.env.QUANT_DATA_DIR!, "wire-"));
  const args = parseArgs([
    "--tdx-root",
    root,
    ...(flags.includes("--pool") ? [] : ["--symbols", symbol]),
    "--start",
    series[140]!.date,
    "--end",
    series[last]!.date,
    ...flags,
  ]);
  const read: typeof readBars = async ({
    instrument,
    period,
    adjustment,
    to,
  }) => {
    const bars = series
      .slice(0, last + 1)
      .map((b, i) =>
        data.ibsSwings ? { ...b, high: b.close + (i % 4 < 2 ? 0.4 : 0.1) } : b,
      )
      .map((b, i) =>
        instrument.symbol === symbol && i === data.corrupt
          ? { ...b, high: 0 }
          : b,
      )
      .filter(
        (b, i) =>
          (!to || b.date <= to) &&
          (instrument.symbol !== symbol || !missing.includes(i)) &&
          (instrument.symbol !== "sz001248" || i >= (data.lateStart ?? 0)),
      );
    return {
      id: instrument.symbol,
      hash: "fixture",
      symbol: instrument.symbol,
      market: "cn-equity",
      period,
      requestedSource: "local",
      source: "tdx-local",
      adjustment: adjustment ?? "none",
      createdAt: 0,
      bars,
      rawBars: bars,
      barStore: {
        version: "bar-store-1",
        market: "cn-equity",
        sourceFingerprint: "fixture",
        sourceVersions: ["fixture"],
        adjustment: "none",
        adjustmentReference: "raw",
        coverage: {
          from: bars[0]?.date ?? null,
          to: bars.at(-1)?.date ?? null,
          count: bars.length,
          historyExhausted: true,
        },
        formingDates: [],
        overlay: null,
        excluded: [],
      },
    };
  };
  return {
    ...args,
    read,
    outDir: root,
    indexBars: series.slice(0, last + 1),
    readFinancialHistory: async () => ({ reports: [], issues: [] }),
  };
}

it.each(["classic-ibs,research-chan-hold-cash", "macd,supertrend"])(
  "rejects unrelated CLI family %s",
  (family) => {
    expect(() =>
      planDiagnoseCells(
        parseArgs([
          "--tdx-root",
          process.env.QUANT_DATA_DIR!,
          "--symbols",
          symbol,
          "--family",
          family,
        ]),
      ),
    ).toThrow(/同一策略家族/);
  },
);
it.each([false, true])(
  "GP29 replay preserves three scored holdout legs and unknown bars invalidate Calmar (extra missing day %s)",
  async (extra) => {
    const cutoff = series[300]!.date;
    const input = await fixture(
      ["--mode", "portfolio", "--holdout-start", cutoff],
      extra ? [320, 330] : [320],
      815,
    );
    const row = Buffer.alloc(13);
    row.writeUInt8(29);
    row.writeUInt32LE(Number(series[321]!.date.replaceAll("-", "")), 1);
    row.writeFloatLE(1, 5);
    const dir = join(input.tdxRoot, "vipdoc", "cw");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "gp" + symbol + ".dat"), row);
    const scorer = vi.spyOn(scoring, "scoreLifecycleResult");
    try {
      const run = await runDiagnose({ ...input, strategies: [] });
      const cell = run.cells[0]!;
      expect(cell.error).toBeUndefined();
      expect(cell.suspensionEvidence).toMatchObject({
        symbolSuspensionDays: 1,
        portfolioAffectedDays: 1,
        certificates: [
          {
            symbol,
            date: series[320]!.date,
            sources: [{ kind: "GP29", offset: 0 }],
          },
        ],
      });
      for (const leg of Object.values(cell.timeHoldout!.holdout!)) {
        if (extra)
          expect([
            leg.return,
            leg.sharpe,
            leg.drawdown,
            leg.calmar,
            leg.benchmarkCalmar,
            leg.calmarDifference,
          ]).toEqual([null, null, null, null, null, null]);
        else
          expect(
            [
              leg.return,
              leg.sharpe,
              leg.drawdown,
              leg.calmar,
              leg.benchmarkCalmar,
              leg.calmarDifference,
            ].every(Number.isFinite),
          ).toBe(true);
      }
      const holdoutScores = scorer.mock.results.filter(
        (_, i) => scorer.mock.calls[i]![1].start === cutoff,
      );
      expect(holdoutScores.length).toBeGreaterThanOrEqual(3);
      for (const r of holdoutScores) {
        const calmar = r.value.riskAdjusted.calmar;
        if (extra) expect(calmar).toBeNull();
        else expect(Number.isFinite(calmar)).toBe(true);
      }
      const report = await readFile(run.reportPath, "utf8");
      expect(report).toContain("Calmar");
      expect(report).toContain("组合受影响日数 1");
      expect(report).toContain("gp" + symbol + ".dat");
    } finally {
      scorer.mockRestore();
    }
  },
);

it("keeps all CH14 candidates when a training window ends on a late member's native baseline", async () => {
  const input = await fixture(
    [
      "--family",
      "ch14-exits",
      "--mode",
      "portfolio",
      "--holdout-start",
      series[540]!.date,
    ],
    [],
    615,
    { lateStart: 160 },
  );
  const project = projector();
  const { cells, comparisons, reportPath } = await runDiagnose({
    ...input,
    symbols: [symbol, "sz001248"],
    project,
    resolveIdentity: async () => identity,
  });
  expect(cells.map((c) => c.error)).toEqual([undefined, undefined, undefined]);
  expect(cells.map((c) => c.nativeChan![0]!.cached)).toEqual([
    false,
    true,
    true,
  ]);
  expect(cells[2]!.nativeChan![0]).toMatchObject({
    projectionVersion: 2,
    zdAtrStop: { levelCount: expect.any(Number) },
  });
  const result = comparisons[0]!.familyHoldout!;
  // The first training window is [140, 299]. Bar 299 is the late member's 140th.
  expect(result.rollingSelection[0]!.start).toBe(series[300]!.date);
  expect(cells[0]!.nativeChan![1]!.baselineDate).toBe(series[299]!.date);
  expect(cells[0]!.portfolioEligibility![1]!.readyDate).toBe(series[300]!.date);
  expect(result.statistics.rawCandidateCount).toBe(3);
  expect(result.statistics.combinations).toBe(252);
  expect(result.statistics.pbo).toEqual(expect.any(Number));
  expect(result.statistics.effectiveTrials).toBeGreaterThan(0);
  expect(result.candidates).toHaveLength(3);
  expect(
    comparisons[0]!.chanZdImpact!.sharedEntryEarlyStops.length,
  ).toBeGreaterThan(0);
  const report = await readFile(reportPath, "utf8");
  for (const term of [
    "PBO(Sharpe)",
    "N_eff",
    "DSR",
    "聚类成员",
    "排除原因",
    "doubledCost",
    "delayed",
    "共同入场提前止损",
  ])
    expect(report).toContain(term);
  expect(
    JSON.parse(await readFile(join(input.outDir, "report.json"), "utf8"))
      .comparisons,
  ).toEqual(comparisons);
});

it("publishes identical development statistics when corrupt holdout OHLC prevents full-range preparation", async () => {
  const flags = [
    "--mode",
    "portfolio",
    "--family",
    "ch14-exits",
    "--holdout-start",
    series[540]!.date,
  ];
  const run = async (corrupt?: number, failOnlyZd = false) => {
    const input = await fixture(flags, [], 700, { corrupt, lateStart: 540 });
    const read: typeof readBars = async (query, ...rest) => {
      // Some local readers reject a window wholly before the first listing.
      if (
        failOnlyZd &&
        query.instrument.symbol === "sz001248" &&
        query.to &&
        query.to < series[540]!.date
      )
        throw new Error("sz001248区间行情缺失");
      return input.read(query, ...rest);
    };
    return runDiagnose(
      {
        ...input,
        read,
        symbols: [symbol, "sz001248"],
        project: projector(),
        resolveIdentity: async () => identity,
      },
      async (request) => {
        if (
          failOnlyZd &&
          request.end === input.end &&
          request.strategy.id.endsWith("-zd-stop")
        )
          throw new Error("留出段 ZD 观察缺失");
        return prepareDiagnoseRequest(request);
      },
    );
  };
  const clean = await run();
  const failed = await run(565);
  expect(failed.cells.every((cell) => cell.status !== "ok")).toBe(true);
  const reference = clean.comparisons[0]!.familyHoldout!;
  const review = failed.comparisons[0]!.familyHoldout!;
  expect(reference.statistics).toMatchObject({
    pbo: expect.any(Number),
    dsr: expect.any(Number),
    effectiveTrials: expect.any(Number),
  });
  expect(review.statistics).toEqual(reference.statistics);
  expect(review.rollingSelection).toEqual(reference.rollingSelection);
  for (const candidate of review.candidates) {
    expect(candidate.holdoutFailure).toContain("排除标的：sz001248");
    for (const leg of Object.values(candidate.holdout))
      expect(Object.values(leg).every((value) => value === null)).toBe(true);
  }
  const mixed = (await run(undefined, true)).comparisons[0]!.familyHoldout!;
  expect(mixed.statistics).toEqual(reference.statistics);
  for (const candidate of mixed.candidates) {
    if (candidate.id.endsWith("-zd-stop"))
      expect(candidate.holdoutFailure).toContain("排除标的：sz001248");
    else
      expect(candidate.holdout).toEqual(
        reference.candidates.find((c) => c.id === candidate.id)!.holdout,
      );
  }
});

it("runs historical portfolios and the Chan family before a later listing has 140 bars", async () => {
  const cut = series[540]!.date,
    lateStart = 570;
  const symbols = [symbol, "sz001248"];
  for (const scenario of ["standard", "chan-auto", "chan-explicit"]) {
    const family = scenario !== "standard";
    const flags = family
      ? ["--family", "ch14-exits"]
      : ["--strategies", "classic-ibs"];
    const input = await fixture(
      [...flags, "--mode", "portfolio", "--holdout-start", cut],
      [],
      615,
      { lateStart },
    );
    const { cells, comparisons, reportPath } = await runDiagnose({
      ...input,
      symbols,
      start: scenario === "chan-explicit" ? series[140]!.date : "auto",
      controls: [],
      project: projector(),
      resolveIdentity: async () => identity,
    });
    for (const cell of cells) {
      expect(cell.status, cell.error).toBe("ok");
      expect(cell.start! < cut).toBe(true);
      const late = cell.portfolioEligibility!.find(
        (row) => row.symbol === symbols[1],
      )!;
      expect(late.firstBar).toBe(series[lateStart]!.date);
      expect(late.readyDate).toBe(
        lateStart + late.warmupBars <= 615
          ? series[lateStart + late.warmupBars]!.date
          : null,
      );
      if (family) {
        expect(cell.start).toBe(series[140]!.date);
        expect(
          cell.nativeChan!.find((row) => row.symbol === symbols[1]),
        ).toMatchObject({
          prefixCount: 0,
          insufficientWarmup: { availableBars: 46, requiredWarmupBars: 140 },
        });
      } else {
        expect(cell.timeHoldout?.devWindowRange?.end! < cut).toBe(true);
        expect(cell.timeHoldout?.holdout?.base.return).toEqual(
          expect.any(Number),
        );
      }
    }
    if (family) {
      expect(comparisons[0]!.familyHoldout!.statistics.pbo).toEqual(
        expect.any(Number),
      );
      expect(await readFile(reportPath, "utf8")).toContain("sz001248 预热不足");
    }
  }
});

it.each(["none", "equal-month-end", "risk-parity-60"])(
  "applies only the requested core-4 allocation policy %s and reports investment and trading metrics",
  async (policy) => {
    const input = await fixture(
      ["--book", "core-4", "--book-control", policy],
      [],
      235,
      { lateStart: 160, ibsSwings: true },
    );
    const { cells, reportPath } = await runDiagnose({
      ...input,
      symbols: [symbol, "sz001248"],
      project: projector(),
      resolveIdentity: async () => identity,
    });
    const cell = cells[0]!;
    expect(cell.error).toBeUndefined();
    expect(cell.bookControl?.policy).toBe(policy);
    const artifact = JSON.parse(
      await readFile(join(cell.runPath, "run.json"), "utf8"),
    );
    if (policy === "none") expect(artifact.rebalance).toBeUndefined();
    else {
      expect(artifact.rebalance).toEqual({});
      expect(artifact.sleeveTargets.length).toBeGreaterThan(0);
      expect(cell.bookControl?.transferCount).toBeGreaterThan(0);
      expect(
        artifact.sleeveTargets.every(
          (t: { availableAt: string; date: string }) =>
            t.availableAt.slice(0, 10) < t.date,
        ),
      ).toBe(true);
    }
    expect(cell.sleeveInvestment?.correlations).toHaveLength(6);
    expect(artifact.executableSymbols ?? artifact.symbols).toContain(
      "sz001248",
    );
    expect(
      cell.nativeChan?.find((row) => row.symbol === "sz001248"),
    ).toMatchObject({
      strategyKey: "research-chan-hold-cash",
      insufficientWarmup: { availableBars: 76, requiredWarmupBars: 140 },
      prefixCount: 0,
    });
    expect(
      await readFile(join(cell.runPath, "orders.csv"), "utf8"),
    ).not.toContain(",chan,sz001248,");
    expect(await readFile(join(cell.runPath, "fills.csv"), "utf8")).toContain(
      `,ibs,${symbol},buy,`,
    );
    expect(cell.sleeveTrades?.portfolio.roundTrips).toBeGreaterThan(0);
    const md = await readFile(reportPath, "utf8");
    for (const label of [
      "剔除划转",
      "交易损益贡献",
      "单边换手",
      "印花税",
      "P25/P50/P75/P90",
      policy,
    ])
      expect(md).toContain(label);
  },
);

it("shares the v3 projection across CH04/07/12 while keeping their entry profiles distinct", async () => {
  const keys = [
    "research-chan-ch04",
    "research-chan-ch07",
    "research-chan-ch12",
  ];
  const input = await fixture(
    ["--strategies", keys.join(","), "--mode", "portfolio"],
    [],
    150,
  );
  const { cells } = await runDiagnose({ ...input, controls: [] });
  expect(cells.map((c) => c.error)).toEqual([undefined, undefined, undefined]);
  expect(
    cells.map((c) => [
      c.nativeChan![0]!.projectionVersion,
      c.nativeChan![0]!.cached,
    ]),
  ).toEqual([
    [3, false],
    [3, true],
    [3, true],
  ]);
  const args = [
    "--tdx-root",
    input.tdxRoot,
    "--pool",
    "core-30-v1",
    "--family",
    keys.slice(0, 2).join(","),
  ];
  expect(() => planDiagnoseCells(parseArgs(args))).toThrow(/同一策略家族/);
  const preset = parseArgs([...args.slice(0, -1), "ch14-exits"]);
  expect(planDiagnoseCells(preset).map((c) => c.strategy)).toHaveLength(3);
  expect(preset.symbols).toHaveLength(30);
});

it("replays all 30 frozen pool members together and discloses overlap and survivorship", async () => {
  const input = await fixture(
    [
      "--pool",
      "core-30-v1",
      "--strategies",
      "classic-ibs",
      "--mode",
      "portfolio",
    ],
    [],
    165,
  );
  const { cells, reportPath } = await runDiagnose({ ...input, controls: [] });
  expect(cells[0]!.status, cells[0]!.error).toBe("ok");
  expect(cells[0]!.symbols).toEqual(input.pool!.members!.map((m) => m.symbol));
  expect(cells[0]!.symbols).toHaveLength(30);
  const report = await readFile(reportPath, "utf8");
  expect(report).toContain("幸存者偏差");
  expect(report).toContain("与 core-12 重叠 0 股");
});
