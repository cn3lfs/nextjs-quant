import { z } from "zod";
import { researchDateSchema } from "../contracts/date.js";
import type { ResearchPositionBook } from "../contracts/position-book.js";
import { big, bpsOf, moneyMul, toNumber } from "trading-strategy-core/money";
const positive = z.number().finite().positive();
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
  quote: { commission(amount: number): number; sellTaxBps: number },
) {
  const q = book.remainingQuantity;
  const amount = moneyMul(q, stop);
  const proceeds = q
    ? toNumber(
        big(amount)
          .minus(quote.commission(amount))
          .minus(bpsOf(amount, quote.sellTaxBps)),
      )
    : 0;
  return toNumber(
    big(book.remainingCost).minus(proceeds).minus(book.realizedProfit),
  );
}

export function initialRepairPlan(
  input: RiskRepair,
  currentRisk: number,
  targetRisk: number,
  close: number,
  repair: boolean,
) {
  const budget =
    input.kind === "cycle-switch"
      ? Math.min(input.budget, Math.max(0, currentRisk))
      : input.budget;
  const eligible =
    input.kind !== "cycle-switch" || close > input.cycle!.triggerPrice;
  const initialRisk = repair ? targetRisk : currentRisk;
  return {
    budget,
    eligible,
    initialRisk,
    pending:
      repair &&
      eligible &&
      (initialRisk > budget + 1e-8 || input.kind === "cycle-switch"),
  };
}

/** Quote callbacks evaluate hypothetical books; the caller alone applies actual fills. */
export function repairRaisedStop(
  stop: number,
  close: number,
  budget: number,
  riskAt: (price: number) => number,
) {
  let lo = stop,
    hi = close;
  if (riskAt(hi) >= budget - 1e-8) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (riskAt(mid) > budget) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function repairReductionQuantity(input: {
  maximum: number;
  minimum: number;
  step: number;
  price: number;
  stop: number;
  budget: number;
  riskAfter: (quantity: number) => number;
}) {
  const { maximum, minimum, step, price, stop, budget, riskAfter } = input;
  if (price <= stop || riskAfter(maximum) > budget + 1e-8) return maximum;
  let lo = 0,
    hi = Math.max(0, Math.floor((maximum - minimum) / step));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (riskAfter(minimum + mid * step) <= budget + 1e-8) hi = mid;
    else lo = mid + 1;
  }
  const candidate = minimum + lo * step;
  return candidate <= maximum && riskAfter(candidate) <= budget + 1e-8
    ? candidate
    : maximum;
}
