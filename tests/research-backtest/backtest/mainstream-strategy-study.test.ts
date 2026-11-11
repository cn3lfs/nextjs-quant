import { expect, it } from "vitest";
import { runClassicStudy, type Bar } from "quant-backtest";
import { studyStrategies, classicStudyStrategies, studyCatalog, studyWarmup } from "trading-strategies";
import {
  cci,
  mfi,
  williamsR,
  chaikinMoneyFlow,
  dmi,
  supertrend,
  parabolicSar,
  ichimoku,
} from "trading-strategy-core/indicators";

function bars(count = 530): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + 0.03 * i + 12 * Math.sin(i / 13) + 2 * Math.sin(i / 3);
    return {
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      open: price,
      close: price + 0.2,
      high: price + 2,
      low: price - 2,
      volume: 10000 + (i % 7) * 5000,
      amount: price * 10000,
    };
  });
}
const data = bars();
const options = {
  start: data[300]!.date,
  end: data[499]!.date,
  initial: 1000000,
};

it("主流目录保留原七项并显式声明规则与预热，长周期缺历史拒绝", () => {
  expect(new Set(studyStrategies).size).toBe(studyStrategies.length);
  expect(studyStrategies.slice(0, 7)).toEqual(classicStudyStrategies);
  for (const strategy of studyStrategies) {
    expect(studyCatalog[strategy].rule.length).toBeGreaterThan(10);
    if (studyWarmup(strategy) === 300) {
      expect(() =>
        runClassicStudy(data.slice(160), [], { ...options, strategy }),
      ).toThrow("预热至少300日");
    }
  }
});

it("全部策略追加未来行情与现金事件不改变过去净值、成交、拒单及pending", () => {
  const before = structuredClone(data);
  for (const strategy of studyStrategies) {
    const short = runClassicStudy(data.slice(0, 500), [], {
      ...options,
      strategy,
    });
    const sameWindow = runClassicStudy(
      data,
      [{ date: data[520]!.date, perShare: 5 }],
      { ...options, strategy },
    );
    expect(sameWindow).toEqual(short);
    const longer = runClassicStudy(
      data,
      [{ date: data[520]!.date, perShare: 5 }],
      { ...options, strategy, end: data.at(-1)!.date },
    );
    expect(longer.curve.slice(0, short.curve.length)).toEqual(short.curve);
    expect(longer.fills.filter((f) => f.date <= options.end)).toEqual(
      short.fills,
    );
    for (const f of longer.fills) {
      expect(f.signalDate < f.date).toBe(true);
      expect(f.shares % 100).toBe(0);
      expect(f.cash).toBeGreaterThanOrEqual(0);
      expect(f.holding).toBeGreaterThanOrEqual(0);
      expect(f.price).toBe(data.find((b) => b.date === f.date)!.open);
      expect(f.fee).toBeCloseTo(
        Math.max(5, f.price * f.shares * 0.0001) +
          (f.side === "sell" ? f.price * f.shares * 0.0005 : 0),
        7,
      );
    }
    expect(new Set(longer.fills.map((f) => f.date)).size).toBe(
      longer.fills.length,
    );
  }
  expect(data).toEqual(before);
});

it("200日趋势只用已完成收盘，跌破后的下一开盘卖，仍按日末估值", () => {
  const input = bars().map((b, i) => ({
    ...b,
    open: i < 310 ? 101 : 99,
    close: i < 299 ? 100 : i < 309 ? 102 : 98,
    high: 105,
    low: 95,
  }));
  const result = runClassicStudy(input, [], { ...options, strategy: "sma200" });
  expect(
    result.fills.map((f) => [f.side, f.signalDate, f.date, f.price]),
  ).toEqual([
    ["buy", input[299]!.date, input[300]!.date, 101],
    ["sell", input[309]!.date, input[310]!.date, 99],
  ]);
});

it("仓位管理不使用隔离分红，分批建仓不注资、每月最多一批且最多12批", () => {
  const flat = bars(750).map((b) => ({
    ...b,
    open: 100,
    close: 100,
    high: 101,
    low: 99,
  }));
  const result = runClassicStudy(
    flat,
    [{ date: flat[350]!.date, perShare: 1 }],
    { ...options, end: flat.at(-1)!.date, strategy: "dca" },
  );
  expect(result.fills).toHaveLength(12);
  expect(new Set(result.fills.map((f) => f.signalDate.slice(0, 7))).size).toBe(
    12,
  );
  expect(result.fills.every((f) => f.shares === 800 && f.side === "buy")).toBe(
    true,
  );
  expect(result.curve.at(-1)!.cash).toBeCloseTo(39904);
  const cppi = runClassicStudy(flat, [], { ...options, strategy: "cppi" });
  expect(cppi.fills[0]!.shares).toBe(6000);
  const vol = runClassicStudy(flat, [], { ...options, strategy: "vol-target" });
  expect(vol.fills[0]!.shares).toBe(9900);
});

