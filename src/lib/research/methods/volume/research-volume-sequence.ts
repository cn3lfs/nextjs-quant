import type { Bar } from "../../../domain";
import type { VolumeEvidence } from "./research-volume-grid";
import { linearSlope, volumeMa } from "../../../indicators";
import {
  researchVolumeSeries,
  volumeIndicatorInput,
  type VolumePoint,
} from "./research-volume";

export const volumeSequenceIds = [
  "vp-slope-up-3",
  "vp-slope-up-5",
  "vp-slope-down-3",
  "vp-slope-down-5",
  "vp-stack-5",
  "vp-contract-5",
  "vp-center-5",
  "vp-center-10",
  "vp-center-20",
  "vp-pulse-1-2",
  "vp-pulse-1-3",
  "vp-pulse-2-2",
  "vp-pulse-3-2",
  "vp-pulse-3-3",
] as const;
export type VolumeSequenceId = (typeof volumeSequenceIds)[number];
type Profile =
  | { kind: "slope-up" | "slope-down" | "stack" | "contract"; n: 3 | 5 }
  | { kind: "center"; n: 5 | 10 | 20 }
  | { kind: "pulse"; gap: 1 | 2 | 3; count: 2 | 3 };
const profiles: Record<VolumeSequenceId, Profile> = {
  "vp-slope-up-3": { kind: "slope-up", n: 3 },
  "vp-slope-up-5": { kind: "slope-up", n: 5 },
  "vp-slope-down-3": { kind: "slope-down", n: 3 },
  "vp-slope-down-5": { kind: "slope-down", n: 5 },
  "vp-stack-5": { kind: "stack", n: 5 },
  "vp-contract-5": { kind: "contract", n: 5 },
  "vp-center-5": { kind: "center", n: 5 },
  "vp-center-10": { kind: "center", n: 10 },
  "vp-center-20": { kind: "center", n: 20 },
  "vp-pulse-1-2": { kind: "pulse", gap: 1, count: 2 },
  "vp-pulse-1-3": { kind: "pulse", gap: 1, count: 3 },
  "vp-pulse-2-2": { kind: "pulse", gap: 2, count: 2 },
  "vp-pulse-3-2": { kind: "pulse", gap: 3, count: 2 },
  "vp-pulse-3-3": { kind: "pulse", gap: 3, count: 3 },
};
export function isVolumeSequence(id: string): id is VolumeSequenceId {
  return (volumeSequenceIds as readonly string[]).includes(id);
}
/** Fixed, disclosed rhythm. No fitting or automatic selection of a best gap. */
export function hasVolumePulses(
  ratios: readonly (number | null)[],
  gap: number,
  count: number,
): boolean {
  if (
    !Number.isInteger(gap) ||
    gap < 1 ||
    !Number.isInteger(count) ||
    count < 2
  )
    return false;
  return (
    ratios.length === (gap + 1) * (count - 1) + 1 &&
    ratios.every(
      (r, i) =>
        r !== null &&
        Number.isFinite(r) &&
        r > 0 &&
        (i % (gap + 1) === 0 ? r >= 1.5 : r < 0.8),
    )
  );
}
function definition(id: VolumeSequenceId) {
  const p = profiles[id];
  const label =
    p.kind === "pulse"
      ? `量价 · 隔${p.gap}根${p.count}次放量突破`
      : p.kind === "center"
        ? `量价 · ${p.n}日均量中枢`
        : p.kind === "stack"
          ? "量价 · 五根温和递增"
          : p.kind === "contract"
            ? "量价 · 五根递减后突破"
            : `量价 · ${p.n}根量能${p.kind === "slope-up" ? "正斜率" : "负斜率后突破"}`;
  const rule =
    p.kind === "pulse"
      ? `上涨/区间/底部代理内，${p.count}次R≥1.5的放量之间各隔${p.gap}根R<0.8缩量；最后一根收盘突破前20根高点才入场。`
      : p.kind === "center"
        ? `含当日${p.n}个有效量能记录的算术均量连续3个值严格抬升、均线上涨位置且当根收盘不下降时入场；连续3个值严格下移退出。`
        : p.kind === "stack"
          ? "均线上涨位置，连续5根量严格递增、各根R在[1.2,1.5)且收盘不下降，首次满足入场。"
          : p.kind === "slope-up"
            ? `最近${p.n}根成交量对等距序号的最小二乘斜率>0，均线上涨位置且窗口内收盘不下降时首次入场；不要求量逐根递增。`
            : `最近${p.n}根${p.kind === "contract" ? "成交量严格递减" : "成交量最小二乘斜率<0"}，上涨/区间/底部代理且近5根振幅≤5%建立候选；10根内R≥1.5且收盘突破冻结5根高点确认，破低、超时、高位或共享退出取消。`;
  return {
    label,
    family: "量价",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${rule}斜率算法、3点中枢方向、5%振幅、10根等待和节奏参数均是公开工程定义，固定比较不自动挑选最好参数。仅使用连续有效日线，零量/一字/缺失不跨段连接；均量跳过零量。收盘确认后下一可成交开盘；候选突破及间隔突破保留3根冻结位守卫，MA20失守、放量下跌/高位滞涨和最长持有期仍有效。公司行动覆盖向前81根价格及候选前60个有效量能记录；历史换手与量能污染未核验。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
    ],
  };
}
export const volumeSequenceStrategies = Object.fromEntries(
  volumeSequenceIds.map((id) => [id, definition(id)]),
) as Record<VolumeSequenceId, ReturnType<typeof definition>>;
type Candidate = {
  date: string;
  high: number;
  low: number;
  close: number;
  wait: number;
  index: number;
};
export type VolumeSequencePoint = VolumePoint & {
  sequence: {
    profile: Profile;
    volumes: number[];
    ratios: (number | null)[];
    slope: number | null;
    meanValues: (number | null)[];
    centerUp: boolean;
    centerDown: boolean;
    strictUp: boolean;
    strictDown: boolean;
    pulse: boolean;
    range5: number | null;
    trigger: boolean;
  };
};
export function researchVolumeSequenceSeries(
  id: VolumeSequenceId,
  bars: readonly Bar[],
  evidence: VolumeEvidence = {},
): VolumeSequencePoint[] {
  const p = profiles[id],
    base = researchVolumeSeries("vp-breakout-1-5", bars, evidence);
  const mean =
    p.kind === "center" ? volumeMa(volumeIndicatorInput(bars), p.n) : [];
  let candidate: Candidate | null = null,
    priorTrigger = false;
  return base.map((point, i) => {
    const v = point.values,
      previous = base[i - 1]?.values;
    const n =
      p.kind === "pulse"
        ? (p.gap + 1) * (p.count - 1) + 1
        : p.kind === "center"
          ? 3
          : p.n;
    const rows = base.slice(Math.max(0, i - n + 1), i + 1),
      five = base.slice(Math.max(0, i - 4), i + 1);
    const valid = rows.length === n && rows.every((r) => r.reason === null),
      volumes = rows.map((r) => r.values.volume),
      ratios = rows.map((r) => (r.reason ? null : r.values.ratio5));
    const slope = valid ? linearSlope(volumes) : null,
      strictUp = valid && volumes.every((x, k) => !k || x > volumes[k - 1]!),
      strictDown = valid && volumes.every((x, k) => !k || x < volumes[k - 1]!);
    const priceUp =
      valid &&
      rows.every((r, k) => !k || r.values.close >= rows[k - 1]!.values.close);
    const meanValues =
      p.kind === "center" ? mean.slice(Math.max(0, i - 2), i + 1) : [];
    const centerValid =
      meanValues.length === 3 && meanValues.every((x) => x !== null);
    const centerUp =
        centerValid &&
        meanValues[2]! > meanValues[1]! &&
        meanValues[1]! > meanValues[0]!,
      centerDown =
        centerValid &&
        meanValues[2]! < meanValues[1]! &&
        meanValues[1]! < meanValues[0]!;
    const high5 =
        five.length === 5 ? Math.max(...five.map((r) => r.values.high)) : null,
      low5 =
        five.length === 5 ? Math.min(...five.map((r) => r.values.low)) : null;
    const range5 =
      high5 !== null && low5 !== null && low5 > 0 ? high5 / low5 - 1 : null;
    const pulse =
      p.kind === "pulse" && valid && hasVolumePulses(ratios, p.gap, p.count);
    const reason =
      point.reason ??
      (!valid ||
      (p.kind === "center" && !centerValid) ||
      ((p.kind === "contract" || p.kind === "slope-down") &&
        (five.length !== 5 || five.some((r) => r.reason !== null)))
        ? "量能形状窗口不足或不连续"
        : null);
    const eligible = ["up-ma-proxy", "range-proxy", "bottom-proxy"].includes(
      v.location,
    );
    let trigger = false,
      entry = false,
      exit = !reason && point.exit,
      decision = "等待量能形状";
    let captured: Candidate | null = null,
      ruleStop: VolumePoint["ruleStop"];
    if (reason) {
      candidate = null;
      priorTrigger = false;
      decision = "输入不可用，量能候选取消";
    } else {
      if (p.kind === "pulse") {
        trigger =
          eligible &&
          pulse &&
          v.high20Prior !== null &&
          v.close > v.high20Prior;
        entry = trigger && !priorTrigger;
        if (entry) {
          decision = "间隔放量收盘突破";
          ruleStop = {
            price: v.high20Prior!,
            days: 3,
            reason: "间隔放量突破位",
          };
        }
      } else if (p.kind === "center") {
        trigger =
          v.location === "up-ma-proxy" &&
          centerUp &&
          !!previous &&
          v.close >= previous.close;
        entry = trigger && !priorTrigger;
        if (centerDown) {
          exit = true;
          decision = "量能中枢连续3点下移";
        } else if (entry) decision = "量能中枢连续3点抬升";
      } else if (p.kind === "stack" || p.kind === "slope-up") {
        trigger =
          v.location === "up-ma-proxy" &&
          priceUp &&
          (p.kind === "stack"
            ? strictUp && ratios.every((r) => r !== null && r >= 1.2 && r < 1.5)
            : slope !== null && slope > 0);
        entry = trigger && !priorTrigger;
        if (entry)
          decision =
            p.kind === "stack"
              ? "连续5根温和递增量"
              : "正量能斜率与非下降价格确认";
      } else {
        trigger =
          eligible &&
          range5 !== null &&
          range5 <= 0.05 &&
          (p.kind === "contract" ? strictDown : slope !== null && slope < 0);
        if (candidate) {
          captured = { ...candidate };
          const age = i - candidate.index;
          if (
            age > candidate.wait ||
            v.low < candidate.low ||
            v.location === "high" ||
            exit
          ) {
            candidate = null;
            decision = "缩量候选过期或失效";
          } else if (v.ratio5! >= 1.5 && v.close > candidate.high) {
            entry = true;
            ruleStop = {
              price: candidate.low,
              days: 3,
              reason: "缩量候选冻结低点",
            };
            candidate = null;
            decision = "缩量后放量收复冻结区间";
          } else if (age === candidate.wait) {
            candidate = null;
            decision = "缩量候选等待期结束";
          }
        }
        if (!captured && !candidate && trigger && !priorTrigger && !exit) {
          candidate = {
            date: point.date,
            high: high5!,
            low: low5!,
            close: v.close,
            wait: 10,
            index: i,
          };
          captured = { ...candidate };
          decision = "缩量窄幅候选，等待放量突破";
        }
      }
      priorTrigger = trigger;
    }
    if (exit) {
      entry = false;
      ruleStop = undefined;
      candidate = null;
      if (point.exit) decision += "；共享量价退出";
    }
    return {
      date: point.date,
      values: v,
      reason,
      entry,
      exit,
      decision,
      candidate: captured
        ? {
            date: captured.date,
            high: captured.high,
            low: captured.low,
            close: captured.close,
            wait: captured.wait,
          }
        : null,
      sequence: {
        profile: { ...p },
        volumes,
        ratios,
        slope,
        meanValues,
        centerUp,
        centerDown,
        strictUp,
        strictDown,
        pulse,
        range5,
        trigger,
      },
      ...(ruleStop ? { ruleStop } : {}),
    };
  });
}
