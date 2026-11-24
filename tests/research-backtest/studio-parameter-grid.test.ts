import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { etfRotationCatalog, etfRotationUniverse } from "trading-strategies";
import {
  computeTradeExcursions,
  topDrawdownEpisodes,
  type TradeExcursionBarsBySymbol,
  type TradeExcursionInput,
} from "../../packages/quant-performance/src/index";
import {
  diagnoseSampleFillSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseScenarioMetrics,
} from "~/lib/research/diagnose-contract";
import {
  parameterGridWarning,
  studioEtfRotationInputSchema,
  studioResultSchema,
} from "~/lib/research/studio-result";
import {
  computeParameterGrid,
  type ParameterGridEvaluator,
} from "~/server/research/studio/parameter-grid";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const january = (day: number) => `2020-01-${String(day).padStart(2, "0")}`;

describe("studio performance evidence", () => {
  it("ranks five inclusive underwater episodes with stable ties and an unrecovered tail", () => {
    const observations = [
      [1, 100],
      [2, 100],
      [3, 50],
      [4, 50],
      [6, 100],
      [7, 60],
      [8, 200],
      [9, 100],
      [10, 200],
      [11, 400],
      [12, 350],
      [13, 400],
      [14, 300],
      [15, 400],
      [17, 1000],
      [18, 950],
      [19, 1000],
      [20, 1600],
      [21, 1120],
      [23, 1200],
    ] as const;
    const points = observations.map(([day, value]) => ({
      date: january(day),
      value,
    }));

    const episodes = topDrawdownEpisodes(100, points);
    // Removing both 50% episodes splices Jan 1, 7 and 11 together, creating
    // the 40% episode and consuming the original peak of the Jan 12 dip.
    expect(episodes).toEqual([
      {
        peakDate: january(2),
        valleyDate: january(3),
        recoveryDate: january(6),
        depth: 0.5,
        recoveryDays: 3,
        observedRecoveryDays: 3,
        underwaterDays: 4,
      },
      {
        peakDate: january(8),
        valleyDate: january(9),
        recoveryDate: january(10),
        depth: 0.5,
        recoveryDays: 1,
        observedRecoveryDays: 1,
        underwaterDays: 2,
      },
      {
        peakDate: january(1),
        valleyDate: january(7),
        recoveryDate: january(11),
        depth: 0.4,
        recoveryDays: 4,
        observedRecoveryDays: 4,
        underwaterDays: 10,
      },
      {
        peakDate: january(20),
        valleyDate: january(21),
        recoveryDate: null,
        depth: expect.closeTo(0.3, 12),
        recoveryDays: null,
        observedRecoveryDays: 2,
        underwaterDays: 3,
      },
      {
        peakDate: january(13),
        valleyDate: january(14),
        recoveryDate: january(15),
        depth: 0.25,
        recoveryDays: 1,
        observedRecoveryDays: 1,
        underwaterDays: 2,
      },
    ]);
  });

  const closedCycle = {
    id: "closed",
    symbol: "sh600001",
    openedAt: january(2),
    closedAt: january(6),
    expectedHoldingSessions: [january(2), january(3), january(6)],
    entryAverage: 100,
    realizedNetReturn: 0.04,
  } satisfies TradeExcursionInput;
  const bars = [
    { date: january(1), high: 200, low: 20 },
    { date: january(2), high: 108, low: 95 },
    { date: january(3), high: 110, low: 90 },
    { date: january(6), high: 120, low: 97 },
    { date: january(7), high: 300, low: 10 },
  ];

  it("uses only the inclusive holding sessions for MAE/MFE and excludes open cycles", () => {
    const bySymbol: TradeExcursionBarsBySymbol = { [closedCycle.symbol]: bars };
    const openCycle = { ...closedCycle, id: "open", closedAt: null };
    expect(computeTradeExcursions([openCycle, closedCycle], bySymbol)).toEqual([
      {
        id: closedCycle.id,
        symbol: closedCycle.symbol,
        openedAt: closedCycle.openedAt,
        closedAt: closedCycle.closedAt,
        entryAverage: 100,
        entryAverageReason: null,
        realizedNetReturn: 0.04,
        realizedNetReturnReason: null,
        days: 3,
        daysReason: null,
        mae: expect.closeTo(-0.1, 12), // 90 / 100 - 1
        mfe: expect.closeTo(0.2, 12), // 120 / 100 - 1
        reason: null,
      },
    ]);
  });

  it("clamps only the out-of-sign excursion when every holding bar is on one side of entry", () => {
    const cycles = [
      { ...closedCycle, id: "above", entryAverage: 80 },
      { ...closedCycle, id: "below", entryAverage: 150 },
    ];
    expect(
      computeTradeExcursions(cycles, { [closedCycle.symbol]: bars }),
    ).toMatchObject([
      { id: "above", mae: 0, mfe: 0.5, reason: null },
      { id: "below", mae: expect.closeTo(-0.4, 12), mfe: 0, reason: null },
    ]);
  });

  it("leaves both excursions unknown when an interior holding day is missing", () => {
    expect(
      computeTradeExcursions([closedCycle], {
        [closedCycle.symbol]: bars.filter(({ date }) => date !== january(3)),
      }),
    ).toMatchObject([
      {
        id: closedCycle.id,
        days: 3,
        daysReason: null,
        realizedNetReturn: 0.04,
        mae: null,
        mfe: null,
        reason: expect.stringContaining(january(3)),
      },
    ]);
  });
});

