import { z } from "zod";
import {
  seriesValueDefinition,
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import type { Bar } from "../bars.js";
import { financialMetrics } from "../financial/metrics.js";
import { correlation, mean } from "./statistics.js";

export const localDataFactorVersion = "local-data-factors-v1";
export type LocalFactorSource = {
  namespace: "GP" | "SC" | "BK" | "unknown";
  filename: string;
  sourceSha256: string;
  records: {
    group: number;
    date: number | null;
    values: [number, number];
    offset: number;
  }[];
};
type Definition = {
  id: string;
  label: string;
  category: string;
  unit: string;
  formula: string;
  dependencies: (
    | "stock-series"
    | "market-series"
    | "block-series"
    | "reports"
    | "bars"
    | "benchmark"
  )[];
  field?: {
    namespace: "GP" | "SC" | "BK";
    group: number;
    side: 0 | 1;
    scale: number;
  };
};
const rawDefinitions: Definition[] = [];
// Only numeric, documented stock/market observations. ETF, event dates and unknown slots are not stock factors.
for (const [namespace, groups] of [
  [
    "GP",
    Array.from({ length: 50 }, (_, i) => i + 1).filter(
      (group) => ![33, 47].includes(group),
    ),
  ],
  ["BK", Array.from({ length: 15 }, (_, i) => i + 5)],
  ["SC", Array.from({ length: 42 }, (_, i) => i + 1)],
] as const) {
  for (const group of groups)
    for (const side of [0, 1] as const) {
      const field = seriesValueDefinition(namespace, group, side);
      if (
        !field ||
        field.unit === "日期" ||
        field.unit === "时间" ||
        (namespace === "GP" &&
          ((group === 15 && side === 0) || (group === 29 && side === 1)))
      )
        continue;
      rawDefinitions.push({
        id: `${namespace}${group}-${side}`,
        label: `${namespace}${group} ${field.label}`,
        category:
          namespace === "GP"
            ? "股票序列"
            : namespace === "BK"
              ? "指定板块"
              : "市场环境",
        unit: field.unit,
        formula: `同日${namespace}${group}值${side + 1} × ${field.scale}；原单位${field.rawUnit}。不前填，源零值未认证留空。`,
        dependencies: [
          namespace === "GP"
            ? "stock-series"
            : namespace === "BK"
              ? "block-series"
              : "market-series",
        ],
        field: { namespace, group, side, scale: field.scale },
      });
    }
}
const derivedDefinitions: Definition[] = [
  {
    id: "log-market-cap",
    label: "对数总市值",
    category: "规模",
    unit: "指数",
    formula: "ln(GP16总市值元)",
    dependencies: ["stock-series"],
  },
  ...(
    [
      ["pe-ttm", "市盈率 TTM", "倍", "总市值/归母净利润TTM；利润须正"],
      ["pb", "市净率", "倍", "总市值/最近已披露归母权益；权益须正"],
      ["ps-ttm", "市销率 TTM", "倍", "总市值/营业收入TTM；收入须正"],
      ["pcf-ttm", "市现率 TTM", "倍", "总市值/经营现金流TTM；现金流须正"],
      [
        "earnings-yield",
        "盈利收益率 E/P",
        "%",
        "归母净利润TTM/总市值 ×100；负利润保留",
      ],
      [
        "book-to-price",
        "账面市值比 B/P",
        "%",
        "最近已披露归母权益/总市值 ×100；负权益保留",
      ],
      ["sales-to-price", "销售市值比 S/P", "%", "营业收入TTM/总市值 ×100"],
      [
        "cashflow-yield",
        "现金流收益率 CF/P",
        "%",
        "经营现金流TTM/总市值 ×100；负现金流保留",
      ],
    ] as const
  ).map(([id, label, unit, formula]) => ({
    id,
    label,
    unit,
    formula,
    category: "估值",
    dependencies: ["stock-series", "reports"] as Definition["dependencies"],
  })),
  ...(
    [
      ["financing-to-cap", "融资余额/总市值", 3],
      ["financing-net-to-cap", "融资净买入/总市值", 13],
      ["northbound-net-to-cap", "陆股通净买入/总市值", 7],
    ] as const
  ).map(([id, label, group]) => ({
    id,
    label,
    unit: "%",
    category: "资金",
    formula: `GP${group}值1元/同日GP16总市值元 ×100`,
    dependencies: ["stock-series"] as Definition["dependencies"],
  })),
  {
    id: "amount-to-cap",
    label: "成交额/总市值",
    category: "流动性",
    unit: "%",
    formula: "同日日线成交额元/GP16总市值元 ×100；不是流通股换手率",
    dependencies: ["stock-series", "bars"],
  },
  {
    id: "market-beta-60",
    label: "市场 Beta（60日）",
    category: "风险",
    unit: "倍",
    formula:
      "60日个股与沪深300简单收益率协方差/基准方差；截距OLS，非Qlib价格斜率",
    dependencies: ["bars", "benchmark"],
  },
  {
    id: "market-correlation-60",
    label: "市场相关性（60日）",
    category: "风险",
    unit: "比例",
    formula: "60日个股与沪深300简单收益率Pearson相关系数",
    dependencies: ["bars", "benchmark"],
  },
  {
    id: "residual-volatility-60",
    label: "特质波动（60日）",
    category: "风险",
    unit: "%",
    formula: "含截距市场OLS残差标准误sqrt(SSE/(60−2)) ×100；不年化",
    dependencies: ["bars", "benchmark"],
  },
];
export const localDataFactorCatalog: readonly Definition[] = [
  ...rawDefinitions,
  ...derivedDefinitions,
];
export const localDataFactorConditionSchema = z
  .object({
    id: z
      .string()
      .refine(
        (id) => localDataFactorCatalog.some((f) => f.id === id),
        "未知本地数据因子",
      ),
    operator: z.enum(["gt", "gte", "lt", "lte"]),
    threshold: z.number().finite(),
  })
  .strict();
export type LocalDataFactorCondition = z.infer<
  typeof localDataFactorConditionSchema
>;
export type LocalFactorEvidence = {
  source: string;
  sourceSha256: string;
  date: string;
  field: string;
  raw?: number;
  value?: number;
  unit?: string;
  offset?: number;
};
export function calculateLocalDataFactors(input: {
  ids: readonly string[];
  asOf: string;
  stock?: LocalFactorSource;
  market?: LocalFactorSource;
  block?: LocalFactorSource;
  reports: readonly FinancialReportSnapshot[];
  bars?: readonly Bar[];
  benchmark?: readonly Bar[];
  barsHash?: string;
  benchmarkHash?: string;
}) {
  const cache = new Map<
    string,
    {
      value: number | null;
      reason: string | null;
      inputs: LocalFactorEvidence[];
    }
  >();
  const missing = (reason: string) => ({
    value: null,
    reason,
    inputs: [] as LocalFactorEvidence[],
  });
  const raw = (namespace: "GP" | "SC" | "BK", group: number, side: 0 | 1) => {
    const key = `${namespace}${group}-${side}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const source =
      namespace === "GP"
        ? input.stock
        : namespace === "BK"
          ? input.block
          : input.market;
    const field = seriesValueDefinition(namespace, group, side);
    if (!source || source.namespace !== namespace || !field)
      return missing(`${namespace}序列来源缺失或命名空间不符`);
    const date = Number(input.asOf.replaceAll("-", ""));
    const rows = source.records.filter(
      (r) => r.group === group && r.date === date,
    );
    const evidence = rows.map((row) => ({
      source: source.filename,
      sourceSha256: source.sourceSha256,
      date: input.asOf,
      field: key,
      raw: row.values[side],
      value: row.values[side] * field.scale,
      unit: field.unit,
      offset: row.offset,
    }));
    if (rows.length !== 1)
      return {
        value: null,
        reason: rows.length
          ? "同日同组重复记录，不能选择其中一条"
          : "无同日记录；不前填稀疏或无日期数据",
        inputs: evidence.length
          ? evidence
          : [
              {
                source: source.filename,
                sourceSha256: source.sourceSha256,
                date: input.asOf,
                field: key,
              },
            ],
      };
    const row = rows[0]!,
      value = row.values[side] * field.scale;
    const result = {
      value: Number.isFinite(value) && value !== 0 ? value : null,
      reason:
        value === 0
          ? "源零值缺少有效零认证"
          : Number.isFinite(value)
            ? null
            : "序列值或单位换算非法",
      inputs: evidence,
    };
    cache.set(key, result);
    return result;
  };
  let metrics: ReturnType<typeof financialMetrics> | undefined;
  return input.ids.map((id) => {
    const definition = localDataFactorCatalog.find((f) => f.id === id);
    if (!definition) throw new Error(`未知本地数据因子：${id}`);
    let result: ReturnType<typeof raw>;
    if (definition.field) {
      result = raw(
        definition.field.namespace,
        definition.field.group,
        definition.field.side,
      );
    } else if (definition.dependencies.includes("benchmark")) {
      const bars = (input.bars ?? [])
        .filter((b) => b.date.slice(0, 10) <= input.asOf)
        .slice(-61);
      const benchmark = (input.benchmark ?? [])
        .filter((b) => b.date.slice(0, 10) <= input.asOf)
        .slice(-61);
      const valid =
        bars.length === 61 &&
        benchmark.length === 61 &&
        bars.at(-1)!.date.slice(0, 10) === input.asOf &&
        bars.every(
          (b, i) =>
            b.date === benchmark[i]!.date &&
            b.close > 0 &&
            Number.isFinite(b.close) &&
            benchmark[i]!.close > 0 &&
            Number.isFinite(benchmark[i]!.close) &&
            (i === 0 || b.date > bars[i - 1]!.date),
        );
      result = missing("个股与沪深300需要61个完整且日期逐一相同的收盘观测");
      if (valid) {
        const stockReturns = bars
          .slice(1)
          .map((b, i) => b.close / bars[i]!.close - 1);
        const marketReturns = benchmark
          .slice(1)
          .map((b, i) => b.close / benchmark[i]!.close - 1);
        const averageStock = mean(stockReturns),
          averageMarket = mean(marketReturns);
        const variance = marketReturns.reduce(
          (s, r) => s + (r - averageMarket) ** 2,
          0,
        );
        const beta =
          stockReturns.reduce(
            (s, r, i) =>
              s + (r - averageStock) * (marketReturns[i]! - averageMarket),
            0,
          ) / variance;
        const residual =
          Math.sqrt(
            stockReturns.reduce(
              (s, r, i) =>
                s +
                (r -
                  averageStock -
                  beta * (marketReturns[i]! - averageMarket)) **
                  2,
              0,
            ) / 58,
          ) * 100;
        const value =
          id === "market-beta-60"
            ? beta
            : id === "market-correlation-60"
              ? correlation(stockReturns, marketReturns)
              : residual;
        result = {
          value:
            variance > 0 && value !== null && Number.isFinite(value)
              ? value
              : null,
          reason:
            variance > 0 && value !== null && Number.isFinite(value)
              ? null
              : "基准方差为零、相关性无定义或收益无效",
          inputs: [
            ...bars.map((b) => ({
              source: "stock-day",
              sourceSha256: input.barsHash ?? "",
              date: b.date,
              field: "close",
              value: b.close,
              unit: "元",
            })),
            ...benchmark.map((b) => ({
              source: "sh000300-day",
              sourceSha256: input.benchmarkHash ?? "",
              date: b.date,
              field: "close",
              value: b.close,
              unit: "元",
            })),
          ],
        };
      }
    } else {
      const cap = raw("GP", 16, 0);
      result = { ...cap, inputs: [...cap.inputs] };
      if (cap.value !== null && cap.value > 0) {
        let value: number | null = null;
        if (id === "log-market-cap") value = Math.log(cap.value);
        else if (definition.dependencies.includes("reports")) {
          metrics ??= financialMetrics(input.reports);
          const metricId =
            id === "pe-ttm" || id === "earnings-yield"
              ? "96-ttm"
              : id === "ps-ttm" || id === "sales-to-price"
                ? "74-ttm"
                : "107-ttm";
          const metric = metrics.find((m) => m.id === metricId);
          const equity = id === "pb" || id === "book-to-price";
          const numerator = equity
            ? sourceFinancialValue(input.reports[0], 271)
            : (metric?.value ?? null);
          const financialInputs = equity
            ? input.reports.slice(0, 1).map((r) => ({
                reportDate: r.reportDate,
                code: "FN271",
                sourceSha256: r.sourceSha256,
              }))
            : (metric?.inputs ?? []);
          result.inputs.push(
            ...financialInputs.map((r) => ({
              source: "financial-report",
              sourceSha256: r.sourceSha256,
              date: r.reportDate,
              field: r.code,
            })),
          );
          const multiple = ["pe-ttm", "pb", "ps-ttm", "pcf-ttm"].includes(id);
          if (numerator !== null && (!multiple || numerator > 0))
            value = multiple
              ? cap.value / numerator
              : (numerator / cap.value) * 100;
        } else if (id === "amount-to-cap") {
          const bar = input.bars
            ?.filter((b) => b.date.slice(0, 10) === input.asOf)
            .at(-1);
          if (bar && Number.isFinite(bar.amount) && bar.amount >= 0) {
            value = (bar.amount / cap.value) * 100;
            result.inputs.push({
              source: "stock-day",
              sourceSha256: input.barsHash ?? "",
              date: bar.date,
              field: "amount",
              value: bar.amount,
              unit: "元",
            });
          }
        } else {
          const group =
            id === "financing-to-cap"
              ? 3
              : id === "financing-net-to-cap"
                ? 13
                : 7;
          const flow = raw("GP", group, 0);
          result.inputs.push(...flow.inputs);
          if (flow.value !== null) value = (flow.value / cap.value) * 100;
        }
        result.value = value !== null && Number.isFinite(value) ? value : null;
        result.reason =
          result.value === null
            ? "财报组成期、同日行情/序列缺失，或估值分母非正"
            : null;
      } else if (cap.value !== null)
        result = { ...result, value: null, reason: "总市值必须为正" };
    }
    return {
      id,
      label: definition.label,
      unit: definition.unit,
      formula: definition.formula,
      ...result,
    };
  });
}
