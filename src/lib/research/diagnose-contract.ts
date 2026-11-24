import { z } from "zod";
import { isAShareStockSymbol } from "~/lib/market/security-classification";
import {
  nativeStudyDefinition,
  studyStrategies,
  wyckoffStudyBindings,
  type StrategyObjectInput,
} from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { researchCostScenarios } from "trading-strategy-core/costs";

export const diagnoseScenarioIdSchema = z.enum([
  "strict",
  "clamp",
  "cap-0.5-clip",
]);
export type DiagnoseScenarioId = z.infer<typeof diagnoseScenarioIdSchema>;
export type DiagnoseChartContext = {
  archiveId: string;
  cellId?: string;
  scenarioId?: DiagnoseScenarioId;
  defaultSymbol?: string;
};

export const DIAGNOSE_SCENARIO_PRESETS = {
  strict: { id: "strict", label: "Strict 基线", executionProfile: "strict" },
  clamp: { id: "clamp", label: "Clamp 滑点钳位", executionProfile: "clamp" },
  "cap-0.5-clip": {
    id: "cap-0.5-clip",
    label: "0.5% 容量裁剪",
    executionProfile: "strict",
    maxParticipation: 0.005,
    capacityPolicy: "clip",
  },
} as const satisfies Record<
  DiagnoseScenarioId,
  {
    id: DiagnoseScenarioId;
    label: string;
    executionProfile: "strict" | "clamp";
    maxParticipation?: number;
    capacityPolicy?: "clip";
  }
>;

export const diagnoseCheckStatusSchema = z.enum([
  "pass",
  "warn",
  "fail",
  "not-evaluated",
  "blocked",
]);
export type DiagnoseCheckStatus = z.infer<typeof diagnoseCheckStatusSchema>;
export type DiagnoseCheckMetadata = {
  group: "数据与价格基" | "信号与因果性" | "撮合与费用" | "账本与对账";
  label: string;
  /** False indicates a boundary on interpretation, never certification of a strategy. */
  engineeringOnly: boolean;
};

/** The fifteen routine checks, in display order within each group. */
export const DIAGNOSE_CHECK_GROUPS = {
  dataQuality: {
    group: "数据与价格基",
    label: "来源与数据质量",
    engineeringOnly: false,
  },
  corporateActionDates: {
    group: "数据与价格基",
    label: "公司行动日期",
    engineeringOnly: true,
  },
  priceBasisChangeWithoutAction: {
    group: "数据与价格基",
    label: "无公司行动的价格基变化",
    engineeringOnly: true,
  },
  signalCount: {
    group: "信号与因果性",
    label: "窗口内规则信号数",
    engineeringOnly: false,
  },
  fillAfterSignal: {
    group: "信号与因果性",
    label: "信号与成交先后顺序",
    engineeringOnly: true,
  },
  fillOrderMatch: {
    group: "撮合与费用",
    label: "成交对应委托",
    engineeringOnly: true,
  },
  orderFillConservation: {
    group: "撮合与费用",
    label: "委托与成交数量守恒",
    engineeringOnly: true,
  },
  orderFillCardinality: {
    group: "撮合与费用",
    label: "委托状态与成交笔数",
    engineeringOnly: true,
  },
  noDuplicateFill: {
    group: "撮合与费用",
    label: "重复成交",
    engineeringOnly: true,
  },
  fillPriceWithinBar: {
    group: "撮合与费用",
    label: "成交价与当日价格区间",
    engineeringOnly: true,
  },
  feeMatches: {
    group: "撮合与费用",
    label: "交易费用复算",
    engineeringOnly: true,
  },
  capacityRatio: {
    group: "撮合与费用",
    label: "成交额参与率",
    engineeringOnly: false,
  },
  cashNonNegative: {
    group: "账本与对账",
    label: "现金余额非负",
    engineeringOnly: true,
  },
  equityIdentity: {
    group: "账本与对账",
    label: "资产净值恒等式",
    engineeringOnly: true,
  },
  ledgerReconcile: {
    group: "账本与对账",
    label: "成交与账本对账",
    engineeringOnly: true,
  },
} as const satisfies Record<string, DiagnoseCheckMetadata>;

/** Emitted only when the named condition occurs. Absence is not a passing check. */
export const DIAGNOSE_CONDITIONAL_CHECK_GROUPS = {
  signalsToFills: {
    group: "信号与因果性",
    label: "有信号但无成交",
    engineeringOnly: false,
  },
  ordersToFills: {
    group: "撮合与费用",
    label: "有委托但无成交",
    engineeringOnly: false,
  },
  priceBasisAnchor: {
    group: "数据与价格基",
    label: "价格基锚点",
    engineeringOnly: false,
  },
  ledgerReconcileUnavailable: {
    group: "账本与对账",
    label: "缺少对账依据",
    engineeringOnly: true,
  },
  cellError: {
    group: "数据与价格基",
    label: "诊断单元未完成",
    engineeringOnly: true,
  },
} as const satisfies Record<string, DiagnoseCheckMetadata>;

