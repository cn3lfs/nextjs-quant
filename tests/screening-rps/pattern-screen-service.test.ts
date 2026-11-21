import { beforeEach, expect, it, vi } from "vitest";
import { runPatternScreen } from "~/server/screening/pattern-screen-service";
import { serializeSnapshot } from "~/server/screening/snapshot-serializer";

const m = vi.hoisted(() => ({
  scan: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  curve: vi.fn(),
  native: vi.fn(),
  chan: vi.fn(),
  at: vi.fn(),
}));
vi.mock("~/server/infra/settings", () => ({
  settings: () => ({ tdxRoot: "fixture" }),
}));
vi.mock("~/server/data-sources/tdx/tdx", () => ({ scan: m.scan }));
vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: m.read }));
vi.mock("~/server/db", () => ({ sqlite: () => ({}), putChangedBatch: m.save }));
vi.mock("~/server/db/rps-store", () => ({
  RpsStore: class {
    curve = m.curve;
  },
}));
vi.mock("~/server/strategies/chan/czsc", () => ({ analyzeCzsc: m.native }));
vi.mock("trading-strategies", async (original) => ({
  ...(await original<typeof import("trading-strategies")>()),
  preparePatternBreakout: () => ({ at: m.at }),
  evaluateChanSignal: m.chan,
}));

const symbol = "sh600001";
const bars = ["2024-04-08", "2024-04-09", "2024-04-10"].map((date) => ({
  date,
  open: 9,
  high: 11,
  low: 8,
  close: 10,
  volume: 20,
  amount: 200,
}));
const hit = {
  direction: "long",
  summary: "fixture",
  stopPrice: 8,
  targetPrice: 14,
};
const chan = { enabled: true };
const patterns = { enabled: true };
beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockImplementation(async ({ instrument }) => ({
    symbol: instrument.symbol,
    hash: "fixture",
    bars,
    rawBars: bars.map((b) => ({ ...b, close: 20 })).reverse(),
    barStore: { formingDates: [bars[2]!.date], coverage: {} },
  }));
  m.chan.mockReturnValue({ matched: true, ...hit });
  m.at.mockReturnValue([]);
});

it("all rejects cheap misses without native work or persistence; any accepts Chan alone", async () => {
  const q = { chan, patterns, symbols: [symbol] };
  expect(
    (await runPatternScreen({ ...q, combineMode: "all" })).candidates,
  ).toEqual([]);
  expect(m.native).not.toHaveBeenCalled();
  expect(m.save).not.toHaveBeenCalled();
  const result = await runPatternScreen({ ...q, combineMode: "any" });
  expect(result.czscEvaluatedCount).toBe(1);
  expect(result.candidates[0]?.matches[0]?.family).toBe("chan");
  expect(m.scan).not.toHaveBeenCalled();
});

it("a cheap any hit or disabled Chan avoids native work; all requires Chan confirmation", async () => {
  m.at.mockReturnValue([hit]);
  for (const filters of [{ chan }, { chan: { enabled: false } }]) {
    const result = await runPatternScreen({
      patterns,
      ...filters,
      symbols: [symbol],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.czscEvaluatedCount).toBe(0);
  }
  m.chan.mockReturnValue({ matched: false });
  expect(
    (
      await runPatternScreen({
        patterns,
        chan,
        combineMode: "all",
        symbols: [symbol],
      })
    ).candidates,
  ).toEqual([]);
  expect(m.native).toHaveBeenCalledTimes(2);
});

it("looks up RPS on each completed date and freezes only the matching prefix and aligned raw levels", async () => {
  const other = "sh600002";
  m.curve.mockImplementation((s) =>
    s === symbol
      ? [
          {
            date: bars[0]!.date,
            periods: [50, 20],
            values: [{ rps: 10 }, { rps: 90 }],
          },
        ]
      : [],
  );
  const result = await runPatternScreen({
    chan,
    minRps20: 80,
    symbols: [other, symbol, symbol],
  });
  expect(result.errors).toEqual([]);
  expect(m.native).toHaveBeenCalledExactlyOnceWith(
    [bars[0]],
    true,
    undefined,
    true,
    1,
  );
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    symbol,
    date: bars[0]!.date,
    signalClose: 10,
    rawClose: 20,
    rawStopPrice: 16,
    rawTargetPrice: 28,
  });
  expect(m.save).toHaveBeenCalledExactlyOnceWith(
    "snapshot",
    [
      expect.objectContaining({
        id: result.candidates[0]!.snapshotId,
        bars: [bars[0]],
        rawBars: [{ ...bars[0], close: 20 }],
      }),
    ],
    serializeSnapshot,
  );
  expect(result.candidates[0]!.snapshotId).toMatch(/^snapshot-formula-/);
});

