import { marketSourceSchema, type MarketSource } from "./market/market-source";
import { researchDateSchema } from "./research/workflow/research-usage";
import { z } from "zod";
import { notificationPolicySchema } from "./strategy-facts/notification-policy";
import type { SecurityTradingStatus } from "./market/security-trading-status";
import type { Bar, Period } from "trading-strategy-core/bars";
export type { Bar, Period } from "trading-strategy-core/bars";
export const symbolSchema = z.string().regex(/^(sh|sz|bj)\d{6}$/);
export const periodSchema = z.enum(["day", "5m"]);
export type Security = {
  symbol: string;
  name: string;
  market: string;
  bytes: number;
  modified: number;
  period: Period;
};
export type Coverage = {
  root: string;
  counts: Record<string, number>;
  securities: Security[];
  scannedAt: number;
};
export type Snapshot = {
  id: string;
  symbol: string;
  name?: string;
  period: Period;
  source: string;
  adjustment: "none";
  createdAt: number;
  bars: Bar[];
  hash: string;
  historicalAsOf?: string;
  dataRoot?: string;
  sourceUrl?: string;
  volumeUnit?: string;
  sourceNote?: string;
  sourceErrors?: string[];
  sourceVersions?: string[];
  requestedSource?: MarketSource;
};
export const maParamsSchema = z
  .object({
    name: z.string().min(1).max(80).default("双均线趋势"),
    fast: z.number().int().min(2).max(120).default(5),
    slow: z.number().int().min(3).max(250).default(20),
    minChange: z.number().min(-30).max(30).default(-10),
    maxChange: z.number().min(-30).max(30).default(10),
    minVolumeRatio: z.number().min(0).max(20).default(0),
  })
  .refine(
    (s) => s.fast < s.slow && s.minChange <= s.maxChange,
    "短均线须小于长均线，涨幅下限须不大于上限",
  );
const czscParamsSchema = z
  .object({ config: z.union([z.literal(0), z.literal(1100)]).default(0) })
  .strict();
// Flat fields remain a compatibility projection for existing research consumers.
// Persisted pre-M4 objects stay valid without rewriting records or their baselines.
export const strategySchema = z.union([
  z
    .object({
      type: z.literal("dual-breakout"),
      params: z.object({}).strict().default({}),
    })
    .transform((s) => ({ ...maParamsSchema.parse({}), name: "双突破", ...s })),
  z
    .object({ type: z.literal("ma-cross"), params: maParamsSchema })
    .transform((s) => ({ ...s.params, ...s })),
  z
    .object({ type: z.literal("czsc"), params: czscParamsSchema })
    .transform((s) => ({
      ...maParamsSchema.parse({}),
      name: "缠论买卖点",
      ...s,
    })),
  maParamsSchema.and(z.object({ type: z.undefined().optional() })),
]);
export type Strategy = z.infer<typeof strategySchema>;
export const defaultStrategy: Strategy = {
  name: "双均线趋势",
  fast: 5,
  slow: 20,
  minChange: -10,
  maxChange: 10,
  minVolumeRatio: 0,
};
export type Metrics = {
  close: number;
  change: number;
  fast: number;
  slow: number;
  volumeRatio: number;
  matched: boolean;
  date: string;
  score: number;
};
export type Candidate = {
  symbol: string;
  name: string;
  metrics: Metrics;
  snapshotId: string;
};
export type Job = {
  ownerPid?: number;
  attemptId?: string;
  auditIncomplete?: boolean;
  id: string;
  type:
    | "scan"
    | "screen"
    | "online-screen"
    | "backtest"
    | "walk-forward"
    | "research"
    | "monitor";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  phase?: string;
  workProgress?: import("./research/workflow/work-progress").WorkProgress;
  createdAt: number;
  updatedAt: number;
  input: unknown;
  result?: unknown;
  error?: string;
};
export type Evidence = {
  id: string;
  source: string;
  asOf: string;
  text: string;
  envelope?: import("./research/evidence/evidence-envelope").EvidenceEnvelope;
};
export const reportSchema = z.object({
  title: z.string(),
  summary: z.string(),
  supporting: z.array(z.string()),
  opposing: z.array(z.string()),
  risks: z.array(z.string()),
  missing: z.array(z.string()),
  nextSteps: z.array(z.string()),
  citations: z.array(z.string()),
  stages: z
    .array(
      z.object({
        id: z.enum([
          "market",
          "fundamentals",
          "trend",
          "vcp",
          "entry-risk",
          "conclusion",
        ]),
        status: z.enum(["supported", "contradicted", "missing"]),
        summary: z.string().min(1),
        citations: z.array(z.string()),
        missing: z.array(z.string()),
      }),
    )
    .optional(),
});
export type Report = z.infer<typeof reportSchema> & {
  id: string;
  createdAt: number;
  model: string;
  promptVersion: string;
  evidence: Evidence[];
  tokens: number;
  contextId: string;
  skills?: {
    skillId: string;
    ruleVersion: string;
    outputSchema: string;
    files: { file: string; hash: string }[];
    prerequisites: string[];
  }[];
  batchUsage?: { batchId: string; reports: number; tokens: number };
};
export const channelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  type: z.enum(["feishu", "wecom", "telegram", "discord"]),
  enabled: z.boolean().default(false),
  target: z.string().max(200).default(""),
  thread: z.string().max(100).default(""),
  secret: z.string().max(4096).optional(),
  signingSecret: z.string().max(500).optional(),
});
export type Channel = Omit<
  z.infer<typeof channelSchema>,
  "secret" | "signingSecret" | "id"
