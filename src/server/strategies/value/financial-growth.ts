import { createHash } from "node:crypto";
import {
  financialQuality,
  type FinancialQualityArchive,
} from "./financial-quality";
type Row = FinancialQualityArchive["facts"]["annual"][number];
type Fact = Row["netProfit"];
type GrowthFact = {
  value: number | null;
  formula: string;
  citations: string[];
  missing: string[];
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function revenue(row: Row): Fact {
  const a = row.amounts.revenue;
  return {
    value: a.value,
    currencyBasis:
      a.value === null
        ? null
        : a.currency === "CNY"
          ? "CNY"
          : "source-yuan-unspecified",
    citations: [...new Set(a.points.map((p) => p.evidenceId))],
    formula: `营业收入[${row.period}]`,
    missing: a.reasons,
  };
}
function calculate(
  formula: string,
  inputs: (Fact | undefined)[],
  compute: (values: number[]) => number,
  reason: string,
): GrowthFact {
  const citations = [...new Set(inputs.flatMap((f) => f?.citations ?? []))];
  const fail = (missing: string[]) => ({
    value: null,
    formula,
    citations,
    missing,
  });
  if (inputs.some((f) => !f || f.value === null))
    return fail([
      ...new Set([
        "缺少连续年度或必要财务字段",
        ...inputs.flatMap((f) => f?.missing ?? []),
      ]),
    ]);
  if (
    new Set(inputs.map((f) => f!.currencyBasis)).size !== 1 ||
    inputs.some((f) => f!.currencyBasis === null)
  )
    return fail(["各年度币种标记不一致，不能跨口径计算"]);
  const value = compute(inputs.map((f) => f!.value!));
  return Number.isFinite(value)
    ? { value, formula, citations, missing: [] }
    : fail([reason]);
}
export function financialGrowth(archive: FinancialQualityArchive) {
  const content = {
      facts: archive.facts,
      evidence: archive.evidence,
      missingProfiles: archive.missingProfiles,
    },
    hash = digest(content);
  if (
    archive.hash !== hash ||
    archive.id !== `financial-quality-${hash}` ||
    JSON.stringify(
      financialQuality(
        archive.facts.symbol,
        archive.evidence,
        archive.createdAt,
      ),
    ) !== JSON.stringify(archive.facts)
  )
    throw new Error("财务档案内容或计算版本校验失败");
  const rows = archive.facts.annual,
    byPeriod = new Map(rows.map((row) => [row.period, row]));
  const annual = rows.map((row) => {
    const previous = byPeriod.get(`${Number(row.period.slice(0, 4)) - 1}1231`);
    const yoy = (metric: "revenue" | "profit") =>
      calculate(
        `${metric === "revenue" ? "营业收入" : "合并净利润"}同比=(本年/上年)-1`,
        [
          previous
            ? metric === "revenue"
              ? revenue(previous)
              : previous.netProfit
            : undefined,
          metric === "revenue" ? revenue(row) : row.netProfit,
        ],
        ([base, current]) =>
          base! > 0 && (metric === "profit" || current! >= 0)
            ? current! / base! - 1
            : NaN,
        "同比要求上年基数为正；营业收入不能为负；计算溢出保留缺失",
      );
    return {
      period: row.period,
      revenueYoy: yoy("revenue"),
      profitYoy: yoy("profit"),
    };
  });
  const latest = rows.at(-1),
    endYear = latest ? Number(latest.period.slice(0, 4)) : null;
  const window =
    endYear === null
      ? []
      : Array.from({ length: 4 }, (_, i) =>
          byPeriod.get(`${endYear - 3 + i}1231`),
        );
  const cagr = (metric: "revenue" | "profit") =>
    calculate(
      `${metric === "revenue" ? "营业收入" : "合并净利润"}三年CAGR=(末年/三年前)^(1/3)-1；要求四个连续年末`,
      window.length
        ? window.map((row) =>
            row
              ? metric === "revenue"
                ? revenue(row)
                : row.netProfit
              : undefined,
          )
        : [undefined],
      (values) => {
        const first = values[0]!,
          last = values[3]!;
        if (
          first <= 0 ||
          last < 0 ||
          (metric === "revenue" && values.some((v) => v < 0))
        )
          return NaN;
        return last === 0
          ? -1
          : Math.expm1((Math.log(last) - Math.log(first)) / 3);
      },
      "CAGR要求起始值为正、末值非负；不对亏损基数开方或使用绝对值替代",
    );
  const latestGrowth = annual.at(-1);
  const recent =
    endYear === null
      ? []
      : Array.from({ length: 3 }, (_, i) =>
          annual.find((row) => row.period === `${endYear - 2 + i}1231`),
        );
  const positive = (metric: "revenueYoy" | "profitYoy") => {
    const inputs = recent.map((row) => row?.[metric]);
    return {
      value:
        inputs.length !== 3 || inputs.some((f) => !f || f.value === null)
          ? null
          : inputs.every((f) => f!.value! > 0),
      citations: [...new Set(inputs.flatMap((f) => f?.citations ?? []))],
      definition: "最近三个连续年度的同比均严格大于0；需要四个连续年末资料",
    };
  };
  const result = {
    version: "financial-growth-1",
    sourceArchiveId: archive.id,
    symbol: archive.facts.symbol,
    period: latest?.period ?? null,
    annual,
    threeYear: {
      startPeriod: endYear === null ? null : `${endYear - 3}1231`,
      endPeriod: latest?.period ?? null,
      revenueCagr: cagr("revenue"),
      profitCagr: cagr("profit"),
    },
    revenuePositiveThreeYears: positive("revenueYoy"),
    profitPositiveThreeYears: positive("profitYoy"),
    profitGrowthAboveRevenue:
      latestGrowth?.profitYoy.value == null ||
      latestGrowth.revenueYoy.value === null
        ? null
        : latestGrowth.profitYoy.value > latestGrowth.revenueYoy.value,
    revenueUpProfitNotUp:
      latestGrowth?.profitYoy.value == null ||
      latestGrowth.revenueYoy.value === null
        ? null
        : latestGrowth.revenueYoy.value > 0 &&
          latestGrowth.profitYoy.value <= 0,
    warnings: [
      "增长率使用已归档年度资料，不调用预测或模型。三年CAGR需要四个年末，不把三个年度误算成三个增长区间。",
      "亏损或零基期的利润同比/CAGR保留缺失；从盈利转亏的同比可为负，不将转亏改写为改善。",
      "CAGR是端点复合增速，不证明中间年度稳定；并购、处置和重述影响尚未分离。",
      "来源币种和合并范围仍需独立核验；这些指标不是完整成长性评分，也不表示证券高估或低估。",
    ],
  };
  return { id: `financial-growth-${digest(result)}`, ...result };
}
