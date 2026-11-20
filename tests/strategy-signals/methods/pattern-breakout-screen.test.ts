import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePatternBreakout } from "trading-strategies";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import {
  czscSourceCommit,
  type CzscFamily,
  type CzscResult,
} from "trading-strategies/research/chan/czsc";
import type { Bar, Snapshot } from "~/lib/domain";
import {
  breakoutChartData,
  czscChartMarkers,
  patternChartData,
} from "~/lib/chart/chart-data";
import { strategyDecisionReason } from "~/lib/strategy-facts/decision-reason";
import {
  runPatternScreen,
  type PatternScreenRequest,
} from "~/server/screening/pattern-screen-service";
import {
  candle,
  reflectBars,
} from "../../../packages/trading-strategies/tests/ohlc-fixtures";

const io = vi.hoisted(() => ({
  readBars: vi.fn(),
  analyzeCzsc: vi.fn<(bars: Bar[]) => Promise<CzscResult>>(),
  putChangedBatch:
    vi.fn<
      (
        table: string,
        snapshots: Snapshot[],
        serialize: (s: Snapshot) => string,
      ) => void
    >(),
}));

vi.mock("~/server/infra/settings", () => ({
  settings: () => ({ tdxRoot: "fixture" }),
}));
vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars: io.readBars,
}));
vi.mock("~/server/strategies/chan/czsc", () => ({
  analyzeCzsc: io.analyzeCzsc,
}));
vi.mock("~/server/db", () => ({
  sqlite: () => ({}),
  putChangedBatch: io.putChangedBatch,
}));
vi.mock("~/server/db/rps-store", () => ({
  RpsStore: class {
    curve() {
      return [];
    }
  },
}));

function nativeResult(facts: Partial<CzscFamily>): CzscResult {
  return {
    status: "structure",
    hash: "native-table-fixture",
    sourceCommit: czscSourceCommit,
    families: [
      {
        config: 0,
        points: [],
        centers: [],
        signals: [],
        movements: [],
        qualities: [],
        divergences: [],
        ...facts,
      },
    ],
  };
}

const directionCases = [
  {
    direction: "long",
    sign: 1,
    suffix: "买",
    arrow: "↑",
    shape: "arrowUp",
    position: "belowBar",
  },
  {
    direction: "short",
    sign: -1,
    suffix: "卖",
    arrow: "↓",
    shape: "arrowDown",
    position: "aboveBar",
  },
] as const;

