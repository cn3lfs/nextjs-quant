import { randomBytes } from "node:crypto";
import { z } from "zod";
import { symbolSchema, type Evidence } from "~/lib/domain";
import { evidenceEnvelope } from "../../infra/evidence";
import { sepaFinanceFacts } from "../../../lib/strategy-facts/sepa-finance";
import { canslimFinanceFacts } from "../../../lib/strategy-facts/canslim-finance";

export const annualFinanceMetrics = {
  "annual-revenue": "营业收入",
  "annual-operating-cost": "营业成本",
  "annual-parent-profit": "归属于母公司所有者的净利润",
  "annual-minority-profit": "少数股东损益",
  "annual-assets": "资产总计",
  "annual-equity": "所有者权益合计",
  "annual-current-assets": "流动资产合计",
  "annual-current-liabilities": "流动负债合计",
} as const;

const responseSchema = z.object({
  status_code: z.literal(0),
  datas: z.array(z.record(z.unknown())),
  columns: z.array(
    z.object({
      key: z.string(),
      unit: z.string().optional(),
      timestamp: z.string().optional(),
      type: z.string().optional(),
    }),
  ),
});

export function financeEvidence(
  symbol: string,
  response: unknown,
  query: string,
  fetchedAt: number,
): Evidence & { fetchedAt: number } {
  symbolSchema.parse(symbol);
  const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
  const data = responseSchema.parse(response);
  if (data.datas.length !== 1 || data.datas[0]?.["股票代码"] !== code)
    throw new Error("问财财务结果身份不唯一或不匹配");
  const columnKeys = new Set<string>();
  for (const column of data.columns) {
    if (columnKeys.has(column.key)) throw new Error("问财财务字段重复");
    columnKeys.add(column.key);
    if (column.timestamp) {
      const stamp = column.timestamp;
      const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
      const time = Date.parse(`${day}T00:00:00Z`);
      if (
        !/^\d{8}$/.test(stamp) ||
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== day
      )
        throw new Error("问财财务字段日期非法");
      const embedded = column.key.match(/\[(\d{8})\]$/)?.[1];
      if (embedded && embedded !== stamp)
        throw new Error("问财财务字段日期冲突");
    }
    const value = data.datas[0]![column.key];
    if (column.type === "DOUBLE" && value != null && value !== "--") {
      if (
        (typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" &&
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
            value.trim(),
          )) ||
        !Number.isFinite(Number(value))
      )
        throw new Error("问财财务数值字段非法");
    }
  }
  // Preserve field-specific units and periods; never infer a common report date.
  // Only retain documented data fields, not gateway tokens or diagnostics.
  const payload = {
    query,
    row: data.datas[0],
    columns: data.columns,
    ...(data.columns.some(
      (c) => c.key.includes("每股") || c.key.startsWith("单季度_"),
    )
      ? {
          canslimFinanceDiagnostic: canslimFinanceFacts(
            data.datas[0]!,
            data.columns,
          ),
        }
      : {}),
    ...(data.columns.some((c) => c.key.startsWith("单季度_"))
      ? {
          sepaFinanceDiagnostic: sepaFinanceFacts(data.datas[0]!, data.columns),
        }
      : {}),
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
      data.columns.filter((c) => c.unit).map((c) => [c.key, c.unit!]),
    ),
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "同花顺问财当前研究资料；各字段报告期和单位以 columns 为准，缺失时不得推断。",
      "最新指标可能采用不同来源；公告可用时点未逐项核验，不用于历史研究。",
    ],
  });
  return {
    id: `finance-${symbol}-${envelope.payloadHash.slice(0, 16)}`,
    source: "同花顺问财 / 财务查询",
    asOf: "逐字段报告期，非统一时点",
    text: JSON.stringify(payload),
    fetchedAt,
    envelope,
  };
}

