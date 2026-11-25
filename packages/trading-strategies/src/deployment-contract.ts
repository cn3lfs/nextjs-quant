import { z } from "zod";
import { etfRotationConfigSchema } from "./etf-rotation/catalog.js";
import { listTheoryScreenerSpecs } from "./screener/index.js";
import { studyStrategies } from "./study-catalog.js";
import { spotPairPresets } from "./theory-pair-switch.js";

export const deploymentMarkets = ["cn-equity", "crypto"] as const;
export type DeploymentMarket = (typeof deploymentMarkets)[number];
export const deploymentStatuses = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];
export const executionModes = [
  "shadow",
  "manual_confirm",
  "auto_sim",
  "auto_live",
] as const;
export type ExecutionMode = (typeof executionModes)[number];
export const pipelineTriggerKinds = ["scheduled", "manual"] as const;
export type PipelineTriggerKind = (typeof pipelineTriggerKinds)[number];
export const pipelineStages = [
  "pending",
  "universe_done",
  "signals_done",
  "risk_checked",
  "executing",
  "completed",
  "partial",
  "blocked",
  "failed",
] as const;
export type PipelineStage = (typeof pipelineStages)[number];
export const orderIntentStatuses = [
  "planned",
  "queued",
  "submitting",
  "submitted",
  "filled",
  "partial_filled",
  "rejected",
  "cancelled",
  "unknown_reconcile",
] as const;
export type OrderIntentStatus = (typeof orderIntentStatuses)[number];
export const simVenueKinds = ["local_sim", "ths_mock", "crypto_sim"] as const;
export type SimVenueKind = (typeof simVenueKinds)[number];
export const liveVenueKinds = ["cn_broker_live", "crypto_live"] as const;
export type LiveVenueKind = (typeof liveVenueKinds)[number];
export const executionVenueKinds = [
  ...simVenueKinds,
  ...liveVenueKinds,
] as const;
export type ExecutionVenueKind = (typeof executionVenueKinds)[number];

export const poolSyncModes = ["accumulate", "replace"] as const;
export type PoolSyncMode = (typeof poolSyncModes)[number];
export const poolEntryStatuses = ["watching", "evicted"] as const;
export type PoolEntryStatus = (typeof poolEntryStatuses)[number];
export const poolEntrySources = ["screener", "manual"] as const;
export type PoolEntrySource = (typeof poolEntrySources)[number];

const nonempty = z.string().min(1);
const numeric = z.number().finite();
const parameters = z.record(z.string(), numeric).optional();
const symbolSchema = z.string().trim().min(1);
const boundedInt = (min: number, max: number) =>
  z.number().int().min(min).max(max);
const minScore = boundedInt(1, 5).optional();
const scanLimit = boundedInt(1, 100).default(20);
const topCount = boundedInt(1, 50);
const periodEnd = z.enum(["month-end", "quarter-end"]).default("month-end");
const valueStrategyId = z.enum([
  "value-magic-formula-pit",
  "value-fscore-local8-pit",
  "value-dividend-lowvol-pit",
  "value-garp-pit",
]);
const [firstPair, ...otherPairs] = spotPairPresets;
const pairId = z.enum([firstPair.id, ...otherPairs.map((preset) => preset.id)]);
const screenerMethodId = nonempty.refine(
  (id) =>
    listTheoryScreenerSpecs().some(
      (spec) => spec.id === id && spec.direction !== "short",
    ),
  "Expected a registered screener that supports long positions",
);

export const deployableStrategySpecSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("study-rule"),
        strategyId: z
          .enum(studyStrategies)
          .refine((id) => id !== "hold", "Hold is a benchmark"),
        parameters,
      })
      .strict(),
    z
      .object({
        kind: z.literal("theory-screener"),
        methodId: screenerMethodId,
        holdBars: boundedInt(1, 250).default(25),
        minScore,
        useScreenerStops: z.boolean().default(true),
      })
      .strict(),
    z
      .object({
        kind: z.literal("etf-rotation"),
        config: etfRotationConfigSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("alpha-composite"),
        compositeId: nonempty,
        topN: topCount.default(10),
        rebalanceCadence: z
          .enum(["daily", "weekly", "month-end"])
          .default("weekly"),
      })
      .strict(),
    z
      .object({ kind: z.literal("macro-clock"), rebalanceCadence: periodEnd })
      .strict(),
    z
      .object({
        kind: z.literal("pair-switch"),
        pairId,
        lookback: boundedInt(20, 250).default(60),
        entryZ: numeric.default(1.5),
        exitZ: numeric.default(0.25),
      })
      .strict(),
    z
      .object({
        kind: z.literal("value-pit"),
        strategyId: valueStrategyId,
        topK: topCount.default(10),
        rebalanceCadence: periodEnd,
      })
      .strict(),
    z
      .object({
        kind: z.literal("formula"),
        name: nonempty,
        source: nonempty,
        parameters,
      })
      .strict(),
    z
      .object({
        kind: z.literal("double-breakout"),
        minVolumeRatio: numeric.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("chan-native"),
        profile: z.enum(["first", "second", "third", "hold-cash"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("crypto-dual-ma"),
        fast: boundedInt(2, 120),
        slow: boundedInt(3, 250),
        period: z.enum(["5m", "15m", "30m", "1h", "4h", "day"]),
      })
      .strict(),
    z
      .object({ kind: z.literal("multi-book"), preset: z.literal("core-4") })
      .strict(),
  ])
  .refine((spec) => spec.kind !== "crypto-dual-ma" || spec.fast < spec.slow, {
    path: ["fast"],
    message: "Fast window must be shorter than slow window",
  });
