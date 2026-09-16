import { researchManagementSchema } from "./research-management";
import type { ResearchSpec } from "./strategy-research";

export const growthDailyExitIds = [
  "sepa-vcp-exits-elite",
  "sepa-vcp-exits-daily",
  "canslim-priority-exits-daily",
] as const;
export function isGrowthDailyExit(
  id: string,
): id is (typeof growthDailyExitIds)[number] {
  return (growthDailyExitIds as readonly string[]).includes(id);
}
export const growthDailyExitDescription =
  "日线组合工程版：SEPA采用MIN后10%修正版、15%保本、20%及30%各卖初始1/3，实际成交后分别抬成本及盈利20%，余仓继续接受10周均线下穿减半；CANSLIM采用8%止损、15%保本、20%卖初始一半并抬成本、25%清余仓。自然28天涨幅不足10%/5%退出，周线减半和放量大阴全退始终有效；全退优先，受阻重试且不提前抬线。精英八周仅在显式启用sepaElite时生效，其起算与冻结另列；未包含复核提示、跳空盘中及全部异常退出，非完整SE05/CA08。";
export function growthDailyExitTemplate(spec: ResearchSpec): ResearchSpec {
  if (!isGrowthDailyExit(spec.strategy)) return spec;
  const sepa = spec.strategy.startsWith("sepa-");
  const elite = spec.strategy === "sepa-vcp-exits-elite";
  return {
    ...spec,
    holdingDays: elite ? 20 : 60,
    risk: { fraction: 0.015, maxWeight: 0.25 },
    management: researchManagementSchema.parse({
      ...(elite ? { sepaElite: true } : {}),
      stop: { kind: "percent", fraction: sepa ? 0.1 : 0.08 },
      confirmations: 1,
      stressBuffer: 0,
      trail: { kind: "fixed" },
      timeExit: null,
      breakeven: { atR: sepa ? 1.5 : 1.875, mode: "r-only" },
      progressExit: {
        clock: "calendar-days",
        days: 28,
        minimumGain: sepa ? 0.1 : 0.05,
      },
      scaleOut: sepa
        ? [
            { atR: 2, fraction: 1 / 3, raiseStopR: 0 },
            { atR: 3, fraction: 1 / 3, raiseStopR: 2 },
          ]
        : [
            { atR: 2.5, fraction: 0.5, raiseStopR: 0 },
            { atR: 3.125, fraction: 0.5, raiseStopR: null },
          ],
    }),
  };
}
