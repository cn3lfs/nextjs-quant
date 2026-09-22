import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { isAStock } from "../tdx/tdx";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "../../infra/evidence";
import { sharedRead } from "../../infra/shared-read";

const fields = {
  totalRevenue: "营业总收入",
  revenue: "营业收入",
  interestIncome: "利息收入",
} as const;
const responseSchema = z.object({
  status_code: z.literal(0),
  code_count: z.literal(1),
  datas: z.array(z.record(z.unknown())).length(1),
  columns: z
    .array(
      z.object({
        key: z.string(),
        index_name: z.string().optional(),
        type: z.string().optional(),
        timestamp: z.string().optional(),
        unit: z.string().optional(),
      }),
    )
    .min(1),
});
function identity(symbol: string, year: number) {
  if (
    !isAStock(symbol) ||
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 9998
  )
    throw new Error("收入口径资料需要A股证券与明确年度");
}
export function incomeScopeEvidence(
  symbol: string,
  year: number,
  query: string,
  raw: unknown,
  fetchedAt: number,
): Evidence {
  identity(symbol, year);
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt < Date.parse(`${year + 1}-01-01T00:00:00+08:00`)
  )
    throw new Error("收入口径年度尚未结束");
  const response = responseSchema.parse(raw),
    row = response.datas[0]!,
    period = `${year}1231`;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("收入口径证券身份不匹配");
  validateHithinkColumns(row, response.columns);
  const selected = new Set(["股票代码"]),
    missing: string[] = [];
  const read = (label: string): number | null => {
    const key = `${label}[${period}]`,
      column = response.columns.find((c) => c.key === key);
    if (!column) {
      missing.push(`${label}缺失`);
      return null;
    }
    if (
      column.index_name !== label ||
      column.type !== "DOUBLE" ||
      column.unit !== "元" ||
      column.timestamp !== period
    )
      throw new Error("收入口径定义、单位或年度不一致");
    selected.add(key);
    const value = row[key];
    if (value == null || value === "--") {
      missing.push(`${label}缺失`);
      return null;
    }
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
        String(value).trim(),
      ) ||
      !Number.isFinite(Number(value))
    )
      throw new Error("收入口径数值无效");
    return Number(value);
  };
  const amounts = {
    totalRevenue: read(fields.totalRevenue),
    revenue: read(fields.revenue),
    interestIncome: read(fields.interestIncome),
  };
  if (Object.values(amounts).every((v) => v === null))
    throw new Error("收入口径字段均缺失");
  const payload = {
    version: "income-scope-1",
    symbol,
    year,
    query,
    response: {
      ...response,
      columns: response.columns.filter((c) => selected.has(c.key)),
      datas: [
        Object.fromEntries(
          Object.entries(row).filter(([key]) => selected.has(key)),
        ),
      ],
    },
    facts: { period, amounts, missing },
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-finance-query",
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: Object.fromEntries(
      payload.response.columns
        .filter((c) => c.unit)
        .map((c) => [c.key, c.unit!]),
    ),
    adjustment: "not-applicable",
    reportPeriod: period,
    quality: "partial",
    warnings: [
      "营业总收入、营业收入、利息收入保留源端独立定义，不相互替代。",
      "总收入与营业收入之差可能包含其他项目；不预设差额必等于利息收入。",
      "元单位和数值勾稽不证明币种、合并范围、审计及披露时点已核验，不自动修改增长率或估值输入。",
    ],
  });
  return {
    id: `income-scope-${envelope.payloadHash}`,
    source: "同花顺问财 / 收入口径",
    asOf: `${period}报告期，披露时点未核验`,
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function queryIncomeScope(
  symbol: string,
  year: number,
  signal?: AbortSignal,
) {
  identity(symbol, year);
  return shared(
    `${symbol}:${year}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      upstream.throwIfAborted();
      const query = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()} 股票代码 股票简称 ${year}年 营业总收入 营业收入 利息收入`;
      const raw = await request("hithink-finance-query", query, upstream);
      upstream.throwIfAborted();
      return incomeScopeEvidence(symbol, year, query, raw, Date.now());
    },
    signal,
  );
}
