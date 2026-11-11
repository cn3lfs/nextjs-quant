import { evaluateSepaFinance } from "trading-strategies/research/canslim/sepa-finance-gate";
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
  const roe = read("加权净资产收益率").filter((point) =>
    point.period.endsWith("1231"),
  );
  return evaluateSepaFinance({
    revenue,
    profit,
    revenueAmounts,
    profitAmounts,
    roe,
  });
}
