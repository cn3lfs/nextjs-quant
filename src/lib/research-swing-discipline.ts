import type { ResearchManagement } from "./research-management";
import type { BacktestCosts } from "./backtest-costs";
import {
  researchCommission,
  type ResearchExecutionRules,
} from "./research-execution";
import { researchPlannedProceeds } from "./research-pyramid";
export const swingDisciplineIds = [
  "sw-stop2",
  "sw-stop3",
  "sw-stop-volatility",
  "sw-stop-required",
  "sw-no-average",
  "sw-min-rr2",
] as const;
export type SwingDisciplineId = (typeof swingDisciplineIds)[number];
export const swingDisciplineLabels: Record<SwingDisciplineId, string> = {
  "sw-stop2": "波段固定2%止损",
  "sw-stop3": "波段固定3%止损",
  "sw-stop-volatility": "波段ATR14适配2%/3%",
  "sw-stop-required": "双突破有效结构止损准入",
  "sw-no-average": "双突破盈利限定50/50回踩",
  "sw-min-rr2": "双突破费用后至少2R准入",
};
export const swingDisciplineBoundary =
  "具名双突破管理组合v1：均以原dual-breakout为基线，2%/3%固定止损独立；波动适配以信号日ATR14/实际成交价≥2%选3%，否则2%，ATR缺失禁入；这是公开工程分界，不冒称原文唯一值。结构版以当时有效低点止损，缺线/零距离/开盘已失守拒入；不准向亏损移动。严格回踩50/50沿用requireProfit=true，追加需成交价超过首仓并覆盖剩余成本，保留允许低价计划补齐的旧版不改。2R版冻结最近上方目标；实际开盘滑点价、整手数量、买佣、卖税、分笔最低佣金及目标/止损卖滑点后重算计划净回报/净风险≥2，缺目标拒入，跳空会取消信号；未来费用/成交是规划估计，非保证盈亏。统一3%风险上限、20%单股上限、最多3只与60%总仓位、连续3笔净亏暂停2交易日；固定5交易日无进展0.5R工程退出，原有最长持有期保留。";
export function swingDisciplineTemplate(
  id: SwingDisciplineId,
): ResearchManagement {
  return {
    swingDiscipline: id,
    stop:
      id === "sw-stop-required" || id === "sw-no-average" || id === "sw-min-rr2"
        ? { kind: "structure", buffer: 0 }
        : { kind: "percent", fraction: id === "sw-stop3" ? 0.03 : 0.02 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: { days: 5, minR: 0.5 },
    maxTotalWeight: 0.6,
    lossPauseDays: 2,
    ...(id === "sw-no-average"
      ? {
          pyramid: {
            kind: "pullback-50-50" as const,
            maxTotalWeight: 0.6,
            waitBars: 5,
            tolerance: 0,
            requireProfit: true,
          },
        }
      : {}),
  };
}
export function swingRewardAdmission(input: {
  entry: number;
  stop: number | null | undefined;
  target: number | null | undefined;
  quantity: number;
  rules: ResearchExecutionRules;
  costs: BacktestCosts;
}) {
  const { entry, stop, target, quantity, rules, costs } = input;
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    stop == null ||
    !Number.isFinite(stop) ||
    stop <= 0 ||
    stop >= entry ||
    target == null ||
    !Number.isFinite(target) ||
    target <= entry ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  )
    return {
      allow: false,
      ratio: null,
      reason: "缺有效冻结目标/止损或开盘已越过目标",
    };
  const cost = entry * quantity + researchCommission(entry * quantity, costs),
    lossProceeds = researchPlannedProceeds(quantity, stop, rules, costs),
    winProceeds = researchPlannedProceeds(quantity, target, rules, costs);
  if (lossProceeds === null || winProceeds === null || cost <= lossProceeds)
    return {
      allow: false,
      ratio: null,
      reason: "卖出步长/尾仓或净风险不可定义",
    };
  const ratio = (winProceeds - cost) / (cost - lossProceeds);
  return {
    allow: ratio >= 2,
    ratio,
    reason: ratio >= 2 ? null : "实际开盘/费用后计划净回报不足2R",
  };
}