describe("studio 2D parameter grid", () => {
  const dates = Array.from({ length: 214 }, (_, i) =>
    new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  );
  const grid = {
    xAxis: { key: "momentumWindow", values: [20, 10] },
    yAxis: { key: "topK", values: [3, 1] },
    dates,
    holdoutStart: dates[209]!,
    trainBars: 6,
    testBars: 50,
  };
  const coordinates = [
    [20, 3],
    [20, 1],
    [10, 3],
    [10, 1],
  ];
  const patterns = {
    flatMean: [0.002, -0.002],
    steady: [-0.0025, -0.0025, 0.0055, 0.0055],
    early: [0.029, -0.021],
    late: [0.025, -0.025],
  };
  function sample(
    sessions: readonly string[],
    pattern: (oosIndex: number) => readonly number[],
  ) {
    return {
      dates: sessions,
      returns: sessions.map((date) => {
        const index = dates.indexOf(date) - grid.trainBars;
        const values = pattern(index);
        return values[index % values.length]!;
      }),
      trades: 1,
    };
  }

  it("uses only complete development folds, ranks PBO by Sharpe, and reports DSR with N_eff", async () => {
    const evaluate = vi.fn<ParameterGridEvaluator>(({ x, y, dates }) =>
      sample(dates, (index) => {
        if (x === 20 && y === 1) return patterns.steady;
        if (x === 10 && y === 3)
          return index < 100 ? patterns.early : patterns.late;
        return patterns.flatMean;
      }),
    );

    const result = await computeParameterGrid(grid, evaluate);
    const folds = [6, 56, 106, 156].map((start) => ({
      window: {
        trainStart: dates[start - 6],
        trainEnd: dates[start - 1],
        start: dates[start],
        end: dates[start + 49],
      },
      dates: dates.slice(start, start + 50),
    }));
    expect(evaluate.mock.calls.map(([request]) => request)).toEqual(
      coordinates.flatMap(([x, y]) => folds.map((fold) => ({ x, y, ...fold }))),
    );
    expect(result).toMatchObject({
      status: "reviewed",
      warning: parameterGridWarning,
      reason: null,
      holdoutStart: grid.holdoutStart,
      windows: folds.map(({ window }) => window),
      devOosDays: 200,
      trailingDevelopmentDays: 3,
      // The steady path wins by Sharpe in all 252 splits. With compounded
      // return it swaps first place with the early/late path across each split.
      pboMetric: "sharpe",
      pbo: 0,
      cscvCombinations: 252,
      discardedCscvDays: 0,
      // Four cells give three distinct paths. The alternating paths have
      // correlation 0.9968 and the steady path has zero correlation with both.
      effectiveTrials: 2,
      distinctReturnSeries: 3,
      dsrReference: { x: 20, y: 3 },
      dsrThreshold: 0.95,
    });
    expect(result.cells).toMatchObject([
      {
        x: 20,
        y: 3,
        // With all four daily Sharpes (including the tied path), the
        // sample variance sets the two-effective-trial deflation threshold.
        trades: 4,
        dsr: expect.closeTo(0.09565551, 7),
        meetsDsrThreshold: false,
      },
      {
        x: 20,
        y: 1,
        dsr: expect.closeTo(0.99996602, 7),
        meetsDsrThreshold: true,
      },
      {
        x: 10,
        y: 3,
        dsr: expect.closeTo(0.42788469, 7),
        meetsDsrThreshold: false,
      },
      {
        x: 10,
        y: 1,
        dsr: expect.closeTo(0.09565551, 7),
        meetsDsrThreshold: false,
      },
    ]);
    expect(result.dsr).toBe(result.cells[0]!.dsr);
    expect(result.cells[1]!.sharpe).toBeCloseTo(0.375 * Math.sqrt(252), 12);
    expect(result.cells[1]!.totalReturn).toBeCloseTo(
      (0.9975 * 1.0055) ** 100 - 1,
      12,
    );
    expect(result.cells[1]!.maxDrawdown).toBeCloseTo(1 - 0.9975 ** 2, 12);
  });

  it("retains both axes and every coordinate when all cells have identical nonconstant returns", async () => {
    const result = await computeParameterGrid(grid, ({ dates }) =>
      sample(dates, () => patterns.steady),
    );

    expect(result).toMatchObject({
      xAxis: grid.xAxis,
      yAxis: grid.yAxis,
      status: "insufficient",
      reason: expect.any(String),
      pbo: null,
      dsr: null,
    });
    expect(result.cells.map(({ x, y }) => [x, y])).toEqual(coordinates);
    for (const cell of result.cells) {
      expect(cell).toMatchObject({
        reason: null,
        totalReturn: expect.closeTo((0.9975 * 1.0055) ** 100 - 1, 12),
        sharpe: expect.closeTo(0.375 * Math.sqrt(252), 12),
        dsr: null,
        meetsDsrThreshold: null,
      });
    }
  });

  it("compares each cell against 0.95 even when distinct paths form one correlation cluster", async () => {
    const result = await computeParameterGrid(grid, ({ x, dates }) =>
      sample(dates, () => (x === 20 ? [0.01115, -0.00885] : [0.0112, -0.0088])),
    );

    // With N_eff = 1, both symmetric paths use PSR vs zero.
    // Their DSRs are Φ(0.115√199) and Φ(0.12√199).
    expect(result).toMatchObject({
      status: "reviewed",
      pbo: 0,
      distinctReturnSeries: 2,
      effectiveTrials: 1,
      dsrThreshold: 0.95,
      dsr: expect.closeTo(0.94762772, 7),
    });
    expect(
      result.cells.map(({ meetsDsrThreshold }) => meetsDsrThreshold),
    ).toEqual([false, false, true, true]);
    expect(result.cells[2]!.dsr).toBeCloseTo(0.95475402, 7);
  });

  it("leaves the grid review unavailable when a cell has zero return variance", async () => {
    const result = await computeParameterGrid(grid, ({ x, y, dates }) =>
      sample(dates, () => (x === 20 && y === 3 ? [0] : patterns.steady)),
    );

    expect(result).toMatchObject({
      status: "insufficient",
      pbo: null,
      dsr: null,
    });
    expect(result.cells[0]).toMatchObject({
      totalReturn: 0,
      maxDrawdown: 0,
      sharpe: null,
      dsr: null,
      meetsDsrThreshold: null,
      reason: expect.any(String),
    });
    expect(result.reason).toBe(result.cells[0]!.reason);
    expect(result.cells[1]!.sharpe).toBeCloseTo(0.375 * Math.sqrt(252), 12);
  });

  it("leaves all statistical guardrails blank when a candidate omits a common OOS session", async () => {
    const result = await computeParameterGrid(grid, ({ x, y, dates }) => {
      const row = sample(dates, () => patterns.steady);
      if (x === 20 && y === 3)
        return { ...row, returns: [null, ...row.returns.slice(1)] };
      return row;
    });
    expect(result).toMatchObject({
      status: "insufficient",
      pbo: null,
      dsr: null,
      effectiveTrials: null,
    });
    expect(result.cells[0]).toMatchObject({
      reason: expect.stringContaining(dates[grid.trainBars]!),
      trades: null,
      sharpe: null,
    });
    expect(result.cells[1]!.sharpe).not.toBeNull();
  });

  it.each(["quotes", "GBBQ"] as const)(
    "preserves scored grid cells, PBO, DSR and effective trials after holdout %s are appended",
    async (source) => {
      const dataDir = process.env.QUANT_DATA_DIR;
      if (!dataDir) throw new Error("Test requires isolated QUANT_DATA_DIR");
      const tdxRoot = join(dataDir, `studio-grid-tdx-${source}`);
      const actionsDirectory = join(tdxRoot, "T0002", "hq_cache");
      await mkdir(actionsDirectory, { recursive: true });
      const actionsPath = join(actionsDirectory, "gbbq");
      await writeFile(actionsPath, Buffer.alloc(4));
      const sessions = Array.from({ length: 244 }, (_, i) =>
        new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      );
      const holdoutStart = "2020-08-27";
      const symbols = [
        "sh000001",
        "sh510300",
        "sh510500",
        "sz159915",
        "sh511010",
      ];
      for (const exchange of ["sh", "sz"])
        await mkdir(join(tdxRoot, "vipdoc", exchange, "lday"), {
          recursive: true,
        });
      async function writeQuotes(holdout: boolean) {
        const window = sessions.filter(
          (date) => date >= holdoutStart === holdout,
        );
        await Promise.all(
          symbols.map(async (symbol, s) => {
            const bytes = Buffer.alloc(32 * window.length);
            const scale = s === 0 ? 100 : 1000;
            for (const [i, date] of window.entries()) {
              const at = 32 * i;
              const price = Math.round(
                scale *
                  (10 +
                    i * (0.004 + 0.001 * s) +
                    Math.sin(i / (5 + s)) / 20 +
                    (holdout ? 40 : 0)),
              );
              bytes.writeUInt32LE(Number(date.replaceAll("-", "")), at);
              bytes.writeUInt32LE(price, at + 4);
              bytes.writeUInt32LE(price + Math.round(scale / 20), at + 8);
              bytes.writeUInt32LE(price - Math.round(scale / 20), at + 12);
              bytes.writeUInt32LE(price, at + 16);
              bytes.writeFloatLE(1e8, at + 20);
              bytes.writeUInt32LE(1e7, at + 24);
            }
            await (holdout ? appendFile : writeFile)(
              join(
                tdxRoot,
                "vipdoc",
                symbol.slice(0, 2),
                "lday",
                symbol + ".day",
              ),
              bytes,
            );
          }),
        );
      }
      const { runStudioParameterGrid, studioEtfGridResultSchema } =
        await import("~/server/research/studio");
      const input = {
        start: sessions[0]!,
        holdoutStart,
        trainBars: 20,
        testBars: 30,
        momentumWindows: [5, 20],
        topKs: [1, 2],
      };
      await writeQuotes(false);
      const first = studioEtfGridResultSchema.parse(
        await runStudioParameterGrid(input, { tdxRoot }),
      );
      expect(first.replay.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.windows).toHaveLength(7);
      expect(first.windows.at(-1)?.end).toBe(sessions[229]);
      expect(first.status, first.reason ?? "").toBe("reviewed");
      expect(first.pbo).toEqual(expect.any(Number));
      expect(first.dsr).toEqual(expect.any(Number));
      expect(first.effectiveTrials).toEqual(expect.any(Number));
      if (source === "quotes") {
        await writeQuotes(true);
        expect(await runStudioParameterGrid(input, { tdxRoot })).toEqual(first);
        return;
      }

      const records = [
        // sh510300: valid dividend on Aug 27, NaN dividend on Aug 28.
        "dd3be98cf6f74832a8563454466b82c31904d01f68e853950000000000",
        "dd3be98cf6f74832603f3aee0a080affec83256e324155530000000000",
        // Unknown category on Aug 29 and unknown symbol on Aug 30.
        "dd3be98cf6f74832a20afb77d46997a97005eeb91deaf33a0000000000",
        "59c2284f04b139e3e28af3f53cb5a2987005eeb91deaf33a0000000000",
      ];
      const count = Buffer.alloc(4);
      count.writeUInt32LE(records.length);
      await writeFile(
        actionsPath,
        Buffer.concat([count, Buffer.from(records.join(""), "hex")]),
      );
      expect(await runStudioParameterGrid(input, { tdxRoot })).toEqual(first);

      // The same NaN dividend inside development still blocks evaluation.
      count.writeUInt32LE(1);
      await writeFile(
        actionsPath,
        Buffer.concat([
          count,
          Buffer.from(
            "dd3be98cf6f748322566cf3ede2d5e3cec83256e324155530000000000",
            "hex",
          ),
        ]),
      );
      const invalid = await runStudioParameterGrid(input, { tdxRoot });
      expect(invalid.status).toBe("insufficient");
      expect(invalid.reason).toContain("公司行动来源");
    },
  );
});

