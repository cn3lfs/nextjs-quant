import type { ResearchManagement } from "../workflow/research-management";

export const researchExitPresetVersion = "research-exit-presets-1";
export const canslimExitPresetIds = [
  "canslim-8-fixed",
  "canslim-20-25-cost",
  "canslim-20-25-profit10",
] as const;
export const canslimProgressPresetIds = [
  "canslim-time4-calendar",
  "canslim-time4-trading20",
] as const;
export function isCanslimProgressPreset(
  kind: string,
): kind is (typeof canslimProgressPresetIds)[number] {
  return (canslimProgressPresetIds as readonly string[]).includes(kind);
}
export type CanslimExitPreset =
  | (typeof canslimExitPresetIds)[number]
  | (typeof canslimProgressPresetIds)[number];
export function isCanslimExitPreset(kind: string): kind is CanslimExitPreset {
  return (
    isCanslimProgressPreset(kind) ||
    (canslimExitPresetIds as readonly string[]).includes(kind)
  );
}
export const canslimExitDescription =
  "固定首仓成交价8%止损，收盘不高于止损确认、下一可成交开盘执行。阶梯版收盘盈利15%保本、20%卖初始仓位一半、25%卖完余仓；首档实际完成后才按版本抬成本或盈利10%，受阻与取整不提前抬线。固定8%初始风险下阈值对应1.875R、2.5R、3.125R；不改变原始买点。应用时重置组合风控参数，仓位比例独立设置，信号退出与最长持有有效。日线收盘确认不代表盘中即时成交，不含完整CANSLIM因子、凯利或异常退出。";
export const sepaExitPresetIds = [
  "sepa-min-cap10",
  "sepa-be15",
  "sepa-time4-calendar",
  "sepa-time4-trading20",
] as const;
export type SepaExitPreset = (typeof sepaExitPresetIds)[number];
export function isSepaExitPreset(id: string): id is SepaExitPreset {
  return (sepaExitPresetIds as readonly string[]).includes(id);
}
export const sepaExitDescription =
  "SEPA价量组合组件：固定首仓10%初始止损为MIN后按10%修正的具名版本（不是MIN或MAX原式）；15%保本版收盘达到1.5R抬至首仓价，次日起生效，不保证扣费或跳空后无亏损；四周版从实际首仓成交日起自然28天或含入场日第20研究交易日，首个有效收盘涨幅不足10%才全退，等于10%不退出，只复核一次。收盘确认后下一可成交开盘执行，T+1/受阻重试/最长持有保持；不含完整SEPA。";
export const researchExitPresetIds = [
  ...sepaExitPresetIds,
  ...canslimProgressPresetIds,
  ...canslimExitPresetIds,
  "target-2r",
  "target-3r",
  "trail-only",
  "half-2r-tail",
] as const;
export type ResearchExitPreset = (typeof researchExitPresetIds)[number];
export const researchExitPresetLabels: Record<ResearchExitPreset, string> = {
  "sepa-min-cap10": "SEPA MIN后10%修正止损",
  "sepa-be15": "SEPA盈利15%后保本",
  "sepa-time4-calendar": "SEPA自然28天涨幅不足10%退出",
  "sepa-time4-trading20": "SEPA第20交易日涨幅不足10%退出",
  "canslim-time4-calendar": "CANSLIM自然28天涨幅不足5%退出",
  "canslim-time4-trading20": "CANSLIM第20交易日涨幅不足5%退出",
  "canslim-8-fixed": "CANSLIM固定8%止损",
  "canslim-20-25-cost": "CANSLIM 20%减半抬成本、25%清仓",
  "canslim-20-25-profit10": "CANSLIM 20%减半抬10%、25%清仓",
  "target-2r": "固定2R整仓退出",
  "target-3r": "固定3R整仓退出",
  "trail-only": "仅22周期3ATR跟随",
  "half-2r-tail": "半仓2R兑现与22周期3ATR尾仓",
};

