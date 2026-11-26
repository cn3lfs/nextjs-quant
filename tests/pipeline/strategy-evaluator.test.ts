import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listTheoryScreenerSpecs } from "trading-strategies";
import { czscSourceCommit } from "trading-strategies/research/chan/czsc";
import {
  alphaExperimentSchema,
  createTargetSnapshot,
} from "~/lib/research/alpha-experiment";
import {
  createDeployment,
  type CreateDeploymentInput,
  type DeploymentRecord,
} from "~/server/db/deployment-repository";
import { migrate } from "~/server/db/migrations";
import {
  getOrCreatePipelineRun,
  getPipelineRun,
  listIntentsByRun,
  updatePipelineRunStage,
} from "~/server/db/pipeline-repository";
import {
  getActivePoolEntries,
  manualAddPoolEntry,
  recordPoolEntrySignal,
} from "~/server/db/pool-repository";
import { upsertSleeveHolding } from "~/server/db/sleeve-holding-repository";
import { runPipelinePlanning } from "~/server/pipeline/signal-risk-runner";
import {
  createStrategyTickDeps,
  evaluateDeploymentStrategy,
  evaluatedStrategyProposalSchema,
  type StrategyEvaluatorDeps,
} from "~/server/pipeline/strategy-evaluator";
import {
  parseEvaluatedPoolSnapshot,
  syncDeploymentPool,
} from "~/server/pipeline/universe-pool-runner";
import { candle } from "../../packages/trading-strategies/tests/ohlc-fixtures";

const sources = vi.hoisted(() => ({
  panel: vi.fn(),
  alpha: vi.fn(),
  composite: vi.fn(),
  chan: vi.fn(),
}));
vi.mock("~/server/research/alpha/panel", async (original) => ({
  ...(await original<typeof import("~/server/research/alpha/panel")>()),
  pinnedPanel: sources.panel,
}));
vi.mock("~/server/research/alpha", () => ({
  runAlphaEvaluation: sources.alpha,
}));
vi.mock("~/server/db/factor-composite-repository", () => ({
  getFactorComposite: sources.composite,
}));
vi.mock("~/server/strategies/chan/czsc", () => ({ analyzeCzsc: sources.chan }));

const A = "sh600001";
const B = "sh600002";
const panelId = "a".repeat(64);
const alphaDates = [
  "2024-02-06",
  "2024-02-07",
  "2024-02-08",
  "2024-02-19",
  "2024-02-20",
  "2024-02-21",
  "2024-02-22",
  "2024-02-23",
  "2024-02-26",
];
const alphaConfig = alphaExperimentSchema.parse({
  factors: [{ factorId: "amount" }],
});
const venue = { kind: "ths_mock", accountTag: "default" } as const;
let db: Database.Database;
let deploymentCount: number;
let fetchAttempt: ReturnType<typeof vi.fn>;

beforeEach(() => {
  expect(process.env.QUANT_DATA_DIR).toBeTruthy();
  db = new Database(":memory:");
  deploymentCount = 0;
  migrate(db);
  vi.resetAllMocks();
  fetchAttempt = vi.fn(() => {
    throw new Error("offline fixture");
  });
  vi.stubGlobal("fetch", fetchAttempt);
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  expect(fetchAttempt).not.toHaveBeenCalled();
});

function deploy(
  strategySpec: CreateDeploymentInput["strategySpec"],
  overrides: Partial<CreateDeploymentInput> = {},
) {
  return createDeployment(
    {
      name: `strategy evidence fixture ${++deploymentCount}`,
      market: "cn-equity",
      strategySpec,
      universeSpec: { kind: "fixed-symbols", symbols: [A] },
      venueBinding: venue,
      schedule: { kind: "manual_only" },
      regimeGate: { kind: "none" },
      riskPolicy: {},
      provenance: { sourceKind: "manual" },
      ...overrides,
    },
    db,
  );
}

