import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import type { NativeStudyIdentity } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import type {
  FinancialCell,
  FinancialReportSnapshot,
} from "tstdx/financial-model";
import { settingsSchema } from "~/lib/domain";
import type { readBars } from "~/server/market/bar-store/read-bars";
import type { projectCzsc } from "~/server/strategies/chan/czsc";
import type {
  CzscRawFamily,
  CzscRawSignal,
} from "~/server/strategies/chan/czsc-api";
import { parseArgs } from "../../../scripts/backtest-diagnose";
import {
  prepareDiagnoseCell,
  replayDiagnoseCell,
} from "~/server/research/diagnose/cell";
import { prepareDiagnoseRequest } from "~/server/research/diagnose/prepare-request";
import { runDiagnose } from "~/server/research/diagnose/run";
import {
  buildStrategy,
  planDiagnoseCells,
} from "~/server/research/diagnose/strategy-specs";

vi.mock("~/server/research/causal-price-basis", async (original) => ({
  ...(await original<typeof import("~/server/research/causal-price-basis")>()),
  readResearchPriceActions: async () => ({
    events: new Map(),
    issues: [],
    recordCount: 0,
    sourceSha256: "synthetic",
  }),
}));
const identity: NativeStudyIdentity = {
  dllHash: "a".repeat(64),
  apiVersion: 22,
  buildCommit: "fixture",
  configId: "defaults",
  config: 0,
  anchor: 1,
};
const buySignal = 340,
  sellSignal = 346;
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
    const zd = index < sellSignal ? 105 : 102;
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
          zg: 110,
          zd,
          gg: 115,
          dd: zd - 1,
          direction: 1,
          confirmedAt: 12,
          established: 11,
          relationToPrev: 0,
          lifecycle: 0,
        },
      ],
      signals:
        index === buySignal
          ? [signal(2, buySignal)]
          : index === sellSignal
            ? [signal(-2, sellSignal)]
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

function financialCell(
  id: number,
  value: number | null,
  status: FinancialCell["status"] = "value",
): FinancialCell {
  const code = `FN${id}`;
  return {
    code,
    label: code,
    section: "synthetic",
    slot: id - 1,
    raw: value,
    value,
    unit: "synthetic",
    rawUnit: "synthetic",
    scale: 1,
    timing: "unknown",
    status,
    reason: status === "value" ? null : "synthetic missing field",
  };
}

function financialReports(symbol: string): FinancialReportSnapshot[] {
  // The year-end snapshots contain both annual fields and the standalone Q4
  // fields. Annual EPS compounds at 50%; Q4 EPS only clears C1 in 2020.
  const rows = [
    ["2017-12-31", "2018-03-28", "2018-03-29", 2, 1.5, 19, 90, 15],
    ["2018-12-31", "2019-03-28", "2019-03-29", 3, 2, 19, 120, 20],
    ["2019-12-31", "2020-03-31", "2020-04-01", 4.5, 2, 19, 150, 25],
    ["2020-12-31", "2021-03-31", "2021-04-01", 6.75, 3.2, 26, 210, 40],
  ] as const;
  return rows.map(
    ([
      period,
      announced,
      available,
      annualEps,
      quarterEps,
      roe,
      revenue,
      profit,
    ]) => ({
      symbol,
      financialCompany: false,
      reportDate: period,
      announcementDate: announced,
      availableFrom: available,
      sourceFilename: `gpcw${period.replaceAll("-", "")}.dat`,
      sourceSha256: "synthetic source",
      contentSha256: "synthetic content",
      recordOffset: 0,
      mappingVersion: "synthetic",
      fields: [
        financialCell(1, annualEps),
        financialCell(6, roe),
        financialCell(7, annualEps * 1.25),
        financialCell(230, revenue),
        financialCell(232, profit),
        financialCell(311, quarterEps),
      ],
      warnings: [],
    }),
  );
}

const symbols = Array.from({ length: 11 }, (_, i) => `sh${600000 + i}`);
const symbol = symbols[0]!;
const bars: Bar[] = Array.from(
  { length: 550 },
  (_, i) => new Date(Date.UTC(2020, 0, 1 + i)),
)
  .filter((date) => ![0, 6].includes(date.getUTCDay()))
  .slice(0, 380)
  .map((date) => ({
    date: date.toISOString().slice(0, 10),
    open: 110,
    close: 110,
    high: 111,
    low: 109,
    volume: 100000,
    amount: 11000000,
  }));
