import { expect, it } from "vitest";
import {
  technicalMethodDecision,
  technicalMethodProfiles,
  technicalConfluence,
  technicalRsiState,
  technicalIntradayRatio,
  researchTechnicalMethodSeries,
  type TechnicalMethodFacts as F,
  type TechnicalMethodId,
} from "../../../src/lib/research/technical/research-technical-methods";
const f = (patch: Partial<F> = {}): F => ({
  close: 100,
  open: 100,
  high: 101,
  low: 99,
  previousClose: 100,
  dif: 0,
  dea: 0,
  histogram: 0,
  k: 50,
  d: 50,
  strength: 50,
  ma5: 100,
  ma10: 100,
  ma20: 100,
  ma60: 100,
  support: 100,
  middle: 100,
  upper: 105,
  lower: 95,
  ratio: 1,
  high20: 102,
  low20: 98,
  highVolume: 1000,
  lowVolume: 1000,
  volume: 1000,
  range10: 0.1,
  ma20Change: 0.01,
  crossings: 0,
  top: false,
  bottom: false,
  doubleTop: false,
  doubleBottom: false,
  rsiTop: false,
  rsiBottom: false,
  ...patch,
});
type Case = [TechnicalMethodId, "entry" | "exit", Partial<F>[], Partial<F>[]];
const cases: Case[] = [
  [
    "sw-macd-negative",
    "exit",
    [
      { dif: -1, dea: -1 },
      { dif: -2, dea: -1 },
    ],
    [
      { dif: 1, dea: 1 },
      { dif: 0, dea: 1 },
    ],
  ],
  [
    "sw-macd-red",
    "entry",
    [{ histogram: 1 }, { histogram: 2 }, { histogram: 3 }],
    [{ histogram: 1 }, { histogram: 2 }, { histogram: 2 }],
  ],
  [
    "sw-macd-green",
    "exit",
    [{ histogram: -1 }, { histogram: -2 }, { histogram: -3 }],
    [{ histogram: -1 }, { histogram: -2 }, { histogram: -2 }],
  ],
  [
    "sw-macd-top",
    "exit",
    [{}, { top: true, strength: 49 }],
    [{}, { top: true, strength: 50 }],
  ],
  [
    "sw-macd-bottom",
    "entry",
    [{}, { bottom: true, strength: 51 }],
    [{}, { bottom: true, strength: 50 }],
  ],
  [
    "sw-macd-double-top",
    "exit",
    [{}, { doubleTop: true, strength: 49 }],
    [{}, { top: true, strength: 49 }],
  ],
  [
    "sw-macd-double-bottom",
    "entry",
    [{}, { doubleBottom: true, strength: 51 }],
    [{}, { bottom: true, strength: 51 }],
  ],
  [
    "sw-kdj-zone",
    "entry",
    [
      { k: 79, d: 79 },
      { k: 80, d: 79 },
    ],
    [
      { k: 79, d: 79 },
      { k: 81, d: 79 },
    ],
  ],
  ["sw-kdj-range", "entry", [{}, { k: 51 }], [{}, { k: 51, range10: 0.10001 }]],
  ["sw-rsi-state", "entry", [{}, { strength: 29 }], [{}, { strength: 30 }]],
  [
    "sw-rsi-neutral",
    "entry",
    [{ strength: 60 }, { strength: 61 }],
    [{ strength: 60 }, { strength: 60 }],
  ],
  ["sw-rsi-top", "exit", [{}, { rsiTop: true }], [{}, { top: true }]],
  ["sw-rsi-bottom", "entry", [{}, { rsiBottom: true }], [{}, { bottom: true }]],
  [
    "sw-boll-squeeze",
    "entry",
    [
      { upper: 106, lower: 94 },
      { upper: 105, lower: 95 },
      { upper: 104, lower: 96 },
      { close: 106, ratio: 1.5 },
    ],
    [
      { upper: 106, lower: 94 },
      { upper: 105, lower: 95 },
      { upper: 104, lower: 96 },
      { close: 106, ratio: 1.49 },
    ],
  ],
  [
    "sw-boll-expand",
    "entry",
    [{ middle: 99 }, { upper: 110, lower: 90, close: 101 }],
    [{ middle: 100 }, { upper: 110, lower: 90, close: 101 }],
  ],
  [
    "sw-boll-upper",
    "entry",
    [{ close: 104 }, { close: 104 }, { close: 104 }],
    [{ close: 104 }, { close: 103.99 }, { close: 104 }],
  ],
  [
    "sw-boll-lower",
    "exit",
    [{ close: 96 }, { close: 96 }, { close: 96 }],
    [{ close: 96 }, { close: 96.01 }, { close: 96 }],
  ],
  ...([20, 60, 120, 250] as const).map((n): Case => [
    `sw-support-${n}`,
    "entry",
    [{ close: 101 }, { close: 101, low: 100 }],
    [{ close: 101 }, { close: 100, low: 100 }],
  ]),
  [
    "sw-volume-up-up",
    "entry",
    [{}, { close: 103, ratio: 1.5 }],
    [{}, { close: 103, ratio: 1.49 }],
  ],
  [
    "sw-volume-up-down",
    "exit",
    [{}, { close: 103, ratio: 0.79 }],
    [{}, { close: 103, ratio: 0.8 }],
  ],
  [
    "sw-volume-down-up",
    "exit",
    [{}, { close: 97, ratio: 1.5 }],
    [{}, { close: 97, ratio: 1.49 }],
  ],
  [
    "sw-volume-down-down",
    "entry",
    [{ close: 97, high: 99, ratio: 0.79 }, { close: 100 }],
    [{ close: 97, high: 100, ratio: 0.79 }, { close: 100 }],
  ],
  [
    "sw-volume-top",
    "exit",
    [{}, { high: 103, volume: 999 }],
    [{}, { high: 103, volume: 1000 }],
  ],
  [
    "sw-volume-bottom",
    "entry",
    [{}, { low: 97, volume: 999 }],
    [{}, { low: 97, volume: 1000 }],
  ],
  [
    "sw-volume-breakout",
    "entry",
    [{}, { close: 103, ratio: 1.5 }],
    [{}, { close: 103, ratio: 1.49 }],
  ],
  [
    "sw-confluence",
    "entry",
    [{}, { close: 103, ratio: 1.5, dif: 1, strength: 51 }],
    [{}, { close: 103, ratio: 1.49, dif: 1, strength: 51 }],
  ],
  [
    "sw-direction",
    "entry",
    [
      {},
      {
        close: 103,
        ratio: 1.5,
        dif: 1,
        ma5: 104,
        ma10: 103,
        ma20: 102,
        ma60: 101,
      },
    ],
    [
      {},
      {
        close: 103,
        ratio: 1.5,
        dif: 1,
        ma5: 100,
        ma10: 101,
        ma20: 102,
        ma60: 103,
      },
    ],
  ],
  [
    "sw-kdj-size",
    "entry",
    [{}, { dif: 1, k: 81, ratio: 1.5 }],
    [{}, { dif: 1, k: 81, ratio: 1.49 }],
  ],
  [
    "sw-bear-order",
    "exit",
    [{}, { ma5: 97, ma10: 98, ma20: 99, ma60: 100 }],
    [{}, { ma5: 100, ma10: 98, ma20: 99, ma60: 100 }],
  ],
  [
    "sw-tangle",
    "entry",
    [{}, { close: 103, ratio: 1.5, crossings: 2 }],
    [{}, { close: 103, ratio: 1.5, crossings: 3 }],
  ],
];
it.each(cases)("%s 有独立正反例和等号边界", (id, side, yes, no) => {
  expect(technicalMethodDecision(id, yes.map(f))[side]).toBe(true);
  expect(technicalMethodDecision(id, no.map(f))[side]).toBe(false);
  expect(technicalMethodDecision(id, []).reason).not.toBeNull();
});
it("方法表全部有算法例或真实待数据适配例", () => {
  expect(new Set([...cases.map((x) => x[0]), "sw-intraday-ratio"])).toEqual(
    new Set(Object.keys(technicalMethodProfiles)),
  );
});
it("五票不重复计量、半仓及方向冲突", () => {
  const p = f();
  const two = f({ dif: 1, strength: 51, ratio: 1.5, close: 100 });
  expect(technicalConfluence(two, p)).toMatchObject({
    count: 2,
    fraction: 0.5,
  });
  expect(technicalConfluence({ ...two, close: 101 }, p)).toMatchObject({
    count: 3,
    fraction: 1,
  });
  expect(technicalConfluence({ ...two, ratio: 1.49 }, p).fraction).toBe(0);
  expect(
    technicalConfluence({ ...two, ma5: 97, ma10: 98, ma20: 99, ma60: 100 }, p),
  ).toMatchObject({ conflict: true, fraction: 0 });
  expect(
    technicalMethodDecision("sw-kdj-size", [
      p,
      f({ dif: 1, k: 81, ratio: 1.5 }),
    ]).entryFraction,
  ).toBe(0.5);
  expect(
    technicalMethodDecision("sw-kdj-size", [
      p,
      f({ dif: 1, k: 80, ratio: 1.5 }),
    ]).entryFraction,
  ).toBe(1);
  expect([29, 30, 40, 50, 60, 70, 71].map(technicalRsiState)).toEqual([
    "oversold",
    "boundary",
    "weak",
    "boundary",
    "strong",
    "boundary",
    "overbought",
  ]);
});
it("分时量比用每分钟分母、边界及未知拒绝", () => {
  const input = {
    date: "2020-01-02",
    availableDate: "2020-01-02",
    source: "fixed",
    volume: 150,
    elapsedMinutes: 120,
    sessionMinutes: 240,
    prior5DailyVolumes: [200, 200, 200, 200, 200],
    volumeUnit: "share" as const,
  };
  expect(technicalIntradayRatio(input, input.date)).toEqual({
    ratio: 1.5,
    band: "expanded",
    projectedVolume: 300,
  });
  for (const [v, band] of [
    [80, "normal"],
    [79, "contracted"],
    [300, "expanded"],
    [301, "abnormal"],
  ] as const)
    expect(
      technicalIntradayRatio({ ...input, volume: v }, input.date)?.band,
    ).toBe(band);
  expect(
    technicalIntradayRatio(
      { ...input, availableDate: "2020-01-03" },
      input.date,
    ),
  ).toBeNull();
  expect(
    technicalIntradayRatio({ ...input, elapsedMinutes: 0 }, input.date),
  ).toBeNull();
  expect(technicalIntradayRatio(undefined, input.date)).toBeNull();
  const bars = Array.from({ length: 65 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 200,
    amount: 20000,
  }));
  const last = bars.at(-1)!;
  Object.assign(last, { close: 103, high: 104 });
  expect(
    researchTechnicalMethodSeries("sw-intraday-ratio", bars).at(-1),
  ).toMatchObject({ entry: false, reason: expect.stringContaining("待数据") });
  expect(
    researchTechnicalMethodSeries("sw-intraday-ratio", bars, {
      [last.date]: { ...input, date: last.date, availableDate: last.date },
    }).at(-1)?.entry,
  ).toBe(true);
});