it("caps full-market native calls at 120 in stable symbol order and keeps later cheap hits", async () => {
  const symbols = Array.from(
    { length: 123 },
    (_, i) => "sh" + String(600000 + i),
  );
  m.scan.mockResolvedValue({
    securities: symbols
      .slice()
      .reverse()
      .map((symbol) => ({ symbol, period: "day" })),
  });
  m.chan.mockReturnValue({ matched: false });
  m.at.mockImplementation(() =>
    m.read.mock.lastCall?.[0].instrument.symbol === symbols.at(-1) ? [hit] : [],
  );
  const result = await runPatternScreen({ chan, patterns, lookbackBars: 1 });
  expect(m.read.mock.calls.map(([args]) => args.instrument.symbol)).toEqual(
    symbols,
  );
  expect(result.czscEvaluatedCount).toBe(120);
  expect(m.native).toHaveBeenCalledTimes(120);
  expect(result.candidates.map((c) => c.symbol)).toEqual(symbols.slice(-1));
});

// Interpolated trend whose final bar breaks the 20-day high on 2.3x volume,
// so the growth-oneil SEPA method emits a hit without any Chanlun fallback.
function trendBars() {
  const knots: [number, number][] = [
    [0, 40],
    [248, 99],
    [249, 102],
  ];
  let segment = 1;
  const end = knots.at(-1)![0];
  return Array.from({ length: end + 1 }, (_, i) => {
    while (i > knots[segment]![0]) segment++;
    const [a, x] = knots[segment - 1]!;
    const [b, y] = knots[segment]!;
    const close = x + ((y - x) * (i - a)) / (b - a);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      close,
      high: close + 0.1,
      low: close - 0.1,
      volume: i === end ? 230 : 100,
      amount: 1000,
    };
  });
}

function flatBars() {
  return Array.from({ length: 250 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 100.1,
    low: 99.9,
    volume: 100,
    amount: 1000,
  }));
}

function serve(rows: ReturnType<typeof flatBars>) {
  m.read.mockImplementation(async ({ instrument }) => ({
    symbol: instrument.symbol,
    hash: "fixture",
    bars: rows,
    rawBars: rows.map((b) => ({ ...b, close: 2 * b.close })).reverse(),
    barStore: { formingDates: [], coverage: {} },
  }));
}

it("screens theory families in any mode and attaches a risk position plan", async () => {
  serve(trendBars());
  const result = await runPatternScreen({
    theory: {
      enabled: true,
      families: ["growth-oneil"],
      methodIds: ["f09-sepa-trend-template"],
    },
    combineMode: "any",
    lookbackBars: 1,
    symbols: [symbol],
  });
  expect(result.errors).toEqual([]);
  expect(result.czscEvaluatedCount).toBe(0);
  expect(m.native).not.toHaveBeenCalled();
  expect(result.candidates).toHaveLength(1);
  const candidate = result.candidates[0]!;
  expect(candidate.matches[0]).toMatchObject({
    family: "theory",
    theoryFamily: "growth-oneil",
    methodId: "f09-sepa-trend-template",
    theoryId: "F09.02",
    direction: "long",
    label: "SEPA 趋势模板突破",
  });
  expect(candidate.positionPlan.confluenceGrade).toBe("B");
  expect(candidate.positionPlan.distinctFamilies).toBe(1);
  expect(candidate.positionPlan.recommendedShares % 100).toBe(0);
  expect(candidate.positionPlan.recommendedShares).toBeGreaterThan(0);
  expect(candidate.positionPlan.recommendedWeightPct).toBeGreaterThan(0);
  expect(candidate.positionPlan.riskPct).toBeGreaterThan(0);
  // Raw prices are doubled, so the plan's per-share risk stays proportional.
  expect(candidate.positionPlan.riskPct).toBeCloseTo(
    (candidate.rawClose - candidate.rawStopPrice!) / candidate.rawClose,
  );
});