// Two contracting swings followed by a VCP breakout. CH14 and IBS enter
// together earlier, while the later annual high triggers CANSLIM separately.
bars[311]!.high = 120;
bars[321]!.low = 90;
bars[331]!.high = 115;
bars[341]!.low = 100;
for (let i = 331; i <= 341; i++) bars[i]!.volume = 10000;
bars[buySignal]!.low = 109.9;
bars[buySignal - 2]!.low = 108;
bars[buySignal + 1]!.amount = 7500000;
Object.assign(bars[351]!, { close: 117, high: 118, low: 110, volume: 200000 });
Object.assign(bars[360]!, { close: 121, high: 122, volume: 200000 });
const indexBars = bars.map((b, i) => ({
  ...b,
  open: 3000 + i,
  close: 3000 + i,
  high: 3001 + i,
  low: 2999 + i,
}));
const read: typeof readBars = async ({ instrument, period }) => ({
  id: instrument.symbol,
  hash: "fixture-bars",
  symbol: instrument.symbol,
  market: "cn-equity",
  period,
  requestedSource: "local",
  source: "tdx-local",
  adjustment: "none",
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
      from: bars[0]!.date,
      to: bars.at(-1)!.date,
      count: bars.length,
      historyExhausted: true,
    },
    formingDates: [],
    overlay: null,
    excluded: [],
  },
});
async function options() {
  const root = await mkdtemp(join(process.env.QUANT_DATA_DIR!, "book-"));
  return {
    config: settingsSchema.parse({ tdxRoot: root }),
    read,
    project: projector(),
    resolveIdentity: async () => identity,
    nativeCacheDir: join(root, "cache"),
    readFinancialHistory: async (_root: string, name: string) => ({
      reports: financialReports(name),
      issues: [],
    }),
    indexBars,
    start: bars[330]!.date,
    end: bars.at(-1)!.date,
    initial: 1000000,
    riskPerTrade: 0.02,
    maxPositions: 11,
    cost: "base" as const,
  };
}

it("replays four active sleeves from one freeze, enforcing shared turnover and account holdings across eleven candidates", async () => {
  const input = await options();
  const args = parseArgs([
    "--tdx-root",
    input.config.tdxRoot,
    "--book",
    "core-4",
    "--symbols",
    symbols.join(","),
  ]);
  const cell = await prepareDiagnoseCell(planDiagnoseCells(args)[0]!, input);
  const req = cell.frozen.request;
  expect(req).toMatchObject({
    accountMaxUniqueSymbols: 10,
    accountMaxSymbolWeight: 0.1,
    collectDailyDecisionCounts: true,
  });
  for (const { external } of req.instruments) {
    expect(external?.chan?.length).toBeGreaterThan(0);
    expect(
      external?.signals?.some(
        (s) => s.id === "research-canslim-pit-ma50" && s.entry,
      ),
    ).toBe(true);
  }
  expect(args).toMatchObject({
    maxParticipation: 0.005,
    capacityPolicy: "clip",
  });
  // Direct replay without explicit capacity overrides must inherit core-4's 0.5% shared cap.
  const {
    frozen: defaultFrozen,
    replay,
    disclosures,
    diagnostics,
  } = replayDiagnoseCell(cell, {});
  expect(defaultFrozen).toMatchObject({
    maxParticipation: 0.005,
    capacityPolicy: "clip",
  });
  expect(diagnostics.status, JSON.stringify(diagnostics.findings)).toBe("ok");
  const { fills, positionSnapshots, rejections } = replay.result;
  expect([...new Set(fills.map((f) => f.sleeve))].sort()).toEqual([
    "canslim",
    "chan",
    "ibs",
    "vcp",
  ]);
  expect(rejections.map((r) => r.reason)).toContain("账户跨分仓持仓品种上限");
  for (const date of req.calendar) {
    const held = new Map<string, number>();
    for (const p of positionSnapshots.filter((p) => p.date === date))
      held.set(p.symbol, (held.get(p.symbol) ?? 0) + p.weight);
    expect(held.size).toBeLessThanOrEqual(10);
    for (const w of held.values()) expect(w).toBeLessThanOrEqual(0.1);
  }
  const joint = fills.filter(
    (f) => f.symbol === symbol && f.date === bars[buySignal + 1]!.date,
  );
  expect(new Set(joint.map((f) => f.sleeve)), JSON.stringify(joint)).toEqual(
    new Set(["chan", "ibs"]),
  );
  expect(joint.some((f) => f.capacityClipped)).toBe(true);
  expect(
    joint.reduce((sum, f) => sum + f.quantity * f.price, 0),
  ).toBeLessThanOrEqual(bars[buySignal + 1]!.amount * 0.005);
  const a = disclosures.sleeveAttribution!;
  expect(a.correlations).toHaveLength(6);
  expect(a.maxDrawdown).toBeGreaterThan(0);
  const peak = Math.max(
    ...replay.result.curve
      .filter((p) => p.date <= a.troughDate)
      .map((p) => p.equity),
  );
  const trough = replay.result.curve.find(
    (p) => p.date === a.troughDate,
  )!.equity;
  expect(
    a.sleeves.reduce((sum, s) => sum + s.drawdownContribution, 0),
  ).toBeCloseTo(1 - trough / peak, 12);
});