function historicalArchive(): DiagnoseArchiveDetail {
  const scenario: DiagnoseScenarioMetrics = {
    scenarioId: "strict",
    label: "Synthetic strict replay",
    executionProfile: "strict",
    maxParticipation: null,
    capacityPolicy: null,
    status: "ok",
    counts: {
      bars: 3,
      warmup: 0,
      signals: 1,
      orders: 2,
      fills: 2,
      rejections: 0,
      closedTrades: 1,
    },
    rejectionReasons: [],
    totalFees: 10,
    totalReturn: 0.04,
    maxDrawdown: 0.02,
    capacityActive: false,
    checks: [],
    findings: [],
    sampleOrders: [],
    sampleFills: [],
    sampleRejections: [],
  };
  return {
    summary: {
      id: "lab-synthetic-history",
      source: "lab-archive",
      title: "Synthetic historical archive",
      generatedAt: "2020-01-07T00:00:00.000Z",
      strategyKeys: ["hold"],
      symbols: ["sh600001"],
      scenarios: ["strict", "clamp"],
      statusCounts: { ok: 2, blocked: 0, failed: 0, zeroSignal: 0 },
      driftWarnings: [],
      missingFiles: [],
    },
    cells: [
      {
        strategyKey: "hold",
        symbols: ["sh600001"],
        mode: "portfolio",
        start: january(2),
        end: january(6),
        scenarios: [
          scenario,
          {
            ...scenario,
            scenarioId: "clamp",
            executionProfile: "clamp",
            totalReturn: 0.06,
          },
        ],
      },
    ],
    pagination: { page: 1, pageSize: 1, totalCells: 1 },
    boundaryState: "ok",
  };
}

