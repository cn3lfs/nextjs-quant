import type { ResearchReadiness } from "./research-readiness";

export const engineeringStatusLabels = {
  runnable: "可运行",
  blocked: "被阻断",
  unknown: "未知",
} as const;
export const ruleCheckStatusLabels = {
  checked: "已检查",
  "checked-partial": "部分检查（存在缺失槽）",
  failed: "检查失败",
  "not-checked": "未检查",
  unknown: "未知",
} as const;
export const dataQualificationStatusLabels = {
  qualified: "数据合格",
  partial: "部分合格",
  unqualified: "不合格",
  unknown: "未知",
} as const;
export const independentValidationStatusLabels = {
  unknown: "未知",
  "no-holdout": "无留出窗口",
  exposed: "留出已被触碰",
  unused: "留出未使用但未验证",
  incomplete: "独立检查不完整",
  passed: "独立检查通过",
  failed: "独立检查失败",
} as const;
export const forwardObservationStatusLabels = {
  unknown: "未知",
  "not-actual": "非真实前向观察",
  none: "尚无真实观察",
  accumulating: "观察累积中",
  "minimum-met": "达到最低观察数（非收益结论）",
} as const;

/** Presentation labels only; the readiness module owns every status decision. */
export function readinessSummary(readiness: ResearchReadiness) {
  return {
    engineering: engineeringStatusLabels[readiness.engineering.status],
    ruleCheck: ruleCheckStatusLabels[readiness.ruleCheck.status],
    dataQualification:
      dataQualificationStatusLabels[readiness.dataQualification.status],
    independentValidation:
      independentValidationStatusLabels[readiness.independentValidation.status],
    forwardObservation:
      forwardObservationStatusLabels[readiness.forwardObservation.status],
  };
}
