import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { isAStock } from "../tdx/tdx";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "../../infra/evidence";
import { sharedRead } from "../../infra/shared-read";
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
export function forecastYear(now = Date.now()) {
  return Number(
    new Date(now).toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
    }),
  );
}
function identity(symbol: string, year: number) {
  if (
    !isAStock(symbol) ||
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 9996
  )
    throw new Error("盈利预测需要A股证券和明确预测年度");
}
export function forecastEvidence(
  symbol: string,
  startYear: number,
  query: string,
  raw: unknown,
  fetchedAt: number,
): Evidence {
  identity(symbol, startYear);
  if (!Number.isFinite(fetchedAt) || forecastYear(fetchedAt) !== startYear)
    throw new Error("预测起始年度与当前抓取年度不一致");
  const response = responseSchema.parse(raw),
    row = response.datas[0]!;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("盈利预测证券身份不匹配");
  validateHithinkColumns(row, response.columns);
  const selected = new Set(["股票代码"]);
  const annual = Array.from({ length: 3 }, (_, i) => {
    const period = `${startYear + i}1231`;
    const read = (
      base: string,
      index: string,
      type: string,
      unit: string,
    ): number | null => {
      const key = `${base}[${period}]`,
        column = response.columns.find((c) => c.key === key);
      if (!column) return null;
      if (
        column.index_name !== index ||
        column.type !== type ||
        column.unit !== unit ||
        column.timestamp !== period
      )
        throw new Error("盈利预测指标定义、年度或单位不匹配");
      selected.add(key);
      const value = row[key];
      if (value == null || value === "--") return null;
      if (
        (typeof value !== "string" && typeof value !== "number") ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
          String(value).trim(),
        ) ||
        !Number.isFinite(Number(value))
      )
        throw new Error("盈利预测数值无效");
      return Number(value);
    };
    const profitMedian = read(
      "预测净利润中值",
      "预测净利润中值(虚拟表)",
      "DOUBLE",
      "元",
    );
    const epsMedian = read(
      "每股收益中值",
      "预测每股收益中值(虚拟表)",
      "DOUBLE",
      "元",
    );
    const institutionCount = read("预测家数", "预测家数(虚拟表)", "LONG", "家");
    if (
      institutionCount !== null &&
      (!Number.isSafeInteger(institutionCount) || institutionCount < 0)
    )
      throw new Error("预测机构家数必须为非负整数");
    if (institutionCount === 0 && (profitMedian !== null || epsMedian !== null))
      throw new Error("零覆盖机构与非空预测值矛盾");
    return { period, profitMedian, epsMedian, institutionCount };
  });
  if (!annual.some((a) => a.profitMedian !== null || a.epsMedian !== null))
    throw new Error("三个预测年度均无可用盈利预测");
  const payload = {
    version: "forecast-1",
    symbol,
    startYear,
    query,
    statistic: "source-median",
    response: {
      ...response,
      columns: response.columns.filter((c) => selected.has(c.key)),
      datas: [
        Object.fromEntries(
          Object.entries(row).filter(([key]) => selected.has(key)),
        ),
      ],
    },
    annual,
    aggregationAsOf: null,
    coverageWindow: null,
    institutions: null,
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-insresearch-query",
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
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "资料来源：同花顺问财；净利润和每股收益为源端预测中值，不是已实现财务、平均值或本应用估值。",
      "字段日期为预测目标年度，不是预测发布日期或更新截止日；单篇研报日期不能证明整组预测时点。不能用于历史回测。",
      "预测家数按各年度保留；机构名单、样本重叠、纳入窗口及中值算法尚未核验，不把家数当作概率或确定性。",
      "元单位不自动证明币种；净利润归属、每股收益分母及摊薄口径未核验，禁止由两项独立中值相除反推股本。",
      "缺项保留null；亏损预测保留负值，不自动生成PE、PEG、评级或目标价。",
    ],
  });
  return {
    id: `forecast-${envelope.payloadHash}`,
    source: "同花顺问财 / 盈利预测",
    asOf: "预测目标年度逐项保留，聚合更新时点未核验",
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function queryForecast(
  symbol: string,
  startYear: number,
  signal?: AbortSignal,
) {
  identity(symbol, startYear);
  return shared(
    `${symbol}:${startYear}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      upstream.throwIfAborted();
      const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
      const query = `${code} 股票代码 股票简称 ${Array.from({ length: 3 }, (_, i) => `${startYear + i}年`).join(" ")} 预测净利润中值 预测每股收益中值 预测家数`;
      const raw = await request("hithink-insresearch-query", query, upstream);
      upstream.throwIfAborted();
      return forecastEvidence(symbol, startYear, query, raw, Date.now());
    },
    signal,
  );
}