> & { id: string; configured: boolean };
export type Signal = {
  breakout?: import("../server/strategies/breakout/breakout").BreakoutResult;
  czsc?: import("./research/methods/chan/czsc").CzscSignalDetails;
  monitorRun?: { createdAt: number; revision: string | null };
  tradingStatusEvidence?: SecurityTradingStatus;
  calendarEvidence?: {
    source: string;
    hash: string | null;
    assessedAt: number;
  };
  id: string;
  monitorId: string;
  symbol: string;
  strategy: Strategy;
  period: Period;
  date: string;
  createdAt: number;
  expiresAt: number;
  metrics: Metrics;
  snapshotId: string;
  source: string;
};
export type Delivery = {
  policyDecisionIds?: string[];
  summarySignalIds?: string[];
  manualRetry?: boolean;
  id: string;
  signalId: string;
  channelId: string;
  kind: "signal" | "analysis" | "test" | "summary";
  title: string;
  body: string;
  status: "pending" | "sending" | "sent" | "failed" | "expired" | "cancelled";
  attempts: number;
  nextAt: number;
  expiresAt: number;
  createdAt: number;
  error?: string;
  remoteId?: string;
};
export type Monitor = {
  revision?: string;
  tradingStatusChecks?: Record<string, SecurityTradingStatus>;
  calendarEvidence?: {
    source: string;
    hash: string | null;
    assessedAt: number;
  };
  id: string;
  name: string;
  symbols: string[];
  strategy: Strategy;
  period: Period;
  source: MarketSource | "mcp";
  channels: string[];
  ai: boolean;
  enabled: boolean;
  states: Record<
    string,
    { date: string; matched: boolean; signalKeys?: string[] }
  >;
  createdAt: number;
  lastCheck?: number;
  error?: string;
};
export const settingsSchema = z.object({
  marketDataSource: marketSourceSchema.default("auto"),
  holdoutStart: researchDateSchema.nullable().default(null),
  notificationPolicy: notificationPolicySchema,
  llmProvider: z.enum(["codex", "claude", "deepseek"]).default("codex"),
  codexModel: z.string().trim().max(100).default(""),
  claudeModel: z.string().trim().max(100).default(""),
  industryBlocksRoot: z.string().trim().max(2048).default(""),
  industryMembershipSource: z.enum(["blocks", "tdx"]).default("blocks"),
  tdxRoot: z.string().min(1).default("E:\\new_tdx64"),
  clsDbPath: z
    .string()
    .min(1)
    .default("E:/pythonPrj/cls_news_collector/cls_news.db"),
  autoAnalysis: z.boolean().default(true),
  autoNewsAnalysis: z.boolean().default(false),
  autoNewsDailyBatches: z.number().int().min(1).max(100).default(8),
  analysisLimit: z.number().int().min(1).max(10).default(10),
  fastModel: z.string().default("deepseek-v4-flash"),
  deepModel: z.string().default("deepseek-v4-pro"),
  proxy: z.string().default(""),
  /** Fallback route for overseas data (crypto): direct first, then this proxy. */
  outboundProxy: z
    .string()
    .trim()
    .max(200)
    .regex(/^$|^(socks5h?|socks4|https?):\/\/[^\s/]+$/, "代理地址格式无效")
    .default("socks5://127.0.0.1:10808"),
  binanceTestnet: z.boolean().default(true),
  calendar: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});
export type Settings = z.infer<typeof settingsSchema>;
export type Trade = {
  date: string;
  side: "buy" | "sell";
  price: number;
  shares: number;
  fee: number;
};
export type Backtest = {
  adjustment?: import("./research/evidence/research-adjustment").ResearchAdjustment;
  signalAdjustment?: import("~/server/backtest/cash-adjusted-signals").CashSignalAdjustment;
  dividends?: {
    strategy: import("~/server/backtest/dividend-ledger").DividendLedgerResult;
    benchmark: import("~/server/backtest/dividend-ledger").DividendLedgerResult;
  };
  corporateActions?: import("~/server/backtest/backtest-actions").BacktestActions;
  benchmark?: {
    version: "buy-hold-1" | "buy-hold-2";
    label: string;
    equity: { date: string; value: number }[];
    trade: Trade | null;
    totalReturn: number;
    maxDrawdown: number;
    excessReturnPoints: number;
    cash: number;
    shares: number;
  };
  evaluationStart?: number;
  engineVersion?: string;
  costs?: import("./backtest/backtest-costs").BacktestCosts;
  dataRange?: {
    scope: "full" | "window";
    warmupBars?: number;
    start: string;
    end: string;
    bars: number;
    selectedSnapshotId: string;
  };
  snapshotId: string;
  strategy: Strategy;
  equity: { date: string; value: number }[];
  trades: Trade[];
  totalReturn: number;
  maxDrawdown: number;
  cash: number;
  shares: number;
  diagnostics: Partial<
    import("./research/evidence/research-adjustment").AdjustmentDiagnostics
  > & {
    entrySignals: number;
    insufficientCash: number;
    untradable: number;
    initial: number;
  };
  assumptions: string[];
};
