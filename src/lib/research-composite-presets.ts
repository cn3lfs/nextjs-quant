import {
  contextRiskMaxPositions,
  contextRiskTemplate,
  type ContextRiskId,
} from "./research-context-risk";
import {
  growthIntradayBase,
  growthIntradayTemplate,
  type GrowthIntradayId,
} from "./research-growth-intraday";
import {
  researchManagementSchema,
  type ResearchManagement,
} from "./research-management";
import {
  riskPresetBase,
  riskPresetIds,
  riskPresetParameters,
  riskPresetTemplate,
  riskProfiles,
  type RiskPresetId,
} from "./research-risk-presets";
import {
  volatilityStopTemplate,
  type VolatilityStopId,
} from "./research-volatility-stops";
import { researchSpecSchema, type ResearchSpec } from "./strategy-research";
import { riskExtensionTemplate } from "./research-risk-extensions";
import { diagnosisTemplate } from "./research-risk-routing";

const b2MethodIds = [
  "RK-A1-percent",
  "RK-A2-atr",
  "RK-A3-buffer",
  "RK-A4-indicator",
  "RK-A5-mae",
  "RK-A6-thesis",
  "RK-A-max-distance",
  "RK-B-touch",
  "RK-B-close",
  "RK-B-two-closes",
  "RK-C-risk",
  "RK-C-stress",
  "RK-C-kelly",
  "RK-C-liquidity",
  "RK-C-disaster",
  "RK-D1-fixed",
  "RK-D2-breakeven",
  "RK-D3-percent",
  "RK-D3-distance",
  "RK-D3-structure",
  "RK-D4-retracement",
  "RK-D5-time",
  "RK-D6-partial",
  "RK-V1-chandelier",
  "RK-V1-rolling-high",
  "RK-V2-boll",
  "RK-V3-keltner",
  "RK-V4-kase",
  "RK-V5-kaufman",
  "RK-V6-safezone",
  "RK-V7-beta",
  "RK-V8-sar",
  "RK-E-daily",
  "RK-E-weekly",
  "RK-E-monthly",
  "RK-E-streak",
  "RK-E-drawdown",
  "RK-E-equity",
  "RK-F-reduce",
  "RK-F-diversify",
  "RK-F-rebalance",
  "RK-F-put",
  "RK-F-collar",
  "RK-D6-close-atr-tail",
  "RK-D7-pyramid",
  "SW11-risk-cap3",
  "SW11-three-loss-pause",
  "SW11-emotion-gate",
  "SW-P-risk2",
  "SW-P-stop5",
  "SW-P-three-positions",
  "SW-P-total60",
  "SW-P-market-cap",
  "SW-P-news-exit",
  "SW-P-time5",
  "SW-P-win45",
  "SW-P-expect-positive",
  "SW-P-quality3",
  "SW-P-expect-size",
  "SW-P-example-50-2",
  "SW-P-example-40-3",
  "SW-P-example-60-1",
  "SW-P-kelly30",
  "SW-P-month-win",
  "SW-P-month-rr",
  "SW-P-month-negative3",
  "SW-P-day5-week",
  "SW-P-loss5-week",
  "SW-P-emotion-week",
  "SW-P-discipline-week",
  "SW-P-dd15-week",
  "SW-P-preflight",
  "RK-V2-mid",
  "RK-V3-mid",
  "RK-V3-opposite",
  "RK-V4-stages",
  "RK-V-structure-farther",
  "RK-A1-atr-bands",
  "RK-A3-atr-buffer",
  "RK-A3-distance2atr",
  "RK-A4-ema20",
  "RK-A4-ma60",
  "RK-A4-ma120",
  "RK-A4-chan-line",
  "RK-A4-respect",
  "RK-E-sector-risk",
  "RK-E-week3r",
  "RK-E-elder2-6",
  "RK-F-no-single-stop",
  "RK-F-event-reduce",
  "RK-C-swing-system",
  "RK-D6-half2r",
  "RK-D5-time10",
  "RK-C-risk-tiers",
  "RK-C-hard2",
  "RK-C-current-equity",
  "RK-C-weight15-20",
  "RK-C-total-risk4-6",
  "RK-C-expect02",
  "RK-C-sizing-three",
  "RK-A-explicit",
  "RK-A-buffer-auto",
  "RK-C-slip-report",
  "RK-C-rr2",
  "RK-D-script-r",
  "RK-F-short-script",
  "RK-D2-compare",
  "RK-D-cycle-switch",
  "RK-D-target23",
  "RK-D-trend-exit",
  "RK-D-half-tail",
  "RK-D-add-repair",
  "RK-C-kelly-quarter",
  "RK-C-kelly-p30",
  "RK-C-kelly-quality",
  "RK-C-kelly-switch30",
  "RK-C-kelly-uncertain",
  "RK-A-earliest",
  "RK-A-breakout-upper",
  "RK-A-breakout-candle",
  "RK-A-intraday-time",
  "RK-A-thesis-disaster",
  "RK-A-crowded-buffer",
  "RK-A-stop-diagnosis",
  "RK-A-scenario-routing",
  "RK-C-held-risk-repair",
  "RK-E-chop-frequency",
  "RK-D-fresh-entry-exit",
  "RK-A-atr10-20",
  "RK-C-kelly-direct",
  "RK-C-kelly-realized-b",
  "RK-C-kelly-fraction",
  "RK-C-kelly-market-gate",
] as const;