export const DIAGNOSE_SAMPLE_LIMIT = 50;
const count = z.number().int().nonnegative();
const numeric = z.number().finite();
const symbolPattern = /^(sh|sz|bj)\d{6}$/;
const symbolSchema = z.string().regex(symbolPattern);
const sourceSchema = z.enum(["lab-archive", "cli-report"]);
const textList = z.array(z.string());
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

export function isDiagnosticOnlyStrategyKey(key: string): boolean {
  return (
    [
      "core-4",
      "research-wy-sow-lpsy",
      "wy-trend-pullback-confirm-vol10-diagnostic",
    ].includes(key) ||
    [
      "research-chan",
      "research-canslim-pit",
      "research-sepa-pit",
      "research-sepa-vcp-close",
    ].some((family) => key === family || key.startsWith(family + "-"))
  );
}

const bookPresetSchema = z.literal("core-4");
// Account-state studies have no standalone diagnostic signal rule.
const accountStudies = new Set([
  "ma",
  "breakout",
  "pullback",
  "range",
  "grid",
  "hold80",
  "vol-target",
  "constant-mix",
  "cppi",
  "dca",
]);
const sleeveStrategyKeys = new Set<string>([
  ...studyStrategies.filter((key) => !accountStudies.has(key)),
  "dual-ma",
  "double-breakout",
  "formula",
  wyckoffStudyBindings["research-wy-lps-protected"],
  wyckoffStudyBindings["research-wy-reaccumulation-protected"],
  wyckoffStudyBindings["research-wy-trend-pullback-protected"],
  "research-chan",
  "research-chan-first",
  "research-chan-second",
  "research-chan-third",
  "research-chan-hold-cash",
  "research-chan-hold-cash-zd-stop",
  "research-chan-hold-cash-zd-atr",
  "research-chan-ch04",
  "research-chan-ch07",
  "research-chan-ch12",
  "research-canslim-pit",
  "research-canslim-pit-m",
  "research-canslim-pit-stop8",
  "research-canslim-pit-stop7",
  "research-canslim-pit-ma50",
  "research-canslim-pit-ma20",
  "research-sepa-pit",
  "research-sepa-pit-m",
  "research-sepa-pit-stop8",
  "research-sepa-pit-ma50",
  "research-sepa-vcp-close-price",
  "research-sepa-vcp-close-pit",
  "research-sepa-vcp-close-pit-strict-finance",
]);
const sleeveSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[\p{L}\p{N}_-]+$/u),
    strategyKey: z
      .string()
      .trim()
      .refine((key) => sleeveStrategyKeys.has(key), "未知诊断策略"),
    share: numeric.positive(),
  })
  .strict();
export type DiagnoseBookSleeve = z.infer<typeof sleeveSchema>;
const customSleeves = z
  .array(sleeveSchema)
  .min(2)
  .max(6)
  .refine((rows) => unique(rows.map((row) => row.id)), "分仓 ID 重复")
  .transform((rows) =>
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  )
  .refine(
    (rows) =>
      Math.abs(rows.reduce((sum, row) => sum + row.share, 0) - 1) <= 1e-9,
    "分仓权重之和须为 1",
  );