type EvaluationInput = Parameters<typeof evaluateDeploymentStrategy>[0];
function evaluate(
  deployment: EvaluationInput["deployment"],
  decisionDate: string,
  deps: StrategyEvaluatorDeps,
  heldSymbols: string[] = [A],
) {
  return evaluateDeploymentStrategy({
    deployment,
    decisionDate,
    deps,
    heldSymbols,
    activePoolEntries: getActivePoolEntries(deployment.id, db),
    db,
  });
}

function holding(deployment: DeploymentRecord, date: string, price: number) {
  return upsertSleeveHolding(
    {
      accountScope: "ths_mock",
      accountId: "default",
      ownerKind: "deployment",
      ownerId: deployment.id,
      symbol: A,
      quantity: 100,
      avgEntryPrice: price,
      entryDate: date,
      updatedAt: Date.parse(date + "T10:00:00+08:00"),
    },
    db,
  );
}

function panel(sessions = alphaDates) {
  const close = vi.fn();
  sources.panel.mockResolvedValue({
    snapshotId: panelId,
    manifest: {
      dates: sessions,
      symbols: [
        {
          kind: "index",
          symbol: "sh000001",
          firstDate: sessions[0],
          lastDate: sessions.at(-1),
        },
      ],
    },
    sliceSymbol: () => ({
      dates: sessions,
      closeAtoms: sessions.map(() => 100),
    }),
    close,
  });
  return close;
}

async function archive(
  id = "frozen-alpha",
  alteredPanelId?: string,
  empty = false,
  range = { start: alphaDates[1]!, end: alphaDates[6]! },
) {
  const dates = alphaDates.filter(
    (date) => date >= range.start && date <= range.end,
  );
  const snapshot = await createTargetSnapshot(
    panelId,
    {
      ...range,
      targetOptions: { every: 3, topN: 2, maxWeight: 0.25 },
    },
    dates.map((date) => ({
      date,
      scores: empty ? [] : [{ symbol: A, score: 1 }],
    })),
    { calendarIndex: "sh000001", config: alphaConfig },
  );
  db.prepare(
    "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,'job',?,0)",
  ).run(
    id,
    JSON.stringify({
      id,
      type: "backtest",
      status: "completed",
      input: { mode: "alpha-backtest", payload: { snapshot } },
      result: { panelId: alteredPanelId ?? panelId },
    }),
  );
  return deploy(
    {
      kind: "alpha-composite",
      compositeId: "not-live-config",
      topN: 2,
      rebalanceCadence: "weekly",
    },
    { provenance: { sourceKind: "lab-backtest", sourceRefId: id } },
  );
}

it("uses the final actual session of a holiday-shortened week", async () => {
  const dep = deploy({
    kind: "alpha-composite",
    compositeId: "fixture",
    rebalanceCadence: "weekly",
  });
  const resolver = vi.fn(() => ({ [A]: 0.1 }));
  const deps = {
    readTradingSessions: () => ["2024-04-02", "2024-04-03", "2024-04-08"],
    resolveAlphaComposite: resolver,
  };
  expect(await evaluate(dep, "2024-04-02", deps)).toMatchObject({
    skipReason: "non-rebalance-day",
    mode: "delta-signals",
    targets: {},
  });
  expect(await evaluate(dep, "2024-04-03", deps)).toMatchObject({
    targets: { [A]: 0.1 },
  });
  expect(await evaluate(dep, "2024-04-08", deps)).toMatchObject({
    skipReason: "missing-data",
  });
  expect(resolver).toHaveBeenCalledTimes(1);
});

it.each([
  ["month-end", ["2023-12-28", "2023-12-29", "2024-01-02"]],
  ["quarter-end", ["2024-06-27", "2024-06-28", "2024-07-01"]],
] as const)(
  "uses the last actual market session of %s",
  async (rebalanceCadence, dates) => {
    const dep = deploy({ kind: "macro-clock", rebalanceCadence });
    const resolveMacroClock = vi.fn(() => ({
      regime: "recovery",
      targets: { [A]: 0.4 },
    }));
    const deps = { readTradingSessions: () => dates, resolveMacroClock };
    expect(await evaluate(dep, dates[0], deps)).toMatchObject({
      skipReason: "non-rebalance-day",
    });
    expect(await evaluate(dep, dates[1], deps)).toMatchObject({
      targets: { [A]: 0.4 },
    });
    expect(resolveMacroClock).toHaveBeenCalledTimes(1);
  },
);

