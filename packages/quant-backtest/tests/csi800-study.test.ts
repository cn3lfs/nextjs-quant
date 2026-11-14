import type { Csi800Stock } from "trading-strategies";
import { csi800Weights } from "trading-strategies";
import { describe, it, expect } from "vitest";
import { replayAllocationStudy } from "../src/allocation-profile.js";
import type { Bar } from "../src/model.js";
function fixture(length = 330) {
  const dates: string[] = [];
  for (let n = 0; dates.length < length; n++) {
    const d = new Date(Date.UTC(2020, 0, 1 + n));
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      dates.push(d.toISOString().slice(0, 10));
  }
  const bars = (k: number): Bar[] =>
    dates.map((date, i) => {
      const close = 10 + i * (0.01 + k * 0.001) + Math.sin(i) * 0.03;
      return {
        date,
        open: close,
        close,
        high: close * 1.03,
        low: close * 0.97,
        amount: 200_000_000,
        volume: 10_000_000,
      };
    });
  const stocks: Csi800Stock[] = Array.from({ length: 25 }, (_, i) => ({
    symbol: `sh${600000 + i}`,
    bars: bars(i),
    actions: [],
  }));
  return {
    stocks,
    benchmark: bars(1),
    options: { start: dates[275]!, end: dates[325]!, mode: "regime" as const },
  };
}
describe("CSI800 shared cash study", () => {
  it("retains the default scheduled cap and admits explicit full-weight strategies at the next opening", () => {
    const f = fixture();
    const first = f.benchmark.findIndex((bar) => bar.date === f.options.start);
    const signalDate = f.benchmark[first - 1]!.date;
    const symbol = f.stocks[0]!.symbol;
    const schedule = [{ date: signalDate, weights: { [symbol]: 1 } }];
    const options = {
      ...f.options,
      mode: "scheduled" as const,
      slippageBps: 0,
    };
    expect(() =>
      replayAllocationStudy(f.stocks, f.benchmark, options, schedule),
    ).toThrow("权重非法");
    const result = replayAllocationStudy(
      f.stocks,
      f.benchmark,
      { ...options, maximumWeight: 1 },
      schedule,
    );
    expect(result.options.maximumWeight).toBe(1);
    const buy = result.fills.find((fill) => fill.side === "buy")!;
    expect(buy.signalDate).toBe(signalDate);
    expect(buy.date).toBe(f.options.start);
    expect(buy.price).toBe(f.stocks[0]!.bars[first]!.open);
    expect(result.curve.every((row) => row.cash >= 0)).toBe(true);
    expect(result.curve[0]!.exposure).toBeGreaterThan(0.9);
  });
  it("rejects invalid scheduled caps without changing built-in allocation limits", () => {
    const f = fixture();
    for (const maximumWeight of [
      0,
      -0.1,
      1.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(() =>
        replayAllocationStudy(f.stocks, f.benchmark, {
          ...f.options,
          maximumWeight,
        }),
      ).toThrow("最大权重");
    const result = replayAllocationStudy(f.stocks, f.benchmark, {
      ...f.options,
      maximumWeight: 1,
    });
    expect(
      result.rebalances.every((row) =>
        Object.values(row.weights).every((weight) => weight <= 0.15 + 1e-12),
      ),
    ).toBe(true);
  });
  it("uses the registered transfer-fee and stamp-tax date boundaries", () => {
    const f = fixture(1000),
      symbol = f.stocks[0]!.symbol;
    for (const date of [
      "2022-04-28",
      "2022-04-29",
      "2023-08-25",
      "2023-08-28",
    ]) {
      const i = f.benchmark.findIndex((b) => b.date === date);
      const r = replayAllocationStudy(
        f.stocks,
        f.benchmark,
        { start: f.benchmark[i - 1]!.date, end: date, mode: "scheduled" },
        [
          { date: f.benchmark[i - 2]!.date, weights: { [symbol]: 0.15 } },
          { date: f.benchmark[i - 1]!.date, weights: {} },
        ],
      );
      const sale = r.fills.find((x) => x.side === "sell")!;
      expect(sale).toBeDefined();
      const amount = sale.price * sale.quantity;
      expect(sale.fee).toBeCloseTo(
        Math.max(5, amount * 0.0003) +
          amount * (date < "2022-04-29" ? 0.00002 : 0.00001) +
          amount * (date < "2023-08-28" ? 0.001 : 0.0005),
        6,
      );
    }
  });
  it("carries the prior completed signal into the common-window first opening", () => {
    const f = fixture(),
      first = f.benchmark.findIndex((b) => b.date === f.options.start);
    const signalDate = f.benchmark[first - 1]!.date,
      symbol = f.stocks[0]!.symbol;
    const result = replayAllocationStudy(
      f.stocks,
      f.benchmark,
      { ...f.options, mode: "scheduled" },
      [{ date: signalDate, weights: { [symbol]: 0.15 } }],
    );
    expect(result.fills[0]!.date).toBe(f.options.start);
    expect(result.fills[0]!.signalDate).toBe(signalDate);
    const delayed = replayAllocationStudy(
      f.stocks,
      f.benchmark,
      { ...f.options, mode: "scheduled", delay: 2 },
      [{ date: signalDate, weights: { [symbol]: 0.15 } }],
    );
    expect(delayed.fills[0]!.date).toBe(f.benchmark[first + 1]!.date);
    expect(() =>
      replayAllocationStudy(
        f.stocks,
        f.benchmark,
        { ...f.options, mode: "scheduled" },
        [{ date: signalDate, weights: { [symbol]: 0.151 } }],
      ),
    ).toThrow("权重非法");
    expect(() =>
      replayAllocationStudy(f.stocks, f.benchmark, {
        ...f.options,
        mode: "scheduled",
      }),
    ).toThrow("同时提供");
  });
  it("caps concentration and leaves unallocatable money in cash", () => {
    expect(() => csi800Weights([NaN], 1)).toThrow("权重输入非法");
    expect(csi800Weights([100, 1], 1)).toEqual([0.15, 0.15]);
    const w = csi800Weights(Array(20).fill(1), 1);
    expect(w.every((v) => v <= 0.15)).toBe(true);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("credits cash dividends and bonus shares without creating trading cash", () => {
    const f = fixture(),
      original = replayAllocationStudy(f.stocks, f.benchmark, f.options);
    const buy = original.fills.find((x) => x.side === "buy")!;
    const i = f.benchmark.findIndex((b) => b.date === buy.date);
    const date = f.benchmark[i + 1]!.date;
    const stock = f.stocks.find((s) => s.symbol === buy.symbol)!;
    stock.actions.push({ date, dividend: 0.2, bonus: 0.1, unsupported: false });
    for (const b of stock.bars)
      if (b.date >= date)
        for (const key of ["open", "close", "high", "low"] as const)
          b[key] = (b[key] - 0.2) / 1.1;
    const r = replayAllocationStudy(f.stocks, f.benchmark, f.options);
    const h = r.snapshots.find(
      (p) => p.date === date && p.symbol === buy.symbol,
    )!;
    expect(h.quantity).toBeCloseTo(buy.quantity * 1.1);
    expect(
      r.curve.find((p) => p.date === date)!.cash -
        original.curve.find((p) => p.date === date)!.cash,
    ).toBeCloseTo(buy.quantity * 0.2, 5);
    expect(r.curve.find((p) => p.date === date)!.equity).toBeCloseTo(
      original.curve.find((p) => p.date === date)!.equity,
      5,
    );
  });
  it("funds all stocks from one account and only trades after signals", () => {
    const f = fixture(),
      r = replayAllocationStudy(f.stocks, f.benchmark, f.options);
    expect(r.fills.length).toBeGreaterThan(10);
    expect(r.fills.every((x) => x.date > x.signalDate)).toBe(true);
    expect(
      r.rebalances.every((x) =>
        Object.values(x.weights).every((w) => w <= 0.15 + 1e-12),
      ),
    ).toBe(true);
    for (const p of r.curve) {
      expect(p.cash).toBeGreaterThanOrEqual(0);
      expect(p.exposure).toBeGreaterThanOrEqual(0);
      expect(p.exposure).toBeLessThanOrEqual(1);
    }
    const cash =
      1_000_000 +
      r.fills.reduce(
        (n, x) =>
          n + (x.side === "sell" ? 1 : -1) * x.quantity * x.price - x.fee,
        0,
      );
    expect(r.curve.at(-1)!.cash).toBeCloseTo(cash, 5);
  });
  it("future price mutations cannot rewrite earlier signals or fills", () => {
    const f = fixture(),
      original = replayAllocationStudy(f.stocks, f.benchmark, f.options);
    const date = f.benchmark[310]!.date;
    const altered = structuredClone(f.stocks);
    for (const s of altered)
      for (const b of s.bars)
        if (b.date > date)
          for (const key of ["open", "high", "low", "close"] as const)
            b[key] *= 1.2;
    const r = replayAllocationStudy(altered, f.benchmark, f.options);
    expect(r.curve.filter((p) => p.date <= date)).toEqual(
      original.curve.filter((p) => p.date <= date),
    );
    expect(r.rebalances.filter((p) => p.date <= date)).toEqual(
      original.rebalances.filter((p) => p.date <= date),
    );
  });
  it("negative controls reject duplicates and malformed prices", () => {
    const f = fixture();
    expect(() =>
      replayAllocationStudy(
        [...f.stocks, f.stocks[0]!],
        f.benchmark,
        f.options,
      ),
    ).toThrow("证券重复");
    f.stocks[0]!.bars[280]!.close = NaN;
    expect(() =>
      replayAllocationStudy(f.stocks, f.benchmark, f.options),
    ).toThrow("行情");
  });
  it("rejects buys locked at the upper limit", () => {
    const f = fixture();
    const r = replayAllocationStudy(f.stocks, f.benchmark, f.options);
    const buy = r.fills.find((x) => x.side === "buy")!;
    const stock = f.stocks.find((s) => s.symbol === buy.symbol)!;
    const i = stock.bars.findIndex((b) => b.date === buy.date);
    const p = Math.round(stock.bars[i - 1]!.close * 1.1 * 100) / 100;
    Object.assign(stock.bars[i]!, { open: p, close: p, high: p, low: p });
    const altered = replayAllocationStudy(f.stocks, f.benchmark, f.options);
    expect(
      altered.fills.some(
        (x) =>
          x.date === buy.date && x.symbol === buy.symbol && x.side === "buy",
      ),
    ).toBe(false);
    expect(
      altered.rejected.some(
        (x) => x.date === buy.date && x.symbol === buy.symbol,
      ),
    ).toBe(true);
  });
  it("stops rather than inventing accounting for held unsupported actions", () => {
    const f = fixture(),
      r = replayAllocationStudy(f.stocks, f.benchmark, f.options),
      buy = r.fills[0]!;
    const i = f.benchmark.findIndex((b) => b.date === buy.date);
    f.stocks
      .find((s) => s.symbol === buy.symbol)!
      .actions.push({
        date: f.benchmark[i + 1]!.date,
        dividend: 0,
        bonus: 0,
        unsupported: true,
      });
    expect(() =>
      replayAllocationStudy(f.stocks, f.benchmark, f.options),
    ).toThrow("未支持");
  });
});
