import { researchKellyQuality } from "./research-kelly-quality";
import type { ResearchKellyTraining } from "./research-kelly-training";
export type RiskAdmissionRule =
  | "win45"
  | "positive"
  | "quality3"
  | "expect-size"
  | "example50"
  | "example40"
  | "example60"
  | "kelly30"
  | "expect02"
  | "rr2"
  | "quarter-kelly";
export const riskAdmissionBoundary =
  "准入工程v1：同双突破事件，先以不带准入限制的开发段参考成交训练，验证段只使用cutoff≤分区起点且每笔退出严格早于cutoff的至少30笔完整交易，不读取验证期结果。p按净盈利笔数/全部笔数（含零收益），b按净盈利金额均值/净亏损金额均值；是金额样本比的具名版本，不冒充恒定1R真实概率。无盈利且有亏损时b=0、期望=-1R，完整保留样本；无亏损不能估算b，不补造。原文三个例子分别固定assumptionWinRate=.5/.4/.6、assumptionPayoff=2/3/1，不宣称实测p。E=p*b-(1-p)：E>0.5用标准仓，0.2≤E≤0.5用半仓，0<E<0.2工程裁定观望，E≤0禁止；边界容差1e-12用于十进制舍入。凯利30版为2%风险/30%单股及组合上限与半凯利三者取小；不确定版用四分之一凯利并保持20%上限。质量版只读已冻结五项是/否，不使用其概率映射。RR2另以实际开盘、费用后冻结目标/止损算规划2R，不用训练b代替目标。";
export function riskAdmissionNeedsTraining(
  rule: RiskAdmissionRule | undefined,
) {
  return (
    !!rule &&
    [
      "win45",
      "positive",
      "expect-size",
      "kelly30",
      "expect02",
      "quarter-kelly",
    ].includes(rule)
  );
}
export function researchRiskAdmission(
  rule: RiskAdmissionRule,
  start: string,
  evidence: string,
  training?: ResearchKellyTraining | null,
) {
  let assumptionWinRate: number | null = null,
    assumptionPayoff: number | null = null;
  let p: number | null = null,
    b: number | null = null,
    reason: string | null = null;
  if (rule === "quality3") {
    const quality = researchKellyQuality(evidence);
    return {
      allow: quality.score != null && quality.score >= 3,
      scale: 1,
      maxWeight: 1,
      p: null,
      b: null,
      expectancy: null,
      fullKelly: null,
      assumptionWinRate,
      assumptionPayoff,
      reason: quality.reason,
      score: quality.score,
      samples: [],
    };
  }
  if (rule === "rr2")
    return {
      allow: true,
      scale: 1,
      maxWeight: 1,
      p: null,
      b: null,
      expectancy: null,
      fullKelly: null,
      assumptionWinRate,
      assumptionPayoff,
      reason: null,
      samples: [],
    };
  if (rule.startsWith("example")) {
    [assumptionWinRate, assumptionPayoff] =
      rule === "example50"
        ? [0.5, 2]
        : rule === "example40"
          ? [0.4, 3]
          : [0.6, 1];
    p = assumptionWinRate;
    b = assumptionPayoff;
  } else {
    if (
      !training ||
      training.reason ||
      training.cutoff > start ||
      training.samples.length < 30 ||
      training.samples.some(
        (t) =>
          t.exitDate >= training.cutoff ||
          t.entryDate > t.exitDate ||
          !Number.isFinite(t.profit),
      )
    )
      reason = "至少30笔开发段已闭合训练交易及可用时点证据不足";
    else {
      const samples = training.samples,
        wins = samples.filter((t) => t.profit > 0),
        losses = samples.filter((t) => t.profit < 0);
      p = wins.length / samples.length;
      if (!losses.length && rule !== "win45")
        reason = "无亏损样本，净盈亏比不可估算";
      else if (losses.length)
        b = wins.length
          ? wins.reduce((s, t) => s + t.profit, 0) /
            wins.length /
            (-losses.reduce((s, t) => s + t.profit, 0) / losses.length)
          : 0;
    }
  }
  if (b != null && !Number.isFinite(b)) {
    b = null;
    reason = "净盈亏比超出有限数范围";
  }
  const expectancy = p != null && b != null ? p * b - (1 - p) : null;
  const fullKelly =
    p != null && b != null && b > 0 ? p - (1 - p) / b : b === 0 ? 0 : null;
  let allow = !reason && expectancy != null,
    scale = 1,
    maxWeight = 1;
  if (rule === "win45") allow = p != null && !reason && p >= 0.45;
  else if (rule === "positive") allow = allow && expectancy! > 0;
  else if (rule === "expect02") allow = allow && expectancy! >= 0.2 - 1e-12;
  else if (rule === "kelly30" || rule === "quarter-kelly") {
    maxWeight =
      fullKelly != null
        ? Math.max(0, fullKelly) * (rule === "kelly30" ? 0.5 : 0.25)
        : 0;
    allow = allow && maxWeight > 0;
  } else {
    scale =
      expectancy != null && expectancy > 0.5 + 1e-12
        ? 1
        : expectancy != null && expectancy >= 0.2 - 1e-12
          ? 0.5
          : 0;
    allow = allow && scale > 0;
  }
  return {
    allow,
    scale,
    maxWeight,
    p,
    b,
    expectancy,
    fullKelly,
    assumptionWinRate,
    assumptionPayoff,
    reason: reason ?? (allow ? null : "准入阈值不满足，保留非盈利样本"),
    samples: training?.samples ?? [],
  };
}