it("uses the cached official next session when the local index has not advanced", async () => {
  const dep = deploy({ kind: "macro-clock", rebalanceCadence: "month-end" });
  const config = db.prepare(
    "INSERT INTO records (id,kind,payload,updated_at) VALUES (?,?,?,0)",
  );
  config.run(
    "settings",
    "settings",
    JSON.stringify({ tdxRoot: process.env.QUANT_DATA_DIR }),
  );
  const sessions = [
    20240131, 20240201, 20240202, 20240205, 20240206, 20240207, 20240208,
    20240219, 20240220, 20240221, 20240222, 20240223, 20240226, 20240227,
    20240228, 20240229, 20240301,
  ];
  config.run(
    "gf-calendar-1-2024-02",
    "gf-calendar",
    JSON.stringify({
      raw: {
        errCode: 0,
        data: Array.from({ length: 29 }, (_, i) => {
          const normDay = 20240201 + i;
          const preTrdDay = sessions.filter((day) => day < normDay).at(-1)!;
          const nxtTrdDay = sessions.find((day) => day > normDay)!;
          const isTrdDay = Number(sessions.includes(normDay));
          return {
            normDay,
            preTrdDay,
            nxtTrdDay,
            isTrdDay,
            latesTrdDay: isTrdDay ? normDay : preTrdDay,
          };
        }),
      },
    }),
  );
  expect(
    await evaluate(dep, "2024-02-29", {
      resolveMacroClock: () => ({ regime: "recovery", targets: { [A]: 0.4 } }),
    }),
  ).toMatchObject({ mode: "target-weights", targets: { [A]: 0.4 } });
});

it("runs ETF risk-budget only at month-end and distinguishes missing targets from explicit cash", async () => {
  const dep = deploy({
    kind: "etf-rotation",
    config: { strategyId: "etf-risk-budget" },
  });
  const resolveEtfRotation = vi
    .fn<NonNullable<StrategyEvaluatorDeps["resolveEtfRotation"]>>()
    .mockReturnValueOnce({})
    .mockReturnValueOnce(null)
    .mockReturnValueOnce({ [A]: 0 });
  const dates = ["2024-02-28", "2024-02-29", "2024-03-01"];
  const deps = { readTradingSessions: () => dates, resolveEtfRotation };
  expect(await evaluate(dep, dates[0]!, deps)).toMatchObject({
    skipReason: "non-rebalance-day",
  });
  for (let i = 0; i < 2; i++) {
    expect(await evaluate(dep, dates[1]!, deps)).toMatchObject({
      skipReason: "missing-data",
      mode: "delta-signals",
      targets: {},
      signals: [{ symbol: A, action: "HOLD" }],
    });
  }
  expect(await evaluate(dep, dates[1]!, deps)).toMatchObject({
    mode: "target-weights",
    allocation: "cash",
    targets: { [A]: 0 },
  });
});

it("reads a legacy all-zero checkpoint without converting it into a sell", () => {
  const legacy = {
    asOf: "2024-02-29",
    mode: "target-weights",
    targets: { [A]: 0 },
    signals: [],
    regimeScale: null,
    disclosure: "",
  };
  expect(evaluatedStrategyProposalSchema.parse(legacy)).toMatchObject({
    mode: "delta-signals",
    targets: {},
    signals: [],
  });
  expect(
    evaluatedStrategyProposalSchema.safeParse({
      ...legacy,
      skipReason: "missing-data",
      targets: { [A]: 0.3 },
    }).success,
  ).toBe(false);
});