it.each([
  [["--max-participation", "0.01"], 0.01, "clip"],
  [["--capacity-policy", "reject"], 0.005, "reject"],
  [
    ["--max-participation", "0.02", "--capacity-policy", "reject"],
    0.02,
    "reject",
  ],
] as const)(
  "applies independent core-4 overrides %j",
  (flags, maxParticipation, capacityPolicy) => {
    expect(
      parseArgs(["--tdx-root", process.cwd(), "--book", "core-4", ...flags]),
    ).toMatchObject({ maxParticipation, capacityPolicy });
  },
);

it("reuses CH14 v2 for ZD with zero additional projections and preserves two independent external signal series", async () => {
  const input = await options();
  const base = await prepareDiagnoseCell(
    {
      strategy: "research-chan-hold-cash",
      mode: "portfolio",
      symbols: [symbol],
    },
    input,
  );
  expect(input.project.mock.calls.length).toBeGreaterThan(0);
  input.project.mockClear();
  const keys = [
    "research-chan-hold-cash-zd-stop",
    "research-canslim-pit-ma50",
    "research-sepa-vcp-close-price",
  ] as const;
  const strategies = keys.map((key) => ({
    ...buildStrategy(key, [symbol], "portfolio"),
    sleeve: key,
  }));
  const prepared = await prepareDiagnoseRequest({
    ...input,
    costScenario: input.cost,
    forceCausalPrice: true,
    strategy: strategies[0]!,
    additionalStrategies: strategies.slice(1),
    sleeves: keys.map((id) => ({
      id,
      share: 1 / 3,
      riskPerTrade: 0.02,
      maxPositions: 1,
    })),
  });
  expect(input.project).not.toHaveBeenCalled();
  expect(prepared.nativeChan).toMatchObject([
    {
      strategyKey: keys[0],
      symbol,
      projectionVersion: 2,
      cached: true,
      zdStop: { levelCount: 2 },
    },
  ]);
  expect(
    prepared.growthPit?.map((row) => [row.strategyKey, row.symbol]),
  ).toEqual(keys.slice(1).map((k) => [k, symbol]));
  const external = prepared.frozen.request.instruments[0]!.external!;
  expect(external.chan).toEqual(
    base.frozen.request.instruments[0]!.external!.chan,
  );
  expect(external.levels).toContainEqual({
    date: bars[buySignal]!.date,
    availableAt: bars[buySignal]!.date,
    field: "chan-zd",
    value: 105,
  });
  const signals = external.signals!;
  expect(signals.map((s) => s.date)).toEqual(signals.map((s) => s.date).sort());
  const entries = (id: string) =>
    signals.filter((s) => s.id === id && s.entry).map((s) => s.date);
  expect(entries(keys[1])).toContain(bars[360]!.date);
  expect(entries(keys[2])).toEqual([bars[351]!.date]);
  expect(
    prepared.growthPit?.find((row) => row.strategyKey === keys[2]),
  ).toMatchObject({ maxBars: 6 });
  const result = runPortfolio(prepared.frozen.request);
  expect(
    result.fills.some((f) => f.sleeve === keys[0] && f.side === "buy"),
  ).toBe(true);
});

