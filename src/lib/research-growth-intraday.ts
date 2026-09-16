import type { ResearchManagement } from "./research-management";

export const growthIntradayIds = [
  "RK-C-swing-system",
  "RK-A-intraday-structure30",
  "RK-A-intraday-points30",
  "RK-B-touch",
  "SE-E-intraday50",
  "SE-D-gapup3",
  "SE-D-gapdown3",
  "CA-D-gapup3",
  "CA-D-gapdown3",
  "CA-D-review1430",
] as const;
export type GrowthIntradayId = (typeof growthIntradayIds)[number];
export const growthIntradayLabels: Record<GrowthIntradayId, string> = {
  "RK-C-swing-system": "波段完整组合/五分钟灾难备份",
  "RK-A-intraday-structure30": "五分钟结构与30分钟0.5R时间止损",
  "RK-A-intraday-points30": "固定0.5元与30分钟0.5R时间止损",
  "RK-B-touch": "双突破5分钟触碰止损/下一根开盘",
  "SE-E-intraday50": "SEPA五分钟半仓与收盘补足",
  "SE-D-gapup3": "SEPA次日高开3%保本",
  "SE-D-gapdown3": "SEPA次日低开3%减半与盘中止损",
  "CA-D-gapup3": "CANSLIM次日高开3%保本",
  "CA-D-gapdown3": "CANSLIM次日低开3%减半与盘中止损",
  "CA-D-review1430": "CANSLIM 14:30异常次日减半",
};
export const growthIntradayDescription =
  "波段组合工程v1：结构减0.3ATR14且距离至多2ATR14、1%风险/20%市值/前20日均额1%容量；收盘技术退出，五分钟low触碰-2R灾难线下一根open备份，T+1受阻保留。1R保本/2R减原始半仓并抬1R/尾仓22日3ATR、10日未达0.5R退出；周-3R禁入及连亏5笔风险与市值减半。事件日历缺失禁入，已知事件前三交易日减半；每100笔完整同版本交易检查MAE，不自动择优改参。" +
  "日内动量工程v1：同日线双突破入场、次日首根五分钟开盘，结构来自此前完整交易日48根五分钟的最近3左3右确认低点，不用日线低点代替；备选冻结0.5元。自成交起计已完成六根五分钟，30交易分钟收盘未达到0.5R则排队全退，价格触碰与时间先到者触发；T+1当日不可卖，请求保留到次日。不是同日回转交易或盘中入场信号算法，结构缺失/开盘失守不可用。" +
  "五分钟工程版v1；RK-B-touch为双突破5%初始线，完成5分钟low≤线确认，下一根open执行（15:00则次日）；不推断K线内触碰时间，不假定止损价成交，T+1当日触碰保留退出请求。研究窗口2000-01-04至2022-11-30，逐证券逐日48根完整性校验，缺日不可用不顺延。时间戳为右端：14:30是14:25–14:30收盘。跳空仅首仓下一研究交易日，按日线开盘/前日收盘严格超过±3%；日线开盘是9:30已知价，首根五分钟open仅为连续交易首笔，不混用。开盘条件确认后最早9:35（第二根open）执行；五分钟收盘跌破止损后下一根open执行，午休跨至13:00，15:00确认次日。高开在9:35起抬成本；低开减当时剩余50%，止损全退优先。14:30异常工程定义为较昨收跌超2%，次日9:30减剩余50%。SEPA半仓量能为截至当时累计量至少此前20日整日均量1.5倍，不外推全天；价格严格越冻结枢纽101%且不超105%，下一根open先买计划50%；15:00仍满足才次日9:30补至冻结计划量，越105%取消，失败不补。沿用固定10%/8%止损、风险仓位、费用、申报数量、T+1与最长持有；不与其他管理叠加，不代表完整SEPA/CANSLIM。";
export function growthIntradayTemplate(
  id: GrowthIntradayId,
): ResearchManagement {
  if (id === "RK-C-swing-system")
    return {
      growthIntraday: id,
      stop: {
        kind: "structure-atr",
        maxDistanceAtr: 2,
        period: 14,
        multiple: 0.3,
      },
      confirmations: 1,
      stressBuffer: 0,
      trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
      breakeven: { atR: 1, mode: "r-only" },
      scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 1 }],
      trailAfterScaleOut: true,
      timeExit: { days: 10, minR: 0.5 },
      liquidityCap: true,
    };
  return {
    growthIntraday: id,
    stop: {
      kind: "percent",
      fraction: id.startsWith("RK-") ? 0.05 : id.startsWith("SE-") ? 0.1 : 0.08,
    },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
  };
}
export function growthIntradayBase(id: GrowthIntradayId) {
  if (id.startsWith("RK-")) return "dual-breakout" as const;
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
