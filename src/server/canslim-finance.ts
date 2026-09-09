import { canslimEarnings } from "./canslim-earnings";
type Column = { key: string; unit?: string; timestamp?: string };
const fields = {
  quarterlyEps: ["单季度_基本每股收益", "元", false],
  quarterlyEpsGrowth: ["单季度_基本每股收益同比增长率", "%", false],
  quarterlyRevenueGrowth: ["单季度_营业收入同比增长率", "%", false],
  quarterlyProfitGrowth: ["单季度_归母净利润同比增长率", "%", false],
  annualEps: ["基本每股收益", "元", true],
  annualCashPerShare: ["每股经营活动产生的现金流量净额", "元", true],
  annualRoe: ["净资产收益率", "%", true],
  annualWeightedRoe: ["加权净资产收益率", "%", true],
} as const;

export function canslimFinanceFacts(
  row: Record<string, unknown>,
  columns: Column[],
) {
  const series = Object.fromEntries(
    Object.entries(fields).map(([id, [name, unit, annual]]) => {
      const points = columns
        .flatMap((column) => {
          const match = column.key.match(/^(.+)\[(\d{8})\]$/);
          if (!match || match[1] !== name) return [];
          const period = match[2]!;
          const reasons: string[] = [];
          if (
            !/^\d{4}(0331|0630|0930|1231)$/.test(period) ||
            (annual && !period.endsWith("1231"))
          )
            reasons.push("报告期不符合季度/年度口径");
          if (column.timestamp !== period)
            reasons.push("字段日期与元数据不一致");
          if (column.unit !== unit) reasons.push("单位缺失或不匹配");
          if (columns.filter((c) => c.key === column.key).length !== 1)
            reasons.push("字段重复");
          const raw = row[column.key];
          const numeric =
            typeof raw === "number" ||
            (typeof raw === "string" &&
              /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
                raw.trim(),
              ));
          if (!numeric || !Number.isFinite(Number(raw)))
            reasons.push("数值缺失或非法");
          return [
            {
              period,
              field: column.key,
              unit,
              value: reasons.length ? null : Number(raw),
              reasons,
            },
          ];
        })
        .sort((a, b) => b.period.localeCompare(a.period));
      return [id, points];
    }),
  );
  return {
    version: "canslim-finance-1",
    series,
    earnings: canslimEarnings(series),
    warnings: [
      "仅解析明确字段，不代表股本口径、币种和历史公告可用时间已核验。",
      "EPS与净利润不互相替代；普通ROE与加权ROE分别保留。",
    ],
  };
}