// Structural input avoids making the configuration schema depend on its own inferred type.
export function matchesResearchExitPreset(value: {
  exitPreset?: ResearchExitPreset;
  stop?: { kind: string; fraction?: number };
  stopOverride?: unknown;
  pyramid?: unknown;
  stressBuffer?: number;
  timeExit?: unknown;
  progressExit?: { clock: string; days: number; minimumGain: number };
  confirmations: number;
  breakeven?: unknown;
  trail: { kind: string; period?: number; multiple?: number };
  scaleOut?: readonly {
    atR: number;
    fraction: number;
    raiseStopR: number | null;
  }[];
  trailAfterScaleOut?: boolean;
}) {
  const kind = value.exitPreset;
  if (kind && isSepaExitPreset(kind)) {
    if (
      value.stop?.kind !== "percent" ||
      value.stop.fraction !== 0.1 ||
      value.confirmations !== 1 ||
      value.stopOverride ||
      value.pyramid ||
      value.stressBuffer !== 0 ||
      value.timeExit != null ||
      value.trail.kind !== "fixed" ||
      value.trailAfterScaleOut ||
      value.scaleOut
    )
      return false;
    if (kind === "sepa-be15")
      return (
        !value.progressExit &&
        typeof value.breakeven === "object" &&
        value.breakeven !== null &&
        "atR" in value.breakeven &&
        value.breakeven.atR === 1.5 &&
        "mode" in value.breakeven &&
        value.breakeven.mode === "r-only"
      );
    if (value.breakeven) return false;
    if (kind === "sepa-min-cap10") return !value.progressExit;
    return (
      value.progressExit?.clock ===
        (kind.endsWith("calendar") ? "calendar-days" : "trading-days") &&
      value.progressExit.days === (kind.endsWith("calendar") ? 28 : 20) &&
      value.progressExit.minimumGain === 0.1
    );
  }
  if (kind && isCanslimExitPreset(kind)) {
    if (
      value.confirmations !== 1 ||
      value.stop?.kind !== "percent" ||
      value.stop.fraction !== 0.08 ||
      value.stopOverride ||
      value.pyramid ||
      value.stressBuffer !== 0 ||
      value.timeExit != null ||
      value.trail.kind !== "fixed" ||
      value.trailAfterScaleOut
    )
      return false;
    if (isCanslimProgressPreset(kind))
      return (
        !value.breakeven &&
        !value.scaleOut &&
        value.progressExit?.clock ===
          (kind.endsWith("calendar") ? "calendar-days" : "trading-days") &&
        value.progressExit.days === (kind.endsWith("calendar") ? 28 : 20) &&
        value.progressExit.minimumGain === 0.05
      );
    if (value.progressExit) return false;
    if (kind === "canslim-8-fixed") return !value.breakeven && !value.scaleOut;
    const be = value.breakeven;
    return (
      typeof be === "object" &&
      be !== null &&
      "atR" in be &&
      be.atR === 1.875 &&
      "mode" in be &&
      be.mode === "r-only" &&
      value.scaleOut?.length === 2 &&
      value.scaleOut[0]?.atR === 2.5 &&
      value.scaleOut[0].fraction === 0.5 &&
      value.scaleOut[0].raiseStopR ===
        (kind === "canslim-20-25-cost" ? 0 : 1.25) &&
      value.scaleOut[1]?.atR === 3.125 &&
      value.scaleOut[1].fraction === 0.5 &&
      value.scaleOut[1].raiseStopR === null
    );
  }
  if (!kind || value.confirmations !== 1 || value.breakeven) return false;
  const target = value.scaleOut?.[0];
  if (kind === "target-2r" || kind === "target-3r")
    return (
      value.trail.kind === "fixed" &&
      !value.trailAfterScaleOut &&
      value.scaleOut?.length === 1 &&
      target?.atR === (kind === "target-2r" ? 2 : 3) &&
      target.fraction === 1 &&
      target.raiseStopR === null
    );
  if (
    value.trail.kind !== "rolling-chandelier" ||
    value.trail.period !== 22 ||
    value.trail.multiple !== 3
  )
    return false;
  if (kind === "trail-only")
    return !value.scaleOut && !value.trailAfterScaleOut;
  return (
    value.trailAfterScaleOut === true &&
    value.scaleOut?.length === 1 &&
    target?.atR === 2 &&
    target.fraction === 0.5 &&
    target.raiseStopR === null
  );
}

export function researchExitPresetTemplate(
  value: ResearchManagement,
  kind: ResearchExitPreset,
): ResearchManagement {
  if (isSepaExitPreset(kind))
    return {
      exitPreset: kind,
      stop: { kind: "percent", fraction: 0.1 },
      confirmations: 1,
      stressBuffer: 0,
      trail: { kind: "fixed" },
      timeExit: null,
      ...(kind === "sepa-be15"
        ? { breakeven: { atR: 1.5, mode: "r-only" as const } }
        : {}),
      ...(kind.startsWith("sepa-time4")
        ? {
            progressExit: {
              clock: kind.endsWith("calendar")
                ? ("calendar-days" as const)
                : ("trading-days" as const),
              days: kind.endsWith("calendar") ? 28 : 20,
              minimumGain: 0.1,
            },
          }
        : {}),
    };
  if (isCanslimProgressPreset(kind))
    return {
      ...researchExitPresetTemplate(value, "canslim-8-fixed"),
      exitPreset: kind,
      progressExit: {
        clock: kind.endsWith("calendar") ? "calendar-days" : "trading-days",
        days: kind.endsWith("calendar") ? 28 : 20,
        minimumGain: 0.05,
      },
    };
  if (isCanslimExitPreset(kind))
    return {
      exitPreset: kind,
      stop: { kind: "percent", fraction: 0.08 },
      confirmations: 1,
      stressBuffer: 0,
      trail: { kind: "fixed" },
      timeExit: null,
      ...(kind === "canslim-8-fixed"
        ? {}
        : {
            breakeven: { atR: 1.875, mode: "r-only" as const },
            scaleOut: [
              {
                atR: 2.5,
                fraction: 0.5,
                raiseStopR: kind === "canslim-20-25-cost" ? 0 : 1.25,
              },
              { atR: 3.125, fraction: 0.5, raiseStopR: null },
            ],
          }),
    };
  const {
    breakeven: _be,
    scaleOut: _scale,
    trailAfterScaleOut: _after,
    exitPreset: _preset,
    ...rest
  } = value;
  if (kind === "target-2r" || kind === "target-3r")
    return {
      ...rest,
      exitPreset: kind,
      confirmations: 1,
      trail: { kind: "fixed" },
      scaleOut: [
        { atR: kind === "target-2r" ? 2 : 3, fraction: 1, raiseStopR: null },
      ],
    };
  return {
    ...rest,
    exitPreset: kind,
    confirmations: 1,
    trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
    ...(kind === "half-2r-tail"
      ? {
          scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: null }],
          trailAfterScaleOut: true,
        }
      : {}),
  };
}

export function clearStaleExitPreset(
  value: ResearchManagement,
): ResearchManagement {
  if (!value.exitPreset || matchesResearchExitPreset(value)) return value;
  const { exitPreset: _preset, ...rest } = value;
  return rest;
}
