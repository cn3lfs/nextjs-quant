import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "./evidence";
import { sharedRead } from "./shared-read";
import { get, put } from "./db";
export const macroDefinitions = {
  "bond-10y": {
    label: "中国十年期国债即期收益率",
    query: "最新 中国10年期国债收益率 日期",
    id: "M005959895",
    name: "国债收益率:10年",
    indicator: "十年期国债即期收益率",
    frequency: "日",
  },
  "gdp-annual": {
    label: "中国年度GDP同比",
    query: "最新 中国年度GDP同比",
    id: "M002826938",
    name: "GDP:同比",
    indicator: "GDP同比增长率",
    frequency: "年",
  },
  "cpi-monthly": {
    label: "中国CPI当月同比",
    query: "最新 中国CPI同比",
    id: "M002826730",
    name: "CPI:当月同比",
    indicator: "CPI同比增长率",
    frequency: "月",
  },
  "ppi-cumulative": {
    label: "中国PPI累计同比",
    query: "最新 中国PPI同比",
    id: "M002842671",
    name: "PPI:累计同比",
    indicator: "PPI同比增长率",
    frequency: "月",
  },
  "manufacturing-pmi": {
    label: "中国制造业PMI",
    query: "最新 中国制造业PMI",
    id: "M002043802",
    name: "制造业PMI",
    indicator: "PMI",
    frequency: "月",
  },
} as const;
export type MacroProfile = keyof typeof macroDefinitions;
export const macroProfiles = Object.keys(macroDefinitions) as MacroProfile[];
const responseSchema = z.object({
  status_code: z.literal(0),
  code_count: z.literal(1),
  datas: z
    .array(
      z.object({
        国家: z.literal("中国"),
        时间: z.string(),
        指标: z.string(),
        指标值: z.union([z.number(), z.string()]),
        周期: z.string(),
        macro_id: z.string(),
        macro_name: z.string(),
        单位: z.literal("%"),
        地区级别: z.array(z.string()),
      }),
    )
    .length(1),
  columns: z
    .array(
      z.object({
        key: z.string(),
        index_name: z.string().optional(),
        type: z.string().optional(),
        unit: z.string().optional(),
        timestamp: z.string().optional(),
      }),
    )
    .min(1),
});
function definition(profile: MacroProfile) {
  if (!Object.hasOwn(macroDefinitions, profile))
    throw new Error("未知宏观指标");
  return macroDefinitions[profile];
}
export function macroEvidence(
  profile: MacroProfile,
  query: string,
  raw: unknown,
  fetchedAt: number,
): Evidence {
  const expected = definition(profile),
    response = responseSchema.parse(raw),
    row = response.datas[0]!;
  if (
    row.macro_id !== expected.id ||
    row.macro_name !== expected.name ||
    row.指标 !== expected.indicator ||
    row.周期 !== expected.frequency ||
    row.地区级别.length !== 1 ||
    row.地区级别[0] !== "国家"
  )
    throw new Error("宏观指标定义、周期或国家层级不匹配");
  validateHithinkColumns(row, response.columns);
  for (const [key, type, index] of [
    ["时间", "DATE", "宏观@交易日期"],
    ["指标值", "DOUBLE", "宏观@经济核算值"],
    ["单位", "STR", "宏观@单位"],
  ]) {
    if (
      !response.columns.some(
        (c) => c.key === key && c.type === type && c.index_name === index,
      )
    )
      throw new Error("宏观字段类型或单位元数据缺失");
  }
  const asOf = `${row.时间.slice(0, 4)}-${row.时间.slice(4, 6)}-${row.时间.slice(6, 8)}`;
  const date = Date.parse(`${asOf}T00:00:00+08:00`);
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(date) || date > fetchedAt)
    throw new Error("宏观资料日期非法或晚于抓取时间");
  const value = Number(row.指标值);
  if (!Number.isFinite(value)) throw new Error("宏观数值无效");
  if (expected.frequency === "年" && !row.时间.endsWith("1231"))
    throw new Error("年度宏观指标不是年末报告期");
  if (expected.frequency === "月") {
    const lastDay = new Date(
      Date.UTC(Number(row.时间.slice(0, 4)), Number(row.时间.slice(4, 6)), 0),
    ).getUTCDate();
    if (Number(row.时间.slice(6, 8)) !== lastDay)
      throw new Error("月度宏观指标不是月末报告期");
  }
  if (profile === "manufacturing-pmi" && (value < 0 || value > 100))
    throw new Error("PMI指数超出有效范围");
  const payload = {
    version: "macro-1",
    profile,
    query,
    response,
    facts: {
      label: expected.label,
      country: "中国",
      asOf,
      frequency: expected.frequency,
      value,
      sourceUnit: "%",
      rateFraction: profile === "bond-10y" ? value / 100 : null,
      interpretation:
        profile === "manufacturing-pmi"
          ? "扩散指数水平，不是同比增长率"
          : expected.label,
    },
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-macro-query",
    symbol: null,
    type: "quote-financial",
    asOf,
    publishedAt: null,
    fetchedAt,
    currency: null,
    unit: { 指标值: "%" },
    adjustment: "not-applicable",
    reportPeriod: expected.frequency === "日" ? null : row.时间,
    quality: "partial",
    warnings: [
      "资料来源：同花顺问财；来源日期为观察日或统计期末，不等于发布日期；只供当前背景，不回填历史回测。",
      "年度GDP、CPI当月同比、PPI累计同比与制造业PMI各自保留口径，不能混作同一月份的增长率。",
      "国债即期收益率不是企业WACC或到期收益率；百分数换为小数仅为单位换算，不自动替代用户估值参数。",
      "源端仅返回最近记录，修订版本与实际发布时点未核验；不同指标不同频率，不宣称均为实时数据。",
    ],
  });
  return {
    id: `macro-${envelope.payloadHash}`,
    source: "同花顺问财 / 中国宏观",
    asOf,
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function queryMacro(profile: MacroProfile, signal?: AbortSignal) {
  const expected = definition(profile);
  return shared(
    profile,
    async (upstream) => {
      upstream.throwIfAborted();
      const key = `macro-context-v1-${profile}`;
      const cached = get<{ createdAt: number; evidence: Evidence }>(key),
        age = cached ? Date.now() - cached.createdAt : Infinity;
      if (cached && age >= 0 && age < 30 * 60000) return cached.evidence;
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      const response = await request(
        "hithink-macro-query",
        expected.query,
        upstream,
      );
      upstream.throwIfAborted();
      const evidence = macroEvidence(
        profile,
        expected.query,
        response,
        Date.now(),
      );
      put("evidence", key, { createdAt: Date.now(), evidence });
      return evidence;
    },
    signal,
  );
}