it.each(directionCases)(
  "renders all nine $direction Chanlun labels from native tables and excludes revoked points",
  ({ sign, suffix, shape, position }) => {
    const bars = Array.from({ length: 28 }, (_, i) => candle(i, 100));
    const date = (index: number) => bars[index]!.date;
    const signal = (index: number, kind: number, revokedAt = -1) => ({
      index,
      date: date(index),
      kind: kind * sign,
      quality: 2,
      confirmedAt: index,
      revokedAt,
    });
    const result = nativeResult({
      signals: [
        signal(0, 1, 0),
        signal(2, 1),
        signal(4, 2),
        signal(23, 3),
        {
          ...signal(24, 3),
          divergence: {
            areaRatio: 70,
            priceRatio: 80,
            speedRatio: 80,
            flags: 16,
            semantic: 3,
          },
        },
        signal(27, 2, 27),
      ],
      points: [
        { index: 8, confirmedAt: 10, direction: -sign, price: 100 - 10 * sign },
        { index: 12, confirmedAt: 14, direction: sign, price: 100 + 10 * sign },
        { index: 16, confirmedAt: 18, direction: -sign, price: 100 + 4 * sign },
        { index: 19, confirmedAt: 21, direction: sign, price: 100 + 12 * sign },
      ].map((point) => ({ ...point, date: date(point.index) })),
      breakouts: [
        {
          centerId: 1,
          direction: sign === 1 ? -1 : 1,
          leavePointId: 1,
          retestPointId: 3,
          third: true,
          confirmedAt: 20,
          divergence: {
            areaRatio: 60,
            priceRatio: 80,
            speedRatio: 70,
            flags: 16,
            semantic: 2,
          },
        },
      ],
      native: {
        config: 0,
        version: czscSourceCommit,
        completedSequence: "unavailable",
        highCandidates: [],
        trends: [
          {
            id: 1,
            config: 0,
            unit: 1,
            type: -sign,
            start: 1,
            end: 21,
            firstCenterId: 1,
            lastCenterId: 1,
            memberCenterIds: [1],
            completedAt: 20,
            completedByIndex: -1,
            confirmedAt: 20,
          },
        ],
      },
      diagnostics: {
        version: czscSourceCommit,
        lifecycle: [],
        nested: [
          {
            lowConfig: 0,
            sourceConfig: 1100,
            index: 2,
            level: 2,
            sourceCandidateId: 1,
            lowStartPointId: 0,
            lowEndPointId: 0,
            semantic: 1,
            confirmFlags: 3,
            direction: sign,
          },
        ],
        ma: [
          {
            index: 25,
            difference: sign,
            kiss: 2,
            volumeKiss: 0,
            instantWarning: 0,
          },
          {
            index: 26,
            difference: 2 * sign,
            kiss: 0,
            volumeKiss: 0,
            instantWarning: 0,
          },
        ],
      },
    });

    const markers = czscChartMarkers(result, "day", 0, bars);
    const labels = [
      [2, "笔1"],
      [2, "区间套"],
      [4, "笔2"],
      [8, "笔盘背1"],
      [16, "笔2+3"],
      [23, "笔3"],
      [23, "笔中阴"],
      [24, "笔小转大"],
      [26, "笔均线吻"],
    ] as const;
    expect(markers).toHaveLength(labels.length);
    expect(markers).toEqual(
      expect.arrayContaining(
        labels.map(([index, label]) => ({
          time: date(index),
          text: label + suffix,
          shape,
          position,
          color: sign === 1 ? "#cf5562" : "#28977f",
        })),
      ),
    );
    expect(markers.map((marker) => marker.time)).not.toContain(date(0));
    expect(markers.map((marker) => marker.time)).not.toContain(date(27));
  },
);

function upwardBreakout() {
  const bars = Array.from({ length: 65 }, (_, i) => candle(i, 114));
  // The latest two highs rise counter to the descending rail through 28 and 48.
  for (const [index, high] of [
    [16, 132],
    [28, 128.25],
    [40, 120],
    [48, 122],
  ] as const)
    bars[index] = candle(index, 114, { high });
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
  return bars;
}

it.each(directionCases)(
  "projects the $direction double-breakout marker and clipped trendline",
  ({ sign, arrow, shape, position }) => {
    const rising = sign === 1;
    const upward = upwardBreakout();
    const bars = rising ? upward : reflectBars(upward, 230);
    const color = rising ? "#7c3aed" : "#28977f";
    const view = breakoutChartData(analyzeBreakout(bars), bars, 32, 64, "day");
    expect(view.markers).toEqual([
      {
        time: bars[64]!.date,
        text: `双突破${arrow} 4/5`,
        color,
        shape,
        position,
      },
    ]);
    expect(view.lines).toContainEqual({
      title: rising ? "下降趋势线 · 3触" : "上升趋势线 · 3触",
      color,
      data: [
        { time: bars[32]!.date, value: rising ? 127 : 103 },
        { time: bars[64]!.date, value: rising ? 117 : 113 },
      ],
    });
  },
);

function shoulders() {
  const bars = Array.from({ length: 30 }, (_, i) => candle(i, 100));
  bars[4] = candle(4, 100, { low: 94 });
  bars[9] = candle(9, 100, { high: 110 });
  bars[14] = candle(14, 100, { low: 84 });
  bars[19] = candle(19, 100, { high: 115 });
  bars[24] = candle(24, 100, { low: 95 });
  bars[29] = candle(29, 122, { open: 112, volume: 200 });
  return bars;
}

function channel(
  [top, topSlope]: readonly [number, number],
  [floor, floorSlope]: readonly [number, number],
) {
  return Array.from({ length: 25 }, (_, i) => {
    const high = top + topSlope * i;
    const low = floor + floorSlope * i;
    const mid = (high + low) / 2;
    if (i === 24) return candle(i, high + 2, { open: mid, volume: 200 });
    if (i === 4 || i === 14) return candle(i, mid, { high });
    if (i === 8 || i === 18) return candle(i, mid, { low });
    return candle(i, mid);
  });
}