export type DeployableStrategySpec = z.infer<
  typeof deployableStrategySpecSchema
>;

export const universeSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fixed-symbols"),
      symbols: z
        .array(symbolSchema)
        .min(1)
        .max(200)
        .refine(
          (symbols) =>
            new Set(symbols.map((symbol) => symbol.toUpperCase())).size ===
            symbols.length,
          "Expected unique symbols",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("watchlist"),
      maxSymbols: boundedInt(1, 200).default(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("etf-pool"),
      pool: z
        .enum(["full", "legacy-long-history", "pair-only"])
        .default("full"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rps-filter"),
      period: z.union([
        z.literal(10),
        z.literal(20),
        z.literal(50),
        z.literal(120),
      ]),
      minRps: numeric.min(0).max(100),
      maxSymbols: scanLimit,
    })
    .strict(),
  z
    .object({
      kind: z.literal("formula-screen"),
      formulaName: nonempty,
      source: nonempty,
      parameters,
      maxSymbols: scanLimit,
    })
    .strict(),
  z
    .object({
      kind: z.literal("theory-screener-scan"),
      methodId: screenerMethodId,
      minScore,
      maxSymbols: scanLimit,
    })
    .strict(),
  z
    .object({
      kind: z.literal("value-pit-topn"),
      strategyId: valueStrategyId,
      baseSymbols: z.array(symbolSchema).max(500).optional(),
      topK: topCount.default(15),
    })
    .strict(),
]);
export type UniverseSpec = z.infer<typeof universeSpecSchema>;

export const poolEvictionRuleSchema = z
  .object({
    maxConsecutiveMissedDays: boundedInt(0, 60).default(5),
    hardEvictBelowMaDays: boundedInt(5, 250).nullable().default(null),
    hardEvictMaxDrawdownPct: numeric.gt(0).lt(0.95).nullable().default(null),
    maxPoolSize: boundedInt(1, 500).default(50),
    maxWatchDays: boundedInt(1, 365).nullable().default(null),
  })
  .strict();
export type PoolEvictionRule = z.infer<typeof poolEvictionRuleSchema>;

export const poolPolicySchema = z
  .object({
    mode: z.enum(poolSyncModes).default("accumulate"),
    eviction: poolEvictionRuleSchema.default({}),
  })
  .strict();
export type PoolPolicy = z.infer<typeof poolPolicySchema>;

export const poolSyncSnapshotSchema = z
  .object({
    asOf: z.string().date(),
    mode: z.enum(poolSyncModes),
    sourceHash: nonempty,
    matchedCount: z.number().int().nonnegative(),
    activePoolCount: z.number().int().nonnegative(),
    added: z.array(
      z
        .object({
          symbol: symbolSchema,
          reason: z.string(),
          score: numeric.nullable().default(null),
          price: numeric.positive().nullable().default(null),
        })
        .strict(),
    ),
    retained: z.array(symbolSchema),
    missedGrace: z.array(
      z
        .object({
          symbol: symbolSchema,
          consecutiveMissedDays: z.number().int().positive(),
        })
        .strict(),
    ),
    evicted: z.array(
      z.object({ symbol: symbolSchema, reason: z.string() }).strict(),
    ),
    activeSymbols: z.array(symbolSchema),
  })
  .strict()
  .superRefine(({ activePoolCount, activeSymbols, evicted }, ctx) => {
    if (activePoolCount !== activeSymbols.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activePoolCount"],
        message: "Active pool count must match the number of active symbols",
      });
    }
    const active = new Set(activeSymbols.map((symbol) => symbol.toUpperCase()));
    if (active.size !== activeSymbols.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeSymbols"],
        message: "Active symbols must be unique",
      });
    }
    evicted.forEach(({ symbol }, index) => {
      if (active.has(symbol.toUpperCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evicted", index, "symbol"],
          message: "An evicted symbol cannot also be active",
        });
      }
    });
  });