it("honors the archived every-three-session epoch through holidays and persists the bound panel on skipped runs", async () => {
  const dep = await archive();
  const close = panel();
  const resolveAlphaComposite = vi.fn(() => ({ [A]: 0.25 }));
  const deps = createStrategyTickDeps({ resolveAlphaComposite });
  const off = await evaluate(dep, "2024-02-19", { ...deps });
  expect(off).toMatchObject({
    skipReason: "non-rebalance-day",
    panelSnapshotId: panelId,
    targets: {},
  });
  expect(await evaluate(dep, "2024-02-20", deps)).toMatchObject({
    mode: "target-weights",
    targets: { [A]: 0.25 },
    panelSnapshotId: panelId,
  });
  expect(resolveAlphaComposite).not.toHaveBeenCalled();
  expect(await evaluate(dep, "2024-02-23", deps)).toMatchObject({
    targets: { [A]: 0.25 },
  });
  expect(resolveAlphaComposite).toHaveBeenCalledWith(
    "not-live-config",
    2,
    "2024-02-23",
    {
      panelSnapshotId: panelId,
      config: alphaConfig,
      options: { every: 3, maxWeight: 0.25, topN: 2 },
    },
  );
  expect(sources.panel).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  const { run } = getOrCreatePipelineRun(
    {
      deploymentId: dep.id,
      decisionDate: off.asOf,
      executeDate: "2024-02-20",
      triggerKind: "manual",
    },
    db,
  );
  updatePipelineRunStage(run.id, { stage: "signals_done", signals: off }, db);
  expect(
    evaluatedStrategyProposalSchema.parse(getPipelineRun(run.id, db)?.signals),
  ).toEqual(off);
  expect(listIntentsByRun(run.id, db)).toEqual([]);
});

it("rejects an archive/panel mismatch and an unavailable epoch before evaluating", async () => {
  const mismatch = await archive("wrong-panel", "b".repeat(64));
  const truncated = await archive("truncated-panel");
  const resolveAlphaComposite = vi.fn(() => ({ [A]: 0.25 }));
  panel(alphaDates.slice(2));
  expect(
    await evaluate(mismatch, "2024-02-20", { resolveAlphaComposite }),
  ).toMatchObject({
    skipReason: "missing-data",
    targets: {},
  });
  expect(sources.panel).not.toHaveBeenCalled();
  expect(
    await evaluate(truncated, "2024-02-20", { resolveAlphaComposite }),
  ).toMatchObject({
    skipReason: "missing-data",
    panelSnapshotId: panelId,
    targets: {},
  });
  expect(resolveAlphaComposite).not.toHaveBeenCalled();
});

it("checks pinned coverage before accepting an empty frozen Alpha selection", async () => {
  const dep = await archive("empty-alpha", undefined, true);
  panel();
  const date = "2024-02-20";
  const evidence = (liquidity: number) => ({
    targetSnapshot: {
      panelId,
      calendarIndex: "sh000001",
      scheduledTargets: [{ date, targets: {} }],
    },
    daily: [{ date, eligible: 0, exclusions: { liquidity } }],
    metadata: { panelId },
  });
  sources.alpha
    .mockResolvedValueOnce(evidence(0))
    .mockResolvedValueOnce(evidence(5));
  const unavailable = await evaluate(dep, date, {});
  expect(unavailable).toMatchObject({
    skipReason: "missing-data",
    panelSnapshotId: panelId,
    targets: {},
  });
  const valid = await evaluate(dep, date, {});
  expect(valid.skipReason).toBeUndefined();
  expect(valid).toMatchObject({
    panelSnapshotId: panelId,
    mode: "target-weights",
    allocation: "cash",
  });
});

it("anchors a frozen range starting on a holiday to its first actual session", async () => {
  const dep = await archive("holiday-start", undefined, false, {
    start: "2024-02-10",
    end: "2024-02-25",
  });
  panel();
  for (const date of ["2024-02-19", "2024-02-22"])
    expect(await evaluate(dep, date, {})).toMatchObject({
      targets: { [A]: 0.25 },
      panelSnapshotId: panelId,
    });
  expect(await evaluate(dep, "2024-02-20", {})).toMatchObject({
    skipReason: "non-rebalance-day",
    panelSnapshotId: panelId,
  });
});

