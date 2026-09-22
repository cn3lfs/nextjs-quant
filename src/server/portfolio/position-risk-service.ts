import { z } from "zod";
import {
  positionRisk,
  positionRiskMetrics,
  type PositionRiskPoint,
} from "~/lib/position-risk";
import type { NavDay } from "~/lib/trade-review-nav";

export const positionRiskPageSchema = z.object({
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(10),
  sort: z
    .enum(["date", "positionCount", ...positionRiskMetrics.map(([key]) => key)])
    .default("date"),
  desc: z.boolean().default(true),
});
export function pagePositionRisk(
  days: readonly NavDay[],
  page: z.infer<typeof positionRiskPageSchema>,
) {
  const points = positionRisk(days);
  const value = (point: PositionRiskPoint) => {
    const field = point[page.sort];
    return typeof field === "object" ? field.value : field;
  };
  const sorted = [...points].sort((a, b) => {
    const x = value(a),
      y = value(b);
    if (x === null || y === null)
      return x === y ? a.date.localeCompare(b.date) : x === null ? 1 : -1;
    const order =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return (page.desc ? -order : order) || a.date.localeCompare(b.date);
  });
  const effective = points
    .flatMap((p) =>
      p.effectivePositions.value === null ? [] : [p.effectivePositions.value],
    )
    .sort((a, b) => a - b);
  const maximum = points
    .filter((p) => p.maxSingleWeight.value !== null)
    .sort(
      (a, b) =>
        b.maxSingleWeight.value! - a.maxSingleWeight.value! ||
        a.date.localeCompare(b.date),
    )[0];
  return {
    rows: sorted.slice(
      page.pageIndex * page.pageSize,
      (page.pageIndex + 1) * page.pageSize,
    ),
    rowCount: points.length,
    curve: points.map((p) => ({
      date: p.date,
      effectivePositions: p.effectivePositions.value,
      maxSingleWeight: p.maxSingleWeight.value,
    })),
    summary: {
      maxSingleWeight: maximum?.maxSingleWeight.value ?? null,
      maxSingleWeightDate: maximum?.date ?? null,
      medianEffectivePositions: effective.length
        ? (effective[Math.floor((effective.length - 1) / 2)]! +
            effective[Math.floor(effective.length / 2)]!) /
          2
        : null,
      availableDays: effective.length,
    },
  };
}
