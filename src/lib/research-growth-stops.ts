import type { ResearchManagement } from "./research-management";
export const growthPivotStopIds = [
  "sepa-pivot-min",
  "sepa-pivot-max",
  "canslim-pivot-max",
] as const;
export type GrowthPivotStop = (typeof growthPivotStopIds)[number];
export function isGrowthPivotStop(id: string): id is GrowthPivotStop {
  return (growthPivotStopIds as readonly string[]).includes(id);
}
export const growthPivotStopLabels: Record<GrowthPivotStop, string> = {
  "sepa-pivot-min": "SEPA原式MIN（不加10%修正）",
  "sepa-pivot-max": "SEPA文字MAX（较紧止损）",
  "canslim-pivot-max": "CANSLIM枢纽与买价8%取MAX",
};
export const growthPivotStopDescription =
  "冻结信号枢纽，按实际首仓含滑点成交价计算：SEPA原式MIN(枢纽×0.92,成交价×0.90)和文字MAX独立；MIN不追加10%修正，可能超过10%计划距离，不称亏损上限保证。CANSLIM取MAX(枢纽×0.92,成交价×0.92)。缺合法枢纽或选中止损不低于成交价拒绝买入；不以当前形态或未来价格替代。止损收盘确认后下一可成交开盘退出，风险仓位按所选距离及费用计算，信号及最长持有仍生效。";
export function growthPivotStopTemplate(
  kind: GrowthPivotStop,
): ResearchManagement {
  return {
    stop: { kind },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
  };
}
export function researchGrowthPivotStop(
  kind: GrowthPivotStop,
  entry: number,
  pivot: number | undefined,
) {
  if (
    pivot == null ||
    !Number.isFinite(pivot) ||
    pivot <= 0 ||
    !Number.isFinite(entry) ||
    entry <= 0
  )
    return null;
  const fromPivot = pivot * 0.92,
    fromEntry = entry * (kind === "canslim-pivot-max" ? 0.92 : 0.9);
  const selected =
    kind === "sepa-pivot-min"
      ? Math.min(fromPivot, fromEntry)
      : Math.max(fromPivot, fromEntry);
  return selected > 0 && selected < entry ? selected : null;
}
