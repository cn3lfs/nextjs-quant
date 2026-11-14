import { researchExecutor } from "~/lib/backtest/research-executor";
import { commissionFor as researchCommission } from "quant-backtest/execution";
import { researchPlannedProceeds } from "trading-strategies/research/technical/research-pyramid";
import { big, toNumber } from "trading-strategy-core/money";
import { expect, it } from "vitest";
import {
  swingDisciplineTemplate,
  swingRewardAdmission,
} from "trading-strategies/research/swing/research-swing-discipline";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";
const rules = {
  evidence: "fixture",
  tradable: true,
  limitUp: null,
  limitDown: null,
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
};
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
it("fixed 2/3 and volatility-adaptive stop use real entry price, ATR equality and missing path", () => {
  expect(
    researchInitialStop(swingDisciplineTemplate("sw-stop2"), 100, {}),
  ).toBe(98);
  expect(
    researchInitialStop(swingDisciplineTemplate("sw-stop3"), 100, {}),
  ).toBe(97);
  const m = swingDisciplineTemplate("sw-stop-volatility");
  expect(researchInitialStop(m, 100, { stopAtr: 2 })).toBe(97);
  expect(researchInitialStop(m, 100, { stopAtr: 1.999 })).toBe(98);
  expect(researchInitialStop(m, 100, {})).toBeNull();
});
it("2R admission accounts for fees and sell-order chunks", () => {
  const input = {
    entry: 100,
    stop: 90,
    target: 120,
    quantity: 100,
    quote: quote(costs, rules),
  };
  expect(swingRewardAdmission(input)).toMatchObject({ allow: true, ratio: 2 });
  expect(
    swingRewardAdmission({
      ...input,
      quote: quote({ ...costs, minimumCommission: 5 }, rules),
    }).allow,
  ).toBe(false);
  expect(
    swingRewardAdmission({
      ...input,
      target: 121,
      quote: quote(
        { ...costs, minimumCommission: 5 },
        { ...rules, maximumSell: 100 },
      ),
      quantity: 300,
    }).allow,
  ).toBe(true);
});
it("no-average template requires a profitable second tranche", () => {
  const m = swingDisciplineTemplate("sw-no-average");
  expect(m.pyramid).toMatchObject({
    kind: "pullback-50-50",
    requireProfit: true,
  });
});
function quote(c: typeof costs, r: typeof rules) {
  return {
    entryCost: (amount: number) =>
      toNumber(big(amount).plus(researchCommission(amount, c))),
    sellProceeds: (quantity: number, price: number) =>
      researchPlannedProceeds(quantity, price, researchExecutor(r, c)),
  };
}
