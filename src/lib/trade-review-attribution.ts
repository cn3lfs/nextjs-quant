import { reviewStatistics, type ReviewRound } from "./trade-review";

export type AttributionDimensions = {
  industries?: Readonly<Record<string, readonly string[]>>;
  concepts?: Readonly<Record<string, readonly string[]>>;
  /** Security then exact opening date; RPS is on the 0..100 scale. */
  rps?: Readonly<Record<string, Readonly<Record<string, number | null>>>>;
  /** Input round index; confirmed opening order value / pre-order account NAV. */
  positionFractions?: Readonly<Record<number, number | null>>;
};
const unknown = "未知";
const finite = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n);

export function reviewAttribution(
  rounds: readonly ReviewRound[],
  dimensions: AttributionDimensions = {},
  minimumSamples = 5,
) {
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1)
    throw new Error("样本阈值须为正整数");
  if (new Set(rounds.map((r) => r.costMethod)).size > 1)
    throw new Error("不同成本口径必须分别分组，不能重复计为独立样本");
  const names = (values?: readonly string[]) => {
    const result = [...new Set(values?.map((v) => v.trim()).filter(Boolean))];
    return result.length ? result.sort() : [unknown];
  };
  const selectors = {
    security: (r: ReviewRound) => [r.security || unknown],
    instrument: (r: ReviewRound) => [
      (
        { stock: "股票", fund: "ETF", convertible: "可转债" } as Record<
          string,
          string
        >
      )[r.instrument] ?? unknown,
    ],
    holdingPeriod: (r: ReviewRound) => {
      const n = r.holdingTradingDays.value;
      return [
        !finite(n) || n < 0
          ? unknown
          : n === 0
            ? "0 日（当日）"
            : n <= 1
              ? "1 日"
              : n <= 5
                ? "2-5 日"
                : n <= 20
                  ? "6-20 日"
                  : n <= 60
                    ? "21-60 日"
                    : "60 日以上",
      ];
    },
    rps: (r: ReviewRound) => {
      const n = r.openingDate
        ? dimensions.rps?.[r.security]?.[r.openingDate]
        : null;
      return [
        !finite(n) || n < 0 || n > 100
          ? unknown
          : n < 70
            ? "<70"
            : n < 90
              ? "70-90"
              : "≥90",
      ];
    },
    industry: (r: ReviewRound) => names(dimensions.industries?.[r.security]),
    concept: (r: ReviewRound) => names(dimensions.concepts?.[r.security]),
    weekday: (r: ReviewRound) => {
      const date = r.openingDate ? new Date(r.openingDate) : null;
      return [
        date && Number.isFinite(date.getTime())
          ? [
              "星期日",
              "星期一",
              "星期二",
              "星期三",
              "星期四",
              "星期五",
              "星期六",
            ][date.getUTCDay()]!
          : unknown,
      ];
    },
    position: (_: ReviewRound, i: number) => {
      const n = dimensions.positionFractions?.[i];
      return [
        !finite(n) || n < 0 || n > 1
          ? unknown
          : n < 0.1
            ? "<10%"
            : n < 0.25
              ? "10%-25%"
              : n < 0.5
                ? "25%-50%"
                : "≥50%",
      ];
    },
  };
  return {
    description: "描述性分组，不声称因果，不等同因子分析",
    minimumSamples,
    basis:
      "持有期用交易日；RPS与仓位分档左闭右开；仓位需开仓前账户估值，缺失不推算；当日回合单列0日",
    groups: Object.entries(selectors).map(([dimension, select]) => {
      const members = new Map<string, number[]>();
      rounds.forEach((r, i) =>
        select(r, i).forEach((name) => {
          members.set(name, [...(members.get(name) ?? []), i]);
        }),
      );
      return {
        dimension,
        overlapping: dimension === "concept" || dimension === "industry",
        sampleNote:
          dimension === "concept" || dimension === "industry"
            ? "样本可重叠，组间不可相加或当作独立样本"
            : "每个回合仅归入一个组",
        items: [...members]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, roundIndices]) => {
            const detail = roundIndices.map((i) => rounds[i]!);
            const statistics = reviewStatistics(detail);
            const valid = detail.filter(
              (r) =>
                r.closingDate !== null &&
                r.netProfit.value !== null &&
                r.netReturn.value !== null,
            );
            return {
              name,
              roundIndices,
              rounds: detail,
              statistics,
              sampleCount: valid.length,
              warning:
                valid.length < minimumSamples ? "样本不足，不稳定" : null,
              netProfitTotal: valid.length
                ? valid.reduce((s, r) => s + r.netProfit.value!, 0)
                : null,
            };
          }),
      };
    }),
  };
}