// Expected line endpoints are measured directly from the fixture's rails and necklines.
const patternCases = [
  {
    kind: "head-shoulders-bottom",
    direction: "long",
    bars: shoulders(),
    label: "头肩底突破↑",
    active: [
      [9, 110],
      [29, 120],
    ],
    passive: [
      [4, 94],
      [9, 110],
      [14, 84],
      [19, 115],
      [24, 95],
    ],
  },
  {
    kind: "head-shoulders-top",
    direction: "short",
    bars: reflectBars(shoulders(), 220),
    label: "头肩顶破位↓",
    active: [
      [9, 110],
      [29, 100],
    ],
    passive: [
      [4, 126],
      [9, 110],
      [14, 136],
      [19, 105],
      [24, 125],
    ],
  },
  {
    kind: "box",
    direction: "long",
    bars: channel([110, 0], [100, 0]),
    label: "箱体突破↑",
    active: [
      [4, 110],
      [24, 110],
    ],
    passive: [
      [4, 100],
      [24, 100],
    ],
  },
  {
    kind: "triangle",
    direction: "short",
    bars: reflectBars(channel([120, -0.5], [80, 0.5]), 200),
    label: "对称三角形↓",
    active: [
      [0, 80],
      [24, 92],
    ],
    passive: [
      [0, 120],
      [24, 108],
    ],
  },
  {
    kind: "wedge",
    direction: "long",
    bars: channel([135, -1.25], [90, -0.5]),
    label: "下降楔形↑",
    active: [
      [0, 135],
      [24, 105],
    ],
    passive: [
      [0, 90],
      [24, 78],
    ],
  },
] as const;

it.each(patternCases)(
  "projects $kind geometry and the $direction marker",
  ({ kind, direction, bars, label, active, passive }) => {
    const index = bars.length - 1;
    const matches = preparePatternBreakout(bars, { kinds: [kind] }).at(index);
    expect(matches).toHaveLength(1);
    const { lines, markers } = patternChartData(matches, bars, 0);
    const long = direction === "long";
    const color = long ? "#d97706" : "#0891b2";
    expect(markers).toEqual([
      {
        time: bars[index]!.date,
        text: `${label} ${matches[0]!.score}/5`,
        color,
        shape: long ? "arrowUp" : "arrowDown",
        position: long ? "belowBar" : "aboveBar",
      },
    ]);
    const points = (coordinates: readonly (readonly [number, number])[]) =>
      coordinates.map(([i, value]) => ({ time: bars[i]!.date, value }));
    expect(
      lines.map(({ data, color, lineStyle }) => ({ data, color, lineStyle })),
    ).toEqual(
      expect.arrayContaining([
        { data: points(active), color, lineStyle: 2 },
        {
          data: points(passive),
          color: "#64748b",
          lineStyle: kind.startsWith("head-shoulders") ? 0 : 2,
        },
      ]),
    );
    expect(lines).toHaveLength(2);
    expect(patternChartData(matches, bars, 0, index - 1)).toEqual({
      lines: [],
      markers: [],
    });
  },
);

