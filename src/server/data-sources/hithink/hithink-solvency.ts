import { z } from "zod";
import type { Evidence } from "~/lib/domain";
import { isAStock } from "../tdx/tdx";
import { request } from "./hithink-context";
import { validateHithinkColumns } from "./hithink-columns";
import { evidenceEnvelope } from "../../infra/evidence";
import { sharedRead } from "../../infra/shared-read";
export const solvencyProfiles = ["balance", "coverage"] as const;
export type SolvencyProfile = (typeof solvencyProfiles)[number];
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
function identity(symbol: string, year: number, profile: SolvencyProfile) {
  if (
    !isAStock(symbol) ||
    !Number.isInteger(year) ||
    year < 1990 ||
    year > 9998
  )
    throw new Error("偿债资料需要A股证券与明确年度");
  z.enum(solvencyProfiles).parse(profile);
}
export function solvencyEvidence(
  symbol: string,
  year: number,
  profile: SolvencyProfile,
  query: string,
  raw: unknown,
  fetchedAt: number,
): Evidence {
  identity(symbol, year, profile);
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt < Date.parse(`${year + 1}-01-01T00:00:00+08:00`)
  )
    throw new Error("偿债资料年度尚未结束");
  const response = responseSchema.parse(raw),
    row = response.datas[0]!,
    period = `${year}1231`;
  if (
    row["股票代码"] !== `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
  )
    throw new Error("偿债资料证券身份不匹配");
  validateHithinkColumns(row, response.columns);
  const selected = new Set(["股票代码"]),
    missing: string[] = [];
  const read = (
    base: string,
    index: string,
    nonnegative = true,
  ): number | null => {
    const key = `${base}[${period}]`,
      column = response.columns.find((c) => c.key === key);
    if (!column) {
      missing.push(`${index}缺失`);
      return null;
    }
    if (
      column.index_name !== index ||
      column.type !== "DOUBLE" ||
      column.unit !== "元" ||
      column.timestamp !== period
    )
      throw new Error("偿债指标定义、单位或年度不一致");
    selected.add(key);
    const value = row[key];
    if (value == null || value === "--") {
      missing.push(`${index}缺失`);
      return null;
    }
    const number = Number(value);
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
        String(value).trim(),
      ) ||
      !Number.isFinite(number) ||
      (nonnegative && number < 0)
    )
      throw new Error("偿债指标数值无效");
    return number;
  };
  const amounts: Record<string, number | null> =
    profile === "balance"
      ? {
          assets: read("总资产", "资产总计"),
          liabilities: read("负债", "负债合计"),
          equity: read("所有者权益", "所有者权益合计", false),
        }
      : {
          ebit: read("息税前利润", "息税前利润ebit", false),
          interestExpense: read("利息支出", "利息支出"),
          reportedInterestBearingDebt: read("带息债务", "带息债务"),
        };
  if (Object.values(amounts).every((v) => v === null))
    throw new Error("偿债字段均缺失");
  let balanceVerified: boolean | null = null,
    debtToAssets: number | null = null,
    interestCoverage: number | null = null;
  if (profile === "balance") {
    const { assets, liabilities, equity } = amounts;
    if (assets !== null && assets! <= 0) throw new Error("总资产必须为正");
    if (assets != null && liabilities != null && equity != null) {
      const sum = liabilities + equity;
      if (
        !Number.isFinite(sum) ||
        Math.abs(assets - sum) >
          Math.max(0.01, Math.abs(assets) * Number.EPSILON * 16)
      )
        throw new Error("资产不等于负债与权益之和");
      balanceVerified = true;
      const ratio = liabilities / assets;
      if (Number.isFinite(ratio)) debtToAssets = ratio;
      else missing.push("资产负债率计算溢出");
    } else missing.push("资产负债表等式无法核对，不计算资产负债率");
  } else {
    const { ebit, interestExpense } = amounts;
    if (ebit != null && interestExpense != null && interestExpense > 0) {
      const ratio = ebit / interestExpense;
      if (Number.isFinite(ratio)) interestCoverage = ratio;
      else missing.push("利息保障倍数计算溢出");
    } else
      missing.push("利息保障倍数需要EBIT和正的利息支出，零支出不视为无限保障");
  }
  const payload = {
    version: "solvency-1",
    symbol,
    year,
    profile,
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
    facts: {
      period,
      amounts,
      balanceVerified,
      debtToAssets,
      interestCoverage,
      formulas: {
        debtToAssets: "负债合计/资产总计，先核对资产=负债+权益",
        interestCoverage: "EBIT/利息支出，利息支出必须为正",
      },
      missing,
    },
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
      "资料来源：同花顺问财；年度原始金额与来源元单位的条件性比率，不等于已独立核验的人民币估值输入。",
      "总负债与带息债务分开；带息债务是源端报告指标，组成、租赁负债及到期分类未核验，不自动填入企业价值扣减。",
      "EBIT与利息支出均保留源端定义，不用净利润或净利息费用替代；负权益及负EBIT保留，不隐藏困境。",
      "资产负债表等式通过只说明数值勾稽一致，不证明合并范围、币种、审计或披露时点已经核验。",
    ],
  });
  return {
    id: `solvency-${envelope.payloadHash}`,
    source: "同花顺问财 / 偿债资料",
    asOf: `${period}报告期，披露时点未核验`,
    text: JSON.stringify(payload),
    envelope,
  };
}
const shared = sharedRead<Evidence>();
export function querySolvency(
  symbol: string,
  year: number,
  profile: SolvencyProfile,
  signal?: AbortSignal,
) {
  identity(symbol, year, profile);
  return shared(
    `${symbol}:${year}:${profile}`,
    async (upstream) => {
      if (!process.env.IWENCAI_API_KEY) throw new Error("未配置问财凭证");
      upstream.throwIfAborted();
      const code = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
      const query = `${code} 股票代码 股票简称 ${year}年 ${profile === "balance" ? "负债合计 资产总计 所有者权益合计" : "息税前利润 利息支出 有息负债"}`;
      const raw = await request("hithink-finance-query", query, upstream);
      upstream.throwIfAborted();
      return solvencyEvidence(symbol, year, profile, query, raw, Date.now());
    },
    signal,
  );
}
