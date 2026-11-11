import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import { runClassicStudy } from "quant-backtest";
import {
  createExtendedStudyRule,
  getStrategyDefinition,
} from "trading-strategies";

it("runs the 98% price-only crossing then requests exit after exactly five held observations", () => {
  const bars: Bar[] = Array.from({ length: 380 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: i < 367 ? 80 : 100,
    close: i < 366 ? 80 : 100,
    high: 101,
    low: 79,
    volume: 10000,
    amount: 1000000,
  }));
  const rule = createExtendedStudyRule("research-growth", bars)!;
  expect(rule(366, { entry: 0, entryIndex: 0 })).toMatchObject({
    enter: true,
    exit: false,
  });
  expect(rule(371, { entry: 100, entryIndex: 367 }).exit).toBe(false);
  expect(rule(372, { entry: 100, entryIndex: 367 }).exit).toBe(true);
  const result = runClassicStudy(bars, [], {
    strategy: "research-growth",
    start: bars[300]!.date,
    end: bars.at(-1)!.date,
    initial: 1000000,
  });
  const buy = result.fills.find((f) => f.side === "buy")!,
    sale = result.fills.find((f) => f.side === "sell")!;
  expect(buy.signalDate).toBe(bars[366]!.date);
  expect(buy.date).toBe(bars[367]!.date);
  expect(sale.signalDate).toBe(bars[372]!.date);
  expect(sale.date).toBe(bars[373]!.date);
  expect(getStrategyDefinition("research-growth")!.rule).toContain(
    "不含完整CANSLIM",
  );
});

it("runs the existing SOS candidate/confirmation and real exit policy through next-open execution", () => {
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
    [89, 99],
  ];
  const bars: Bar[] = Array.from({ length: 150 }, (_, i) => {
    const j = i - 60;
    const r = j < 0 ? 0 : anchors.findIndex((a) => a[0]! >= j),
      a = anchors[Math.max(0, r - 1)]!,
      b = anchors[r]!;
    const close =
      j < 0
        ? 80
        : a[1]! + ((b[1]! - a[1]!) * (j - a[0]!)) / Math.max(1, b[0]! - a[0]!);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.1,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: 10000,
      amount: 1000000,
    };
  });
  const add = (row: Partial<Bar>) => {
    bars.push({
      ...bars.at(-1)!,
      date: new Date(Date.UTC(2020, 0, bars.length + 1))
        .toISOString()
        .slice(0, 10),
      ...row,
    });
  };
  add({ open: 99, close: 102, high: 102.5, low: 98.5, volume: 15000 });
  add({ open: 102, close: 102.2, high: 102.5, low: 100.5, volume: 10000 });
  add({ open: 102.2, close: 102.2, high: 103, low: 101 });
  add({ open: 102.2, close: 94, high: 103, low: 93 });
  add({ open: 94, close: 94, high: 95, low: 93 });
  const rule = createExtendedStudyRule("research-wyckoff", bars)!;
  expect(rule(150, { entry: 0, entryIndex: 0 }).enter).toBe(false);
  expect(rule(151, { entry: 0, entryIndex: 0 }).enter).toBe(true);
  const result = runClassicStudy(bars, [], {
    strategy: "research-wyckoff",
    start: bars[140]!.date,
    end: bars.at(-1)!.date,
    initial: 1000000,
  });
  expect(
    result.fills.some((f) => f.side === "buy" && f.date === bars[152]!.date),
  ).toBe(true);
  expect(result.fills.some((f) => f.side === "sell")).toBe(true);
  expect(result.fills.every((f) => f.date > f.signalDate)).toBe(true);
});