describe("strategy decision reasons", () => {
  const reason = (kind: string, inputs: Record<string, unknown>) =>
    strategyDecisionReason({
      kind,
      inputs,
      close: 112,
      volume: 200,
      entry: true,
    });
  const prefix = "入场条件通过；信号收盘 112.0000；";

  it("formats pattern geometry evidence and omits a missing target", () => {
    expect(
      reason("pattern-breakout", {
        matches: [
          {
            label: "箱体突破↑",
            score: 4,
            pivotPrice: 110,
            volumeRatio: 2,
            stopPrice: 100,
            targetPrice: null,
          },
        ],
      }),
    ).toBe(
      prefix +
        "箱体突破↑ / 评分 4/5 / 突破位 110.0000 / 量比 2.00 / 止损 100.0000",
    );
  });

  it("formats the enriched Chanlun label and recorded endpoint", () => {
    expect(
      reason("czsc-monitor", {
        config: 0,
        fresh: [
          {
            kind: -2,
            code: "L2S",
            shortLabel: "笔2+3卖",
            endpointDate: "2025-01-17",
            quality: 2,
            stopPrice: 120,
            targetPrice: 100,
          },
        ],
      }),
    ).toBe(
      prefix +
        "笔2+3卖 / 端点 2025-01-17 / 质量 2 / 止损 120.0000 / 目标 100.0000",
    );
  });

  it("formats the first evaluation index for Chanlun third buy", () => {
    expect(reason("chan-third-buy", { rule: { firstIndex: 90 } })).toBe(
      prefix + "缠论三买 / 首个评估K线索引 90",
    );
  });

  it.each([
    { direction: "long", label: "向上", line: 110, stop: 105, target: 120 },
    { direction: "short", label: "向下", line: 114, stop: 118, target: 100 },
  ])(
    "formats $direction double-breakout evidence",
    ({ direction, label, line, stop, target }) => {
      expect(
        reason("double-breakout", {
          direction,
          stopPrice: stop,
          targetPrice: target,
          line: { value: line },
          keyLevel: { price: 112 },
          volumeRatio: 2,
          volume20: 100,
          checks: {
            trend: "是",
            level: true,
            volume: true,
            indicators: true,
            candle: false,
          },
        }),
      ).toBe(
        prefix +
          `趋势线 ${line}.0000 / 关键位 112.0000 / 量比 2.00 / 20期均量 100；` +
          `趋势通过 / 关键位通过 / 量能通过 / 指标通过 / K线未通过；方向 ${label}；止损 ${stop}.0000；目标 ${target}.0000`,
      );
    },
  );
});