it("shares one unbound panel build per tick and scores only through the decision close", async () => {
  const close = panel();
  const date = "2024-02-20";
  sources.composite.mockReturnValue({
    config: { factors: alphaConfig.factors },
    updatedAt: Date.parse("2024-02-06"),
    weightingMethod: "equal",
    neutralizationMode: "none",
    winsorizeMethod: "mad",
  });
  sources.alpha.mockResolvedValue({
    targetSnapshot: {
      panelId,
      scheduledTargets: [
        { date: "2024-02-21", targets: { [B]: 0.1 } },
        { date, targets: { [A]: 0.1 } },
      ],
    },
    daily: [{ date }],
    metadata: { panelId },
  });
  const one = deploy({
    kind: "alpha-composite",
    compositeId: "one",
    rebalanceCadence: "daily",
  });
  const two = deploy({
    kind: "alpha-composite",
    compositeId: "two",
    rebalanceCadence: "daily",
  });
  const dependencies = { readTradingSessions: () => alphaDates };
  const tick = createStrategyTickDeps(dependencies);
  for (const result of await Promise.all([
    evaluate(one, date, tick),
    evaluate(two, date, { ...tick }),
  ])) {
    expect(result).toMatchObject({
      panelSnapshotId: panelId,
      targets: { [A]: 0.1 },
    });
  }
  expect(sources.panel).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(sources.alpha).toHaveBeenCalledTimes(2);
  expect(sources.alpha).toHaveBeenCalledWith(
    expect.objectContaining({
      now: Date.parse(date + "T23:59:59.999+08:00"),
      input: expect.objectContaining({
        snapshotId: panelId,
        start: date,
        end: date,
      }),
    }),
  );
  await evaluate(one, date, createStrategyTickDeps(dependencies));
  expect(sources.panel).toHaveBeenCalledTimes(2);
});

it("uses the owner fill cost for study exits and rejects a later cost revision", async () => {
  const dep = deploy({ kind: "study-rule", strategyId: "range" });
  const other = deploy({ kind: "study-rule", strategyId: "range" });
  const bars = Array.from({ length: 100 }, (_, index) =>
    candle(index, index === 99 ? 95 : 100),
  );
  const date = bars[99]!.date;
  const fillDate = bars[96]!.date;
  const deps = { readBars: () => bars };
  holding(other, fillDate, 110);
  expect(await evaluate(dep, date, deps)).toMatchObject({
    skipReason: "missing-data",
  });
  holding(dep, fillDate, 100);
  expect((await evaluate(dep, date, deps)).signals[0]?.action).toBe("HOLD");
  const revised = holding(dep, fillDate, 110);
  expect((await evaluate(dep, date, deps)).signals[0]?.action).toBe("SELL");
  upsertSleeveHolding(
    { ...revised, updatedAt: Date.parse(bars[99]!.date + "T16:00:00Z") },
    db,
  );
  expect(await evaluate(dep, date, deps)).toMatchObject({
    skipReason: "missing-data",
    signals: [{ action: "HOLD" }],
  });
});

it("starts theory hold duration at its own fill even if a watching BUY is much older", async () => {
  const methodId = listTheoryScreenerSpecs().find(
    (spec) => spec.direction === "long",
  )!.id;
  const dep = deploy({
    kind: "theory-screener",
    methodId,
    holdBars: 3,
    useScreenerStops: false,
  });
  const other = deploy({ kind: "theory-screener", methodId });
  const bars = Array.from({ length: 26 }, (_, index) => candle(index, 100));
  manualAddPoolEntry(
    dep.id,
    { symbol: A, asOf: bars[1]!.date, entryPrice: 120 },
    db,
  );
  recordPoolEntrySignal(
    dep.id,
    A,
    { action: "BUY", signalDate: bars[2]!.date },
    db,
  );
  holding(other, bars[3]!.date, 120);
  const deps = { readBars: () => bars };
  expect(await evaluate(dep, bars[20]!.date, deps)).toMatchObject({
    skipReason: "missing-data",
    signals: [{ action: "HOLD" }],
  });
  holding(dep, bars[20]!.date, 100);
  expect((await evaluate(dep, bars[22]!.date, deps)).signals[0]?.action).toBe(
    "HOLD",
  );
  expect((await evaluate(dep, bars[23]!.date, deps)).signals[0]?.action).toBe(
    "SELL",
  );
});

