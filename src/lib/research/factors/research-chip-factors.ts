import { z } from "zod";
import { asOfTimestampSchema, type AsOfDomain } from "../evidence/as-of";
import { researchDateSchema } from "../workflow/research-usage";
import { symbolSchema } from "../../domain";

const percent = z.number().finite().min(0).max(100);
export const chipHistorySchema = z
  .object({
    symbol: symbolSchema,
    source: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1),
    comparabilityEvidence: z.string().trim().min(1),
    calendar: z.array(researchDateSchema).length(21),
    rows: z
      .array(
        z
          .object({
            date: researchDateSchema,
            availableAt: asOfTimestampSchema,
            capturedAt: asOfTimestampSchema,
            chipAvgCost: z.number().finite().positive(),
            chipConcentration90: percent,
            chipConcentration70: percent,
            chipProfitRate: percent,
          })
          .strict(),
      )
      .length(21),
  })
  .strict()
  .refine(
    (p) =>
      p.rows.length === p.calendar.length &&
      p.calendar.every(
        (d, i) =>
          (i === 0 || d > p.calendar[i - 1]!) &&
          p.rows[i]!.date === d &&
          Date.parse(p.rows[i]!.availableAt) >=
            Date.parse(`${d}T15:00:00+08:00`) &&
          Date.parse(p.rows[i]!.capturedAt) >=
            Date.parse(p.rows[i]!.availableAt),
      ),
    "21个完整交易日同源筹码须逐日对齐且收盘后可知",
  );

export const chipFactorRules: Record<string, string> = {
  "WP01-cost": "21交易日端点平均成本严格抬升；工程月窗口，不推断主力身份",
  "WP01-concentration": "21交易日端点70%及90%集中度均严格下降；数值越低越集中",
  "WP01-profit": "21交易日端点获利盘比例严格增加；不是未来盈利概率",
};

export function evaluateChipFactor(
  id: string,
  req: {
    symbol: string;
    observationDate: string;
    asOf: string;
    capturedBy?: string;
  },
  read: (domain: AsOfDomain, field: string, at: string) => unknown,
) {
  if (!Object.hasOwn(chipFactorRules, id)) throw new Error("未知筹码方法");
  const p = chipHistorySchema.parse(
    read("capital", "chipHistory", req.observationDate),
  );
  if (
    p.symbol !== req.symbol ||
    p.calendar.at(-1) !== req.observationDate ||
    p.rows.some(
      (r) =>
        Date.parse(r.availableAt) > Date.parse(req.asOf) ||
        (req.capturedBy != null &&
          Date.parse(r.capturedAt) > Date.parse(req.capturedBy)),
    )
  )
    throw new Error("筹码证券、窗口或可知时点不符");
  const first = p.rows[0]!,
    last = p.rows.at(-1)!;
  const changes = {
    costPct: (last.chipAvgCost / first.chipAvgCost - 1) * 100,
    concentration70Points: last.chipConcentration70 - first.chipConcentration70,
    concentration90Points: last.chipConcentration90 - first.chipConcentration90,
    profitPoints: last.chipProfitRate - first.chipProfitRate,
  };
  const passed =
    id === "WP01-cost"
      ? changes.costPct > 0
      : id === "WP01-profit"
        ? changes.profitPoints > 0
        : changes.concentration70Points < 0 &&
          changes.concentration90Points < 0;
  return {
    points: passed ? 1 : 0,
    participation: "rule" as const,
    details: {
      version: "chip-trend-21-v1",
      source: p.source,
      modelVersion: p.modelVersion,
      comparabilityEvidence: p.comparabilityEvidence,
      windowStart: first.date,
      windowEnd: last.date,
      first,
      last,
      changes,
      buyEligible: passed,
      action: passed ? "eligible" : "filtered",
      combination: {
        baseline: "dual-breakout",
        rebalance: "daily-close",
        entry: "next-legal-open",
        exit: "baseline-unchanged",
        weight: "baseline-unchanged",
      },
      limitations: [
        "供应商筹码模型估算，不证明主力建仓或控盘",
        "需补齐同模型历史筹码、首次可知时间及历史公司行动可比证明；未运行真实历史回测",
      ],
    },
  };
}
