import type { Bar } from "trading-strategy-core/bars";
import type { Csi800Stock } from "trading-strategies";
import { defaultExecutionCosts } from "trading-strategy-core/costs";

export function parityFiveMinute() {
  const bars: Bar[] = Array.from({ length: 120 }, (_, i) => {
    const j = i % 48,
      minute = j < 24 ? 575 + j * 5 : 785 + (j - 24) * 5;
    const close = 10 + Math.sin(i / 4);
    return {
      date: `${["2026-10-09", "2026-10-12", "2026-10-13"][Math.floor(i / 48)]}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`,
      open: close + 0.05,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      amount: 10000,
    };
  });
  return {
    bars,
    input: {
      symbol: "sh600519",
      start: "2026-10-12",
      end: "2026-10-13",
      initial: 100000,
      costs: { ...defaultExecutionCosts, slippageBps: 0 },
    },
  };
}
export function parityDaily() {
  const dates: string[] = [];
  for (let n = 0; dates.length < 420; n++) {
    const date = new Date(Date.UTC(2024, 0, 1 + n));
    if (![0, 6].includes(date.getUTCDay()))
      dates.push(date.toISOString().slice(0, 10));
  }
  const bars: Bar[] = dates.map((date, i) => {
    const close = 20 + i * 0.015 + Math.sin(i / 9) * 2;
    return {
      date,
      open: close * 1.002,
      high: close * 1.04,
      low: close * 0.96,
      close,
      volume: 1e7,
      amount: 2e8,
    };
  });
  return {
    bars,
    options: { start: dates[300]!, end: dates[410]!, initial: 1000000 },
    dividends: [{ date: dates[340]!, perShare: 0.2 }],
  };
}
export function parityAllocation() {
  const { bars, options } = parityDaily();
  const stocks: Csi800Stock[] = Array.from({ length: 25 }, (_, i) => ({
    symbol: `sh${600000 + i}`,
    bars: bars.map((b, j) => ({
      ...b,
      open: b.open * (1 + (i * j) / 100000),
      close: b.close * (1 + (i * j) / 100000),
      high: b.high * (1 + (i * j) / 100000),
      low: b.low * (1 + (i * j) / 100000),
    })),
    actions: [],
  }));
  return { stocks, benchmark: bars, options };
}