it("applies the same-bar intersection in all mode and skips symbols without theory hits", async () => {
  serve(trendBars());
  const all = await runPatternScreen({
    theory: {
      enabled: true,
      families: ["growth-oneil"],
      methodIds: ["f09-sepa-trend-template"],
    },
    combineMode: "all",
    lookbackBars: 1,
    symbols: [symbol],
  });
  expect(all.errors).toEqual([]);
  expect(all.candidates).toHaveLength(1);
  expect(all.candidates[0]!.matches[0]?.family).toBe("theory");

  serve(flatBars());
  const miss = await runPatternScreen({
    theory: {
      enabled: true,
      families: ["growth-oneil"],
      methodIds: ["f09-sepa-trend-template"],
    },
    combineMode: "all",
    lookbackBars: 1,
    symbols: [symbol],
  });
  expect(miss.errors).toEqual([]);
  expect(miss.candidates).toEqual([]);
  expect(m.native).not.toHaveBeenCalled();
});

it("rebases an older signal before native evaluation when a later ex-date changed its price", async () => {
  const date = bars[0]!.date;
  const snapshot = (rows: typeof bars) => ({
    symbol,
    hash: "fixture",
    bars: rows,
    rawBars: bars,
    barStore: {
      adjustmentSource: "local-gbbq",
      formingDates: [],
      coverage: {},
    },
  });
  m.read.mockImplementation(async ({ to }) =>
    to === date
      ? snapshot([bars[0]!])
      : snapshot([{ ...bars[0]!, close: 5 }, ...bars.slice(1)]),
  );
  m.curve.mockReturnValue([{ date, periods: [20], values: [{ rps: 99 }] }]);
  const result = await runPatternScreen({
    chan,
    minRps20: 90,
    symbols: [symbol],
  });
  expect(result.errors).toEqual([]);
  expect(m.read.mock.calls[1]![0].to).toBe(date);
  expect(m.native).toHaveBeenCalledExactlyOnceWith(
    [bars[0]],
    true,
    undefined,
    true,
    1,
  );
  expect(result.candidates[0]).toMatchObject({
    date,
    rps20: 99,
    signalClose: 10,
    rawClose: 10,
  });
});

it("loads prior RPS for a one-bar theory scan and uses price fallback only on an empty curve", async () => {
  const rows = flatBars();
  const last = rows.at(-1)!;
  Object.assign(last, { close: 120, high: 121 });
  serve(rows);
  const dates = rows.slice(-2).map((bar) => bar.date);
  const query = {
    theory: { enabled: true, methodIds: ["f10-rps-turnaround"] },
    lookbackBars: 1,
    symbols: [symbol],
  };
  for (const [ranks, expected] of [
    [[84, 85], 1],
    [[95, 90], 0],
    [[], 1],
  ] as const) {
    m.curve.mockImplementation((_symbol, requested: string[]) =>
      dates.flatMap((date, i) =>
        requested.includes(date) && ranks[i] !== undefined
          ? [
              {
                date,
                periods: [10, 120],
                values: [{ rps: ranks[i] }, { rps: 60 }],
              },
            ]
          : [],
      ),
    );
    const result = await runPatternScreen(query);
    expect(result.errors).toEqual([]);
    expect(m.curve).toHaveBeenCalledWith(symbol, dates);
    expect(result.candidates).toHaveLength(expected);
  }
});
