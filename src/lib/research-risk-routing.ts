import { z } from "zod";
import { researchDateSchema } from "./research-usage";
import type { ResearchManagement } from "./research-management";
import { growthIntradayTemplate } from "./research-growth-intraday";
import { riskPresetTemplate } from "./research-risk-presets";
import { contextRiskTemplate } from "./research-context-risk";
import { riskExtensionTemplate } from "./research-risk-extensions";
export const riskRouteNames = {
  pullback: "趋势回调",
  breakout: "突破买入",
  volatile: "高波动结构模糊",
  intraday: "日内动量",
  profit: "趋势浮盈保护",
  fundamental: "中长基本面",
  unmonitored: "无法监控",
  records100: "百笔记录校准",
} as const;
export const riskRouteSchema = z
  .object({
    version: z.literal("risk-route-v1"),
    provenance: z.literal("manual-scenario"),
    knownOn: researchDateSchema,
    scenario: z.enum([
      "pullback",
      "breakout",
      "volatile",
      "intraday",
      "profit",
      "fundamental",
      "unmonitored",
      "records100",
    ]),
    branch: z.enum(["primary", "alternative"]),
  })
  .strict()
  .refine(
    (v) =>
      v.branch !== "alternative" ||
      !["unmonitored", "records100"].includes(v.scenario),
    "原文未给该场景备选，不补造",
  );
export type RiskRoute = z.infer<typeof riskRouteSchema>;
export const riskRoutingBoundary =
  "八场景路由工程v1：实验开始前人工预登记场景及可知日期，不从未来收益反推类别；首选/备选分别保存为独立实验。定性取值冻结：回调ATR备选2倍、突破K低点、模糊结构ATR2倍/Keltner中线、日内前日五分钟结构/固定0.5元且30分钟时间退出、浮盈22日3ATR/EMA20、基本面逻辑证伪灾难线/保护性put独立扩展、无法监控5%、百笔MAE开发段Q90。浮盈场景以同双突破基线验证保护规则，不伪造已有浮盈仓位；保护性put分支只算给定情景不生成A股回测。无备选的两行不创造备选。";