it("无定义的平盘指标不虚构反转信号，零资金流窗口保留null", () => {
  const flat = bars().map((b) => ({
    ...b,
    open: 100,
    close: 100,
    high: 100,
    low: 100,
    volume: 0,
  }));
  expect(cci(flat).at(-1)).toBeNull();
  expect(mfi(flat).at(-1)).toBeNull();
  expect(williamsR(flat).at(-1)).toBeNull();
  expect(chaikinMoneyFlow(flat).at(-1)).toBeNull();
  for (const strategy of [
    "cci",
    "mfi",
    "williams",
    "kdj",
    "rsi-reversion",
    "rsi2",
    "cmf",
  ] as const) {
    expect(runClassicStudy(flat, [], { ...options, strategy }).fills).toEqual(
      [],
    );
  }
});

it("再平衡数量来自信号日收盘，目标波动按252日样本波动率且受现金限制", () => {
  const flat = bars().map((b) => ({
    ...b,
    open: 100,
    close: 100,
    high: 106,
    low: 99,
  }));
  flat[300] = { ...flat[300]!, open: 105 };
  const mix = runClassicStudy(flat, [], {
    ...options,
    strategy: "constant-mix",
  });
  expect(mix.fills[0]!.shares).toBe(8000);
  expect(mix.fills[0]!.price).toBe(105);
  expect(mix.fills[0]!.cash).toBe(159916);
  const varied = flat.map((b, i) => {
    const p = i >= 279 && i < 300 && i % 2 === 0 ? 102 : 100;
    return { ...b, open: p, close: p };
  });
  const positive = 0.02,
    negative = 100 / 102 - 1,
    mean = (positive + negative) / 2;
  const dailyVol = Math.sqrt(
    (10 * (positive - mean) ** 2 + 10 * (negative - mean) ** 2) / 19,
  );
  const expectedShares =
    Math.floor((1000000 * 0.15) / (dailyVol * Math.sqrt(252)) / 100 / 100) *
    100;
  const vol = runClassicStudy(varied, [], {
    ...options,
    strategy: "vol-target",
  });
  expect(vol.fills[0]!.shares).toBe(expectedShares);
  expect(expectedShares).toBe(4600);
  flat[300] = { ...flat[300]!, volume: 0 };
  const retry = runClassicStudy(flat, [], { ...options, strategy: "dca" });
  expect(retry.rejected[0]!.date).toBe(flat[300]!.date);
  expect(retry.fills[0]!.date).toBe(flat[301]!.date);
  expect(
    retry.fills.filter(
      (f) => f.date.slice(0, 7) === flat[300]!.date.slice(0, 7),
    ),
  ).toHaveLength(1);
});

it("新增共享指标有手算基准，云层使用26日前数据而非未来绘图位置", () => {
  const line = [1, 2, 3].map((p, i) => ({
    ...data[i]!,
    open: p,
    close: p,
    high: p,
    low: p,
  }));
  expect(cci(line, 3)[2]).toBeCloseTo(100);
  const flow = [10, 11, 10, 12].map((p, i) => ({
    ...data[i]!,
    open: p,
    close: p,
    high: p,
    low: p,
    volume: 100,
  }));
  expect(mfi(flow, 3)[3]).toBeCloseTo((2300 / 3300) * 100);
  const range = data
    .slice(0, 30)
    .map((b) => ({ ...b, high: 12, low: 8, open: 10, close: 11 }));
  expect(williamsR(range)[29]).toBe(-25);
  expect(chaikinMoneyFlow(range)[29]).toBe(0.5);
  const up = data.slice(0, 100).map((b, i) => ({
    ...b,
    open: 100 + i,
    close: 101 + i,
    high: 102 + i,
    low: 100 + i,
  }));
  expect(dmi(up)[27]!.adx).toBeCloseTo(100);
  expect(supertrend(up).at(-1)!.bullish).toBe(true);
  expect(parabolicSar(up).at(-1)!.bullish).toBe(true);
  const cloud = ichimoku(up);
  // At t=77, span A is the average of 9/26 midpoints at t=51.
  expect(cloud[77]!.upper).toBeCloseTo((148 + 139.5) / 2);
  expect(cloud[77]!.lower).toBe(126.5);
  const shock = [
    ...up,
    {
      ...up[99]!,
      date: "2020-04-10",
      open: 100,
      close: 100,
      high: 101,
      low: 99,
    },
  ];
  expect(supertrend(shock).at(-1)!.bullish).toBe(false);
  expect(parabolicSar(shock).at(-1)!.bullish).toBe(false);
  for (const indicator of [
    cci,
    mfi,
    williamsR,
    chaikinMoneyFlow,
    dmi,
    supertrend,
    parabolicSar,
    ichimoku,
  ]) {
    expect(indicator(shock).slice(0, up.length)).toEqual(indicator(up));
  }
});