it("retains both external PIT disclosures on one strategy and symbol", async () => {
  const input = await options();
  const entryId = "research-sepa-vcp-close-price";
  const exitId = "research-canslim-pit-ma50";
  const prepared = await prepareDiagnoseRequest({
    ...input,
    costScenario: input.cost,
    forceCausalPrice: true,
    strategy: {
      ...buildStrategy(entryId, [symbol], "single"),
      id: "diag-mixed",
      exit: { rule: { kind: "external", id: exitId, side: "exit" } },
    },
  });
  expect(
    prepared.frozen.sources.find((s) => s.symbol === symbol)
      ?.growthPitByStrategy,
  ).toMatchObject({
    mixed: {
      [entryId]: { symbol, ruleId: entryId, maxBars: 6 },
      [exitId]: {
        symbol,
        ruleId: exitId,
        exitAblation: { kind: "ma-close-breakdown", period: 50 },
      },
    },
  });
});

it("writes the book, signed attribution and historical review with three legs to the CLI artifacts", async () => {
  const input = await options();
  const args = parseArgs([
    "--tdx-root",
    input.config.tdxRoot,
    "--symbols",
    symbol,
    "--book",
    "core-4",
    "--holdout-start",
    bars[363]!.date,
  ]);
  const {
    cells: [cell],
    reportPath,
  } = await runDiagnose({ ...args, ...input, outDir: input.config.tdxRoot });
  expect(cell?.status, cell?.error).toBe("ok");
  const review = cell!.timeHoldout!;
  expect(review.status).toBe("reviewed");
  expect(review.devWindowRange!.end < review.holdoutStart).toBe(true);
  expect(Object.keys(review.holdout!)).toEqual([
    "base",
    "doubledCost",
    "delayed",
  ]);
  const summary = JSON.parse(
    await readFile(join(cell!.runPath, "summary.json"), "utf8"),
  );
  expect(summary.timeHoldout).toEqual(review);
  expect(summary.sleeveAttribution.correlations).toHaveLength(6);
  const report = await readFile(reportPath, "utf8");
  for (const label of [
    "historical-holdout-review",
    "Dev 滚动窗",
    "通过风险调整标准的窗口数",
    "Holdout",
    "doubledCost",
    "delayed",
    "DSR",
    "PBO",
    "峰谷回撤贡献",
    "分仓日收益相关性",
  ])
    expect(report).toContain(label);
  expect(
    JSON.parse(await readFile(join(cell!.runPath, "run.json"), "utf8"))
      .strategies,
  ).toHaveLength(4);
});

function bar(index: number, close: number, overrides: Partial<Bar> = {}): Bar {
  return {
    date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    open: close - 0.1,
    close,
    high: close + 0.5,
    low: close - 0.5,
    volume: 100,
    amount: close * 100,
    ...overrides,
  };
}

function jacBars() {
  const anchors = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
  ] as const;
  const bars = Array.from({ length: 150 }, (_, index) => {
    const i = index - 60;
    if (i < 0) return bar(index, 80);
    const right = anchors.findIndex(([at]) => at >= i);
    const [start, from] = anchors[Math.max(0, right - 1)]!;
    const [end, to] = anchors[right]!;
    return bar(
      index,
      from + ((to - from) * (i - start)) / Math.max(1, end - start),
    );
  });
  bars.push(
    bar(150, 105, { open: 102, low: 102, high: 105.1, volume: 150 }),
    bar(151, 105, { open: 104.9, low: 104.6, high: 105.2 }),
  );
  return bars;
}

function lpsyBars() {
  return [
    ...jacBars(),
    bar(152, 99, { open: 105.2, high: 105.4, low: 98, volume: 180 }),
    bar(153, 99, { open: 99, high: 100, low: 98.5 }),
    bar(154, 99.5, { open: 99.2, high: 100, low: 99, volume: 40 }),
    bar(155, 98.5, { open: 99, high: 99.8, low: 98 }),
  ];
}