describe("batch pattern screening", () => {
  const upSymbol = "sh600001";
  const downSymbol = "sh600002";
  const chanOnly = "sh600003";
  const noMatch = "sh600004";
  const up = upwardBreakout();
  const down = reflectBars(up, 230);
  const securities = new Map([
    [upSymbol, up],
    [downSymbol, down],
    [chanOnly, [candle(0, 100), candle(1, 101)]],
    [noMatch, [candle(0, 100), candle(1, 100)]],
    ...patternCases.map(({ bars }, i) => [`sh60001${i}`, bars] as const),
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date("2025-06-02T09:00:00Z"));
    io.readBars.mockImplementation(
      async ({ instrument }: { instrument: { symbol: string } }) => {
        const { symbol } = instrument;
        const bars = securities.get(symbol);
        if (!bars) throw new Error(`Unexpected fixture symbol: ${symbol}`);
        const rawBars = bars
          .map((b) => ({
            ...b,
            open: 2 * b.open,
            high: 2 * b.high,
            low: 2 * b.low,
            close: 2 * b.close,
            amount: 2 * b.amount,
          }))
          .reverse();
        return {
          symbol,
          hash: symbol,
          bars,
          rawBars,
          barStore: { formingDates: [], coverage: {} },
        };
      },
    );
    io.analyzeCzsc.mockImplementation(async (bars) => {
      const last = bars.at(-1)!;
      const signals: CzscFamily["signals"] = [];
      if (last.close === 119 || last.close === 101 || last.close === 111) {
        const index = bars.length - 1;
        const buy = last.close !== 111;
        signals.push({
          index,
          date: last.date,
          confirmedAt: index,
          kind: buy ? 1 : -2,
          quality: 2,
          stop: buy ? 95 : 120,
          revokedAt: -1,
          ...(buy
            ? {
                divergence: {
                  areaRatio: 60,
                  priceRatio: 80,
                  speedRatio: 70,
                  flags: 16,
                  semantic: 2,
                },
              }
            : {}),
        });
      }
      return nativeResult({ signals });
    });
  });

  afterEach(() => vi.useRealTimers());

  const doubleBreakout = { enabled: true, minScore: 4, minTouches: 3 } as const;
  const symbols = [upSymbol, downSymbol, chanOnly, noMatch];

  it("filters confirmed Chanlun matches by code and direction", async () => {
    const request = { symbols, lookbackBars: 1 };
    const buy = await runPatternScreen({
      ...request,
      chan: { enabled: true, codes: ["P1B"] },
    });
    expect(buy.errors).toEqual([]);
    expect(
      buy.candidates.map(({ symbol, direction, matches }) => [
        symbol,
        direction,
        matches[0]!.code,
      ]),
    ).toEqual([
      [upSymbol, "long", "P1B"],
      [chanOnly, "long", "P1B"],
    ]);
    const sell = await runPatternScreen({
      ...request,
      chan: { enabled: true, direction: "short", codes: ["P1B", "2S"] },
    });
    expect(sell.errors).toEqual([]);
    expect(
      sell.candidates.map(({ symbol, direction, matches }) => [
        symbol,
        direction,
        matches[0]!.code,
      ]),
    ).toEqual([[downSymbol, "short", "2S"]]);
  });

  it("screens both double-breakout directions and freezes date-aligned raw price levels", async () => {
    const result = await runPatternScreen({
      symbols,
      lookbackBars: 1,
      doubleBreakout,
    });
    expect(result.errors).toEqual([]);
    expect(
      result.candidates.map(
        ({
          symbol,
          direction,
          signalClose,
          rawClose,
          rawStopPrice,
          rawTargetPrice,
        }) => [
          symbol,
          direction,
          signalClose,
          rawClose,
          rawStopPrice,
          rawTargetPrice,
        ],
      ),
    ).toEqual([
      [upSymbol, "long", 119, 238, 218, 244],
      [downSymbol, "short", 111, 222, 242, 216],
    ]);
    expect(io.readBars).toHaveBeenCalledWith(
      expect.objectContaining({
        period: "day",
        adjustment: "forward",
        source: "local",
        freezeRaw: true,
      }),
    );
    expect(io.putChangedBatch).toHaveBeenCalledTimes(1);
    const [table, frozen, serialize] = io.putChangedBatch.mock.calls[0]!;
    expect(table).toBe("snapshot");
    expect(frozen.map((s) => s.id)).toEqual(
      result.candidates.map((c) => c.snapshotId),
    );
    expect(JSON.parse(serialize(frozen[0]!))).toMatchObject({
      historicalAsOf: up[64]!.date,
      bars: up,
      rawBars: up.map((b) => ({
        date: b.date,
        open: 2 * b.open,
        high: 2 * b.high,
        low: 2 * b.low,
        close: 2 * b.close,
        volume: b.volume,
        amount: 2 * b.amount,
      })),
    });
  });

  it.each(
    patternCases.map(({ kind, direction }, i) => ({
      kind,
      direction,
      symbol: `sh60001${i}`,
    })),
  )(
    "keeps only $kind matches in the batch",
    async ({ kind, direction, symbol }) => {
      const result = await runPatternScreen({
        symbols: patternCases.map((_, i) => `sh60001${i}`),
        lookbackBars: 1,
        patterns: { enabled: true, kinds: [kind] },
      });
      expect(result.errors).toEqual([]);
      expect(
        result.candidates.map((c) => ({
          symbol: c.symbol,
          direction: c.direction,
          kinds: c.matches.map((match) => match.kind),
        })),
      ).toEqual([{ symbol, direction, kinds: [kind] }]);
    },
  );

  it("uses a union for any and a same-bar intersection for all", async () => {
    const request = {
      symbols,
      lookbackBars: 2,
      doubleBreakout,
      chan: { enabled: true, codes: ["P1B"] },
    } satisfies PatternScreenRequest;
    // The down fixture has P1B on day 63 and a downward breakout on day 64.
    const earlierChan = await runPatternScreen({
      symbols: [downSymbol],
      lookbackBars: request.lookbackBars,
      chan: request.chan,
    });
    expect(earlierChan.errors).toEqual([]);
    expect(earlierChan.candidates.map((c) => c.date)).toEqual([down[63]!.date]);
    const any = await runPatternScreen({ ...request, combineMode: "any" });
    const all = await runPatternScreen({ ...request, combineMode: "all" });
    const families = (result: Awaited<ReturnType<typeof runPatternScreen>>) =>
      result.candidates.map((c) => [c.symbol, c.matches.map((m) => m.family)]);
    expect(any.errors).toEqual([]);
    expect(all.errors).toEqual([]);
    expect(families(any)).toEqual([
      [upSymbol, ["doubleBreakout"]],
      [downSymbol, ["doubleBreakout"]],
      [chanOnly, ["chan"]],
    ]);
    expect(families(all)).toEqual([[upSymbol, ["doubleBreakout", "chan"]]]);
  });
});
