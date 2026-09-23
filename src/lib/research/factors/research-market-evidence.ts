import { z } from "zod";
import type { ResearchExecutionRules } from "../technical/research-execution";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
    );
  });
export const researchMarketEvidenceSchema = z
  .object({
    version: z.literal("research-market-evidence-1"),
    source: z.string().trim().min(1).max(500),
    exportedAt: z.number().int().nonnegative(),
    // A provider assertion, retained as evidence; importing is not verification.
    adjustment: z.literal("none"),
    corporateActionFree: z
      .array(
        z.object({
          symbol: z.string().regex(/^(sh|sz)\d{6}$/),
          start: date,
          end: date,
          evidenceId: z.string().min(1).max(200),
        }),
      )
      .default([]),
    rows: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^(sh|sz)\d{6}$/),
            date,
            tradable: z.boolean(),
            limitUp: z.number().finite().positive().nullable(),
            limitDown: z.number().finite().positive().nullable(),
            minimumBuy: z.number().int().positive().max(1000000),
            buyStep: z.number().int().positive().max(1000000),
            maximumOrder: z.number().int().positive().max(10000000),
            minimumSell: z.number().int().positive().max(1000000).optional(),
            sellStep: z.number().int().positive().max(1000000).optional(),
            sellOddLotAll: z.boolean().optional(),
            maximumSell: z.number().int().positive().max(10000000).optional(),
            evidenceId: z.string().min(1).max(200),
          })
          .superRefine((row, context) => {
            const supplied = [
              row.minimumSell,
              row.sellStep,
              row.sellOddLotAll,
              row.maximumSell,
            ].filter((v) => v !== undefined).length;
            if (
              (supplied !== 0 && supplied !== 4) ||
              (row.minimumSell != null &&
                row.maximumSell != null &&
                row.minimumSell > row.maximumSell)
            )
              context.addIssue({
                code: "custom",
                message: "卖出数量规则须完整提供且最小量不超过最大量",
              });
            if (row.minimumBuy > row.maximumOrder)
              context.addIssue({
                code: "custom",
                message: "最小申报量超过最大申报量",
              });
            if (
              row.limitUp !== null &&
              row.limitDown !== null &&
              row.limitUp <= row.limitDown
            )
              context.addIssue({ code: "custom", message: "涨跌停价格倒置" });
          }),
      )
      .max(1000000),
  })
  .superRefine((value, context) => {
    for (const coverage of value.corporateActionFree)
      if (coverage.start > coverage.end)
        context.addIssue({ code: "custom", message: "公司行动覆盖日期倒置" });
    const seen = new Set<string>();
    for (const row of value.rows) {
      const key = `${row.symbol}:${row.date}`;
      if (seen.has(key)) {
        context.addIssue({ code: "custom", message: `交易条件重复：${key}` });
        break;
      }
      seen.add(key);
    }
  });
export type ResearchMarketEvidence = z.infer<
  typeof researchMarketEvidenceSchema
>;
export function researchEvidenceLookup(evidence: ResearchMarketEvidence) {
  const rows = new Map(
    evidence.rows.map((row) => [`${row.symbol}:${row.date}`, row]),
  );
  return (symbol: string, date: string): ResearchExecutionRules | null => {
    const row = rows.get(`${symbol}:${date}`);
    return row
      ? { ...row, evidence: `${evidence.source}/${row.evidenceId}` }
      : null;
  };
}