it("the breakout level mode changes the decision and is saved with the trend mode", async () => {
  const dep = deploy({ kind: "double-breakout" });
  const bars = Array.from({ length: 65 }, (_, i) => candle(i, 114));
  for (const [index, high] of [
    [3, 132],
    [16, 132],
    [28, 128.25],
    [40, 120],
    [48, 122],
  ])
    bars[index!] = candle(index!, 114, { high });
  bars[54] = candle(54, 114, { low: 109 });
  bars[61] = candle(61, 113);
  bars[62] = candle(62, 112);
  bars[63] = candle(63, 111);
  bars[64] = candle(64, 119, {
    open: 111,
    high: 119.5,
    low: 110.5,
    volume: 200,
  });
  const date = bars[64]!.date;
  manualAddPoolEntry(dep.id, { symbol: A, asOf: date }, db);
  const run = (
    levelMode: "all" | "structural",
    trendMode: "ma20" | "trendline" = "ma20",
    inputBars = bars,
  ) =>
    evaluate(
      {
        ...dep,
        strategySpec: { kind: "double-breakout", trendMode, levelMode },
      },
      date,
      { readBars: () => inputBars },
      [],
    );
  expect(await run("all")).toMatchObject({
    trendMode: "ma20",
    levelMode: "all",
    signals: [{ action: "BUY" }],
  });
  expect(await run("structural")).toMatchObject({
    trendMode: "ma20",
    levelMode: "structural",
    signals: [{ action: "HOLD" }],
  });
  const noTrendline = bars.map((bar, i) =>
    i === 64 || i >= 61 ? bar : candle(i, 114),
  );
  expect((await run("all", "ma20", noTrendline)).signals[0]?.action).toBe(
    "BUY",
  );
  expect((await run("all", "trendline", noTrendline)).signals[0]?.action).toBe(
    "HOLD",
  );
});

it("Chan filters the native signal by the recorded configuration", async () => {
  const dep = deploy({ kind: "chan-native", profile: "third" });
  const bars = Array.from({ length: 17 }, (_, i) => candle(i, 100));
  bars[14] = candle(14, 105, { low: 104 });
  const date = bars[16]!.date;
  manualAddPoolEntry(dep.id, { symbol: A, asOf: date }, db);
  sources.chan.mockResolvedValue({
    status: "structure",
    hash: "fixture",
    sourceCommit: czscSourceCommit,
    configId: "native-fixture",
    families: [
      {
        config: 1100,
        movements: [],
        qualities: [],
        divergences: [],
        points: [
          {
            index: 14,
            date: bars[14]!.date,
            confirmedAt: 16,
            price: 104,
            direction: -1,
          },
        ],
        centers: [
          {
            start: 1,
            end: 6,
            startDate: bars[1]!.date,
            endDate: bars[6]!.date,
            direction: -1,
            confirmedAt: 7,
            ZD: 98,
            ZG: 102,
            DD: 96,
            GG: 108,
          },
        ],
        signals: [
          {
            index: 14,
            date: bars[14]!.date,
            kind: 3,
            confirmedAt: 16,
            stop: 102,
            centerId: 1,
            quality: 1,
            revokedAt: -1,
          },
        ],
      },
    ],
  });
  for (const [config, action] of [
    [0, "HOLD"],
    [1100, "BUY"],
  ] as const) {
    expect(
      await evaluate(
        {
          ...dep,
          strategySpec: { kind: "chan-native", profile: "third", config },
        },
        date,
        { readBars: () => bars },
        [],
      ),
    ).toMatchObject({
      chanConfig: {
        profile: "third",
        configs: [config],
        anchor: 1,
        sourceCommit: czscSourceCommit,
        configId: "native-fixture",
      },
      signals: [{ action }],
    });
  }
  expect(
    await evaluate(
      {
        ...dep,
        strategySpec: {
          kind: "chan-native",
          profile: "third",
          config: 1100,
          configId: "other",
        },
      },
      date,
      { readBars: () => bars },
      [],
    ),
  ).toMatchObject({
    skipReason: "missing-data",
    chanConfig: { configId: "other" },
    signals: [],
  });
});

