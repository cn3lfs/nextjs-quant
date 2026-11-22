import { expect, it } from "vitest";
import {
  portfolioExecutionFee,
  runPortfolio,
  type PortfolioRequest,
} from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  executionCostsForDate,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import { reconcileFills } from "../../../scripts/lib/backtest-diagnose/reconcile";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const symbol = "sh600000";
const dates = [
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
  "2025-01-09",
  "2025-01-10",
] as const;
const costs = {
  version: "cost-experiment-1",
  commissionBps: 3,
  minimumCommission: 5,
  transferBps: 0.1,
  sellTaxBps: 5,
  slippageBps: 0,
} as const;

function request({
  day2 = {},
  day3 = {},
  exit = {},
  slippageBps = 0,
  limitUp = 12,
  limitDown = 9,
  initial = 2_600,
}: {
  day2?: Partial<Bar>;
  day3?: Partial<Bar>;
  exit?: PortfolioRequest["strategies"][number]["exit"];
  slippageBps?: number;
  limitUp?: number;
  limitDown?: number;
  initial?: number;
} = {}): PortfolioRequest {
  const bars = dates.map((date, index): Bar => ({
    date,
    open: 10,
    high: 11.5,
    low: 9.5,
    close: 10.2,
    volume: 100_000,
    amount: 1_000_000,
    ...(index === 1 ? { open: 10.5, ...day2 } : {}),
    ...(index === 2 ? { open: 11, ...day3 } : {}),
  }));
  return {
    market: "cn-equity",
    initial,
    start: dates[0],
    end: dates[4],
    calendar: dates,
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "synthetic execution bounds",
          tradable: true,
          minimum: 100,
          step: 100,
          limitUp,
          limitDown,
        },
      },
    ],
    strategies: [{ ...buildStrategy("hold", [symbol], "single"), exit }],
    sleeves: [{ id: "diag", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
    costs: { ...costs, slippageBps },
  };
}

it("buys at the next open after a close signal and charges lot-rounded buy and sell fees", () => {
  const input = request({ exit: { maxBars: 1 } });
  const result = runPortfolio(input);
  const [buy, sell] = result.fills;
  expect(result.orders[0]).toMatchObject({
    signalAt: dates[0],
    due: dates[1],
    status: "filled",
  });
  expect(buy).toMatchObject({
    side: "buy",
    date: dates[1],
    price: 10.5,
    quantity: 200,
  });
  expect(buy!.quantity % 100).toBe(0);
  // ¥2,600 buys 200 shares in 100-share lots. ¥2,100 × 3bp = ¥0.63,
  // so the buy fee is the ¥5 floor plus ¥2,100 × 0.1bp = ¥5.021.
  expect(buy?.fee).toBeCloseTo(5.021, 8);
  expect(buy?.cashAfter).toBeCloseTo(494.979, 8);
  expect(sell).toMatchObject({
    side: "sell",
    signalAt: dates[1],
    date: dates[2],
    price: 11,
    quantity: 200,
  });
  // ¥2,200 × 5bp adds ¥1.10 stamp duty to ¥5 + ¥0.022.
  expect(sell?.fee).toBeCloseTo(6.122, 8);
  expect(portfolioExecutionFee(200, 11, "sell", costs)).toBeCloseTo(6.122, 8);
  expect(sell?.cashAfter).toBeCloseTo(2_688.857, 8);
  expect(reconcileFills(input, result)).toHaveLength(0);
});

it("charges the proportional commission above the minimum", () => {
  // 2,000 × ¥10.50 = ¥21,000; ¥6.30 commission + ¥0.21 transfer.
  const buy = runPortfolio(request({ initial: 21_100 })).fills[0];
  expect(buy?.quantity).toBe(2_000);
  expect(buy?.fee).toBeCloseTo(6.51, 8);
});

// 2,000 shares at ¥10 cost ¥20,000. Commission is ¥6 on both sides.
// Transfer costs ¥0.40 before its cut and ¥0.20 afterward. The sell adds
// ¥20 stamp duty before its cut and ¥10 afterward.
it.each([
  { date: "2022-04-28", transfer: 0.2, stamp: 10, buyFee: 6.4, sellFee: 26.4 },
  { date: "2022-04-29", transfer: 0.1, stamp: 10, buyFee: 6.2, sellFee: 26.2 },
  { date: "2023-08-25", transfer: 0.1, stamp: 10, buyFee: 6.2, sellFee: 26.2 },
  { date: "2023-08-28", transfer: 0.1, stamp: 5, buyFee: 6.2, sellFee: 16.2 },
])(
  "charges the historical buy and sell fees on $date",
  ({ date, transfer, stamp, buyFee, sellFee }) => {
    const dateCosts = executionCostsForDate(
      researchExecutionCosts("cn-equity", "base"),
      date,
    );
    expect(dateCosts).toMatchObject({
      commissionBps: 3,
      minimumCommission: 5,
      transferBps: transfer,
      sellTaxBps: stamp,
    });
    expect(portfolioExecutionFee(2_000, 10, "buy", dateCosts)).toBeCloseTo(
      buyFee,
      9,
    );
    expect(portfolioExecutionFee(2_000, 10, "sell", dateCosts)).toBeCloseTo(
      sellFee,
      9,
    );
  },
);

