import { z } from "zod";
import {
  nativeStudyDefinition,
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
const symbolSchema = z.string().regex(/^(sh|sz|bj)\d{6}$/);
const sourceSchema = z.enum(["lab-archive", "cli-report"]);
const textList = z.array(z.string());
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

export function isDiagnosticOnlyStrategyKey(key: string): boolean {
  return ["research-chan", "research-canslim-pit", "research-sepa-pit"].some(
    (prefix) => key.startsWith(prefix),
  );
}

export const labDiagnoseRunInputSchema = z
  .object({
    symbols: z.array(symbolSchema).min(1).max(12).refine(unique, "标的重复"),
    mode: z.enum(["per-symbol", "portfolio"]).optional(),
    strategyKey: z.string().trim().min(1).max(100),
    start: z.union([z.literal("auto"), researchDateSchema]),
    end: researchDateSchema,
    initial: numeric.positive().max(1e9),
    costScenario: z.enum(researchCostScenarios),
    scenarios: z
      .array(diagnoseScenarioIdSchema)
      .min(1)
      .max(3)
      .refine(unique, "执行情景重复"),
    confirmed: z.literal(true),
  })
  .strict()
  .refine(
    (v) => v.start === "auto" || v.start < v.end,
    "开始日期须早于结束日期",
  );
export type LabDiagnoseRunInput = z.infer<typeof labDiagnoseRunInputSchema>;

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
  boundary: z.string(),
});
export type DiagnoseNativeChanDisclosure = z.infer<typeof nativeChan>;
export type DiagnoseGrowthPitDisclosure = z.infer<typeof growthPit>;
export type DiagnoseWyckoffFunnel = z.infer<typeof wyckoffFunnel>;

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

/** A return target is exactly the scanner route, optionally with its original query. */
function safeScanReturn(value: string): boolean {
  if (value !== "/scan" && !value.startsWith("/scan?")) return false;
  // Search params may themselves contain percent-encoded URL delimiters.
  let decoded = value;
  while (true) {
    if (
      decoded.includes("//") ||
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

export const ScanToLabHandoffSchema = z
  .object({
    handoffSource: z.enum(["formula", "pattern", "rps"]),
    symbol: symbolSchema,
    frozenDate: researchDateSchema.optional(),
    strategyHint: z.string().trim().min(1).max(100).optional(),
    label: z.string().trim().min(1).max(100).optional(),
    returnTo: z
      .string()
      .max(4096)
      .refine(safeScanReturn, "返回地址须为本地 /scan 页面")
      .optional(),
    scope: z.literal("single-symbol-diagnose"),
  })
  .strict();
export type ScanToLabHandoff = z.infer<typeof ScanToLabHandoffSchema>;

export function buildScanToLabHandoffHref(payload: ScanToLabHandoff): string {
  const handoff = ScanToLabHandoffSchema.parse(payload);
  const params = new URLSearchParams({ handoff: "1" });
  for (const [name, value] of Object.entries(handoff)) {
    if (value !== undefined) params.set(name, value);
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
  const raw: Record<string, string> = {};
  for (const name of Object.keys(ScanToLabHandoffSchema.shape)) {
    const value = search.get(name);
    if (value !== null) raw[name] = value;
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
  }[handoff.handoffSource];
  const hintedRules =
    handoff.strategyHint && scanHandoffStrategyRules(handoff.strategyHint);
  const strategyKey = hintedRules ? handoff.strategyHint! : defaultKey;
  const rules = hintedRules || scanHandoffStrategyRules(defaultKey)!;
  const strategy: StrategyObjectInput = {
    id: `diag-${strategyKey}`,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: [handoff.symbol] },
    ...rules,
    sizing: { kind: "weight", weight: 1 },
    sleeve: "diag",
  };
  // Without an as-of date, leave the Lab's date fields awaiting explicit selection.
  const end = handoff.frozenDate ?? "";
  const start = end
    ? new Date(Date.parse(end) - 365 * 86_400_000).toISOString().slice(0, 10)
    : "";
  const notes = [
    "此草稿只诊断扫描候选中的一个标的。历史证券池与逐日选股表现需独立验证。",
  ];
  if (handoff.strategyHint && !hintedRules)
    notes.push(
      `策略提示「${handoff.strategyHint}」未映射，草稿采用 ${strategyKey}。`,
    );
  if (strategyKey === "formula")
    notes.push("草稿使用诊断示例公式，可按原扫描公式编辑。");
  if (handoff.handoffSource === "rps")
    notes.push("RPS 排名仅用于选择候选；草稿规则用于单标的回放。");
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