const b5MethodIds = [
  "OP01",
  "OP02",
  "OP03",
  "OP04",
  "OP05",
  "OP06",
  "OP07",
  "OP08",
  "AR01-time-window",
  "AR02-gain-filter",
  "AR03-st-filter",
  "AR04-ipo-age",
  "AR05-resumption",
  "AR06-report-window",
  "AR07-late-size",
  "AR08-auction-confirm",
  "SW02-last30",
  "RK-X-market-stop",
  "RK-X-stop-limit1",
  "RK-X-profit-limit",
  "RK-X-manual",
  "RK-X-conditional",
  "RK-X-t0-old",
  "RK-X-gap10",
  "RK-X-limit-news",
  "RK-X-limit-budget",
  "RK-X-halt-cap",
  "RK-X-auction-queue",
  "RK-X-event5",
] as const;

export const researchCompositeMethodIds = [
  ...b2MethodIds,
  ...b5MethodIds,
] as const;
export type ResearchCompositeMethodId =
  (typeof researchCompositeMethodIds)[number];

export type ResearchCompositePreset = {
  id: string;
  methodId: ResearchCompositeMethodId;
  baseline: "dual-breakout" | "boll-band-recovery";
  component: string;
  inputRequirement?: string;
  build: (base: ResearchSpec) => ResearchSpec;
};

const presetId = (methodId: string) =>
  `r3b-${methodId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-dual-breakout`;

function baseWithoutManagement(base: ResearchSpec) {
  const {
    management: _management,
    risk: _risk,
    riskExtension: _riskExtension,
    riskRepair: _riskRepair,
    riskRoute: _riskRoute,
    stopDiagnosis: _stopDiagnosis,
    ...rest
  } = base;
  return rest;
}

function fixedManagement(overrides: Partial<ResearchManagement> = {}) {
  return researchManagementSchema.parse({
    stop: { kind: "percent", fraction: 0.05 },
    confirmations: 1,
    stressBuffer: 0,
    trail: { kind: "fixed" },
    timeExit: null,
    ...overrides,
  });
}

function withManagement(
  base: ResearchSpec,
  management: ResearchManagement,
  options: {
    strategy?: ResearchSpec["strategy"];
    risk?: ResearchSpec["risk"];
    maxPositions?: number;
    extra?: Record<string, unknown>;
  } = {},
) {
  return researchSpecSchema.parse({
    ...baseWithoutManagement(base),
    strategy: options.strategy ?? "dual-breakout",
    risk: options.risk ?? { fraction: 0.01, maxWeight: 0.2 },
    holdingDays: 60,
    maxPositions: options.maxPositions ?? base.maxPositions,
    management,
    ...options.extra,
  });
}

function withRiskPreset(base: ResearchSpec, id: RiskPresetId) {
  const parameters = riskPresetParameters(id);
  return withManagement(base, riskPresetTemplate(id), {
    strategy: riskPresetBase(id),
    risk: { fraction: parameters.fraction, maxWeight: parameters.maxWeight },
  });
}

function withContextRisk(base: ResearchSpec, id: ContextRiskId) {
  return withManagement(base, contextRiskTemplate(id), {
    risk: { fraction: 0.02, maxWeight: 0.2 },
    maxPositions: contextRiskMaxPositions(id),
  });
}

function withGrowthIntraday(base: ResearchSpec, id: GrowthIntradayId) {
  return withManagement(base, growthIntradayTemplate(id), {
    strategy: growthIntradayBase(id),
    risk: { fraction: 0.01, maxWeight: 0.2 },
  });
}

const riskPresetByMethod = new Map<string, RiskPresetId>(
  riskPresetIds.map((id) => [riskProfiles[id].method, id]),
);