describe("research studio adapters", () => {
  it("exposes six template kinds, named preset pools, and grouped strategies", async () => {
    const { studioTemplates } = await import("~/server/research/studio");
    const { templates, pools, strategyGroups } = studioTemplates();
    expect(templates.map(({ kind }) => kind).sort()).toEqual([
      "alpha-formula",
      "etf-rotation",
      "exit-family",
      "ma-baseline-5m",
      "multi-book",
      "single",
    ]);
    const presetSizes = { "core-12": 12, "core-30-v1": 30, "etf-21": 21 };
    for (const [id, size] of Object.entries(presetSizes)) {
      const symbols = pools.find((pool) => pool.id === id)?.symbols;
      expect(symbols, id).toHaveLength(size);
      expect(new Set(symbols).size, id).toBe(size);
    }
    expect(strategyGroups.length).toBeGreaterThan(0);
  });

  it("adapts a pre-evidence archive with null diagnostics and preserves recorded case metrics", async () => {
    const { adaptDiagnoseArchive } = await import("~/server/research/studio");
    const detail = historicalArchive();
    const view = studioResultSchema.parse(adaptDiagnoseArchive(detail));

    expect(view).toMatchObject({
      version: "studio-result-v1",
      template: "single",
      archiveId: detail.summary.id,
      strategyKey: "hold",
      symbols: ["sh600001"],
      totalReturn: 0.04,
      maxDrawdown: 0.02,
      performance: null,
      equity: null,
      topDrawdowns: null,
      tradeExcursions: null,
      excursionDistribution: null,
      cases: [
        {
          strategyKey: "hold",
          symbols: ["sh600001"],
          scenarioId: "strict",
          status: "ok",
          totalReturn: 0.04,
          maxDrawdown: 0.02,
        },
        {
          strategyKey: "hold",
          symbols: ["sh600001"],
          scenarioId: "clamp",
          status: "ok",
          totalReturn: 0.06,
          maxDrawdown: 0.02,
        },
      ],
    });
  });

  it("round-trips a synthetic historical archive through the real isolated archive reader", async () => {
    // tests/setup-data-dir.ts provides a fresh temporary root before test imports.
    const dataDir = process.env.QUANT_DATA_DIR;
    if (!dataDir) throw new Error("Test requires isolated QUANT_DATA_DIR");
    const options = { archiveDir: join(dataDir, "studio-archive-roundtrip") };
    const { publishDiagnoseArchive, readDiagnoseArchive } =
      await import("~/server/research/diagnose/archive");
    const detail = historicalArchive();
    await publishDiagnoseArchive(detail, options);
    const restored = await readDiagnoseArchive(detail.summary.id, {
      ...options,
      allCells: true,
    });
    expect(restored).toEqual(detail);
  });

  it("restores full fills beyond the legacy preview and keeps the archive readable on sidecar I/O errors", async () => {
    const dataDir = process.env.QUANT_DATA_DIR;
    if (!dataDir) throw new Error("Test requires isolated QUANT_DATA_DIR");
    const {
      exportDiagnoseArchive,
      publishDiagnoseArchive,
      readDiagnoseArchive,
    } = await import("~/server/research/diagnose/archive");
    const { readStudioArchive } = await import("~/server/research/studio");
    const { groupedScenarioEvidence } =
      await import("~/server/research/studio/diagnose-evidence");
    const { runPortfolio } = await import("quant-backtest");
    const { evaluatePerformance } = await import("quant-performance");
    const calendar = Array.from({ length: 110 }, (_, i) =>
      new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    );
    const symbol = "sh600001";
    const bars = calendar.map((date) => ({
      date,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1_000_000,
      amount: 10_000_000,
    }));
    const request: Parameters<typeof runPortfolio>[0] = {
      market: "cn-equity",
      initial: 100_000,
      start: calendar[0]!,
      end: calendar.at(-1)!,
      calendar,
      instruments: [
        {
          symbol,
          market: "cn-equity",
          bars,
          signalBars: bars,
          execution: {
            evidence: "synthetic execution",
            limitUp: null,
            limitDown: null,
            tradable: true,
          },
        },
      ],
      strategies: [
        {
          id: "fixture",
          version: 1,
          market: "cn-equity",
          period: "day",
          sleeve: "book",
          universe: { kind: "symbols", symbols: [symbol] },
          entry: { kind: "constant", value: false },
          exit: { rule: { kind: "constant", value: false } },
          sizing: { kind: "weight", weight: 1 },
        },
      ],
      sleeves: [{ id: "book", share: 1, riskPerTrade: 1, maxPositions: 1 }],
      scheduledTargets: calendar.slice(0, 52).map((date, i) => {
        const targets: Record<string, number> = {};
        if (i % 2 === 0) targets[symbol] = 0.5;
        return {
          date,
          availableAt: date,
          sourceHash: "a".repeat(64),
          strategyId: "fixture",
          targets,
        };
      }),
    };
    const ledger = runPortfolio(request);
    expect(ledger.fills).toHaveLength(52);
    const equity = ledger.equity.map(({ date, equity: value }) => ({
      date,
      value,
    }));
    const evidence = groupedScenarioEvidence(
      request,
      ledger,
      evaluatePerformance(request.initial, equity),
    );
    const detail = historicalArchive();
    detail.summary.id = "lab-job-studio-evidence";
    const scenario = detail.cells[0]!.scenarios[0]!;
    const sampleFills = evidence
      .fullFills!.slice(0, 50)
      .map((fill) => diagnoseSampleFillSchema.parse(fill));
    Object.assign(scenario, evidence, {
      inputHash: "frozen-fixture",
      counts: { ...scenario.counts, fills: 52, closedTrades: 26 },
      sampleFills,
    });
    await publishDiagnoseArchive(detail);
    const archiveId = detail.summary.id;
    const dir = join(dataDir, "diagnose-archives", archiveId);
    const group = await readFile(join(dir, "diagnose-group.json"), "utf8");
    expect(group).not.toContain('"fullFills"');
    const restored = await readDiagnoseArchive(archiveId);
    expect(restored?.cells[0]?.scenarios[0]).toMatchObject({
      sampleFills,
      fullFills: evidence.fullFills,
    });
    const view = studioResultSchema.parse(
      await readStudioArchive({ archiveId }),
    );
    expect(view).toMatchObject({
      archiveId,
      jobId: "job-studio-evidence",
      equity,
      excursionDistribution: { count: 26, missing: 0 },
    });
    expect(view.tradeExcursions![0]).toMatchObject({
      strategyId: "fixture",
      sleeve: "book",
    });
    expect(view.topDrawdowns).toEqual(evidence.topDrawdowns);

    const sidecar = join(dir, "fill-evidence.json");
    const original = await readFile(sidecar, "utf8");
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    for (const code of ["EIO", "EBUSY"]) {
      vi.mocked(open).mockImplementation(async (...args) => {
        if (args[0] === sidecar)
          throw Object.assign(new Error("fixture read failure"), { code });
        return fs.open(...args);
      });
      try {
        const unreadable = await readDiagnoseArchive(archiveId);
        expect(unreadable?.summary.missingFiles).toContain(
          "fill-evidence.json",
        );
        expect(unreadable?.summary.driftWarnings.join(" ")).toContain(code);
        expect(unreadable?.cells[0]?.scenarios[0]?.sampleFills).toEqual(
          sampleFills,
        );
        expect(unreadable?.cells[0]?.scenarios[0]?.fullFills).toBeUndefined();
        const exported = await exportDiagnoseArchive(archiveId, "json");
        expect(JSON.parse(exported.content).cells).toEqual(unreadable?.cells);
      } finally {
        vi.mocked(open).mockReset();
      }
    }
    await writeFile(sidecar, original + "\n");
    const damaged = await readDiagnoseArchive(archiveId);
    expect(damaged?.summary.missingFiles).toContain("fill-evidence.json");
    expect(damaged?.cells[0]?.scenarios[0]?.sampleFills).toHaveLength(50);
    expect(damaged?.cells[0]?.scenarios[0]?.fullFills).toBeUndefined();
  });

  it("runs all three ETF families through the shared view with frozen inputs and risk enabled", async () => {
    const { runStudioEtfRotation } = await import("~/server/research/studio");
    const calendar = Array.from({ length: 115 }, (_, i) =>
      new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    );
    const series = Object.fromEntries(
      etfRotationUniverse.map(({ symbol }, index) => [
        symbol,
        {
          events: [],
          bars: calendar.map((date, i) => {
            const close = 8 + i * 0.005 * (1 + index / 21);
            return {
              date,
              open: close,
              high: close + 0.01,
              low: close - 0.01,
              close,
              volume: 2e6,
              amount: 2e6 * close,
            };
          }),
        },
      ]),
    );
    for (const { id } of etfRotationCatalog) {
      const executionReality = id === "etf-dual-momentum";
      const draft = studioEtfRotationInputSchema.parse({
        template: "etf-rotation",
        config: { strategyId: id },
        initial: 300_000,
        start: calendar[62],
        end: calendar.at(-1),
        riskPolicy: { maxIndustryWeight: 1 },
        executionReality,
      });
      const result = studioResultSchema.parse(
        await runStudioEtfRotation(draft, {
          source: {
            kind: "frozen",
            data: {
              calendar,
              series,
              calendarBasis: "synthetic calendar",
              actionsSource: "synthetic actions",
            },
          },
        }),
      );
      expect(result.strategyKey).toBe(id);
      expect(result.equity).toHaveLength(calendar.length - 62);
      expect(
        result.costScenarios.map(({ costScenario }) => costScenario),
      ).toEqual(["fixed", "base", "double-cost"]);
      expect(
        result.costScenarios.every(({ fills }) => fills !== null && fills > 0),
      ).toBe(true);
      if (executionReality) {
        expect(result.executionReality?.matrix).toHaveLength(9);
        expect(
          result.executionReality?.matrix.some(
            ({ missingQuotes }) => missingQuotes > 0,
          ),
        ).toBe(true);
      } else expect(result.executionReality).toBeNull();
    }
  });
});
