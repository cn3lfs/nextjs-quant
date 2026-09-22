import { randomBytes } from "node:crypto";
import { z } from "zod";
import { symbolSchema, type Evidence } from "~/lib/domain";
import { evidenceEnvelope } from "../../infra/evidence";
import { validateHithinkColumns } from "./hithink-columns";
const table = z.object({
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
type Skill = "hithink-basicinfo-query" | "hithink-industry-query";
export async function request(
  skill:
    | Skill
    | "hithink-astock-selector"
    | "hithink-sector-selector"
    | "hithink-business-query"
    | "hithink-management-query"
    | "hithink-insresearch-query"
    | "hithink-macro-query"
    | "hithink-event-query"
    | "hithink-market-query"
    | "hithink-finance-query",
  query: string,
  signal?: AbortSignal,
  page = 1,
  limit = 10,
  callType: "normal" | "retry" = "normal",
) {
  const response = await fetch("https://openapi.iwencai.com/v1/query2data", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${process.env.IWENCAI_API_KEY}`,
      "Content-Type": "application/json",
      "X-Claw-Call-Type": callType,
      "X-Claw-Skill-Id": skill,
      "X-Claw-Skill-Version": "1.0.0",
      "X-Claw-Plugin-Id": "none",
      "X-Claw-Plugin-Version": "none",
      "X-Claw-Trace-Id": randomBytes(32).toString("hex"),
    },
    body: JSON.stringify({
      query,
      page: String(page),
      limit: String(limit),
      is_cache: "1",
      expand_index: "true",
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("问财行业背景查询失败");
  return response.json() as Promise<unknown>;
}
export function contextEvidence(
  symbol: string,
  skill: Skill,
  query: string,
  response: unknown,
  industry?: string,
): Evidence & { fetchedAt: number } {
  symbolSchema.parse(symbol);
  const data = table.parse(response),
    row = data.datas[0];
  if (data.datas.length !== 1 || !row) throw new Error("行业背景身份不唯一");
  validateHithinkColumns(row, data.columns);
  if (skill === "hithink-basicinfo-query") {
    if (
      row["股票代码"] !==
      `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
    )
      throw new Error("股票身份不匹配");
  } else if (
    !industry ||
    row["指数简称"] !== industry ||
    row["指数类型"] !== "申万一级行业指数" ||
    typeof row["指数代码"] !== "string" ||
    !/^\d{6}\.SL$/.test(row["指数代码"])
  )
    throw new Error("行业指数身份未核验");
  const payload = { query, row, columns: data.columns },
    fetchedAt = Date.now();
  const envelope = evidenceEnvelope(payload, {
    source: skill,
    symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: Object.fromEntries(
      data.columns.filter((c) => c.unit).map((c) => [c.key, c.unit!]),
    ),
    adjustment: "unknown",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "当前行业背景，行业分类及指数归属不能用于历史时点研究。",
      "逐字段保留源单位和日期；查询中要求但响应未提供的指标仍为缺失，不从成分股首页推算行业平均。",
    ],
  });
  return {
    id: `context-${skill}-${envelope.payloadHash.slice(0, 16)}`,
    source: `同花顺问财 / ${skill}`,
    asOf: "源时点逐字段核验",
    text: JSON.stringify(payload),
    fetchedAt,
    envelope,
  };
}
export async function queryIndustryContext(
  symbol: string,
  signal?: AbortSignal,
) {
  symbolSchema.parse(symbol);
  if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
  signal?.throwIfAborted();
  const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
  const basicQuery = `${code} 股票代码 股票简称 所属申万一级行业 所属同花顺行业 上市日期`;
  const basic = contextEvidence(
    symbol,
    "hithink-basicinfo-query",
    basicQuery,
    await request("hithink-basicinfo-query", basicQuery, signal),
  );
  const row = JSON.parse(basic.text).row as Record<string, unknown>;
  const industry = row["所属申万一级行业"];
  if (
    typeof industry !== "string" ||
    !/^[\u4e00-\u9fffA-Za-z0-9（）()]{1,40}$/.test(industry)
  )
    return [basic];
  const query = `${industry} 申万行业指数 指数代码 指数简称 近1月涨跌幅 市盈率`;
  try {
    return [
      basic,
      contextEvidence(
        symbol,
        "hithink-industry-query",
        query,
        await request("hithink-industry-query", query, signal),
        industry,
      ),
    ];
  } catch {
    signal?.throwIfAborted();
    return [
      basic,
      {
        id: `missing-industry-${symbol}`,
        source: "行业资料可用性检查",
        asOf: "未知",
        text: "行业指数未能唯一核验；不得推断缺失指标。",
        fetchedAt: Date.now(),
      },
    ];
  }
}
