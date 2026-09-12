import type { NavDay } from "./trade-review-nav";
import type { ReviewValue } from "./trade-review";

export const positionRiskMetrics = [
  ["effectivePositions", "等效持仓只数", false],
  ["grossExposure", "总敞口（分母：总资产）", true],
  ["maxSingleWeight", "最大单一权重（分母：总资产）", true],
  ["herfindahl", "赫芬达尔（分母：总资产）", false],
  ["herfindahlInvested", "赫芬达尔（分母：持仓市值）", false],
] as const;
export type PositionRiskPoint = {
  date: string;
  positionCount: number;
} & Record<(typeof positionRiskMetrics)[number][0], ReviewValue>;
export type PositionRiskCurvePoint = Pick<PositionRiskPoint, "date"> & {
  effectivePositions: number | null;
  maxSingleWeight: number | null;
};

/** invariants §1 U11：逆回购只在 NAV 分母；缺失不能部分估算。 */
export function positionRisk(days: readonly NavDay[]): PositionRiskPoint[] {
  return days.map((day) => {
    const holdings = Object.entries(day.positions).filter(
      ([, quantity]) => quantity !== 0,
    );
    const values = holdings.map(([key]) => day.positionValues[key]);
    const invalidIndex = values.findIndex(
      (value) =>
        !value ||
        value.value === null ||
        !Number.isFinite(value.value) ||
        value.value < 0,
    );
    const invested =
      invalidIndex >= 0
        ? null
        : values.reduce((sum, value) => sum + value!.value!, 0);
    const reason =
      (day.marketValue.value === null
        ? (day.marketValue.reason ?? "持仓市值不可得")
        : null) ??
      (invalidIndex >= 0
        ? (values[invalidIndex]?.reason ?? "持仓市值不可得")
        : null) ??
      Object.values(day.positionValues).find((value) => value.value === null)
        ?.reason ??
      (day.nav.value === null ||
      !Number.isFinite(day.nav.value) ||
      day.nav.value <= 0
        ? (day.nav.reason ?? "总资产非正或不可得")
        : null) ??
      (!holdings.length
        ? "空仓日，集中度无定义"
        : invested === null || invested <= 0 || !Number.isFinite(invested)
          ? "持仓市值合计非正或溢出"
          : null);
    const row: PositionRiskPoint = {
      date: day.date,
      positionCount: holdings.length,
      effectivePositions: { value: null, reason },
      grossExposure: { value: null, reason },
      maxSingleWeight: { value: null, reason },
      herfindahl: { value: null, reason },
      herfindahlInvested: { value: null, reason },
    };
    if (reason) return row;
    const amounts = values.map((value) => value!.value!);
    const nav = day.nav.value!;
    const hhi = amounts.reduce(
      (sum, value) => sum + (value / invested!) ** 2,
      0,
    );
    const numbers = {
      grossExposure: invested! / nav,
      maxSingleWeight: Math.max(...amounts) / nav,
      herfindahl: amounts.reduce((sum, value) => sum + (value / nav) ** 2, 0),
      herfindahlInvested: hhi,
      effectivePositions: 1 / hhi,
    };
    if (Object.values(numbers).some((value) => !Number.isFinite(value))) {
      for (const [key] of positionRiskMetrics)
        row[key] = { value: null, reason: "集中度计算溢出" };
    } else
      for (const [key] of positionRiskMetrics)
        row[key] = { value: numbers[key], reason: null };
    return row;
  });
}

/** 沿用 U10 连续段写法，首尾空值由图表空白轴保留。 */
export function positionRiskCurveSegments(
  points: readonly PositionRiskCurvePoint[],
  key: "effectivePositions" | "maxSingleWeight",
) {
  const segments: { date: string; value: number }[][] = [];
  let segment: { date: string; value: number }[] = [];
  for (const point of points) {
    const value = point[key];
    if (value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push({ date: point.date, value });
  }
  if (segment.length) segments.push(segment);
  return segments;
}
