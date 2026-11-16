import type { StrategyObjectInput } from "trading-strategies";
import type { ExecutionCosts } from "trading-strategy-core/costs";
import {
  big,
  bigMin,
  bpsOf,
  moneyMul,
  toNumber,
} from "trading-strategy-core/money";
import { commissionFor } from "./execution.js";

export function portfolioExecutionFee(
  quantity: number,
  price: number,
  side: "buy" | "sell",
  costs: ExecutionCosts,
) {
  const amount = moneyMul(quantity, price);
  return toNumber(
    big(commissionFor(amount, costs)).plus(
      side === "sell" ? bpsOf(amount, costs.sellTaxBps) : 0,
    ),
  );
}

export type PortfolioEntrySizing = {
  sizing: StrategyObjectInput["sizing"];
  equity: number;
  cash: number;
  price: number;
  stop: number | null;
  riskPerTrade: number;
  weightCeiling?: number;
  existing?: { quantity: number; cost: number; stop: number | null };
  quantityRules: { step: number; minimum: number; maximum: number };
  costs: ExecutionCosts;
};

/** The same conservative fee reserve and risk-at-stop calculation used by the
 * portfolio engine. Callers supply a completed signal's causal weight ceiling;
 * a missing volatility observation must never be converted to full weight. */
export function sizePortfolioEntry(input: PortfolioEntrySizing) {
  const {
    sizing,
    equity,
    cash,
    price,
    stop,
    riskPerTrade,
    costs,
    quantityRules: rules,
  } = input;
  const tranches = sizing.tranches ?? 1;
  const ceiling = input.weightCeiling ?? 1;
  if (
    ![equity, cash].every((v) => Number.isFinite(v) && v >= 0) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(riskPerTrade) ||
    riskPerTrade <= 0 ||
    riskPerTrade > 1 ||
    !Number.isFinite(ceiling) ||
    ceiling < 0 ||
    ceiling > 1 ||
    !Number.isInteger(tranches) ||
    tranches < 1 ||
    ![rules.step, rules.minimum, rules.maximum].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    rules.maximum < rules.minimum ||
    (stop !== null && (!Number.isFinite(stop) || stop <= 0 || stop >= price))
  )
    throw new Error("Invalid portfolio entry sizing");
  const baseWeight =
    sizing.kind === "equal"
      ? 1 / sizing.positions
      : sizing.kind === "weight"
        ? sizing.weight
        : 1;
  if (!Number.isFinite(baseWeight) || baseWeight <= 0 || baseWeight > 1)
    throw new Error("Invalid portfolio entry weight");
  const floorStep = (value: number | ReturnType<typeof big>) =>
    toNumber(big(value).div(rules.step).round(0, 0).times(rules.step));
  const weight = Math.min(baseWeight, ceiling);
  const budget = Math.min(cash, (equity * weight) / tranches);
  let quantity = floorStep(
    bigMin(
      big(budget).minus(costs.minimumCommission).div(price),
      big(budget).div(
        big(price).times(big(1).plus(big(costs.commissionBps).div(10000))),
      ),
      rules.maximum,
    ),
  );
  let oldRisk = 0;
  let riskBudget: number | null = null;
  if (stop !== null) {
    const held = input.existing;
    oldRisk = held
      ? held.quantity * Math.max(0, held.cost - (held.stop ?? stop)) +
        portfolioExecutionFee(held.quantity, held.stop ?? stop, "sell", costs)
      : 0;
    const fraction = Math.min(
      riskPerTrade,
      sizing.kind === "risk" ? sizing.fraction : riskPerTrade,
    );
    riskBudget = Math.max(0, equity * fraction - oldRisk);
    quantity = Math.min(
      quantity,
      floorStep(
        Math.max(0, riskBudget - costs.minimumCommission * 2) /
          (price -
            stop +
            (price * costs.commissionBps) / 10000 +
            (stop * (costs.commissionBps + costs.sellTaxBps)) / 10000),
      ),
    );
  }
  const affordable =
    quantity >= rules.minimum &&
    quantity * price + portfolioExecutionFee(quantity, price, "buy", costs) <=
      cash + 1e-8;
  if (!affordable) quantity = 0;
  const fee =
    quantity > 0 ? portfolioExecutionFee(quantity, price, "buy", costs) : 0;
  return {
    quantity,
    fee,
    weight,
    budget,
    riskBudget,
    oldRisk,
    notional: quantity * price,
    risk:
      stop === null
        ? null
        : quantity * (price - stop) +
          fee +
          (quantity > 0
            ? portfolioExecutionFee(quantity, stop, "sell", costs)
            : 0),
    reason: affordable ? null : "资金不足以支付一手及费用",
  };
}

/** Rebalance weights are final holdings, not an additional purchase budget. */
export function sizePortfolioTargetEntry(
  input: PortfolioEntrySizing & { targetWeight: number },
) {
  if (
    !Number.isFinite(input.targetWeight) ||
    input.targetWeight < 0 ||
    input.targetWeight > 1
  )
    throw new Error("Invalid portfolio target weight");
  const sized = sizePortfolioEntry(input);
  const targetQuantity = toNumber(
    big(input.equity)
      .times(input.targetWeight)
      .div(input.price)
      .div(input.quantityRules.step)
      .round(0, 0)
      .times(input.quantityRules.step),
  );
  const difference = toNumber(
    big(Math.max(0, targetQuantity - (input.existing?.quantity ?? 0)))
      .div(input.quantityRules.step)
      .round(0, 0)
      .times(input.quantityRules.step),
  );
  const quantity = Math.min(sized.quantity, difference);
  const accepted = quantity >= input.quantityRules.minimum ? quantity : 0;
  const fee =
    accepted > 0
      ? portfolioExecutionFee(accepted, input.price, "buy", input.costs)
      : 0;
  return {
    ...sized,
    quantity: accepted,
    fee,
    notional: accepted * input.price,
    risk:
      input.stop === null
        ? null
        : accepted * (input.price - input.stop) +
          fee +
          (accepted > 0
            ? portfolioExecutionFee(accepted, input.stop, "sell", input.costs)
            : 0),
    targetQuantity,
    reason: accepted > 0 ? null : "目标权重已满足或不足最小数量",
  };
}