const volatilityByMethod: Record<string, VolatilityStopId> = {
  "RK-V2-boll": "rk-boll-lower",
  "RK-V2-mid": "rk-boll-mid",
  "RK-V3-keltner": "rk-keltner-lower",
  "RK-V3-mid": "rk-keltner-mid",
  "RK-V3-opposite": "rk-keltner-opposite",
  "RK-V4-kase": "rk-kase",
  "RK-V4-stages": "rk-kase-stages",
  "RK-V5-kaufman": "rk-kaufman",
  "RK-V6-safezone": "rk-safezone",
  "RK-V7-beta": "rk-beta",
  "RK-V8-sar": "rk-sar",
  "RK-A4-ema20": "rk-ema20",
  "RK-A4-ma60": "rk-ma60",
  "RK-A4-ma120": "rk-ma120",
};

const contextByMethod: Record<string, ContextRiskId> = {
  "RK-A6-thesis": "rk-thesis",
  "RK-A-thesis-disaster": "rk-thesis",
  "RK-C-kelly-market-gate": "rk-kelly-market",
  "RK-D-fresh-entry-exit": "rk-fresh-entry",
  "RK-E-sector-risk": "rk-sector-risk",
  "RK-F-diversify": "rk-diversify",
  "RK-F-event-reduce": "rk-event-reduce",
  "RK-F-rebalance": "rk-diversify",
  "RK-F-reduce": "rk-event-reduce",
  "SW11-emotion-gate": "sw-emotion",
  "SW-P-emotion-week": "sw-emotion-week",
  "SW-P-discipline-week": "sw-discipline-week",
  "SW-P-news-exit": "sw-news-exit",
  "SW-P-preflight": "sw-preflight",
};

const inputOnlyByMethod: Record<string, string> = {
  "RK-A-scenario-routing": "缺历史场景路由输入",
  "RK-C-held-risk-repair": "缺真实持仓批次输入",
  "RK-D-cycle-switch": "缺真实持仓周期切换输入",
  "RK-D-add-repair": "缺真实持仓加减仓输入",
};