it.each([20, 60, 120, 250] as const)(
  "MA%s实际共享指标周期与回踩入场",
  (period) => {
    const bars = Array.from({ length: 270 }, (_, i) => ({
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: 100 + i,
      close: 100 + i,
      high: 101 + i,
      low: 99 + i,
      volume: 100,
      amount: 10000,
    }));
    const expected =
      bars.slice(-period).reduce((a, b) => a + b.close, 0) / period;
    bars.at(-1)!.low = expected;
    const last = researchTechnicalMethodSeries(`sw-support-${period}`, bars).at(
      -1,
    )!;
    expect(last.values.support).toBe(expected);
    expect(last.entry).toBe(true);
    bars.at(-1)!.low = expected + 0.01;
    expect(
      researchTechnicalMethodSeries(`sw-support-${period}`, bars).at(-1)!.entry,
    ).toBe(false);
  },
);
it("日涨跌2%等号不归涨跌信号", () => {
  expect(
    technicalMethodDecision("sw-volume-up-up", [
      f(),
      f({ close: 102, ratio: 1.5 }),
    ]).entry,
  ).toBe(false);
  expect(
    technicalMethodDecision("sw-volume-down-up", [
      f(),
      f({ close: 98, ratio: 1.5 }),
    ]).exit,
  ).toBe(false);
});

it("盘中量比不能延伸本地分钟历史窗口", () => {
  expect(
    technicalIntradayRatio(
      {
        date: "2023-01-03",
        availableDate: "2023-01-03",
        source: "fixed",
        volume: 100,
        elapsedMinutes: 120,
        sessionMinutes: 240,
        prior5DailyVolumes: [100, 100, 100, 100, 100],
        volumeUnit: "share",
      },
      "2023-01-03",
    ),
  ).toBeNull();
});
