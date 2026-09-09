import { createHash } from "node:crypto";
import type { Evidence } from "~/lib/domain";

/** Called only after the dossier has revalidated every source and annual archive. */
export function revenueReconciliation(
  financeId: string,
  period: string,
  archivedRevenue: number | null,
  context: Evidence[],
) {
  const income = context.filter(
    (e) =>
      e.envelope?.source === "hithink-finance-query" &&
      JSON.parse(e.text).version === "income-scope-1",
  );
  const segments = context.filter(
    (e) =>
      e.envelope?.source === "hithink-business-query" &&
      JSON.parse(e.text).profile === "segments",
  );
  if (income.length > 1 || segments.length > 1)
    throw new Error("同年度收入口径或主营构成证据重复，不能选择性勾稽");
  const amounts: {
    totalRevenue: number | null;
    revenue: number | null;
    interestIncome: number | null;
  } = income[0]
    ? JSON.parse(income[0].text).facts.amounts
    : { totalRevenue: null, revenue: null, interestIncome: null };
  const difference = (a: number | null, b: number | null) => {
    if (a === null || b === null) return null;
    const result = a - b;
    return Number.isFinite(result) ? result : null;
  };
  const matches = (a: number | null, b: number | null) => {
    const delta = difference(a, b);
    return delta === null
      ? null
      : Math.abs(delta) <=
          Math.max(
            0.01,
            Math.max(Math.abs(a!), Math.abs(b!)) * Number.EPSILON * 16,
          );
  };
  const missing: string[] = [];
  if (!income.length)
    missing.push("同年度营业总收入、营业收入及利息收入资料缺失");
  else missing.push(...JSON.parse(income[0]!.text).facts.missing);
  if (!segments.length) missing.push("同年度主营构成资料缺失");
  const groups = new Map<
    string,
    {
      classification: string;
      rows: number;
      revenue: number;
      sharePercent: number;
    }
  >();
  if (segments[0]) {
    const rows: Record<string, unknown>[] = JSON.parse(
      segments[0].text,
    ).pages.flatMap((page: { datas: Record<string, unknown>[] }) => page.datas);
    for (const row of rows) {
      const classification = String(row["分类标准"]),
        group = groups.get(classification) ?? {
          classification,
          rows: 0,
          revenue: 0,
          sharePercent: 0,
        };
      group.rows++;
      group.revenue += Number(row["业务收入"]);
      group.sharePercent += Number(row["收入占比"]);
      groups.set(classification, group);
    }
  }
  const revenueDifference = difference(amounts.totalRevenue, amounts.revenue);
  if (matches(archivedRevenue, amounts.revenue) === false)
    missing.push(
      "新收入口径资料与原财务档案营业收入不一致，需要核验修订及范围，未改写旧档案",
    );
  if (
    amounts.totalRevenue !== null &&
    amounts.revenue !== null &&
    revenueDifference === null
  )
    missing.push("营业总收入与营业收入差额计算溢出");
  const content = {
    version: "revenue-reconciliation-1",
    period,
    archivedRevenue,
    amounts,
    archiveRevenueMatches: matches(archivedRevenue, amounts.revenue),
    totalMinusRevenue: revenueDifference,
    residualAfterInterest: difference(
      revenueDifference,
      amounts.interestIncome,
    ),
    differenceMatchesInterest: matches(
      revenueDifference,
      amounts.interestIncome,
    ),
    groups: [...groups.values()].map((group) => {
      const revenue = Number.isFinite(group.revenue) ? group.revenue : null;
      if (revenue === null) missing.push(`${group.classification}收入合计溢出`);
      return {
        ...group,
        revenue,
        sharePercent: Number.isFinite(group.sharePercent)
          ? group.sharePercent
          : null,
        differenceFromArchivedRevenue: difference(revenue, archivedRevenue),
        matchesRevenue: matches(revenue, amounts.revenue),
        matchesTotalRevenue: matches(revenue, amounts.totalRevenue),
      };
    }),
    citations: [
      financeId,
      ...income.map((e) => e.id),
      ...segments.map((e) => e.id),
    ],
    formulas: {
      totalMinusRevenue: "营业总收入-营业收入",
      residualAfterInterest: "营业总收入-营业收入-利息收入",
      segmentTotal: "仅在同一分类内累加业务收入，行业/产品/地区互不相加",
      numericalMatch:
        "绝对差额≤max(0.01元, 两个比较值最大绝对值×Number.EPSILON×16)；原始浮点残差保留",
    },
    missing,
    warnings: [
      "本结果为源端元单位下的数值比较；匹配不证明币种、合并范围、分部覆盖及审计已核验。",
      "差额不等于利息收入时保留残差，不能直接断言源数据错误；可能还有其他收入项目或口径差异。",
      "分类合计匹配某项收入只表示数值相等，不证明该分类具体包含利息业务；占比合计不作为完整性证明。",
      "保留旧财务营业收入及原有增长计算，不用营业总收入替换分母。",
    ],
  };
  return {
    id: `revenue-reconciliation-${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`,
    ...content,
  };
}
