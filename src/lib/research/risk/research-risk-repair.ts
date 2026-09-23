import { z } from "zod";
import type { Bar } from "../../domain";
import { backtestCostsSchema } from "../../backtest/backtest-costs";
import { researchDateSchema } from "../workflow/research-usage";
import {
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
  researchPositionBook,
  type ResearchPositionBook,
} from "../analysis/research-position-book";
import {
  researchFill,
  researchSellQuantity,
  researchCommission,
  type ResearchExecutionRules,
} from "../technical/research-execution";
import { big, bpsOf, moneyMul, toNumber } from "../../money";
const positive = z.number().finite().positive();
const validBar = (b: Bar | undefined): b is Bar =>
  !!b &&
  [b.open, b.high, b.low, b.close, b.volume].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  b.low <= Math.min(b.open, b.close) &&
  b.high >= Math.max(b.open, b.close);
export const riskRepairSchema = z
  .object({
    version: z.literal("risk-repair-v1"),
    provenance: z.literal("manual-scenario"),
    kind: z.enum(["cycle-switch", "add-raise", "add-reduce", "held-reduce"]),
    symbol: z.string().regex(/^(sh|sz)\d{6}$/),
    observedDate: researchDateSchema,
    frozenDate: researchDateSchema,
    availableDate: researchDateSchema,
    budget: positive,
    budgetBasis: z.enum([
      "first-entry-risk",
      "current-equity-risk",
      "original-cycle-risk",
    ]),
    stop: positive,
    proposedStop: positive,
    lots: z
      .array(
        z
          .object({
            date: researchDateSchema,
            quantity: z.number().int().positive(),
            price: positive,
            commission: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    cycle: z
      .object({
        from: z.literal("intraday"),
        to: z.literal("swing"),
        trigger: z.literal("close-above"),
        triggerPrice: positive,
        structureDate: researchDateSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    const expected =
      v.kind === "cycle-switch"
        ? "original-cycle-risk"
        : v.kind === "held-reduce"
          ? "current-equity-risk"
          : "first-entry-risk";
    if (v.budgetBasis !== expected)
      c.addIssue({ code: "custom", message: "预算来源与修复种类不符" });
    if (
      v.availableDate > v.observedDate ||
      v.lots.some((l) => l.date > v.observedDate) ||
      v.lots.some((l, i) => i > 0 && l.date < v.lots[i - 1]!.date)
    )
      c.addIssue({
        code: "custom",
        message: "输入/持仓当时不可知或批次未按日期排序",
      });
    if (
      v.kind === "cycle-switch" &&
      (!v.cycle ||
        v.frozenDate >= v.lots[0]!.date ||
        v.cycle.structureDate > v.observedDate ||
        v.proposedStop >= v.stop)
    )
      c.addIssue({
        code: "custom",
        message: "换周期须入场前冻结预案及当时已知更宽周期结构",
      });
    if (
      v.kind.startsWith("add-") &&
      (v.lots.length < 2 || v.lots.at(-1)!.date !== v.observedDate)
    )
      c.addIssue({ code: "custom", message: "加仓修复须当日实际加仓批次" });
    if (v.kind !== "cycle-switch" && v.proposedStop !== v.stop)
      c.addIssue({
        code: "custom",
        message: "修复不得迁就股数移动结构；抬线版由预算计算",
      });
  });
export type RiskRepair = z.infer<typeof riskRepairSchema>;
export const riskRepairMethods = {
  "cycle-switch": "RK-D-cycle-switch",
  "add-raise": "RK-D-add-repair",
  "add-reduce": "RK-D-add-repair",
  "held-reduce": "RK-C-held-risk-repair",
} as const;
export const riskRepairBoundary =
  "修复工程v1：人工预登记持仓情景独立重放，不伪造历史仓位或合入双突破净值。原文各批成本减统一线求和；执行预算另计买费、卖费及已实现损益，不让修复时低价卖出隐藏亏损。收盘确认后下一可成交开盘，FIFO/T+1/数量步长/单笔上限/费用沿用共享执行器。减仓取能满足预算的最小可申报股数，受阻保留；跳空已经超预算时可清仓但报告无法修复。换周期预案必须早于首批入场，收盘高于冻结阈值且已知新周期结构，更宽线仅在减仓完成且风险合格后生效，期间旧保护线保持。抬线不得低于旧线，算得保护价不低于当前价格则排队退出，不能假装锁定可成交价。未修复基线并列保留。";
export function riskRepairTemplate(kind: RiskRepair["kind"]): RiskRepair {
  return {
    version: "risk-repair-v1",
    provenance: "manual-scenario",
    kind,
    symbol: "sh600000",
    observedDate: "2021-01-06",
    frozenDate: "2021-01-01",
    availableDate: "2021-01-06",
    budget: 1000,
    budgetBasis:
      kind === "cycle-switch"
        ? "original-cycle-risk"
        : kind === "held-reduce"
          ? "current-equity-risk"
          : "first-entry-risk",
    stop: 95,
    proposedStop: kind === "cycle-switch" ? 90 : 95,
    lots: kind.startsWith("add-")
      ? [
          { date: "2021-01-04", quantity: 200, price: 100, commission: 0 },
          { date: "2021-01-06", quantity: 100, price: 105, commission: 0 },
        ]
      : [{ date: "2021-01-04", quantity: 400, price: 100, commission: 0 }],
    ...(kind === "cycle-switch"
      ? {
          cycle: {
            from: "intraday",
            to: "swing",
            trigger: "close-above",
            triggerPrice: 99,
            structureDate: "2021-01-06",
          },
        }
      : {}),
  };
}
export function repairRisk(
  book: ResearchPositionBook,
  stop: number,
  costs: z.infer<typeof backtestCostsSchema>,
) {
  const q = book.remainingQuantity;
  const amount = moneyMul(q, stop);
  const proceeds = q
    ? toNumber(
        big(amount)
          .minus(researchCommission(amount, costs))
          .minus(bpsOf(amount, costs.sellTaxBps)),
      )
    : 0;
  return toNumber(
    big(book.remainingCost).minus(proceeds).minus(book.realizedProfit),
  );
}
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
  let book = researchPositionBook();
  for (const lot of input.lots) book = researchBookBuy(book, lot);
  let stop = input.stop,
    pending = false,
    switched = false,
    cash = 0;
  const budget =
    input.kind === "cycle-switch"
      ? Math.min(input.budget, Math.max(0, repairRisk(book, input.stop, costs)))
      : input.budget;
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
  const eligible =
    input.kind !== "cycle-switch" || observed.close > input.cycle!.triggerPrice;
  const targetStop = input.kind === "cycle-switch" ? input.proposedStop : stop;
  const initialRisk = repairRisk(book, repair ? targetStop : stop, costs);
  pending = repair && eligible && initialRisk > budget + 1e-8;
  if (repair && eligible && input.kind === "cycle-switch" && !pending) {
    // Source exception requires an actual reduction, even if the supplied budget is generous.
    pending = true;
  }
  if (pending && input.kind === "add-raise") {
    let lo = stop,
      hi = observed.close;
    if (repairRisk(book, hi, costs) < budget - 1e-8) {
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (repairRisk(book, mid, costs) > budget) lo = mid;
        else hi = mid;
      }
      stop = hi;
      pending = false;
      actions.push({
        date: input.observedDate,
        kind: "raise",
        quantity: 0,
        price: null,
        stop,
        risk: repairRisk(book, stop, costs),
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
          risk: repairRisk(book, stop, costs),
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
          risk: repairRisk(book, stop, costs),
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
        // Monotonic FIFO remaining risk at the proposed stop when execution is above it.
        const minimum = rule.minimumSell!,
          step = rule.sellStep!;
        if (
          fill.price > targetStop &&
          repairRisk(trial(max).book, targetStop, costs) <= budget + 1e-8
        ) {
          let lo = 0,
            hi = Math.max(0, Math.floor((max - minimum) / step));
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (
              repairRisk(trial(minimum + mid * step).book, targetStop, costs) <=
              budget + 1e-8
            )
              hi = mid;
            else lo = mid + 1;
          }
          const candidate = minimum + lo * step;
          if (
            candidate <= max &&
            repairRisk(trial(candidate).book, targetStop, costs) <=
              budget + 1e-8
          )
            quantity = candidate;
        }
      }
      const sold = trial(quantity);
      book = sold.book;
      cash = toNumber(big(cash).plus(sold.netProceeds));
      const risk = repairRisk(book, targetStop, costs);
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
    risk: repairRisk(book, stop, costs),
    repaired: repairRisk(book, stop, costs) <= budget + 1e-8,
    accounting: {
      initialCost,
      realizedProfit: book.realizedProfit,
      remainingCost: book.remainingCost,
      cash,
    },
    boundary: riskRepairBoundary,
  };
}