export type PoolSyncSnapshot = z.infer<typeof poolSyncSnapshotSchema>;

export const regimeGateSpecSchema = z
  .object({
    kind: z.enum([
      "none",
      "oneil-market-direction",
      "dow-dual-index",
      "sentiment-regime",
      "macro-clock-filter",
    ]),
    benchmark: nonempty.default("sh000300"),
    secondaryBenchmark: nonempty.optional(),
    unlockAvoidanceDays: boundedInt(0, 30).default(10),
  })
  .strict();
export type RegimeGateSpec = z.infer<typeof regimeGateSpecSchema>;

const fraction = numeric.positive().max(1);
export const deploymentRiskPolicySchema = z
  .object({
    maxSymbolWeight: fraction.default(0.2),
    maxTotalExposure: fraction.default(0.95),
    maxDailyOrders: boundedInt(1, 100).default(20),
    maxDailyTurnover: numeric.positive().max(2).default(1),
    maxGapPct: numeric.min(0.005).max(0.2).default(0.02),
    drawdownPausePct: numeric.positive().max(0.5).default(0.08),
    maxConsecutiveFailures: boundedInt(1, 10).default(3),
  })
  .strict();
export type DeploymentRiskPolicy = z.infer<typeof deploymentRiskPolicySchema>;

const cryptoVenue = z.enum(["binance", "okx", "bybit"]);
const brokerEndpointUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "Broker endpoint must be an HTTP(S) URL without credentials, query or fragment");

export const venueBindingSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("local_sim"), simAccountId: nonempty }).strict(),
    z
      .object({ kind: z.literal("ths_mock"), accountTag: z.literal("default") })
      .strict(),
    z
      .object({
        kind: z.literal("crypto_sim"),
        venue: cryptoVenue,
        accountId: nonempty,
      })
      .strict(),
    z
      .object({
        kind: z.literal("cn_broker_live"),
        broker: z.enum(["qmt", "ptrade", "xtquant", "ths_live", "http_bridge"]),
        accountId: nonempty,
        endpointUrl: brokerEndpointUrl.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("crypto_live"),
        venue: cryptoVenue,
        accountId: nonempty,
      })
      .strict(),
  ])
  .superRefine((binding, ctx) => {
    if (
      binding.kind !== "cn_broker_live" ||
      binding.broker !== "ths_live" ||
      !binding.endpointUrl
    )
      return;
    const endpoint = binding.endpointUrl;
    if (!URL.canParse(endpoint)) return; // brokerEndpointUrl reports malformed URLs.
    const url = new URL(endpoint);
    if (
      !/^https?:\/\//i.test(endpoint) ||
      /[?#\\\s]/.test(endpoint) ||
      (url.protocol === "http:" &&
        !["127.0.0.1", "localhost"].includes(url.hostname))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endpointUrl"],
        message:
          "同花顺实盘桥接仅支持 HTTPS 或本机 HTTP 地址，且不能含查询参数或片段",
      });
    }
  });
export type VenueBinding = z.infer<typeof venueBindingSchema>;

export function isLiveVenueKind(
  kind: ExecutionVenueKind,
): kind is LiveVenueKind {
  return liveVenueKinds.some((liveKind) => liveKind === kind);
}

const venueMarkets = {
  local_sim: "cn-equity",
  ths_mock: "cn-equity",
  cn_broker_live: "cn-equity",
  crypto_sim: "crypto",
  crypto_live: "crypto",
} as const satisfies Record<ExecutionVenueKind, DeploymentMarket>;

export function isVenueCompatibleWithMarket(
  market: DeploymentMarket,
  venueKind: ExecutionVenueKind,
): boolean {
  return venueMarkets[venueKind] === market;
}

export function isExecutionModeCompatibleWithVenue(
  mode: ExecutionMode,
  venueKind: ExecutionVenueKind,
): boolean {
  switch (mode) {
    case "auto_sim":
      return !isLiveVenueKind(venueKind);
    case "auto_live":
      return isLiveVenueKind(venueKind);
    case "shadow":
    case "manual_confirm":
      return true;
  }
}

