import { z } from "zod";
export const disciplineNotice = "参数在已知结果后选定，本对照不构成可交易结论";
export const disciplineScope =
  "本对照针对加仓次数与止损，不涉及开仓决策；首笔买入在盈亏回合间无显著差异。已证实的是亏损回合加仓更多，未证实加仓时点处于浮亏。";
export const disciplineRulesSchema = z.object({
  maxAddOns: z.number().int().min(0).max(2).nullable(),
  stopLossPct: z.number().finite().positive().lt(1).nullable(),
});
export type DisciplineRules = z.infer<typeof disciplineRulesSchema>;
export const disciplineGrid: DisciplineRules[] = [0, 1, 2, null].flatMap(
  (maxAddOns) =>
    [0.03, 0.05, 0.08, 0.1, null].map((stopLossPct) => ({
      maxAddOns,
      stopLossPct,
    })),
);

export function disciplineAddOnAllowed(
  maxAddOns: number | null,
  buyNumber: number,
) {
  return maxAddOns === null || buyNumber <= maxAddOns;
}
export function disciplineStopTriggered(
  cost: number,
  held: number,
  close: number,
  stopLossPct: number,
) {
  const threshold = cost * (1 - stopLossPct);
  return (
    threshold - held * close >
    Number.EPSILON * 8 * Math.max(1, Math.abs(threshold))
  );
}