function buildPreset(methodId: ResearchCompositeMethodId, base: ResearchSpec) {
  const profile = riskPresetByMethod.get(methodId) as RiskPresetId | undefined;
  if (profile) return withRiskPreset(base, profile);
  const volatility = volatilityByMethod[methodId];
  if (volatility)
    return withManagement(base, volatilityStopTemplate(volatility));
  const context = contextByMethod[methodId];
  if (context) return withContextRisk(base, context);
  const growth = methodId as GrowthIntradayId;
  if (
    methodId === "RK-B-touch" ||
    methodId === "RK-C-swing-system" ||
    methodId === "RK-A-intraday-time" ||
    (b5MethodIds as readonly string[]).includes(methodId)
  )
    return withGrowthIntraday(
      base,
      methodId === "RK-A-intraday-time" ? "RK-A-intraday-structure30" : growth,
    );
  if (
    methodId === "RK-F-put" ||
    methodId === "RK-F-collar" ||
    methodId === "RK-F-short-script"
  )
    return withManagement(base, fixedManagement(), {
      extra: {
        riskExtension: riskExtensionTemplate(
          methodId === "RK-F-put"
            ? "protective-put"
            : methodId === "RK-F-collar"
              ? "collar"
              : "short-script",
        ),
      },
    });
  if (methodId === "RK-A-stop-diagnosis")
    return withManagement(base, diagnosisTemplate(), {
      extra: {
        stopDiagnosis: {
          version: "stop-diagnosis-v1",
          provenance: "manual-scenario",
          cutoff: base.validationStart,
          variant: "timing-v1",
          records: [],
        },
      },
    });
  if (methodId === "RK-D7-pyramid")
    return withManagement(
      base,
      fixedManagement({
        pyramid: {
          kind: "r-50-30-20",
          maxTotalWeight: 0.6,
        },
      }),
    );
  if (methodId === "RK-D6-half2r" || methodId === "RK-D-script-r")
    return withManagement(
      base,
      fixedManagement({
        scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 1 }],
        trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
        trailAfterScaleOut: true,
      }),
    );
  if (methodId === "RK-D-target23")
    return withManagement(
      base,
      fixedManagement({
        scaleOut: [{ atR: 2, fraction: 1, raiseStopR: null }],
      }),
    );
  if (methodId === "RK-D-trend-exit")
    return withManagement(
      base,
      fixedManagement({
        trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
      }),
    );
  if (methodId === "RK-D-half-tail")
    return withManagement(
      base,
      fixedManagement({
        scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 1 }],
        trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
        trailAfterScaleOut: true,
      }),
    );
  if (methodId === "RK-A2-atr")
    return withManagement(
      base,
      fixedManagement({
        stop: { kind: "atr", period: 14, multiple: 2 },
      }),
    );
  if (methodId === "RK-A3-buffer" || methodId === "RK-A3-atr-buffer")
    return withManagement(
      base,
      fixedManagement({
        stop: { kind: "structure-atr", period: 14, multiple: 0.3 },
      }),
    );
  if (methodId === "RK-A-max-distance" || methodId === "RK-A-explicit")
    return withManagement(
      base,
      fixedManagement({
        stop: {
          kind: "max-distance",
          fraction: 0.05,
          period: 14,
          multiple: 2,
          structureBuffer: 0.3,
        },
      }),
    );
  if (methodId === "RK-A-buffer-auto")
    return withManagement(
      base,
      fixedManagement({
        stop: {
          kind: "nearest-stop",
          fraction: 0.05,
          period: 14,
          multiple: 2,
          structureBuffer: 0.3,
        },
      }),
    );
  if (methodId === "RK-A-breakout-upper")
    return withManagement(
      base,
      fixedManagement({ stop: { kind: "platform-upper", buffer: 0 } }),
    );
  if (methodId === "RK-A-breakout-candle")
    return withManagement(
      base,
      fixedManagement({ stop: { kind: "breakout-candle", buffer: 0 } }),
    );
  if (methodId === "RK-B-close")
    return withManagement(base, fixedManagement({ confirmations: 1 }));
  if (methodId === "RK-B-two-closes")
    return withManagement(base, fixedManagement({ confirmations: 2 }));
  if (methodId === "RK-C-stress")
    return withManagement(base, fixedManagement({ stressBuffer: 0.1 }));
  if (methodId === "RK-D2-breakeven")
    return withManagement(base, riskPresetTemplate("rk-be05"));
  if (methodId === "RK-D3-percent")
    return withManagement(
      base,
      fixedManagement({ stop: { kind: "percent", fraction: 0.03 } }),
    );
  if (methodId === "RK-D3-distance")
    return withManagement(base, riskPresetTemplate("rk-structure-farther"));
  if (methodId === "RK-D3-structure")
    return withManagement(base, riskPresetTemplate("rk-structure-trail"));
  if (methodId === "RK-D4-retracement")
    return withManagement(
      base,
      fixedManagement({ trail: { kind: "retracement" } }),
    );
  if (methodId === "RK-D5-time")
    return withManagement(base, riskPresetTemplate("sw-time5"));
  if (methodId === "RK-D6-partial")
    return withManagement(
      base,
      fixedManagement({ scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 1 }] }),
    );
  if (methodId === "RK-V1-chandelier" || methodId === "RK-V1-rolling-high")
    return withManagement(
      base,
      fixedManagement({
        trail: { kind: "rolling-chandelier", period: 22, multiple: 3 },
      }),
    );
  if (methodId === "RK-C-held-risk-repair" || inputOnlyByMethod[methodId])
    return withManagement(base, fixedManagement());
  return withManagement(base, fixedManagement());
}

function componentLabel(methodId: string) {
  const profile = riskPresetByMethod.get(methodId);
  if (profile) return `${methodId} / ${profile}`;
  if (volatilityByMethod[methodId])
    return `${methodId} / ${volatilityByMethod[methodId]}`;
  if (contextByMethod[methodId])
    return `${methodId} / ${contextByMethod[methodId]}`;
  return methodId;
}

export const researchCompositePresets: readonly ResearchCompositePreset[] = [
  ...researchCompositeMethodIds.map((methodId) => ({
    id: presetId(methodId),
    methodId,
    baseline: "dual-breakout" as const,
    component: componentLabel(methodId),
    ...(inputOnlyByMethod[methodId]
      ? { inputRequirement: inputOnlyByMethod[methodId] }
      : {}),
    build: (base: ResearchSpec) => buildPreset(methodId, base),
  })),
];

export const researchCompositePresetIds = researchCompositePresets.map(
  (preset) => preset.id,
);

const byId = new Map(
  researchCompositePresets.map((preset) => [preset.id, preset] as const),
);

export function findResearchCompositePreset(id: string) {
  return byId.get(id);
}

export function buildResearchCompositeSpec(id: string, base: ResearchSpec) {
  const preset = byId.get(id);
  if (!preset) throw new Error(`未知具名组合预设：${id}`);
  return preset.build(base);
}