export function resolveRiskRoute(input: RiskRoute): {
  management: ResearchManagement | null;
  extension: ReturnType<typeof riskExtensionTemplate> | null;
} {
  const r = riskRouteSchema.parse(input),
    primary = r.branch === "primary";
  const base: ResearchManagement = {
    stop: { kind: "percent", fraction: 0.05 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
  };
  let management: ResearchManagement = base;
  switch (r.scenario) {
    case "pullback":
      management = {
        ...base,
        stop: primary
          ? { kind: "structure-atr", period: 14, multiple: 0.3 }
          : { kind: "atr", period: 14, multiple: 2 },
      };
      break;
    case "breakout":
      management = {
        ...base,
        stop: primary
          ? { kind: "breakout-candle", buffer: 0 }
          : { kind: "atr", period: 14, multiple: 1.5 },
      };
      break;
    case "volatile":
      management = primary
        ? { ...base, stop: { kind: "atr", period: 14, multiple: 2 } }
        : riskPresetTemplate("rk-indicator-keltner-mid");
      break;
    case "intraday":
      management = growthIntradayTemplate(
        primary ? "RK-A-intraday-structure30" : "RK-A-intraday-points30",
      );
      break;
    case "profit":
      management = {
        ...base,
        trail: primary
          ? { kind: "rolling-chandelier", period: 22, multiple: 3 }
          : { kind: "volatility", profile: "rk-ema20" },
      };
      break;
    case "fundamental":
      if (!primary)
        return {
          management: null,
          extension: riskExtensionTemplate("protective-put"),
        };
      management = contextRiskTemplate("rk-thesis");
      break;
    case "records100":
      management = riskPresetTemplate("rk-mae");
      break;
  }
  return { management, extension: null };
}
const positive = z.number().finite().positive();
export const stopDiagnosisSchema = z
  .object({
    version: z.literal("stop-diagnosis-v1"),
    provenance: z.literal("manual-scenario"),
    cutoff: researchDateSchema,
    variant: z.enum(["timing-v1", "atr-resize-v1", "naive-3-to-8-control"]),
    records: z
      .array(
        z
          .object({
            id: z.string().min(1),
            strategyVersion: z.string().min(1),
            entryDate: researchDateSchema,
            exitDate: researchDateSchema,
            availableDate: researchDateSchema,
            entry: positive,
            stop: positive,
            atr: positive,
            pivot: positive,
            delayBars: z.number().int().nonnegative(),
            profit: z.number().finite(),
            stopped: z.boolean(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type StopDiagnosis = z.infer<typeof stopDiagnosisSchema>;
export const stopDiagnosisBoundary =
  "诊断工程v1：预登记同版本完整开发记录至少100笔，所有记录含实际成本/初始线/入场ATR/原始触发位/延迟交易日及结算可知日，退出及可知日严格早于验证起点；不删除无效或亏损记录。净亏止损占比≥30%算频繁；其中≥50%延迟至少3根且距原始触发位至少2ATR算太晚；止损宽度/ATR中位数<1.5算不匹配。时机版在后续候选距当时冻结结构≤2ATR才准入且保留3%线；ATR版只在不匹配时改2ATR并重算股数；3%改8%不缩股为独立反例，仓位按3%预算但真实退出8%，必须报告超预算。三版本不比较后择优，缺训练不可执行。";
export function diagnoseStops(raw: StopDiagnosis) {
  const v = stopDiagnosisSchema.parse(raw),
    r = v.records;
  const reason =
    r.length < 100
      ? "不足100笔训练记录"
      : new Set(r.map((x) => x.id)).size !== r.length
        ? "重复训练记录"
        : new Set(r.map((x) => x.strategyVersion)).size !== 1
          ? "训练版本混合"
          : r.some(
                (x) =>
                  x.entryDate >= x.exitDate ||
                  x.exitDate >= v.cutoff ||
                  x.availableDate >= v.cutoff ||
                  x.availableDate < x.exitDate ||
                  x.stop >= x.entry,
              )
            ? "训练时点/初始线非法"
            : null;
  const losses = r.filter((x) => x.stopped && x.profit < 0),
    late = losses.filter(
      (x) => x.delayBars >= 3 && (x.entry - x.pivot) / x.atr >= 2,
    ).length;
  const ratios = r.map((x) => (x.entry - x.stop) / x.atr).sort((a, b) => a - b),
    mid = (ratios.length - 1) / 2;
  const median = ratios.length
    ? (ratios[Math.floor(mid)]! + ratios[Math.ceil(mid)]!) / 2
    : null;
  return {
    version: v.version,
    variant: v.variant,
    cutoff: v.cutoff,
    reason,
    count: r.length,
    stopLossRate: reason ? null : losses.length / r.length,
    frequent: !reason && losses.length / r.length >= 0.3,
    late: !reason && losses.length > 0 && late / losses.length >= 0.5,
    mismatch: !reason && median != null && median < 1.5,
    medianAtrWidth: reason ? null : median,
    boundary: stopDiagnosisBoundary,
  };
}
export function diagnosisTemplate(): ResearchManagement {
  return {
    stop: { kind: "percent", fraction: 0.03 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
  };
}
export function diagnosisDecision(
  raw: StopDiagnosis,
  date: string,
  entry: number,
  atr: number | null | undefined,
  structure: number | null | undefined,
) {
  const d = diagnoseStops(raw);
  if (d.reason || date < d.cutoff)
    return {
      allow: false,
      stop: null,
      sizingStop: null,
      reason: d.reason ?? "仅用于冻结后的验证段",
    };
  if (
    raw.variant === "timing-v1" &&
    d.frequent &&
    d.late &&
    (atr == null ||
      atr <= 0 ||
      structure == null ||
      structure <= 0 ||
      (entry - structure) / atr > 2)
  )
    return {
      allow: false,
      stop: null,
      sizingStop: null,
      reason: "太晚诊断：入场超2ATR或缺结构",
    };
  const calibrated =
    raw.variant === "atr-resize-v1" && d.frequent && d.mismatch;
  if (calibrated && (atr == null || !Number.isFinite(atr) || atr <= 0))
    return {
      allow: false,
      stop: null,
      sizingStop: null,
      reason: "ATR校准缺入场时可知ATR",
    };
  const sizingStop = calibrated ? entry - 2 * atr! : entry * 0.97;
  const stop =
    raw.variant === "naive-3-to-8-control" ? entry * 0.92 : sizingStop;
  return {
    allow: stop > 0,
    stop,
    sizingStop,
    reason: stop > 0 ? null : "止损无效",
  };
}