export async function queryFinance(
  symbol: string,
  signal?: AbortSignal,
  profile:
    | keyof typeof annualFinanceMetrics
    | "overview"
    | "growth"
    | "quarter-eps"
    | "annual-eps"
    | "annual-cash-flow"
    | "annual-capex" = "overview",
) {
  symbolSchema.parse(symbol);
  const key = process.env.IWENCAI_API_KEY;
  if (!key) throw new Error("未配置问财凭证");
  const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
  const lastAnnualYear =
    new Date(Date.now() + 8 * 3600000).getUTCFullYear() - 1;
  const metric =
    annualFinanceMetrics[profile as keyof typeof annualFinanceMetrics];
  const queries = metric
    ? [
        `${code} ${lastAnnualYear - 4}年至${lastAnnualYear}年 每年年报${metric}`,
        `${code} ${lastAnnualYear - 2}年至${lastAnnualYear}年 每年年报${metric}`,
        `${code} ${lastAnnualYear}年 年报${metric}`,
      ]
    : profile === "annual-capex"
      ? [
          `${code} ${lastAnnualYear - 4}年至${lastAnnualYear}年 每年年报 购建固定资产、无形资产和其他长期资产支付的现金`,
          `${code} 最近5年 年报购建固定资产无形资产和其他长期资产支付的现金`,
          `${code} 最近3年 年报购建固定资产无形资产和其他长期资产支付的现金`,
        ]
      : profile === "annual-cash-flow"
        ? [
            `${code} ${lastAnnualYear - 4}年至${lastAnnualYear}年 每年年报经营活动产生的现金流量净额`,
            `${code} 最近5年 年报经营活动产生的现金流量净额 年报购建固定资产无形资产和其他长期资产支付的现金 年报净利润`,
            `${code} 最近3年 年报经营活动产生的现金流量净额 年报购建固定资产无形资产和其他长期资产支付的现金`,
          ]
        : profile === "quarter-eps"
          ? [
              `${code} 最近8个季度 单季度基本每股收益 单季度基本每股收益同比增长率`,
              `${code} 最近8个季度 单季度基本每股收益`,
              `${code} 最近4个季度 单季度基本每股收益`,
            ]
          : profile === "annual-eps"
            ? [
                `${code} 最近5年 年报基本每股收益 年报每股经营现金流量 年报净资产收益率`,
                `${code} 最近5年 年报基本每股收益 年报每股经营现金流量`,
                `${code} 最近3年 年报基本每股收益 年报每股经营现金流量`,
              ]
            : profile === "growth"
              ? [
                  `${code} 最近8个季度 单季度营业收入同比增长率 单季度归母净利润同比增长率 单季度营业收入 单季度归母净利润 最近3年净资产收益率`,
                  `${code} 最近8个季度 单季度营业收入同比增长率 单季度归母净利润同比增长率 单季度营业收入 单季度归母净利润`,
                  `${code} 最近2个季度 单季度营业收入同比增长率 单季度归母净利润同比增长率`,
                ]
              : [
                  `${code} 最新报告期 营业收入 归母净利润 净资产收益率 资产负债率 经营活动产生的现金流量净额`,
                  `${code} 营业收入 归母净利润 净资产收益率 资产负债率 经营活动产生的现金流量净额`,
                  `${code} 营业收入 净利润`,
                ];
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  for (const [attempt, query] of queries.entries()) {
    requestSignal.throwIfAborted();
    const response = await fetch("https://openapi.iwencai.com/v1/query2data", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Claw-Call-Type": attempt ? "retry" : "normal",
        "X-Claw-Skill-Id": "hithink-finance-query",
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": randomBytes(32).toString("hex"),
      },
      body: JSON.stringify({
        query,
        page: "1",
        limit: "10",
        is_cache: "1",
        expand_index: "true",
      }),
      signal: requestSignal,
    });
    if (!response.ok) throw new Error("问财财务查询失败");
    const payload: unknown = await response.json();
    const empty = z
      .object({
        status_code: z.literal(0),
        datas: z.array(z.unknown()).length(0),
      })
      .safeParse(payload).success;
    if (empty) continue;
    return financeEvidence(symbol, payload, query, Date.now());
  }
  throw new Error("问财财务查询三次均无结果");
}