function wyckoffReplay(
  rows: Bar[],
  instrument: PortfolioRequest["instruments"][number],
) {
  const strategy = buildStrategy("research-wy-sow-lpsy", [symbol], "single");
  return runPortfolio({
    market: "cn-equity",
    initial: 110000,
    start: rows[140]!.date,
    end: rows.at(-1)!.date,
    calendar: rows.slice(140).map((b) => b.date),
    strategies: [strategy],
    sleeves: [
      { id: strategy.sleeve, share: 1, riskPerTrade: 1, maxPositions: 1 },
    ],
    maxParticipation: 0.005,
    capacityPolicy: "clip",
    instruments: [instrument],
  });
}

it("executes the real LPSY half-sale once through T+1, limit-down and capacity-limited retries", () => {
  const rows = [
    ...lpsyBars(),
    ...Array.from({ length: 8 }, (_, i) => bar(156 + i, 98.5)),
  ];
  // A four-for-one ex-date preserves economic value. After the original lot
  // sells, the bonus shares remain locked for a session before limit-down.
  const marketBars = rows.map((b, i) => ({
    ...b,
    ...(i >= 156 && {
      open: b.open / 4,
      high: b.high / 4,
      low: b.low / 4,
      close: b.close / 4,
    }),
    amount: i < 158 ? 1e9 : 2e6,
    ...(i === 158 && { open: 22.16, close: 22.16, low: 22.16, high: 22.16 }),
  }));
  const result = wyckoffReplay(rows, {
    symbol,
    market: "cn-equity",
    bars: marketBars,
    signalBars: rows,
    actions: [
      {
        date: rows[156]!.date,
        availableAt: rows[156]!.date,
        bonus: 3,
        dividend: 0,
        sharesSellableAt: rows[158]!.date,
        evidence: "fixture bonus settlement",
      },
    ],
    execution: (b) => ({
      tradable: true,
      evidence: "fixture",
      minimum: 100,
      step: 100,
      limitUp: null,
      limitDown: b?.date === marketBars[158]!.date ? 22.16 : null,
      slippagePolicy: "none",
    }),
  });
  expect(result.rejections.map((r) => r.reason).join(" ")).toMatch(
    /T\+1.*跌停/,
  );
  const [buy, ...sales] = result.fills;
  expect(buy!.quantity).toBe(1000);
  expect(sales.length).toBeGreaterThan(1);
  expect(sales.reduce((sum, f) => sum + f.quantity, 0)).toBe(2000);
  expect(result.positions[0]!.quantity).toBe(2000);
  expect(result.orders.filter((o) => o.side === "sell")).toMatchObject([
    { status: "filled", exitFraction: 0.5, targetRemainingQuantity: 2000 },
  ]);
});

it.each([
  { event: "UT", partialFill: 500 },
  { event: "破冰", partialFill: 100 },
])(
  "closes the JAC position on $event after selling $partialFill shares on LPSY",
  ({ event, partialFill }) => {
    const after =
      event === "UT"
        ? [
            bar(156, 104, { open: 104, high: 107, low: 103 }),
            bar(157, 102, { open: 104, high: 105, low: 101, volume: 200 }),
          ]
        : [bar(156, 94, { open: 99, high: 99, low: 93, volume: 250 })];
    const fullAt = after.at(-1)!.date;
    const rows = [...lpsyBars(), ...after, bar(156 + after.length, 98)];
    const result = wyckoffReplay(rows, {
      symbol,
      market: "cn-equity",
      signalBars: rows,
      bars: rows.map((b, i) => ({
        ...b,
        amount: i === 156 && partialFill === 100 ? 2.5e6 : 1e9,
      })),
      execution: {
        tradable: true,
        evidence: "fixture",
        step: 100,
        minimum: 100,
        limitUp: null,
        limitDown: null,
        slippagePolicy: "none",
      },
    });
    expect(result.fills).toMatchObject([
      { signalAt: rows[151]!.date, side: "buy", quantity: 1000 },
      { signalAt: rows[155]!.date, side: "sell", quantity: partialFill },
      {
        signalAt: fullAt,
        date: rows.at(-1)!.date,
        side: "sell",
        quantity: 1000 - partialFill,
        holdingAfter: 0,
      },
    ]);
    expect(result.orders.filter((o) => o.side === "sell")).toMatchObject([
      {
        exitFraction: 0.5,
        targetRemainingQuantity: 500,
        status: partialFill === 500 ? "filled" : "rejected",
      },
      { signalAt: fullAt, status: "filled" },
    ]);
  },
);