/** Account identity is scoped to its venue kind and provider, independent of endpoint. */
export function extractVenueAccountKey(binding: VenueBinding): string {
  switch (binding.kind) {
    case "local_sim":
      return `${binding.kind}:${binding.simAccountId}`;
    case "ths_mock":
      return `${binding.kind}:${binding.accountTag}`;
    case "cn_broker_live":
      return `${binding.kind}:${binding.broker}:${binding.accountId}`;
    case "crypto_sim":
    case "crypto_live":
      return `${binding.kind}:${binding.venue}:${binding.accountId}`;
  }
}

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const deploymentScheduleSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("post_close_auto"),
        runSignalsAfterClose: z.boolean().default(true),
        executeAtOpen: z.boolean().default(true),
        openStartTime: time.default("09:31"),
        openCutoffTime: time.default("14:55"),
      })
      .strict(),
    z.object({ kind: z.literal("manual_only") }).strict(),
    z
      .object({
        kind: z.literal("crypto_interval"),
        intervalMinutes: z.union([
          z.literal(5),
          z.literal(15),
          z.literal(30),
          z.literal(60),
          z.literal(240),
          z.literal(1440),
        ]),
      })
      .strict(),
  ])
  .superRefine((schedule, ctx) => {
    if (
      schedule.kind === "post_close_auto" &&
      schedule.openCutoffTime < schedule.openStartTime
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openCutoffTime"],
        message: "Open cutoff time must be at or after open start time",
      });
    }
  });
export type DeploymentSchedule = z.infer<typeof deploymentScheduleSchema>;

export const deploymentProvenanceSchema = z
  .object({
    sourceKind: z.enum([
      "lab-backtest",
      "alpha-lab",
      "scan",
      "macro-panel",
      "manual",
    ]),
    sourceRefId: nonempty.nullable().default(null),
    buildHash: nonempty.nullable().default(null),
    createdFromRoute: nonempty.default("/"),
    note: z.string().max(500).default(""),
  })
  .strict();
export type DeploymentProvenance = z.infer<typeof deploymentProvenanceSchema>;

export const strategyTargetProposalSchema = z
  .object({
    mode: z.enum(["target-weights", "delta-signals"]),
    asOf: z.string().date(),
    targets: z.record(nonempty, numeric.min(0).max(1)),
    signals: z.array(
      z
        .object({
          symbol: symbolSchema,
          action: z.enum(["BUY", "SELL", "HOLD"]),
          score: numeric.nullable(),
          stopPrice: numeric.nullable(),
          targetPrice: numeric.nullable(),
          reason: z.string(),
        })
        .strict(),
    ),
    regimeScale: numeric.nullable(),
    disclosure: z.string(),
  })
  .strict();
export type StrategyTargetProposal = z.infer<
  typeof strategyTargetProposalSchema
>;

const intentTransitions: Record<
  OrderIntentStatus,
  readonly OrderIntentStatus[]
> = {
  planned: ["queued", "submitting", "cancelled", "rejected"],
  queued: ["submitting", "cancelled", "rejected"],
  submitting: [
    "submitted",
    "filled",
    "partial_filled",
    "rejected",
    "unknown_reconcile",
  ],
  submitted: [
    "filled",
    "partial_filled",
    "rejected",
    "cancelled",
    "unknown_reconcile",
  ],
  partial_filled: ["filled", "cancelled", "rejected", "unknown_reconcile"],
  unknown_reconcile: [
    "submitted",
    "filled",
    "partial_filled",
    "rejected",
    "cancelled",
  ],
  filled: [],
  rejected: [],
  cancelled: [],
};

export function isTerminalIntentStatus(status: OrderIntentStatus): boolean {
  return intentTransitions[status].length === 0;
}

export function canTransitionIntentStatus(
  from: OrderIntentStatus,
  to: OrderIntentStatus,
): boolean {
  return intentTransitions[from].includes(to);
}

/** The deployment ID is case-sensitive. Tuple encoding preserves field boundaries. */
export function buildIntentIdempotencyKey(input: {
  deploymentId: string;
  decisionDate: string;
  executeDate: string;
  symbol: string;
  side: string;
  phase: string;
  runSlot?: string;
}): string {
  const fields = [
    input.deploymentId.trim(),
    input.decisionDate.trim(),
    input.executeDate.trim(),
    input.symbol.trim().toUpperCase(),
    input.side.trim().toUpperCase(),
    input.phase.trim().toLowerCase(),
  ];
  const runSlot = input.runSlot?.trim() ?? "daily";
  if (runSlot !== "daily") fields.push(runSlot);
  return JSON.stringify(fields);
}
