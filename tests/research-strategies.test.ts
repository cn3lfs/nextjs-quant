import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { maParamsSchema, type Bar } from "../src/lib/domain";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import {
  researchStrategies,
  researchStrategyIds,
} from "../src/lib/research-strategies";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import {
  plannedStopRisk,
  researchRiskQuantity,
} from "../src/lib/research-risk";
import { backtestCostsSchema } from "../src/lib/backtest-costs";
import {
  ResearchStrategyFields,
  selectResearchStrategy,
} from "../src/components/research-strategy-fields";
import { researchParamsFingerprint } from "../src/server/backtest/research-store";

const days = [
  "2024-01-02",
  "2024-01-03",
  "2024-01-04",
  "2024-01-05",
  "2024-01-08",
];
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: days[0],
  end: days[4],
  validationStart: days[3],
  initialCapital: 10000,
  maxPositions: 1,
  holdingDays: 60,
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const managed = researchSpecSchema.parse({
  ...base,
  strategy: "dual-breakout-structure",
  risk: { fraction: 0.05, maxWeight: 1 },
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: days[0]!,
  endpointDate: days[0]!,
  key: "entry",
  strategyVersion: "dual-breakout-structure-1",
  partition: "development",
  evidence: "{}",
  initialStop: 9,
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
const series: Bar[] = days.map((date, i) => ({
  date,
  open: i >= 2 ? 7 : 10,
  close: i === 1 ? 8 : i >= 2 ? 7 : 10,
  high: i >= 2 ? 8 : 11,
  low: i >= 2 ? 6 : 7,
  volume: 1000,
  amount: 10000,
}));

it("preserves old spec shape, validates strategy-specific parameters and removes stale fields on selection", () => {
  expect(base).not.toHaveProperty("risk");
  expect(base).not.toHaveProperty("maParams");
  for (const id of researchStrategyIds) {
    const selected = selectResearchStrategy(managed, id);
    expect(researchSpecSchema.parse(selected).strategy).toBe(id);
    expect(researchStrategies[id].sources.length).toBeGreaterThan(0);
  }
  expect(
    researchSpecSchema.safeParse({ ...base, strategy: "ma-cross" }).success,
  ).toBe(false);
  expect(
    researchSpecSchema.safeParse({ ...base, risk: managed.risk }).success,
  ).toBe(false);
  expect(
    researchSpecSchema.safeParse({
      ...managed,
      risk: { fraction: -1, maxWeight: 1 },
    }).success,
  ).toBe(false);
  expect(selectResearchStrategy(managed, "dual-breakout")).toEqual(base);
  expect(researchParamsFingerprint(managed)).not.toBe(
    researchParamsFingerprint({
      ...managed,
      risk: { ...managed.risk!, fraction: 0.01 },
    }),
  );
});

it("reuses the existing MA trend conditions without calling native code or reading future bars", async () => {
  const bars = Array.from({ length: 66 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 10 + i,
    close: 10 + i,
    high: 11 + i,
    low: 9 + i,
    volume: 100,
    amount: 1000,
  }));
  const spec = researchSpecSchema.parse({
    ...base,
    strategy: "ma-cross",
    maParams: maParamsSchema.parse({}),
    start: bars[61]!.date,
    end: bars[63]!.date,
    validationStart: bars[63]!.date,
  });
  const native = vi.fn(async () => {
    throw new Error("must not call native");
  });
  const events = await researchSignals("sh600000", bars, spec, native);
  expect(events.map((row) => row.observedDate)).toEqual(
    bars.slice(61, 64).map((bar) => bar.date),
  );
  expect(JSON.parse(events[0]!.evidence)).toMatchObject({
    close: 71,
    fast: 69,
    slow: 61.5,
    volumeRatio: 1,
    matched: true,
  });
  const changed = structuredClone(bars);
  changed[64]!.close = 100000;
  expect(await researchSignals("sh600000", changed, spec, native)).toEqual(
    events,
  );
  expect(native).not.toHaveBeenCalled();
  const another = await researchSignals(
    "sh600000",
    bars,
    { ...spec, maParams: { ...spec.maParams!, fast: 6 } },
    native,
  );
  expect(another[0]!.strategyVersion).not.toBe(events[0]!.strategyVersion);
});

it("includes both minimum commissions and sell tax in the risk cap, then rounds down to valid lots", () => {
  const costs = backtestCostsSchema.parse({ slippageBps: 0 });
  const quantity = researchRiskQuantity({
    cash: 10000,
    equity: 10000,
    price: 10,
    stop: 9,
    fraction: 0.05,
    maxWeight: 1,
    rules,
    costs,
  });
  // 400 * (10-9) + 5 + 5 + 400*9*0.0005 = 411.8; the next lot costs 512.25 risk.
  expect(quantity).toBe(400);
  expect(plannedStopRisk(quantity, 10, 9, costs)).toBeCloseTo(411.8);
  expect(plannedStopRisk(quantity + 100, 10, 9, costs)).toBeGreaterThan(500);
  expect(
    researchRiskQuantity({
      cash: 10000,
      equity: 10000,
      price: 10,
      stop: 9,
      fraction: 0.001,
      maxWeight: 1,
      rules,
      costs,
    }),
  ).toBe(0);
  expect(
    researchRiskQuantity({
      cash: 10000,
      equity: 10000,
      price: 10,
      stop: 11,
      fraction: 0.05,
      maxWeight: 1,
      rules,
      costs,
    }),
  ).toBe(0);
});

it("does not stop out a new A-share position on its buy day; sells the next open including an overnight gap", () => {
  const result = researchPortfolio(
    managed,
    [event],
    days,
    new Map([[event.symbol, series]]),
    () => rules,
  );
  expect(result.trades[0]).toMatchObject({
    entryDate: days[1],
    entryPrice: 10,
    quantity: 500,
    initialStop: 9,
    exitDate: days[2],
    exitPrice: 7,
    profit: -1500,
    exitReason: "收盘失守信号日结构位，下一可成交开盘退出",
  });
  expect(result.nav[1]).toMatchObject({ cash: 5000, value: 9000 });
  expect(result.nav.at(-1)).toMatchObject({ cash: 8500, value: 8500 });
  expect(result.openPositions).toBe(0);
});

it("retains a triggered exit until tradable, and does not cancel it when the price later recovers", () => {
  const changed = structuredClone(series);
  changed[2] = { ...changed[2]!, open: 10, high: 12, close: 11 };
  changed[3] = { ...changed[3]!, open: 11, high: 12, close: 11 };
  const result = researchPortfolio(
    managed,
    [event],
    days,
    new Map([[event.symbol, changed]]),
    (_symbol, date) => ({ ...rules, tradable: date !== days[2] }),
  );
  expect(result.trades[0]).toMatchObject({
    exitDate: days[3],
    exitPrice: 11,
    profit: 500,
  });
  expect(result.attempts).toEqual([
    {
      symbol: event.symbol,
      date: days[2],
      side: "sell",
      reason: "停牌或缺少可交易行情",
    },
  ]);
});

it("rejects missing structure or an entry gap below it rather than quietly falling back to equal weight", () => {
  const missing = researchPortfolio(
    managed,
    [{ ...event, initialStop: null }],
    days,
    new Map([[event.symbol, series]]),
    () => rules,
  );
  expect(missing.trades).toEqual([]);
  expect(missing.excluded[0]!.reason).toContain("缺少有效结构止损");
  const changed = structuredClone(series);
  changed[1]!.open = 8;
  const gap = researchPortfolio(
    managed,
    [event],
    days,
    new Map([[event.symbol, changed]]),
    () => rules,
  );
  expect(gap.trades).toEqual([]);
  expect(gap.excluded).toHaveLength(1);
});

it("keeps fixed-hold behavior when risk management is not selected and caps managed position value", () => {
  const legacy = researchPortfolio(
    { ...base, holdingDays: 1 },
    [event],
    days,
    new Map([[event.symbol, series]]),
    () => rules,
  );
  expect(legacy.trades[0]).toMatchObject({
    quantity: 1000,
    entryDate: days[1],
    exitDate: days[2],
    profit: -3000,
  });
  expect(legacy.trades[0]).not.toHaveProperty("initialStop");
  expect(legacy.trades[0]).not.toHaveProperty("exitReason");
  const capped = researchPortfolio(
    { ...managed, risk: { fraction: 0.05, maxWeight: 0.2 } },
    [event],
    days,
    new Map([[event.symbol, series]]),
    () => rules,
  );
  expect(capped.trades[0]!.quantity).toBe(200);
});

it("renders the actual selected rule and matching parameters, without implying a crossover-only MA signal", () => {
  const managedHtml = renderToStaticMarkup(
    createElement(ResearchStrategyFields, {
      spec: managed,
      onChange: () => {},
    }),
  );
  expect(managedHtml).toContain("单笔计划风险");
  expect(managedHtml).toContain("下一可成交开盘退出");
  const maHtml = renderToStaticMarkup(
    createElement(ResearchStrategyFields, {
      spec: selectResearchStrategy(base, "ma-cross"),
      onChange: () => {},
    }),
  );
  expect(maHtml).toContain("不是只在金叉当天");
  expect(maHtml).toContain("短均线天数");
  expect(maHtml).not.toContain("单笔计划风险");
});
