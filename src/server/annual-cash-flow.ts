import { createHash } from "node:crypto";
import { symbolSchema, type Evidence } from "~/lib/domain";
import { queryFinance } from "./hithink-finance";
import { sharedRead } from "./shared-read";
const cashFlowFields = {
  operatingCashFlow: "经营活动产生的现金流量净额",
  capitalExpenditure: "购建固定资产、无形资产和其他长期资产支付的现金",
  reportedCapitalExpenditure: "资本性支出",
  netProfit: "净利润",
  parentNetProfit: "归属于母公司所有者的净利润",
} as const;
type Point = {
  field: string;
  raw: unknown;
  rawUnit: string | null;
  value: number | null;
  currency: "CNY" | null;
  reasons: string[];
  evidenceId: string;
};
const units: Record<string, { scale: number; currency: "CNY" | null }> = {
  元: { scale: 1, currency: null },
  万元: { scale: 10000, currency: null },
  亿元: { scale: 100000000, currency: null },
  人民币元: { scale: 1, currency: "CNY" },
  人民币万元: { scale: 10000, currency: "CNY" },
  人民币亿元: { scale: 100000000, currency: "CNY" },
};

/** Annual amounts only; generic yuan units do not certify reporting currency. */
export function annualAmounts<Field extends string>(
  symbol: string,
  evidence: Evidence[],
  fields: Record<Field, string | readonly string[]>,
  now = Date.now(),
) {
  symbolSchema.parse(symbol);
  if (!Number.isFinite(now)) throw new Error("财务核验时点无效");
  const today = new Date(now + 8 * 3600000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const years = new Map<string, Partial<Record<Field, Point[]>>>();
  const rejected: { field: string; evidenceId: string; reason: string }[] = [];
  for (const entry of evidence) {
    if (
      entry.envelope?.source !== "hithink-finance-query" ||
      entry.envelope.symbol !== symbol
    )
      throw new Error("年度现金流证据来源或证券不匹配");
    const payload = JSON.parse(entry.text) as {
      row: Record<string, unknown>;
      columns: { key: string; unit?: string; timestamp?: string }[];
    };
    if (
      createHash("sha256").update(JSON.stringify(payload)).digest("hex") !==
      entry.envelope.payloadHash
    )
      throw new Error("年度现金流证据内容哈希不匹配");
    if (
      payload.row["股票代码"] !==
      `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
    )
      throw new Error("年度现金流原文证券不匹配");
    for (const column of payload.columns) {
      const match = column.key.match(/^(.+)\[(\d{8})\]$/);
      const id = (Object.keys(fields) as Field[]).find((id) =>
        typeof fields[id] === "string"
          ? fields[id] === match?.[1]
          : (fields[id] as readonly string[]).includes(match?.[1] ?? ""),
      );
      if (!id || !match) continue;
      const period = match[2]!;
      if (!/^[12]\d{3}1231$/.test(period) || period > today) {
        rejected.push({
          field: column.key,
          evidenceId: entry.id,
          reason: "非已结束年度报告期，不把累计季度数或未来年度当成年报",
        });
        continue;
      }
      const reasons: string[] = [];
      if (column.timestamp !== period) reasons.push("字段报告期与元数据不一致");
      const unit = units[column.unit ?? ""];
      if (!unit) reasons.push("金额单位缺失或不支持");
      const raw = payload.row[column.key];
      const numeric =
        typeof raw === "number" ||
        (typeof raw === "string" &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()));
      const value = numeric && unit ? Number(raw) * unit.scale : NaN;
      if (!Number.isFinite(value)) reasons.push("金额缺失、非法或换算溢出");
      if (id === "capitalExpenditure" && value < 0)
        reasons.push("购建现金支出为负，不能自动取绝对值");
      const currency = unit?.currency ?? null;
      const annual: Partial<Record<Field, Point[]>> = years.get(period) ?? {};
      (annual[id] ??= []).push({
        field: column.key,
        raw,
        rawUnit: column.unit ?? null,
        value: reasons.length ? null : value,
        currency,
        reasons,
        evidenceId: entry.id,
      });
      years.set(period, annual);
    }
  }
  const annual = [...years]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, series]) => {
      const amounts = Object.fromEntries(
        (Object.keys(fields) as Field[]).map((id) => {
          const points = series[id] ?? [];
          const valid =
            points.length > 0 &&
            points.every(
              (p) =>
                p.value !== null &&
                p.value === points[0]!.value &&
                p.currency === points[0]!.currency,
            );
          const duplicates =
            new Set(points.map((p) => `${p.evidenceId}:${p.field}`)).size !==
            points.length;
          return [
            id,
            {
              value: valid && !duplicates ? points[0]!.value : null,
              currency: valid && !duplicates ? points[0]!.currency : null,
              points,
              reasons: !points.length
                ? ["缺少该年度字段"]
                : !valid || duplicates
                  ? ["同年度证据缺失、无效、重复或冲突"]
                  : [],
            },
          ];
        }),
      ) as Record<
        Field,
        {
          value: number | null;
          currency: "CNY" | null;
          points: Point[];
          reasons: string[];
        }
      >;
      return { period, amountUnit: "yuan" as const, amounts };
    });
  return { annual, rejected };
}

export function annualCashFlow(
  symbol: string,
  evidence: Evidence[],
  now = Date.now(),
) {
  const parsed = annualAmounts(symbol, evidence, cashFlowFields, now);
  const annual = parsed.annual.map(({ period, amounts }) => {
    const ocf = amounts.operatingCashFlow,
      capex = amounts.capitalExpenditure;
    const currencyVerified = ocf.currency === "CNY" && capex.currency === "CNY";
    const difference =
      ocf.value !== null && capex.value !== null && currencyVerified
        ? ocf.value - capex.value
        : null;
    const postCapexCashFlow =
      difference !== null && Number.isFinite(difference) ? difference : null;
    return {
      period,
      amountUnit: "yuan",
      amounts,
      postCapexCashFlow,
      missing: [
        ...(!currencyVerified
          ? ["财报币种尚未核验，不能把元自动视为人民币"]
          : []),
        ...(ocf.value === null || capex.value === null
          ? ["同年度经营现金流或资本支出不完整"]
          : []),
        ...(difference !== null && !Number.isFinite(difference)
          ? ["现金流差额计算溢出"]
          : []),
      ],
    };
  });
  return {
    version: "annual-cash-flow-1",
    symbol,
    annual,
    rejected: parsed.rejected,
    warnings: [
      "保留单位换算后的金额与原始字段；币种未知的金额不得直接用于人民币估值",
      "经营现金流减全部购建支出不等同于FCFF，也不等同于郭永清法的保全性现金流",
      "源端资本性支出指标与现金流量表购建现金支出分别保存，未经定义核验不互相替代",
      "归母利润与合并净利润分开；仅当前资料，公告历史可用时间及财报重述未核验",
    ],
  };
}

const shared = sharedRead<Awaited<ReturnType<typeof load>>>();
async function load(symbol: string, signal: AbortSignal) {
  const profiles = ["annual-cash-flow", "annual-capex"] as const;
  const outcomes = await Promise.allSettled(
    profiles.map((profile) => queryFinance(symbol, signal, profile)),
  );
  signal.throwIfAborted();
  const evidence: Evidence[] = [];
  const missingProfiles: string[] = [];
  outcomes.forEach((outcome, i) =>
    outcome.status === "fulfilled"
      ? evidence.push(outcome.value)
      : missingProfiles.push(profiles[i]!),
  );
  return { facts: annualCashFlow(symbol, evidence), evidence, missingProfiles };
}
export function gatherAnnualCashFlow(symbol: string, signal?: AbortSignal) {
  symbolSchema.parse(symbol);
  return shared(symbol, (abort) => load(symbol, abort), signal);
}
