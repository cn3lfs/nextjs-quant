import type { ResearchManagement } from "./research-management";

export const growthIntradayIds = [
  "SE-E-intraday50",
  "SE-D-gapup3",
  "SE-D-gapdown3",
  "CA-D-gapup3",
  "CA-D-gapdown3",
  "CA-D-review1430",
] as const;
export type GrowthIntradayId = (typeof growthIntradayIds)[number];
export const growthIntradayLabels: Record<GrowthIntradayId, string> = {
  "SE-E-intraday50": "SEPA五分钟半仓与收盘补足",
  "SE-D-gapup3": "SEPA次日高开3%保本",
  "SE-D-gapdown3": "SEPA次日低开3%减半与盘中止损",
  "CA-D-gapup3": "CANSLIM次日高开3%保本",
  "CA-D-gapdown3": "CANSLIM次日低开3%减半与盘中止损",
  "CA-D-review1430": "CANSLIM 14:30异常次日减半",
};
export const growthIntradayDescription =
  "五分钟工程版v1；研究窗口2000-01-04至2022-11-30，逐证券逐日48根完整性校验，缺日不可用不顺延。时间戳为右端：14:30是14:25–14:30收盘。跳空仅首仓下一研究交易日，按日线开盘/前日收盘严格超过±3%；日线开盘是9:30已知价，首根五分钟open仅为连续交易首笔，不混用。开盘条件确认后最早9:35（第二根open）执行；五分钟收盘跌破止损后下一根open执行，午休跨至13:00，15:00确认次日。高开在9:35起抬成本；低开减当时剩余50%，止损全退优先。14:30异常工程定义为较昨收跌超2%，次日9:30减剩余50%。SEPA半仓量能为截至当时累计量至少此前20日整日均量1.5倍，不外推全天；价格严格越冻结枢纽101%且不超105%，下一根open先买计划50%；15:00仍满足才次日9:30补至冻结计划量，越105%取消，失败不补。沿用固定10%/8%止损、风险仓位、费用、申报数量、T+1与最长持有；不与其他管理叠加，不代表完整SEPA/CANSLIM。";
export function growthIntradayTemplate(
  id: GrowthIntradayId,
): ResearchManagement {
  return {
    growthIntraday: id,
    stop: { kind: "percent", fraction: id.startsWith("SE-") ? 0.1 : 0.08 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
  };
}
export function growthIntradayBase(id: GrowthIntradayId) {
  return id.startsWith("SE-")
    ? ("sepa-vcp-close" as const)
    : ("canslim-priority" as const);
}
export function assertGrowthIntradayWindow(start: string, end: string) {
  if (start < "2000-01-04" || end > "2022-11-30")
    throw new Error(
      "五分钟研究窗口必须在2000-01-04至2022-11-30内；不得静默混用日线区间",
    );
}
