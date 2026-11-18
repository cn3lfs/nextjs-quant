import { rpsPeriods } from "quant-rps";
import { z } from "zod";
import {
  financialDate,
  financialCatalog,
} from "trading-strategy-core/financial";
import {
  factorConditionSchema,
  localDataFactorConditionSchema,
} from "trading-strategy-core/factors";
import { poolSelectionSchema } from "../market/market-pool";
export {
  financialCatalog,
  financialMappingVersion,
  financialVersions,
  type FinancialCell,
  type FinancialReportSnapshot,
  type FinancialMetric,
} from "trading-strategy-core/financial";
export const financialIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => financialDate(Number(value.replaceAll("-", ""))) === value,
    "日期不存在",
  );
export const financialSymbol = z.string().regex(/^(sh|sz|bj)\d{6}$/);
export const localFinancialQuery = z
  .object({
    symbol: financialSymbol,
    reportDate: financialIsoDate.optional(),
    asOf: financialIsoDate.optional(),
    strict: z.boolean().default(false),
    limit: z.number().int().min(1).max(160).default(12),
    section: z.string().max(100).optional(),
    search: z.string().max(100).default(""),
    pageIndex: z.number().int().min(0).default(0),
    pageSize: z.number().int().min(1).max(100).default(30),
    sort: z.enum(["slot", "label", "value"]).default("slot"),
    descending: z.boolean().default(false),
    trendMetric: z
      .string()
      .refine((id) => metricIds.includes(id), "未知财务趋势指标")
      .default("74-yoy"),
  })
  .refine((input) => !input.strict || !!input.asOf, "严格历史查询必须指定日期");
export type LocalFinancialQuery = z.infer<typeof localFinancialQuery>;
export const localSeriesQuery = z
  .object({
    symbol: financialSymbol,
    group: z.number().int().min(0).max(255).optional(),
    start: financialIsoDate.optional(),
    end: financialIsoDate.optional(),
    pageIndex: z.number().int().min(0).default(0),
    pageSize: z.number().int().min(1).max(100).default(30),
    descending: z.boolean().default(true),
  })
  .refine(
    (input) => !input.start || !input.end || input.start <= input.end,
    "开始日期晚于结束日期",
  );
export const financialSections = [
  ...new Set(
    financialCatalog
      .filter((field) => field.namespace === "FN")
      .map((field) => field.section),
  ),
  "未知/保留槽位",
];
const metricIds = [
  "debt-ratio",
  "net-margin",
  "parent-roe",
  "cash-to-profit",
  "goodwill-ratio",
  "receivables-ratio",
  "inventory-ratio",
  "current-ratio",
  "gross-margin",
  "free-cash-flow",
  ...[74, 96, 206, 107].flatMap((id) => [
    `${id}-yoy`,
    `${id}-quarter`,
    `${id}-ttm`,
  ]),
  ...[308, 309, 319, 281].map((id) => `source-${id}`),
  "74-cagr3",
  "96-cagr3",
];
export const financialConditionSchema = z.object({
  field: z
    .string()
    .refine(
      (code) =>
        metricIds.includes(code) ||
        !!financialCatalog.find(
          (field) =>
            field.code === code &&
            field.namespace === "FN" &&
            field.mappingStatus === "mapped" &&
            !["forecast", "flash"].includes(field.timing),
        ),
      "未知或不支持历史时点的财务条件",
    ),
  operator: z.enum(["gt", "gte", "lt", "lte"]),
  threshold: z.number().finite(),
});
export const financialScreenInput = z
  .object({
    symbols: z.array(financialSymbol).min(1).max(8000).optional(),
    pool: poolSelectionSchema.optional(),
    asOf: financialIsoDate,
    strict: z.boolean().default(true),
    theoryPreset: z.enum(["f-score", "magic-formula"]).optional(),
    mode: z.enum(["all", "any"]).default("all"),
    conditions: z.array(financialConditionSchema).max(12),
    technical: z.array(factorConditionSchema).max(6).default([]),
    dataFactors: z.array(localDataFactorConditionSchema).max(12).optional(),
    factorBlockSymbol: z
      .string()
      .regex(/^sh88\d{4}$/, "使用sh88开头的通达信板块代码")
      .optional(),
    rps: z
      .object({
        period: z
          .number()
          .refine((value) => (rpsPeriods as readonly number[]).includes(value)),
        minimum: z.number().min(0).max(100),
      })
      .optional(),
  })
  .refine(
    (input) =>
      (input.theoryPreset ? 1 : 0) +
        input.conditions.length +
        input.technical.length +
        (input.dataFactors?.length ?? 0) +
        (input.rps ? 1 : 0) >
      0,
    "至少添加一个筛选条件",
  );
export type FinancialScreenInput = z.infer<typeof financialScreenInput>;
