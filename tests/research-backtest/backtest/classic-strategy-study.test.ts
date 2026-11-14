import { expect, it } from "vitest";
import { replayDailyStudy, studySignalBars } from "quant-backtest";
import { classicStudyStrategies } from "trading-strategies";
import type { Bar } from "quant-backtest";
const bars = (count = 200): Bar[] =>
  Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 105,
    low: 95,
    volume: 10000,
    amount: 1000000,
  }));
const input = bars();
const options = {
  start: input[140]!.date,
  end: input.at(-1)!.date,
  initial: 1000000,
  strategy: "hold" as const,
};
it("下一日开盘、整手、佣金及卖出税费按用户口径计算", () => {
  const data = bars();
  for (let i = 141; i < data.length; i++)
    data[i] = { ...data[i]!, open: 98, close: 97, high: 102, low: 90 };
  const r = replayDailyStudy(data, [], { ...options, strategy: "ma" });
  expect(r.fills.length).toBe(0);
  const h = replayDailyStudy(input, [], options),
    f = h.fills[0]!;
  expect(f.date).toBe(options.start);
  expect(f.signalDate < f.date).toBe(true);
  expect(f.shares).toBe(9900);
  expect(f.fee).toBe(99);
  expect(h.finalEquity).toBe(999901);
});
it("除息前持仓享权，当日开盘新买无分红；分红不可再投入", () => {
  const ex = input[150]!.date,
    events = [{ date: ex, perShare: 10 }];
  const r = replayDailyStudy(input, events, options);
  expect(r.dividends).toBe(99000);
  expect(r.fills.length).toBe(1);
  expect(r.curve.at(-1)!.shares).toBe(9900);
  expect(r.curve.at(-1)!.cash).toBe(9901);
  const fresh = replayDailyStudy(input, events, { ...options, start: ex });
  expect(fresh.dividends).toBe(0);
  const taxed = replayDailyStudy(input, events, {
    ...options,
    dividendTaxBps: 2000,
  });
  expect(taxed.dividends).toBe(79200);
});
it("所有策略追加未来行情和未来分红不改变此前成交或净值", () => {
  const full = bars(240).map((b, i) => {
    const p = 100 + Math.sin(i / 9) * 12 + i * 0.08;
    return { ...b, open: p, close: p + Math.sin(i), high: p + 5, low: p - 5 };
  });
  for (const strategy of classicStudyStrategies) {
    const short = replayDailyStudy(full.slice(0, 200), [], {
      ...options,
      strategy,
    });
    const long = replayDailyStudy(
      full,
      [{ date: full[220]!.date, perShare: 3 }],
      { ...options, strategy, end: full.at(-1)!.date },
    );
    expect(long.curve.slice(0, short.curve.length)).toEqual(short.curve);
    expect(long.fills.filter((f) => f.date <= options.end)).toEqual(
      short.fills,
    );
  }
});
it("网格保全底仓、无透支、每日最多一笔、卖出不含当日新买股", () => {
  const data = bars(260).map((b, i) => {
    const p = 100 + Math.sin(i / 5) * 15;
    return { ...b, open: p, close: p, high: p + 5, low: p - 5 };
  });
  const r = replayDailyStudy(data, [], {
    ...options,
    strategy: "grid",
    end: data.at(-1)!.date,
  });
  expect(r.fills.some((f) => f.side === "sell")).toBe(true);
  expect(new Set(r.fills.map((f) => f.date)).size).toBe(r.fills.length);
  for (const f of r.fills) {
    expect(f.shares % 100).toBe(0);
    expect(f.cash).toBeGreaterThanOrEqual(0);
    expect(f.holding).toBeGreaterThanOrEqual(r.coreShares);
    if (f.side === "sell")
      expect(f.fee).toBeCloseTo(
        Math.max(5, f.price * f.shares * 0.0001) + f.price * f.shares * 0.0005,
        6,
      );
  }
});
it("无量开盘拒绝、不用日内高低点补成交，非法输入拒绝", () => {
  const data = bars();
  data[140] = { ...data[140]!, volume: 0 };
  const r = replayDailyStudy(data, [], options);
  expect(r.rejected[0]!.date).toBe(options.start);
  expect(r.fills[0]!.date).toBe(data[141]!.date);
  expect(() => replayDailyStudy(input.slice(1, 80), [], options)).toThrow();
  expect(() => replayDailyStudy([...input].reverse(), [], options)).toThrow();
  expect(() =>
    replayDailyStudy(
      input,
      [
        { date: input[150]!.date, perShare: 1 },
        { date: input[150]!.date, perShare: 2 },
      ],
      options,
    ),
  ).toThrow();
});
it("后复权因子只从除息日生效", () => {
  const s = studySignalBars(input, [{ date: input[150]!.date, perShare: 10 }]);
  expect(s[149]!.close).toBe(100);
  expect(s[150]!.close).toBeCloseTo(10000 / 90);
});
it("突破必须排除当前日高点，退出在破20日低点后的下一开盘", () => {
  const data = bars().map((b, i) => {
    const p = 100 + i;
    return { ...b, open: p, close: p, high: p + 1, low: p - 1 };
  });
  // Previous close 239 is above the prior high 239 only after increasing the
  // close slightly; including today's high (240) would suppress this breakout.
  data[139] = { ...data[139]!, close: 239.5 };
  data[150] = { ...data[150]!, open: 250, close: 225, low: 224 };
  data[151] = { ...data[151]!, open: 240, close: 240, high: 245, low: 235 };
  const r = replayDailyStudy(data, [], { ...options, strategy: "breakout" });
  expect(r.fills[0]!.date).toBe(data[140]!.date);
  expect(r.fills[0]!.price).toBe(240);
  expect(r.fills[1]!.side).toBe("sell");
  expect(r.fills[1]!.signalDate).toBe(data[150]!.date);
  expect(r.fills[1]!.date).toBe(data[151]!.date);
});
it("布林低吸在平稳区间触发，回中轨后次日退出", () => {
  const data = bars();
  data[145] = { ...data[145]!, open: 100, close: 96, low: 95 };
  const r = replayDailyStudy(data, [], { ...options, strategy: "range" });
  expect(r.fills.map((f) => [f.side, f.signalDate, f.date])).toEqual([
    ["buy", data[145]!.date, data[146]!.date],
    ["sell", data[146]!.date, data[147]!.date],
  ]);
});
it("开盘涨停买单受阻，最后一天信号保持待执行而不提前成交", () => {
  const data = bars();
  data[140] = { ...data[140]!, open: 110, high: 112, low: 99, close: 100 };
  const held = replayDailyStudy(data, [], options);
  expect(held.rejected[0]!.reason).toBe("开盘涨停，无法证明买入成交");
  expect(held.fills[0]!.date).toBe(data[141]!.date);
  const last = bars();
  last[last.length - 1] = { ...last.at(-1)!, close: 96, low: 95 };
  const r = replayDailyStudy(last, [], { ...options, strategy: "range" });
  expect(r.fills).toHaveLength(0);
  expect(r.pending?.signalDate).toBe(options.end);
});
