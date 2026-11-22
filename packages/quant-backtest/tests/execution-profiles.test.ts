import { expect, it } from "vitest";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import { fillMarketOrder, type ExecutionRules } from "../src/execution.js";

const bar = {
  date: "2025-01-07",
  open: 10.005,
  high: 10.01,
  low: 9.99,
  close: 10.005,
  volume: 1_000,
  amount: 10_000,
};
const rules: ExecutionRules = {
  evidence: "synthetic execution limits",
  tradable: true,
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 2_000,
  limitUp: 11,
  limitDown: 9,
};
const costs = { ...defaultExecutionCosts, slippageBps: 10 };
const outsideRange = "滑点成交价超出可观察价格范围";
const suspended = "停牌或缺少可交易行情";

it.each([
  { side: "buy", open: 10.005, boundary: 10.01 },
  { side: "sell", open: 9.995, boundary: 9.99 },
] as const)(
  "applies reject, clamp and none to $side slippage outside OHLC",
  ({ side, open, boundary }) => {
    const quoteBar = { ...bar, open, close: open };
    const reject = fillMarketOrder(
      quoteBar,
      side,
      { ...rules, slippagePolicy: "reject" },
      costs,
    );
    expect(reject.price).toBeNull();
    expect(reject.reason).toBe(outsideRange);
    expect(fillMarketOrder(quoteBar, side, rules, costs)).toEqual(reject);

    const clamp = fillMarketOrder(
      quoteBar,
      side,
      { ...rules, slippagePolicy: "clamp" },
      costs,
    );
    expect(clamp.price).toBe(boundary);
    expect(clamp.reason).toBeNull();

    const none = fillMarketOrder(
      quoteBar,
      side,
      { ...rules, slippagePolicy: "none" },
      costs,
    );
    expect(none.price).toBe(open);
    expect(none.reason).toBeNull();
  },
);

it.each(["clamp", "none"] as const)(
  "keeps the one-price and limit-up buy guards under %s",
  (slippagePolicy) => {
    const policyRules = { ...rules, slippagePolicy };
    const onePrice = fillMarketOrder(
      { ...bar, high: bar.open, low: bar.open },
      "buy",
      policyRules,
      costs,
    );
    expect(onePrice.price).toBeNull();
    expect(onePrice.reason).toBe("一字行情，保守不成交");

    const limitUp = fillMarketOrder(
      { ...bar, open: 11, high: 11 },
      "buy",
      policyRules,
      costs,
    );
    expect(limitUp.price).toBeNull();
    expect(limitUp.reason).toBe("开盘涨停，无法证明买入成交");
  },
);

it.each(["reject", "clamp", "none"] as const)(
  "rejects zero volume and suspended trading under %s",
  (slippagePolicy) => {
    const policyRules = { ...rules, slippagePolicy };
    const zeroVolume = fillMarketOrder(
      { ...bar, volume: 0, amount: 0 },
      "buy",
      policyRules,
      costs,
    );
    expect(zeroVolume.price).toBeNull();
    expect(zeroVolume.reason).toBe(suspended);

    const halted = fillMarketOrder(
      bar,
      "buy",
      { ...policyRules, tradable: false },
      costs,
    );
    expect(halted.price).toBeNull();
    expect(halted.reason).toBe(suspended);
  },
);
