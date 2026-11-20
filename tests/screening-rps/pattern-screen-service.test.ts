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
