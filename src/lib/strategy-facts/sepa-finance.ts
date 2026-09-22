type Column = { key: string; unit?: string; timestamp?: string };
export function sepaFinanceFacts(
  row: Record<string, unknown>,
  columns: Column[],
) {
  const read = (field: string, unit = "%") =>
    columns
      .flatMap((column) => {
        const match = column.key.match(new RegExp(`^${field}\\[(\\d{8})\\]$`));
        const raw = row[column.key];
        if (!match || column.unit !== unit || column.timestamp !== match[1])
          return [];
        const value =
          raw === null || raw === undefined || raw === "--"
            ? null
            : Number(raw);
        return [
          {
            period: match[1]!,
            value: value !== null && Number.isFinite(value) ? value : null,
            field: column.key,
          },
        ];
      })
      .sort((a, b) => b.period.localeCompare(a.period));
  const revenue = read("单季度_营业收入同比增长率"),
    profit = read("单季度_归母净利润同比增长率");
  const revenueAmounts = read("单季度_营业收入", "元"),
    profitAmounts = read("单季度_归母净利润", "元");
  const margin = revenueAmounts.map((point) => {
    const income = profitAmounts.find((p) => p.period === point.period)?.value;
    return {
      period: point.period,
      value:
        point.value !== null && point.value > 0 && income != null
          ? (income / point.value) * 100
          : null,
      field: "单季度归母净利润/营业收入×100",
      inputs: [point.field, `单季度_归母净利润[${point.period}]`],
    };
  });
  const roe = read("加权净资产收益率").filter((point) =>
    point.period.endsWith("1231"),
  );
  const latest =
    [...revenue, ...profit, ...margin]
      .map((p) => p.period)
      .sort()
      .at(-1) ?? null;
  const ends = ["0331", "0630", "0930", "1231"];
  const quarter = latest ? ends.indexOf(latest.slice(4)) : -1;
  const previous =
    latest && quarter >= 0
      ? quarter === 0
        ? `${Number(latest.slice(0, 4)) - 1}1231`
        : latest.slice(0, 4) + ends[quarter - 1]
      : null;
  const pair = (series: typeof revenue, threshold: number) => {
    const values = [latest, previous].map(
      (date) => series.find((p) => p.period === date)?.value,
    );
    return values.some((v) => v == null)
      ? null
      : values.every((v) => v! >= threshold);
  };
  const currentMargin = margin.find((p) => p.period === latest)?.value;
  const oldMargin = latest
    ? margin.find(
        (p) =>
          p.period === `${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}`,
      )?.value
    : null;
  const strictChecks = {
    revenueGrowthTwoQuarters20: pair(revenue, 20),
    profitGrowthTwoQuarters25: pair(profit, 25),
    margin15AndImproving:
      currentMargin == null || oldMargin == null
        ? null
        : currentMargin >= 15 && currentMargin > oldMargin,
    annualWeightedRoe17: roe[0]?.value == null ? null : roe[0].value >= 17,
  };
  const toleranceChecks = {
    revenue: pair(revenue, 16),
    profit: pair(profit, 20),
    margin:
      currentMargin == null || oldMargin == null
        ? null
        : currentMargin >= 12 && currentMargin > oldMargin,
    roe: roe[0]?.value == null ? null : roe[0].value >= 13.6,
  };
  const strictValues = Object.values(strictChecks),
    tolerantValues = Object.values(toleranceChecks);
  const strictCount = strictValues.filter((v) => v === true).length;
  const gate = tolerantValues.some((v) => v === false)
    ? "failed"
    : strictValues.some((v) => v === null)
      ? "incomplete"
      : strictCount === 4
        ? "strict-pass"
        : strictCount >= 2
          ? "tolerant-pass"
          : "failed";
  return {
    version: "sepa-finance-diagnostic-2",
    latestQuarter: latest,
    previousQuarter: previous,
    revenue,
    profit,
    margin,
    revenueAmounts,
    profitAmounts,
    weightedAnnualRoe: roe,
    strictChecks,
    toleranceChecks,
    strictCount,
    gate,
    warnings: [
      "仅基本面筛选门；宽松通过降低置信度，不等于完整 SEPA 或交易结论。容差只放宽数值门槛，保留连续两季及净利率同比改善要求。",
      "净利率按同季归母净利润/营业收入计算，不采用销售净利率字段替代；零或负营收无法计算有效比率。",
      "只采用明确单季度字段及百分比单位，缺失季度不跳过，不用累计指标替代。",
      "ROE 明确采用源返回的最新加权年报口径；各字段公告可用日与财务重述尚未核验，不供历史回测使用。",
    ],
  };
}