it("liquidates all 1,050 shares including the odd lot and charges fees on all shares", () => {
  const input = request({ initial: 11_000, exit: { maxBars: 1 } });
  input.instruments = [
    {
      ...input.instruments[0]!,
      actions: [
        {
          date: dates[2],
          availableAt: dates[2],
          cashAvailableAt: dates[2],
          sharesSellableAt: dates[2],
          timingAssumption: "ex-date-research-scenario",
          dividend: 0,
          bonus: 0.05,
          evidence: "synthetic bonus of 50 shares on a 1,000-share position",
        },
      ],
    },
  ];
  const { fills } = runPortfolio(input);
  const [buy, sell] = fills;
  expect(buy).toMatchObject({ side: "buy", quantity: 1_000 });
  expect(sell).toMatchObject({
    date: dates[2],
    side: "sell",
    price: 11,
    quantity: 1_050,
    holdingAfter: 0,
  });
  // ¥11,550 × 3bp = ¥3.465. The fee is ¥5 + ¥0.1155 transfer + ¥5.775 stamp duty.
  expect(sell?.fee).toBeCloseTo(10.8905, 9);
});

it("charges the minimum commission plus transfer on a small buy", () => {
  const dateCosts = executionCostsForDate(
    researchExecutionCosts("cn-equity", "base"),
    "2023-08-28",
  );
  // ¥100 × 3bp = ¥0.03. Use the ¥5 minimum plus ¥100 × 0.1bp = ¥0.001.
  expect(portfolioExecutionFee(100, 1, "buy", dateCosts)).toBeCloseTo(5.001, 9);
});

it("charges exactly zero on both sides when all fee rates and the minimum are zero", () => {
  const zeroCosts = {
    ...costs,
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    transferBps: 0,
  };
  expect(portfolioExecutionFee(2_000, 10, "buy", zeroCosts)).toBe(0);
  expect(portfolioExecutionFee(2_000, 10, "sell", zeroCosts)).toBe(0);
});

it("blocks a protective sell on the day of entry under T+1 and retries at the next open", () => {
  // ¥10.50 × 95% = ¥9.975 stop. Day 2 touches it after buying at the open.
  const result = runPortfolio(
    request({ exit: { stop: { kind: "fixed", fraction: 0.05 } } }),
  );
  const stop = result.orders.find((order) => order.trigger === "stop")!;
  expect(stop).toMatchObject({
    side: "sell",
    signalAt: dates[1],
    due: dates[1],
    attempts: 2,
  });
  expect(result.rejections).toContainEqual({
    orderId: stop.id,
    date: dates[1],
    reason: "T+1：当日买入不可卖出",
  });
  expect(
    result.fills.some((fill) => fill.side === "sell" && fill.date === dates[1]),
  ).toBe(false);
  expect(result.fills.find((fill) => fill.orderId === stop.id)).toMatchObject({
    orderId: stop.id,
    date: dates[2],
    price: 11,
  });
});

it.each([
  { name: "limit-up open", bar: { open: 12, high: 12 }, reason: /开盘涨停/ },
  {
    name: "one-price bar away from the limits",
    bar: { open: 10.5, high: 10.5, low: 10.5, close: 10.5 },
    reason: /一字行情/,
  },
  {
    name: "zero-volume bar with tradable metadata",
    bar: { volume: 0, amount: 0 },
    reason: /停牌或缺少可交易行情/,
  },
])("rejects a buy at a $name with its own reason", ({ bar, reason }) => {
  const result = runPortfolio(request({ day2: bar }));
  const order = result.orders[0]!;
  expect(order).toMatchObject({ side: "buy", status: "rejected" });
  expect(result.rejections).toContainEqual(
    expect.objectContaining({
      orderId: order.id,
      date: dates[1],
      reason: expect.stringMatching(reason),
    }),
  );
  expect(result.fills.some((fill) => fill.date === dates[1])).toBe(false);
});

it("rejects the next-open sell at limit-down and retains the order for the next session", () => {
  const result = runPortfolio(
    request({
      day3: { open: 9, low: 9 },
      exit: { maxBars: 1 },
    }),
  );
  const sell = result.orders.find((order) => order.side === "sell")!;
  expect(result.rejections).toContainEqual(
    expect.objectContaining({
      orderId: sell.id,
      date: dates[2],
      reason: expect.stringMatching(/开盘跌停/),
    }),
  );
  expect(result.fills.find((fill) => fill.orderId === sell.id)?.date).toBe(
    dates[3],
  );
});

it("applies signed 100 bp slippage while both fills stay inside raw OHLC and price limits", () => {
  const input = request({ slippageBps: 100, exit: { maxBars: 1 } });
  const { fills } = runPortfolio(input);
  // Buy at ¥10.50 × 1.01, sell at ¥11 × 0.99.
  expect(fills[0]?.side).toBe("buy");
  expect(fills[1]?.side).toBe("sell");
  expect(fills[0]?.price).toBeCloseTo(10.605, 8);
  expect(fills[1]?.price).toBeCloseTo(10.89, 8);
  for (const fill of fills) {
    const bar = input.instruments[0]!.bars.find(
      ({ date }) => date === fill.date,
    )!;
    expect(fill.price).toBeGreaterThanOrEqual(bar.low);
    expect(fill.price).toBeLessThanOrEqual(bar.high);
    expect(fill.price).toBeGreaterThan(9);
    expect(fill.price).toBeLessThan(12);
  }
});

it.each([
  { cap: "raw high", day2: { high: 10.6 }, limitUp: 12 },
  { cap: "upper limit", day2: { high: 10.8 }, limitUp: 10.6 },
])(
  "rejects slippage that crosses the $cap even though the raw open was eligible",
  ({ day2, limitUp }) => {
    const result = runPortfolio(request({ day2, limitUp, slippageBps: 100 }));
    expect(result.rejections).toContainEqual({
      orderId: result.orders[0]!.id,
      date: dates[1],
      reason: "滑点成交价超出可观察价格范围",
    });
    expect(result.fills.some((fill) => fill.date === dates[1])).toBe(false);
  },
);
