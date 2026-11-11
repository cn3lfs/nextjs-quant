import {
  riskRepairSchema,
  riskRepairBoundary,
  repairRisk,
  initialRepairPlan,
  repairRaisedStop,
  repairReductionQuantity,
  type RiskRepair,
} from "trading-strategies/research/risk/research-risk-repair";
import { z } from "zod";
import type { Bar } from "../../domain";
import { backtestCostsSchema } from "../../backtest/backtest-costs";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import {
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
  researchPositionBook,
} from "../analysis/research-position-book";
import { type ResearchPositionBook } from "trading-strategies/research/contracts/position-book";
import {fillMarketOrder as researchFill,sellQuantity as researchSellQuantity,commissionFor as researchCommission,type ExecutionRules as ResearchExecutionRules} from "quant-backtest/execution";
import { big, bpsOf, moneyMul, toNumber } from "../../money";
const validBar = (b: Bar | undefined): b is Bar =>
  !!b &&
  [b.open, b.high, b.low, b.close, b.volume].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  b.low <= Math.min(b.open, b.close) &&
  b.high >= Math.max(b.open, b.close);
export function replayRiskRepair(
  raw: RiskRepair,
  bars: readonly Bar[],
  calendar: readonly string[],
  rules: (date: string) => ResearchExecutionRules | null,
  costs: z.infer<typeof backtestCostsSchema>,
  repair = true,
) {
  const input = riskRepairSchema.parse(raw);
  if (
    calendar.some((d, i) => i > 0 && d <= calendar[i - 1]!) ||
    new Set(bars.map((b) => b.date)).size !== bars.length
  )
    throw new Error("修复日历/行情日期重复或未排序");
  costs = backtestCostsSchema.parse(costs);
  const quote = {
    sellTaxBps: costs.sellTaxBps,
    commission: (amount: number) => researchCommission(amount, costs),
  };
  let book = researchPositionBook();
  for (const lot of input.lots) book = researchBookBuy(book, lot);
  let stop = input.stop,
    pending = false,
    switched = false,
    cash = 0;
  const initialCost = book.totalCost,
    actions: {
      date: string;
      kind: string;
      quantity: number;
      price: number | null;
      stop: number;
      risk: number;
      reason: string;
    }[] = [];
  const byDate = new Map(bars.map((b) => [b.date, b]));
  const observed = byDate.get(input.observedDate);
  if (!calendar.includes(input.observedDate) || !validBar(observed))
    return {
      status: "missing" as const,
      reason: "缺修复观察日有效行情",
      actions,
      book,
      stop,
      cash,
    };
  const targetStop = input.kind === "cycle-switch" ? input.proposedStop : stop;
  const {
    budget,
    eligible,
    initialRisk,
    pending: repairPending,
  } = initialRepairPlan(
    input,
    repairRisk(book, input.stop, quote),
    repairRisk(book, targetStop, quote),
    observed.close,
    repair,
  );
  pending = repairPending;
  if (pending && input.kind === "add-raise") {
    const raised = repairRaisedStop(stop, observed.close, budget, (price) =>
      repairRisk(book, price, quote),
    );
    if (raised !== null) {
      stop = raised;
      pending = false;
      actions.push({
        date: input.observedDate,
        kind: "raise",
        quantity: 0,
        price: null,
        stop,
        risk: repairRisk(book, stop, quote),
        reason: "统一线抬至含费预算，下一交易日起有效",
      });
    }
  }
  let exit = observed.close < stop || (pending && input.kind === "add-raise");
  for (const date of calendar.filter((d) => d > input.observedDate)) {
    if (!book.remainingQuantity) break;
    const bar = byDate.get(date),
      rule = rules(date),
      fill = researchFill(bar, "sell", rule, costs);
    if (pending || exit) {
      if (fill.price == null || !rule) {
        actions.push({
          date,
          kind: "blocked",
          quantity: 0,
          price: null,
          stop,
          risk: repairRisk(book, stop, quote),
          reason: fill.reason ?? "规则缺失",
        });
        continue;
      }
      const sellable = researchBookSellable(book, date),
        max = researchSellQuantity(sellable, book.remainingQuantity, rule);
      if (!max) {
        actions.push({
          date,
          kind: "blocked",
          quantity: 0,
          price: null,
          stop,
          risk: repairRisk(book, stop, quote),
          reason: "T+1/卖出数量限制",
        });
        continue;
      }
      const trial = (quantity: number) => {
        const amount = moneyMul(quantity, fill.price);
        return researchBookSell(book, {
          date,
          quantity,
          price: fill.price,
          commission: researchCommission(amount, costs),
          tax: bpsOf(amount, costs.sellTaxBps),
        });
      };
      let quantity = max;
      if (!exit) {
        quantity = repairReductionQuantity({
          maximum: max,
          minimum: rule.minimumSell!,
          step: rule.sellStep!,
          price: fill.price,
          stop: targetStop,
          budget,
          riskAfter: (q) => repairRisk(trial(q).book, targetStop, quote),
        });
      }
      const sold = trial(quantity);
      book = sold.book;
      cash = toNumber(big(cash).plus(sold.netProceeds));
      const risk = repairRisk(book, targetStop, quote);
      if (!exit && risk <= budget + 1e-8) {
        pending = false;
        if (input.kind === "cycle-switch") {
          stop = targetStop;
          switched = true;
        }
      }
      actions.push({
        date,
        kind: exit ? "exit" : "reduce",
        quantity,
        price: fill.price,
        stop,
        risk,
        reason:
          risk > budget ? "实际损失/剩余风险仍超预算，继续请求" : "预算修复",
      });
    }
    if (validBar(bar) && bar.close < stop) exit = true;
  }
  return {
    status: "available" as const,
    reason: null,
    input,
    repair,
    initialRisk,
    effectiveBudget: budget,
    actions,
    book,
    stop,
    cash,
    switched,
    pending: pending && book.remainingQuantity > 0,
    risk: repairRisk(book, stop, quote),
    repaired: repairRisk(book, stop, quote) <= budget + 1e-8,
    accounting: {
      initialCost,
      realizedProfit: book.realizedProfit,
      remainingCost: book.remainingCost,
      cash,
    },
    boundary: riskRepairBoundary,
  };
}
