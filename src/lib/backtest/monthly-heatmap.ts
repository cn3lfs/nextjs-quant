import type { EquityPoint } from "./equity-drawdown";

export type MonthlyHeatmapRow = {
  year: number;
  /** 1 至 12 月的收益比例，缺失月份为 null。 */
  months: readonly (number | null)[];
  yearTotal: number | null;
};

export type DrawdownPeriod = {
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null;
  /** 相对前高的负收益比例。 */
  depth: number;
  /** 峰值至恢复的有效观察点数，含两端；尚未恢复时计至谷底。 */
  bars: number;
};

function isPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function validDate(date: string): boolean {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?$/.test(date)) return false;
  if (date.length === 7) return true;
  const time = Date.parse(date);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date
  );
}

function sortedPoints(equity: readonly EquityPoint[]): EquityPoint[] {
  return equity
    .filter(({ date, value }) => isPositive(value) && validDate(date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function computeMonthlyReturnsHeatmap(
  equity: readonly EquityPoint[],
  initial?: number,
): MonthlyHeatmapRow[] {
  const points = sortedPoints(equity);
  const first = points[0];
  if (!first) return [];

  const monthEnds = new Map<string, number>();
  for (const { date, value } of points) monthEnds.set(date.slice(0, 7), value);

  let base = isPositive(initial) ? initial : first.value;
  const rows: MonthlyHeatmapRow[] = [];
  const lastYear = Number(points[points.length - 1]!.date.slice(0, 4));
  for (let year = Number(first.date.slice(0, 4)); year <= lastYear; year++) {
    const yearBase = base;
    let yearTotal: number | null = null;
    const months = Array<number | null>(12).fill(null);
    const yearPrefix = String(year).padStart(4, "0") + "-";
    for (let month = 1; month <= 12; month++) {
      const end = monthEnds.get(yearPrefix + String(month).padStart(2, "0"));
      if (end === undefined) continue;
      months[month - 1] = end / base - 1;
      yearTotal = end / yearBase - 1;
      base = end;
    }
    rows.push({ year, months, yearTotal });
  }
  return rows;
}

export function computeTopDrawdownPeriods(
  equity: readonly EquityPoint[],
  initial?: number,
  topN = 3,
): DrawdownPeriod[] {
  const points = sortedPoints(equity);
  const first = points[0];
  if (!first || !(topN >= 1)) return [];

  // initial 没有独立日期，首个观察点同时作为期初峰值的日期锚点。
  let peak = isPositive(initial) ? initial : first.value;
  let peakIndex = 0;
  let active: DrawdownPeriod | null = null;
  const periods: DrawdownPeriod[] = [];
  for (const [index, point] of points.entries()) {
    const bars = index - peakIndex + 1;
    if (point.value >= peak) {
      if (active) {
        active.recoveryDate = point.date;
        active.bars = bars;
        periods.push(active);
        active = null;
      }
      peak = point.value;
      peakIndex = index;
      continue;
    }

    const depth = (point.value - peak) / peak;
    if (!active || depth < active.depth) {
      active = {
        peakDate: points[peakIndex]!.date,
        troughDate: point.date,
        recoveryDate: null,
        depth,
        bars,
      };
    }
  }
  if (active) periods.push(active);
  return periods.sort((a, b) => a.depth - b.depth).slice(0, topN);
}