export const diagnoseBookInputSchema = z.union([
  bookPresetSchema,
  z.object({ preset: bookPresetSchema }).strict(),
  z.object({ sleeves: customSleeves }).strict(),
]);
export type DiagnoseBookInput = z.input<typeof diagnoseBookInputSchema>;
export function normalizeDiagnoseBookInput(book: DiagnoseBookInput) {
  const parsed = diagnoseBookInputSchema.parse(book);
  return typeof parsed === "string" ? { preset: parsed } : parsed;
}
export function customBookId(sleeves: readonly DiagnoseBookSleeve[]): string {
  const definitions = customSleeves
    .parse(sleeves)
    .map(({ id, strategyKey, share }) => [id, strategyKey, share]);
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(JSON.stringify(definitions)))
    hash = Math.imul(hash ^ byte, 0x01000193);
  return `custom-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
const runFields = z
  .object({
    symbols: z.array(symbolSchema).min(1).max(12).refine(unique, "标的重复"),
    mode: z.enum(["per-symbol", "portfolio"]).optional(),
    strategyKey: z.string().trim().min(1).max(100).optional(),
    bookPreset: bookPresetSchema.optional(),
    book: diagnoseBookInputSchema.optional(),
    includeHoldout: z.boolean().default(false),
    holdoutStart: researchDateSchema.optional(),
    start: z.union([z.literal("auto"), researchDateSchema]),
    end: researchDateSchema,
    initial: numeric.positive().max(1e9),
    costScenario: z.enum(researchCostScenarios),
    scenarios: z
      .array(diagnoseScenarioIdSchema)
      .min(1)
      .max(3)
      .refine(unique, "执行情景重复"),
  })
  .strict();
export const diagnoseArchiveRunSchema = runFields.extend({
  strategies: textList,
  family: z.string().min(1).optional(),
});
export type DiagnoseArchiveRun = z.infer<typeof diagnoseArchiveRunSchema>;
export const labDiagnoseRunInputSchema = runFields
  .extend({ confirmed: z.literal(true), strategies: textList.optional() })
  .refine(
    (v) => v.start === "auto" || v.start < v.end,
    "开始日期须早于结束日期",
  )
  .transform((v, ctx) => {
    const rawBook = v.book ?? v.bookPreset;
    const book = rawBook && normalizeDiagnoseBookInput(rawBook);
    if (book && "sleeves" in book && v.bookPreset) {
      ctx.addIssue({
        code: "custom",
        path: ["book"],
        message: "自定义组合与预设互斥",
      });
      return z.NEVER;
    }
    const strategyKey = book
      ? "preset" in book
        ? book.preset
        : customBookId(book.sleeves)
      : v.strategyKey;
    if (!strategyKey || (strategyKey === "core-4" && !book)) {
      ctx.addIssue({
        code: "custom",
        path: ["strategyKey"],
        message: "请选择诊断策略，四策略组合须指定 bookPreset",
      });
      return z.NEVER;
    }
    if (book && v.mode === "per-symbol") {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: "分仓组合须使用组合模式",
      });
      return z.NEVER;
    }
    const holdoutStart =
      v.holdoutStart ?? (v.includeHoldout ? "2023-01-01" : undefined);
    if (
      holdoutStart &&
      ((v.start !== "auto" && holdoutStart <= v.start) || holdoutStart > v.end)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["holdoutStart"],
        message: "留出切点须晚于开始日期且不晚于结束日期",
      });
      return z.NEVER;
    }
    return {
      ...v,
      book,
      bookPreset: book && "preset" in book ? book.preset : undefined,
      strategyKey,
      mode: book ? ("portfolio" as const) : v.mode,
      holdoutStart,
    };
  });
export type LabDiagnoseRunInput = z.input<typeof labDiagnoseRunInputSchema>;

const page = z.number().int().positive().max(1_000_000);
const pageSize = z.number().int().positive().max(50);
export const diagnoseArchivesInputSchema = z
  .object({
    source: sourceSchema.optional(),
    strategyKey: z.string().min(1).max(100).optional(),
    symbol: symbolSchema.optional(),
    page: page.optional(),
    pageSize: pageSize.optional(),
  })
  .strict()
  .optional();
export const diagnoseArchiveDetailInputSchema = z
  .object({
    id: z.string().min(1).max(4096),
    page: page.optional(),
    pageSize: pageSize.optional(),
  })
  .strict();
export const diagnoseResultInputSchema = z
  .object({ jobId: z.string().min(1).max(200) })
  .strict();
export const diagnoseCompareInputSchema = z
  .object({
    leftId: z.string().min(1).max(4096),
    rightId: z.string().min(1).max(4096),
  })
  .strict()
  .refine((v) => v.leftId !== v.rightId, "请选择两份不同的诊断归档进行对比");
export type DiagnoseCompareInput = z.infer<typeof diagnoseCompareInputSchema>;

export const diagnoseCountsSchema = z.object({
  bars: count,
  warmup: count,
  signals: count,
  orders: count,
  fills: count,
  rejections: count,
  closedTrades: count,
  capacityClippedFills: count.optional(),
});
export type DiagnoseCounts = z.infer<typeof diagnoseCountsSchema>;
export const diagnoseCheckSchema = z.object({
  id: z.string().min(1),
  status: diagnoseCheckStatusSchema,
  message: z.string(),
  evidence: z.unknown().optional(),
});
export type DiagnoseCheck = z.infer<typeof diagnoseCheckSchema>;

const dateRange = z.tuple([z.string(), z.string()]).nullable();
const growthPit = z.object({
  ruleId: z.string().optional(),
  strategyKey: z.string().optional(),
  symbol: z.string(),
  strictReportCount: count,
  reportDateRange: dateRange,
  qualifiedDays: count,
  missingDays: count,
  conflictDays: count,
  priceSignalCount: count,
  pitFilteredSignalCount: count,
  sourceIssuesCount: count,
  boundary: z.string(),
  checkCoverage: z
    .record(
      z.object({
        computed: count,
        missing: count,
        conflict: count,
        passed: count,
        marginalPassRate: numeric.nullable(),
      }),
    )
    .optional(),
  sepaPit: z
    .object({
      strictReportCount: count,
      reportDateRange: dateRange,
      strictPassDays: count,
      tolerantPassDays: count,
      incompleteDays: count,
      failedDays: count,
      boundary: z.string(),
    })
    .optional(),
  marketRegime: z
    .object({
      symbol: z.string(),
      source: z.string(),
      inputHash: z.string(),
      latestIndexDate: z.string().nullish(),
      allowedDays: count,
      blockedDays: count,
      unknownDays: count,
      boundary: z.string(),
    })
    .optional(),
  exitAblation: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("5-bar") }),
      z.object({ kind: z.literal("fixed-stop"), fraction: numeric }),
      z.object({ kind: z.literal("ma-close-breakdown"), period: count }),
    ])
    .optional(),
  exitSuppressedEntrySignals: count.optional(),
  funnel: z
    .object({
      priceSignals: count,
      trendVcpSignals: count,
      pitFinanceSignals: count,
      marketRegimeSignals: count,
      strictPitFinanceSignals: count.optional(),
      tolerantPitFinanceSignals: count.optional(),
    })
    .optional(),
  duplicateIssues: z
    .array(
      z.object({
        message: z.string(),
        file: z.string().optional(),
        code: z.string().optional(),
        symbol: z.string().optional(),
        reportDate: z.string().optional(),
        recordOffsets: z.array(count).optional(),
      }),
    )
    .optional(),
});

const nativeChan = z.object({
  strategyKey: z.string().optional(),
  symbol: z.string(),
  identity: z.object({
    dllHash: z.string(),
    apiVersion: count,
    buildCommit: z.string(),
    configId: z.string(),
    config: count,
    anchor: count,
  }),
  originDate: z.string(),
  baselineDate: z.string(),
  firstIndex: count,
  prefixCount: count,
  captureElapsedMs: numeric,
  cacheLoadMs: numeric.nullish(),
  auditCount: count,
  pendingCount: count,
  signalPriceBasis: z.string().nullable(),
  cached: z.boolean(),
  projectionVersion: count.optional(),
  dllHash: z.string().optional(),
  mode: z.enum(["frozen-replay", "current-dll-compute"]).optional(),
  captureMetricsAvailable: z.boolean().optional(),
});
export const diagnoseWyckoffNextDayBreakdownSchema = z
  .object({
    candidatesWithNextBar: count,
    holdCandidateLow: count,
    closeAboveCandidateHigh: count,
    volumeGe15xMean20: count,
    volumeGe10xMean20: count,
    validNextBarNoReason: count,
    holdAndCloseAboveHigh: count,
    allFourConfirmed: count,
  })
  .strict();
export type DiagnoseWyckoffNextDayBreakdown = z.infer<
  typeof diagnoseWyckoffNextDayBreakdownSchema
>;
const wyckoffFunnel = z.object({
  symbol: z.string(),
  parentEvents: count,
  pullbackShrinkage: count,
  candidates: count,
  nextDayVolumeConfirm: count,
  entrySignals: count,
  parentConfirmations: count,
  carryInCandidates: count,
  buyOrders: count,
  buyFills: count,
  nextDayBreakdown: diagnoseWyckoffNextDayBreakdownSchema.optional(),
  boundary: z.string(),
});
export type DiagnoseNativeChanDisclosure = z.infer<typeof nativeChan>;
export type DiagnoseGrowthPitDisclosure = z.infer<typeof growthPit>;
export type DiagnoseWyckoffFunnel = z.infer<typeof wyckoffFunnel>;

const nullableMetric = numeric.nullable();
const reviewRange = z
  .object({ start: researchDateSchema, end: researchDateSchema })
  .strict();
const devLeg = z
  .object({
    meanReturn: nullableMetric,
    meanSharpe: nullableMetric,
    worstDrawdown: nullableMetric,
    trades: count,
  })
  .strict();
const holdoutLeg = z
  .object({
    return: nullableMetric,
    excess: nullableMetric,
    drawdown: nullableMetric,
    sharpe: nullableMetric,
    calmar: nullableMetric.optional(),
    benchmarkCalmar: nullableMetric.optional(),
    calmarDifference: nullableMetric.optional(),
    trades: count,
    fees: numeric,
  })
  .strict();
const holdoutMetadata = z
  .object({
    classification: z.literal("historical-holdout-review"),
    disclosure: z.string(),
    holdoutStart: researchDateSchema,
    reasons: textList,
    statistics: z
      .object({
        dsr: nullableMetric,
        dsrThreshold: z.literal(0.95),
        pbo: nullableMetric,
        effectiveTrials: count.positive(),
        note: z.string(),
      })
      .strict(),
    passed: z.boolean(),
  })
  .strict();
export const diagnoseTimeHoldoutSchema = z.discriminatedUnion("status", [
  holdoutMetadata.extend({
    status: z.literal("insufficient"),
    devWindowRange: z.null(),
    devSummary: z.null(),
    holdoutRange: reviewRange.nullable(),
    holdout: z.null(),
  }),
  holdoutMetadata.extend({
    status: z.literal("reviewed"),
    devWindowRange: reviewRange.extend({ windowCount: count }),
    devSummary: z
      .object({
        windowCount: count,
        positiveWindows: count,
        base: devLeg,
        doubledCost: devLeg,
        delayed: devLeg,
      })
      .strict(),
    holdoutRange: reviewRange,
    holdout: z
      .object({
        base: holdoutLeg,
        doubledCost: holdoutLeg,
        delayed: holdoutLeg,
      })
      .strict(),
  }),
]);
export type DiagnoseTimeHoldoutResult = z.infer<
  typeof diagnoseTimeHoldoutSchema
>;

export const diagnoseSleeveAttributionSchema = z
  .object({
    sleeves: z.array(
      z
        .object({
          id: z.string(),
          initialEquity: numeric,
          finalEquity: numeric,
          return: nullableMetric,
          maxDrawdown: numeric,
          trades: count,
          averageWeight: nullableMetric,
          drawdownContribution: numeric,
        })
        .strict(),
    ),
    correlations: z.array(
      z
        .object({
          left: z.string(),
          right: z.string(),
          overlap: count,
          correlation: nullableMetric,
          reason: z.string().nullable(),
        })
        .strict(),
    ),
    peakDate: researchDateSchema,
    troughDate: researchDateSchema,
    peakEquity: numeric,
    troughEquity: numeric,
    maxDrawdown: numeric,
    contributionSum: numeric,
    transferBasis: z.string(),
  })
  .strict();
export type SleeveAttribution = z.infer<typeof diagnoseSleeveAttributionSchema>;

export const diagnoseSleeveInvestmentSchema = z.object({
  sleeves: z.array(
    z.object({
      id: z.string(),
      investmentReturn: nullableMetric,
      investmentMaxDrawdown: nullableMetric,
      tradingPnlContribution: numeric,
      dailyInvestmentReturns: z.array(
        z.object({
          date: researchDateSchema,
          return: nullableMetric,
          invested: z.boolean(),
        }),
      ),
    }),
  ),
  correlations: z.array(
    z.intersection(
      z.object({ left: z.string(), right: z.string(), overlap: count }),
      z.union([
        z.object({ correlation: numeric, reason: z.null() }),
        z.object({ correlation: z.null(), reason: z.string() }),
      ]),
    ),
  ),
});
const tradeMetrics = z.object({
  roundTrips: count,
  winRate: nullableMetric,
  profitLossRatio: nullableMetric,
  profitFactor: nullableMetric,
  holdingPeriod: z.object({
    p25: nullableMetric,
    p50: nullableMetric,
    p75: nullableMetric,
    p90: nullableMetric,
  }),
  cashRatio: nullableMetric,
  oneSidedTurnover: nullableMetric,
  costs: z.object({
    commission: numeric,
    stampDuty: numeric,
    transferFee: numeric,
    slippage: nullableMetric,
    slippageMissingFills: count,
    totalFees: numeric,
  }),
});
export const diagnoseSleeveTradesSchema = z.object({
  portfolio: tradeMetrics,
  sleeves: z.array(tradeMetrics.extend({ id: z.string() })),
});
export const diagnoseSuspensionSummarySchema = z.object({
  symbolSuspensionDays: count,
  portfolioAffectedDays: count,
  unknownDays: count.optional(),
});
const provenance = z.object({
  symbol: z.string(),
  sourcePath: z.string(),
  sourceSha256: z.string(),
  effectiveDate: researchDateSchema,
  knownAt: z.string().nullable(),
});
export const diagnoseSessionEvidenceSchema =
  diagnoseSuspensionSummarySchema.extend({
    certificates: z.array(
      z.object({
        symbol: z.string(),
        date: researchDateSchema,
        resumptionDate: researchDateSchema,
        sources: z.array(
          z.discriminatedUnion("kind", [
            provenance.extend({
              kind: z.literal("GP29"),
              offset: count,
              suspendedSessions: count,
            }),
            provenance.extend({
              kind: z.literal("announcement"),
              throughDate: researchDateSchema,
              recordId: z.string(),
            }),
          ]),
        ),
      }),
    ),
  });
export const diagnoseFamilyHoldoutSchema = z.object({
  family: z.string(),
  pbo: nullableMetric,
  effectiveTrials: count,
  rawCandidateCount: count,
  clusters: z.array(textList),
  excluded: z.array(z.object({ id: z.string(), reason: z.string() })),
  dsr: nullableMetric,
  dsrThreshold: numeric,
  note: z.string().optional(),
  devOosDays: count.optional(),
  combinations: count.optional(),
  discardedCscvDays: count.optional(),
  includedCandidateIds: textList.optional(),
  dsrCandidateId: z.string().optional(),
  pboReason: z.string().nullish(),
  dsrReason: z.string().nullish(),
  pboBasis: z.string().optional(),
});
export type DiagnoseSleeveInvestment = z.infer<
  typeof diagnoseSleeveInvestmentSchema
>;
export type DiagnoseSleeveTrades = z.infer<typeof diagnoseSleeveTradesSchema>;
export type DiagnoseFamilyHoldout = z.infer<typeof diagnoseFamilyHoldoutSchema>;
export type DiagnoseSuspensionSummary = z.infer<
  typeof diagnoseSuspensionSummarySchema
>;
export type DiagnoseSessionEvidence = z.infer<
  typeof diagnoseSessionEvidenceSchema
>;

const tradeIdentity = z.object({
  symbol: z.string(),
  strategyId: z.string(),
  sleeve: z.string(),
  side: z.enum(["buy", "sell"]),
  signalAt: z.string(),
});
export const diagnoseSampleOrderSchema = tradeIdentity.extend({
  id: count,
  due: z.string().nullable(),
  status: z.enum(["pending", "filled", "rejected"]),
  reason: z.string().nullable(),
  attempts: count,
  trigger: z.enum(["signal", "stop", "target", "trailing", "time"]),
  capacityClipped: z.boolean().optional(),
  rankScore: numeric.optional(),
  weightCeiling: numeric.optional(),
  targetWeight: numeric.optional(),
  targetSourceHash: z.string().optional(),
  industries: z.record(textList).optional(),
  riskGroups: z.array(textList).optional(),
  marketTargetShare: numeric.optional(),
});
export const diagnoseSampleFillSchema = tradeIdentity.extend({
  orderId: count,
  trigger: diagnoseSampleOrderSchema.shape.trigger.optional(),
  date: z.string(),
  price: numeric,
  quantity: numeric,
  fee: numeric,
  cashAfter: numeric,
  holdingAfter: numeric,
  capacityClipped: z.boolean().optional(),
  executionEvidence: z
    .object({
      intendedPrice: numeric,
      slippageBps: numeric,
      source: z.string(),
    })
    .optional(),
});
export const diagnoseSampleRejectionSchema = z.object({
  orderId: count,
  date: z.string(),
  reason: z.string(),
});

export const diagnoseScenarioMetricsSchema = z.object({
  scenarioId: z.string().min(1),
  label: z.string(),
  executionProfile: z.string(),
  maxParticipation: numeric.nullable(),
  capacityPolicy: z.enum(["clip", "reject"]).nullable(),
  status: z.enum(["ok", "blocked", "failed"]),
  layer: z.string().optional(),
  error: z.string().optional(),
  counts: diagnoseCountsSchema,
  rejectionReasons: z.array(z.object({ reason: z.string(), count })),
  totalFees: numeric.nullable(),
  totalReturn: numeric.nullable(),
  maxDrawdown: numeric.nullable(),
  capacityActive: z.boolean(),
  capacityNote: z.string().optional(),
  inputHash: z.string().optional(),
  timingStatus: z.string().optional(),
  checks: z.array(diagnoseCheckSchema),
  findings: textList,
  nativeChan: z.array(nativeChan).optional(),
  canslimPit: z.array(growthPit).optional(),
  growthPit: z.array(growthPit).optional(),
  wyckoffFunnel: z.array(wyckoffFunnel).optional(),
  timeHoldout: diagnoseTimeHoldoutSchema.optional(),
  sleeveAttribution: diagnoseSleeveAttributionSchema.optional(),
  sleeveInvestment: diagnoseSleeveInvestmentSchema.optional(),
  sleeveTrades: diagnoseSleeveTradesSchema.optional(),
  sessionEvidence: diagnoseSessionEvidenceSchema.optional(),
  familyHoldout: diagnoseFamilyHoldoutSchema.optional(),
  bookControl: z
    .object({
      policy: z.enum(["none", "equal-month-end", "risk-parity-60"]),
      targetCount: count,
      transferCount: count,
    })
    .optional(),
  sampleOrders: z.array(diagnoseSampleOrderSchema).max(DIAGNOSE_SAMPLE_LIMIT),
  sampleFills: z.array(diagnoseSampleFillSchema).max(DIAGNOSE_SAMPLE_LIMIT),
  sampleRejections: z
    .array(diagnoseSampleRejectionSchema)
    .max(DIAGNOSE_SAMPLE_LIMIT),
});
export type DiagnoseScenarioMetrics = z.infer<
  typeof diagnoseScenarioMetricsSchema
>;
export const diagnoseScenarioCellGroupSchema = z.object({
  strategyKey: z.string(),
  symbols: textList,
  mode: z.enum(["per-symbol", "portfolio"]),
  start: z.string().optional(),
  end: z.string().optional(),
  scenarios: z.array(diagnoseScenarioMetricsSchema),
});
export type DiagnoseScenarioCellGroup = z.infer<
  typeof diagnoseScenarioCellGroupSchema
>;
export const diagnoseArchiveSummarySchema = z.object({
  id: z.string(),
  source: sourceSchema,
  title: z.string(),
  generatedAt: z.string(),
  book: diagnoseBookInputSchema.optional(),
  run: diagnoseArchiveRunSchema.optional(),
  suspensionSummary: diagnoseSuspensionSummarySchema.optional(),
  familyHoldout: diagnoseFamilyHoldoutSchema.optional(),
  bookPreset: bookPresetSchema.optional(),
  holdoutStart: researchDateSchema.nullish(),
  strategyKeys: textList,
  symbols: textList,
  pool: z
    .object({
      id: z.string(),
      label: z.string(),
      symbolCount: count,
      survivorBiasDisclosure: z.string(),
      members: z
        .array(
          z.object({
            symbol: z.string(),
            name: z.string(),
            group: z.string(),
            board: z.string(),
            role: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
  scenarios: textList,
  statusCounts: z.object({
    ok: count,
    blocked: count,
    failed: count,
    zeroSignal: count,
  }),
  driftWarnings: textList,
  missingFiles: textList,
});
export type DiagnoseArchiveSummary = z.infer<
  typeof diagnoseArchiveSummarySchema
>;
export const diagnoseArchiveDetailSchema = z.object({
  summary: diagnoseArchiveSummarySchema,
  cells: z.array(diagnoseScenarioCellGroupSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalCells: count,
  }),
  boundaryState: z.enum(["ok", "zero-signal", "blocked", "missing-files"]),
});
export type DiagnoseArchiveDetail = z.infer<typeof diagnoseArchiveDetailSchema>;

function safeHandoffReturn(value: string): boolean {
  if (
    !["/scan", "/accounts", "/accounts/review"].includes(
      value.split("?", 1)[0]!,
    )
  )
    return false;
  // Search params may themselves contain percent-encoded URL delimiters.
  let decoded = value;
  while (true) {
    if (
      decoded.includes("//") ||
      decoded.includes("..") ||
      /[\\#]|[a-z][a-z0-9+.-]*:\/|(?:^|[?&=])\s*[a-z][a-z0-9+.-]*:/i.test(
        decoded,
      ) ||
      Array.from(decoded).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      )
    )
      return false;
    if (!/%[0-9a-f]{2}/i.test(decoded)) return true;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  }
}

const handoffSymbols = z
  .array(symbolSchema)
  .min(1)
  .max(12)
  .refine(unique, "标的重复");

export function normalizePortfolioHandoffSymbols(
  rawSymbols: readonly string[],
  limit = 12,
  acceptsSymbol = (symbol: string) => symbolPattern.test(symbol),
) {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("标的数量上限须为非负整数");
  const valid = new Set<string>();
  let droppedInvalidCount = 0;
  for (const raw of rawSymbols) {
    if (acceptsSymbol(raw)) valid.add(raw);
    else droppedInvalidCount++;
  }
  return {
    symbols: [...valid].slice(0, limit),
    truncatedCount: Math.max(0, valid.size - limit),
    droppedInvalidCount,
  };
}

export function monthlyReviewHandoffSymbols(symbols: readonly string[]) {
  return normalizePortfolioHandoffSymbols(
    symbols,
    12,
    (symbol) => isAShareStockSymbol(symbol) && !symbol.startsWith("bj"),
  );
}

const handoffFields = z
  .object({
    handoffSource: z.enum([
      "formula",
      "pattern",
      "rps",
      "watchlist",
      "pool",
      "account-review",
    ]),
    symbol: symbolSchema,
    symbols: handoffSymbols.optional(),
    frozenDate: researchDateSchema.optional(),
    strategyHint: z.string().trim().min(1).max(100).optional(),
    label: z.string().trim().min(1).max(100).optional(),
    returnTo: z
      .string()
      .max(4096)
      .refine(safeHandoffReturn, "返回地址须为本地扫描或账户复盘页面")
      .optional(),
    scope: z.enum(["single-symbol-diagnose", "portfolio-diagnose"]),
  })
  .strict();
const singleHandoffSchema = handoffFields.extend({
  scope: z.literal("single-symbol-diagnose"),
  symbols: z.array(symbolSchema).length(1).optional(),
});
const portfolioHandoffSchema = handoffFields.extend({
  scope: z.literal("portfolio-diagnose"),
  symbol: symbolSchema.optional(),
  symbols: handoffSymbols,
});
// Existing scan link builders use .shape.returnTo to validate the return link separately.
export const ScanToLabHandoffSchema = Object.assign(
  z
    .discriminatedUnion("scope", [singleHandoffSchema, portfolioHandoffSchema])
    .refine(
      (v) =>
        v.scope !== "single-symbol-diagnose" ||
        !v.symbols ||
        v.symbols[0] === v.symbol,
      { path: ["symbols"], message: "单标的交接只能包含当前标的" },
    )
    .transform((v) =>
      v.scope === "portfolio-diagnose" ? { ...v, symbol: v.symbols[0]! } : v,
    ),
  { shape: handoffFields.shape },
);
export type ScanToLabHandoff = z.infer<typeof ScanToLabHandoffSchema>;

export function buildScanToLabHandoffHref(
  payload: z.input<typeof ScanToLabHandoffSchema>,
): string {
  const handoff = ScanToLabHandoffSchema.parse(payload);
  const params = new URLSearchParams({ handoff: "1" });
  for (const [name, value] of Object.entries(handoff)) {
    if (value !== undefined)
      params.set(name, Array.isArray(value) ? value.join(",") : value);
  }
  return `/lab/backtest?${params}`;
}
type ParsedScanHandoff =
  | { kind: "none" }
  | { kind: "valid"; handoff: ScanToLabHandoff; key: string }
  | { kind: "invalid"; message: string };

export function parseScanToLabHandoff(search: {
  get(name: string): string | null;
}): ParsedScanHandoff {
  const marker = search.get("handoff");
  if (marker === null) return { kind: "none" };
  if (marker !== "1") return { kind: "invalid", message: "未知的扫描交接版本" };
  const raw: Record<string, string | string[]> = {};
  for (const name of Object.keys(ScanToLabHandoffSchema.shape)) {
    const value = search.get(name);
    if (value !== null)
      raw[name] = name === "symbols" ? value.split(",") : value;
  }
  const parsed = ScanToLabHandoffSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: "invalid",
      message: `扫描交接参数无效（${issue?.path.join(".") ?? "handoff"}）`,
    };
  }
  return {
    kind: "valid",
    handoff: parsed.data,
    key: buildScanToLabHandoffHref(parsed.data),
  };
}

/** Client-safe rules shared by the preview and the corresponding diagnostic adapters. */
export function scanHandoffStrategyRules(
  key: string,
): Pick<StrategyObjectInput, "entry" | "exit"> | undefined {
  switch (key) {
    case "dual-ma":
      return {
        entry: { kind: "dual-ma", fast: 5, slow: 20, side: "entry" },
        exit: { rule: { kind: "dual-ma", fast: 5, slow: 20, side: "exit" } },
      };
    case "double-breakout":
      return {
        entry: {
          kind: "double-breakout",
          side: "entry",
          filter: { direction: "long", minScore: 3, minVolumeRatio: 1.5 },
          useStructureStop: true,
        },
        exit: {
          rule: {
            kind: "double-breakout",
            side: "exit",
            filter: { direction: "short", minScore: 3 },
          },
          maxBars: 60,
        },
      };
    case "formula":
      return {
        entry: {
          kind: "formula",
          source: "选股:C>REF(HHV(H,N1),1) AND V>MA(V,20);",
          parameters: { N1: 20 },
        },
        exit: { rule: { kind: "formula", source: "选股:C<MA(C,20);" } },
      };
    case "research-chan":
      return {
        entry: {
          kind: "chan-third-buy",
          firstIndex: nativeStudyDefinition.warmupBars,
        },
        exit: { maxBars: 5 },
      };
    case "research-chan-first":
    case "research-chan-second":
    case "research-chan-third":
    case "research-chan-hold-cash": {
      const profile = {
        "research-chan-first": "chan-first-native",
        "research-chan-second": "chan-second-native",
        "research-chan-third": "chan-third-native",
        "research-chan-hold-cash": "chan-hold-cash-native",
      } as const;
      const entry = {
        kind: "chan-native",
        profile: profile[key],
        side: "entry",
      } as const;
      return {
        entry,
        exit:
          key === "research-chan-hold-cash"
            ? { rule: { ...entry, side: "exit" } }
            : { maxBars: 5 },
      };
    }
    case "research-sepa-pit":
      return {
        entry: { kind: "external", id: key, side: "entry" },
        exit: { maxBars: 6 },
      };
  }
}

export function buildLabDraftFromHandoff(payload: ScanToLabHandoff) {
  const handoff = ScanToLabHandoffSchema.parse(payload);
  const defaultKey = {
    formula: "formula",
    pattern: "double-breakout",
    rps: "dual-ma",
    watchlist: "dual-ma",
    pool: "dual-ma",
    "account-review": "dual-ma",
  }[handoff.handoffSource];
  const hintedRules =
    handoff.strategyHint && scanHandoffStrategyRules(handoff.strategyHint);
  const strategyKey = hintedRules ? handoff.strategyHint! : defaultKey;
  const rules = hintedRules || scanHandoffStrategyRules(defaultKey)!;
  const portfolio = handoff.scope === "portfolio-diagnose";
  const strategy: StrategyObjectInput = {
    id: `diag-${strategyKey}`,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: handoff.symbols ?? [handoff.symbol] },
    ...rules,
    sizing: portfolio
      ? { kind: "equal", positions: handoff.symbols.length }
      : { kind: "weight", weight: 1 },
    sleeve: "diag",
  };
  // Without an as-of date, leave the Lab's date fields awaiting explicit selection.
  const end = handoff.frozenDate ?? "";
  const start = end
    ? new Date(Date.parse(end) - 365 * 86_400_000).toISOString().slice(0, 10)
    : "";
  const notes = [
    portfolio
      ? "此草稿诊断所选标的组合。历史证券池与逐日选股表现需独立验证。"
      : "此草稿只诊断扫描候选中的一个标的。历史证券池与逐日选股表现需独立验证。",
  ];
  if (handoff.strategyHint && !hintedRules)
    notes.push(
      `策略提示「${handoff.strategyHint}」未映射，草稿采用 ${strategyKey}。`,
    );
  if (strategyKey === "formula")
    notes.push("草稿使用诊断示例公式，可按原扫描公式编辑。");
  if (handoff.handoffSource === "rps")
    notes.push(
      portfolio
        ? "RPS 排名仅用于选择候选。"
        : "RPS 排名仅用于选择候选；草稿规则用于单标的回放。",
    );
  if (!end) notes.push("缺少冻结日期，请选择回放日期范围。");
  return {
    strategy,
    strategyJson: JSON.stringify(strategy, null, 2),
    strategyKey,
    start,
    end,
    scopeNote: notes.join(""),
  };
}