it("keeps the existing replace pool on an incomplete scan, while a valid empty scan evicts", async () => {
  const dep = deploy(
    { kind: "formula", name: "test", source: "X:1;" },
    {
      poolPolicy: { mode: "replace" },
      universeSpec: {
        kind: "formula-screen",
        formulaName: "test",
        source: "X:0;",
      },
    },
  );
  const date = "2024-02-20";
  const prior = manualAddPoolEntry(
    dep.id,
    { symbol: A, asOf: "2024-02-19" },
    db,
  );
  const sync = (result: [] | null) =>
    syncDeploymentPool({
      deployment: dep,
      decisionDate: date,
      deps: { runFormulaScreen: () => result },
      db,
    });
  const missing = parseEvaluatedPoolSnapshot(await sync(null));
  expect(missing).toMatchObject({ skipReason: "missing-data", evicted: [] });
  expect(getActivePoolEntries(dep.id, db)).toEqual([prior]);
  const result = await evaluateDeploymentStrategy({
    deployment: dep,
    decisionDate: date,
    activePoolEntries: [prior],
    heldSymbols: [A],
    universeSkipReason: missing.skipReason,
    db,
  });
  expect(result).toMatchObject({
    skipReason: "missing-data",
    signals: [{ action: "HOLD" }],
  });
  expect(await sync([])).toMatchObject({
    evicted: [{ symbol: A }],
    matchedCount: 0,
  });
  expect(getActivePoolEntries(dep.id, db)).toEqual([]);
});

it("does not admit a future bar to fill a missing formula scan session", async () => {
  const dep = deploy(
    { kind: "formula", name: "test", source: "X:1;" },
    {
      poolPolicy: { mode: "replace" },
      universeSpec: {
        kind: "formula-screen",
        formulaName: "test",
        source: "X:1;",
      },
    },
  );
  const bars = [candle(5, 100), candle(7, 100)];
  const snapshot = await syncDeploymentPool({
    deployment: dep,
    decisionDate: candle(6, 100).date,
    db,
    deps: { readMarketSymbols: () => [A], readBars: () => bars },
  });
  expect(snapshot).toMatchObject({ skipReason: "missing-data", added: [] });
  expect(getActivePoolEntries(dep.id, db)).toEqual([]);
});

it("checkpoints universe failures and liquidates only owned shares for an explicit cash allocation", async () => {
  const missing = deploy(
    { kind: "formula", name: "test", source: "X:1;" },
    {
      universeSpec: {
        kind: "formula-screen",
        formulaName: "test",
        source: "X:1;",
      },
    },
  );
  const empty = deploy({ kind: "macro-clock" });
  const date = "2024-02-29";
  for (const dep of [missing, empty]) {
    holding(dep, "2024-02-20", 10);
    const outcome = await runPipelinePlanning(
      {
        deploymentId: dep.id,
        decisionDate: date,
        executeDate: "2024-03-01",
        triggerKind: "manual",
        deps: {
          universe: { readBars: () => [], runFormulaScreen: () => null },
          strategy: {
            readTradingSessions: () => ["2024-02-29", "2024-03-01"],
            resolveMacroClock: () => ({
              regime: "recovery",
              targets: { [A]: 0 },
            }),
          },
          readAccountState: () => ({
            cash: 100_000,
            equity: 101_000,
            drawdownPct: null,
            positions: [
              {
                symbol: A,
                quantity: dep === empty ? 200 : 100,
                sellable: dep === empty ? 200 : 100,
                lastPrice: 10,
              },
            ],
          }),
          readIndustries: () => [],
        },
      },
      db,
    );
    if (dep === missing) {
      expect(outcome).toMatchObject({
        skipReason: "missing-data",
        run: { stage: "completed" },
        intents: [],
      });
    } else {
      expect(outcome.run.signals).toMatchObject({
        allocation: "cash",
        targets: { [A]: 0 },
      });
      expect(outcome.intents).toMatchObject([
        { side: "SELL", symbol: A, quantity: 100 },
      ]);
    }
  }
});
