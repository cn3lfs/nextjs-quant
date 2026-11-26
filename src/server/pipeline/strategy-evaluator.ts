import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import type { Bar } from "trading-strategy-core/bars";
import { atr, ma } from "trading-strategy-core/indicators";
import { completedBar } from "trading-strategy-core/completed-bars";
import {
  createExtendedStudyRule,
  createStudyDecision,
  cryptoDualMa,
  etfRotationCatalog,
  etfRotationUniverseFor,
  evaluateBreakoutFilter,
  evaluateChanSignal,
  evaluatePairSwitchZScore,
  generateEtfRotationTargets,
  prepareTheoryScreeners,
  spotPairPresets,
  strategyTargetProposalSchema,
  studyWarmup,
  type DeployableStrategySpec,
  type StrategyTargetProposal,
} from "trading-strategies";
import { czscSourceCommit } from "trading-strategies/research/chan/czsc";
import { compileScreenFormula } from "trading-strategies/formula/formula-screen";
import {
  analyzeBreakout,
  type BreakoutLevelMode,
  type BreakoutTrendMode,
} from "trading-strategies/research/breakout/breakout";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { alphaTargetOptionsSchema } from "~/lib/research/alpha-experiment";
import { beijingClock } from "~/lib/market/market-session";
import { z } from "zod";
import { cryptoSymbol } from "~/lib/market/crypto";
import {
  cryptoPeriodEnd,
  cryptoPeriodMs,
} from "~/lib/market/crypto-aggregation";
import type { DeploymentRecord as StrategyDeploymentRecord } from "../db/deployment-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { PaperRepository } from "../db/paper-repository";
import { listOwnerSleeveHoldings } from "../db/sleeve-holding-repository";
import { planningAccount } from "./account-coordinator";
import {
  getActivePoolEntries,
  normalizePoolSymbol,
  recordPoolEntrySignal,
  type PoolEntryRecord,
} from "../db/pool-repository";
import { sentimentRegimeSnapshot } from "../market/limit-sentiment-regime";
import { resolveEtfRotationPresetTargets } from "../paper/ticket-source-catalog";
import { causalResearchPrices } from "../research/causal-price-basis";
import { loadEtfRotationMarketData } from "../research/etf-rotation/market-data";
import {
  evaluateValuePitSnapshot,
  previewMacroClockAllocation,
  previewPairSwitchAllocation,
} from "../research/value-pit-service";
import {
  readDecisionBars,
  readDecisionRps,
  type UniversePoolDeps,
} from "./universe-pool-runner";
import {
  evaluateAlphaOnPanel,
  panelIdSchema,
  readAlphaPanelIdentity,
  readFrozenAlpha,
  type AlphaResolutionContext,
  type AlphaSpec,
} from "./strategy-alpha";
import {
  localMarketSessions,
  MissingStrategyData,
  rebalanceSkip,
  strategySettings,
  validatedSessions,
  type ReadTradingSessions,
  type RebalanceCadence,
  type StrategySkipReason,
} from "./strategy-rebalance";

type Spec<K extends DeployableStrategySpec["kind"]> = Extract<
  DeployableStrategySpec,
  { kind: K }
>;
type BreakoutSpec = Spec<"double-breakout"> & {
  trendMode?: BreakoutTrendMode;
  levelMode?: BreakoutLevelMode;
};
type ChanConfig = 0 | 1100;
type ChanSpec = Spec<"chan-native"> & {
  config?: ChanConfig;
  configId?: string;
};
type DecisionSpec =
  | Exclude<
      DeployableStrategySpec,
      Spec<"alpha-composite" | "double-breakout" | "chan-native">
    >
  | AlphaSpec
  | BreakoutSpec
  | ChanSpec
  | {
      kind: "dual-breakout";
      entryDays: number;
      exitDays: number;
      atrPeriod?: number;
      atrMultiplier?: number;
    }
  | {
      kind: "rps-momentum";
      rpsPeriod: number;
      minRps: number;
      maDays?: number;
      exitRps?: number;
    }
  | { kind: "formula-signal"; formulaId: string; exitFormulaId?: string }
  | { kind: "sentiment-dragon" };
type Weights = Readonly<Record<string, number>>;
type MaybePromise<T> = T | Promise<T>;
type Signal = StrategyTargetProposal["signals"][number];
type Decision = Omit<Signal, "symbol">;
const chanConfigSchema = z.union([z.literal(0), z.literal(1100)]);
export const evaluatedStrategyProposalSchema = strategyTargetProposalSchema
  .extend({
    allocation: z.literal("cash").optional(),
    skipReason: z.enum(["non-rebalance-day", "missing-data"]).optional(),
    panelSnapshotId: panelIdSchema.optional(),
    trendMode: z.enum(["trendline", "trendline-or-ma20", "ma20"]).optional(),
    levelMode: z.enum(["all", "structural"]).optional(),
    chanConfig: z
      .object({
        profile: z.enum(["first", "second", "third", "hold-cash"]),
        configs: z.array(chanConfigSchema).nonempty(),
        anchor: z.literal(1),
        sourceCommit: z.string().min(1),
        configId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((proposal, ctx) => {
    if (
      proposal.skipReason &&
      (proposal.mode !== "delta-signals" ||
        Object.keys(proposal.targets).length ||
        proposal.signals.some((signal) => signal.action !== "HOLD"))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "跳过决策不得包含交易目标或动作",
      });
  })
  .transform((proposal) => {
    // A checkpoint created by a previous version can encode cash as all zeros.
    // Preserve its audit record while preventing liquidation when it resumes.
    if (
      proposal.mode === "target-weights" &&
      proposal.allocation !== "cash" &&
      !Object.values(proposal.targets).some((weight) => weight > 0)
    )
      return {
        ...proposal,
        mode: "delta-signals" as const,
        targets: {},
        signals: proposal.signals.filter((signal) => signal.action === "HOLD"),
      };
    return proposal;
  });
export type EvaluatedStrategyProposal = z.infer<
  typeof evaluatedStrategyProposalSchema
>;
type StrategyEvidence = Pick<
  EvaluatedStrategyProposal,
  "panelSnapshotId" | "trendMode" | "levelMode" | "chanConfig"
>;
type Sentiment = {
  phase: string;
  candidates: readonly {
    symbol: string;
    score?: number | null;
    reason?: string;
  }[];
  disclosure?: string;
};
const tickCacheKey = Symbol("strategy tick cache");
type TickCache = {
  panels: Map<string, ReturnType<typeof readAlphaPanelIdentity>>;
  archives: Map<string, ReturnType<typeof readFrozenAlpha>>;
  sessions: Map<string, Promise<readonly string[]>>;
};
export type StrategyEvaluatorDeps = {
  [tickCacheKey]?: Map<Database.Database | undefined, TickCache>;
  readBars?: UniversePoolDeps["readBars"];
  readTradingSessions?: ReadTradingSessions;
  resolveEtfRotation?: (
    config: Spec<"etf-rotation">["config"],
    decisionDate: string,
  ) => MaybePromise<Weights | null>;
  resolveAlphaComposite?: (
    compositeId: string,
    topN: number,
    decisionDate: string,
    context: AlphaResolutionContext,
  ) => MaybePromise<Weights | null>;
  resolveMacroClock?: (decisionDate: string) => {
    regime: string;
    targets: Weights | null;
    disclosure?: string;
  };
  resolvePairSwitch?: (
    pairId: string,
    decisionDate: string,
    config: Spec<"pair-switch">,
  ) => MaybePromise<{ targets: Weights | null; disclosure?: string }>;
  resolveValuePit?: (
    strategyId: string,
    topN: number,
    symbols: readonly string[],
    decisionDate: string,
  ) => MaybePromise<Weights | null>;
  resolveSentimentDragon?: (decisionDate: string) => Sentiment;
  evaluateFormula?: (
    formulaId: string,
    symbol: string,
    bars: readonly Bar[],
  ) => boolean;
  readRpsRanks?: (
    period: number,
    decisionDate: string,
    symbols: readonly string[],
  ) => MaybePromise<Weights | null>;
  resolveMultiBook?: (
    preset: "core-4",
    symbols: readonly string[],
    decisionDate: string,
  ) => MaybePromise<Weights | null>;
  resolveChan?: typeof evaluateLocalChan;
};

/** Create once per scheduler tick and pass the same deps to every deployment. */
export function createStrategyTickDeps(
  deps: StrategyEvaluatorDeps = {},
): StrategyEvaluatorDeps {
  return { ...deps, [tickCacheKey]: new Map() };
}

function cacheFor(deps: StrategyEvaluatorDeps, db?: Database.Database) {
  const scope = deps[tickCacheKey];
  const existing = scope?.get(db);
  if (existing) return existing;
  const cache: TickCache = {
    panels: new Map(),
    archives: new Map(),
    sessions: new Map(),
  };
  scope?.set(db, cache);
  return cache;
}

function once<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => MaybePromise<T>,
) {
  let pending = cache.get(key);
  if (!pending) {
    pending = Promise.resolve().then(load);
    cache.set(key, pending);
  }
  return pending;
}
const decision = (
  action: Signal["action"],
  reason: string,
  score: number | null = null,
  stopPrice: number | null = null,
  targetPrice: number | null = null,
): Decision => ({ action, reason, score, stopPrice, targetPrice });
const observing = (held: boolean) =>
  decision(
    "HOLD",
    held ? "继续持仓，未触发退出条件" : "仍在监控池观察，未触发买点",
  );

async function localCoreBook(
  binding: StrategyDeploymentRecord["venueBinding"],
  date: string,
  db?: Database.Database,
): Promise<Weights> {
  if (binding.kind !== "local_sim")
    throw new Error("该通道需要提供 core-4 账户分仓目标");
  const state = new PaperRepository(db).state(binding.simAccountId);
  if (!state) throw new Error("core-4 账户缺少冻结的分仓决策");
  const { DIAGNOSE_BOOK_PRESETS } =
    await import("../research/diagnose/strategy-specs");
  const weights: Record<string, number> = {};
  for (const sleeve of DIAGNOSE_BOOK_PRESETS["core-4"].sleeves) {
    const strategy = state.request.strategies.find(
      (s) => s.sleeve === sleeve.id && s.id === `diag-${sleeve.strategyKey}`,
    );
    const budget = state.request.sleeves.find((s) => s.id === sleeve.id);
    if (!strategy || budget?.share !== sleeve.share)
      throw new Error(`账户分仓与 core-4 不匹配：${sleeve.id}`);
    const rows =
      state.request.scheduledTargets?.filter(
        (r) =>
          r.strategyId === strategy.id &&
          r.date === date &&
          r.availableAt <= date &&
          r.sourceHash,
      ) ?? [];
    const decisions =
      state.result.bookDecisions?.filter(
        (r) =>
          r.strategyId === strategy.id &&
          r.decision.date === date &&
          r.decision.available,
      ) ?? [];
    const targets =
      rows.length === 1
        ? rows[0]!.targets
        : !rows.length && decisions.length === 1
          ? decisions[0]!.decision.targets
          : null;
    if (!targets)
      throw new Error(`${date} 缺少唯一可用的 ${sleeve.id} 分仓目标`);
    for (const [symbol, weight] of normalizedWeights(targets))
      weights[symbol] = (weights[symbol] ?? 0) + sleeve.share * weight;
  }
  return weights;
}

async function localEtf(
  config: Spec<"etf-rotation">["config"],
  date: string,
  root: string,
  sessions: readonly string[],
) {
  const preset = etfRotationCatalog.find((p) => p.id === config.strategyId);
  if (preset && isDeepStrictEqual(config, preset.defaults))
    return (
      await resolveEtfRotationPresetTargets(preset.id, date, root, sessions)
    ).targets;
  const universe = etfRotationUniverseFor(config);
  const market = await loadEtfRotationMarketData(
    { kind: "tdx", root },
    universe,
    date,
  );
  const closes = Object.fromEntries(
    universe.map(({ symbol }) => {
      const source = market.series[symbol];
      const bars = source?.bars.filter((b) => b.date <= date && b.volume > 0);
      if (!source || bars?.at(-1)?.date !== date)
        throw new Error(`${symbol} 缺少决策日 ETF 收盘价`);
      return [
        symbol,
        causalResearchPrices(
          bars,
          source.events.filter((e) => e.date <= date),
          market.actionsSource,
          [],
        ).bars,
      ];
    }),
  );
  // Sector rank buffers depend on previous rebalances. Only the next session's date
  // is exposed to the month-end scheduler, never its prices or corporate actions.
  const index = sessions.indexOf(date);
  if (index < 0) throw new Error("ETF 日历缺少决策日");
  const calendar = sessions.slice(0, index + 2);
  const schedule = await generateEtfRotationTargets(config, {
    calendar,
    start: config.strategyId === "etf-sector-rotation" ? calendar[0]! : date,
    end: date,
    closes,
    universe,
    priceBasis: "gbbq-first-raw-anchor-1",
  });
  const row = schedule.snapshots.find((s) => s.date === date);
  if (!row) throw new Error("当前日期没有已确认的 ETF 调仓目标");
  const treasury = universe.find(({ assetClass }) => assetClass === "treasury");
  const missingHistory = (s: typeof row) =>
    s.evidence.rows.some(
      (r) =>
        r.reason === "missing-history" &&
        (config.strategyId === "etf-risk-budget" ||
          r.symbol !== treasury?.symbol),
    );
  if (missingHistory(row)) throw new Error("ETF 调仓历史窗口不足");
  if (config.strategyId === "etf-sector-rotation") {
    const firstComplete = schedule.snapshots.findIndex(
      (s) => !missingHistory(s),
    );
    if (schedule.snapshots.slice(firstComplete).some(missingHistory))
      throw new Error("ETF 调仓历史存在缺口，无法恢复行业保留排名");
  }
  return row.targets;
}

async function localPair(
  spec: Spec<"pair-switch">,
  date: string,
  read: StrategyEvaluatorDeps["readBars"],
  sessions: readonly string[],
  root: string,
) {
  if (spec.lookback === 60 && spec.entryZ === 1.5 && spec.exitZ === 0.25) {
    const preview = await previewPairSwitchAllocation({
      pairId: spec.pairId,
      asOfDate: date,
      tdxRoot: read ? "" : root,
      readBars: read,
      readCalendar: () => sessions,
    });
    if (preview.zScore === null) throw new Error(preview.disclosure);
    return preview;
  }
  const pair = spotPairPresets.find((p) => p.id === spec.pairId)!;
  const [a, b] = await Promise.all([
    readDecisionBars(pair.legA, date, read),
    readDecisionBars(pair.legB, date, read),
  ]);
  const preview = evaluatePairSwitchZScore({
    ...spec,
    asOf: date,
    legA: { symbol: pair.legA, bars: a },
    legB: { symbol: pair.legB, bars: b },
    calendar: sessions.filter((d) => d <= date),
  });
  if (preview.zScore === null) throw new Error(preview.disclosure);
  return {
    ...preview,
    disclosure: preview.disclosure + " 自定义回看与阈值使用未复权收盘价。",
  };
}

async function evaluateLocalChan(
  profile: Spec<"chan-native">["profile"],
  bars: readonly Bar[],
  held: boolean,
  configs: readonly ChanConfig[],
): Promise<Decision & { configId?: string }> {
  const { analyzeCzsc } = await import("../strategies/chan/czsc");
  const codes = {
    first: ["1B", "1S", "P1B", "P1S"],
    second: ["2B", "2S", "L2B", "L2S"],
    third: ["3B", "3S"],
    "hold-cash": undefined,
  } as const;
  const projection = await analyzeCzsc(bars, true, undefined, true, 1);
  const hit = evaluateChanSignal(projection, bars, {
    codes: codes[profile],
    configs,
    direction: held ? "short" : "long",
  });
  const action = hit.matched
    ? decision(
        held ? "SELL" : "BUY",
        hit.summary,
        hit.signal?.quality ?? null,
        hit.stopPrice,
        hit.targetPrice,
      )
    : observing(held);
  return { ...action, configId: projection.configId };
}

async function cryptoBars(
  symbol: string,
  date: string,
  spec: Spec<"crypto-dual-ma">,
  read: StrategyEvaluatorDeps["readBars"],
) {
  const end = Math.min(Date.now(), Date.parse(date) + 86400000);
  const raw = read
    ? await read(symbol, date)
    : ((
        await (
          await import("../research/validation-crypto-history")
        ).readCachedResearchCryptoWindow({
          instrument: {
            market: "crypto",
            symbol: cryptoSymbol(symbol.replace(/^CX/i, "")),
          },
          period: spec.period,
          adjustment: "none",
          cryptoSource: "binance",
          to: date,
          now: end,
        })
      )?.snapshot.bars ?? []);
  const step = cryptoPeriodMs[spec.period]!;
  const bars = raw
    .filter(
      (b) =>
        b.date.slice(0, 10) <= date &&
        cryptoPeriodEnd(b.date, spec.period) <= end,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-spec.slow - 1);
  if (
    bars.some(
      (b, i) =>
        i > 0 && Date.parse(b.date) - Date.parse(bars[i - 1]!.date) !== step,
    )
  )
    return [];
  return bars;
}

type Context = {
  symbol: string;
  held: boolean;
  bars: readonly Bar[];
  fill: { entry: number; entryIndex: number } | null;
};

function study(spec: Spec<"study-rule">, { bars, held, fill }: Context) {
  const i = bars.length - 1;
  if (spec.strategyId === "breakout")
    return channel(
      { kind: "dual-breakout", entryDays: 55, exitDays: 20 },
      { bars, held },
    );
  const rule = createExtendedStudyRule(spec.strategyId, bars);
  if (rule) {
    if (i < studyWarmup(spec.strategyId))
      throw new MissingStrategyData("研究规则的预热窗口不足");
    if (held && !fill)
      throw new MissingStrategyData("缺少本分仓可用的入场成交");
    const hit = rule(i, fill ?? { entry: 0, entryIndex: -1 });
    if (held && hit.exitFraction !== undefined && hit.exitFraction < 1)
      return decision("HOLD", "研究规则触发部分减仓，当前信号仅支持整仓退出");
    return (held ? hit.exit : hit.enter)
      ? decision(
          held ? "SELL" : "BUY",
          hit.reason ?? `${spec.strategyId} 触发${held ? "退出" : "入场"}`,
        )
      : observing(held);
  }
  if (spec.strategyId === "pullback" || spec.strategyId === "range") {
    if (i < (spec.strategyId === "pullback" ? 119 : 79))
      throw new MissingStrategyData("研究规则的预热窗口不足");
    if (held && !fill)
      throw new MissingStrategyData("缺少本分仓可用的入场成交");
    const order = createStudyDecision(
      spec.strategyId,
      bars,
      bars,
      0,
      i,
    )(i, {
      cash: 0,
      shares: Number(held),
      entry: fill?.entry ?? 0,
      entryIndex: fill?.entryIndex ?? -1,
      anchor: 0,
      core: 0,
      sleeveCap: 0,
      initialized: held,
      lastAllocationMonth: "",
      installments: 0,
    });
    return order
      ? decision(held ? "SELL" : "BUY", order.reason)
      : observing(held);
  }
  if (spec.strategyId !== "ma")
    throw new MissingStrategyData("该研究规则需要独立的组合调仓与资金状态");
  const fast = ma(bars, spec.parameters?.fast ?? 5).at(-1);
  const slow = ma(bars, spec.parameters?.slow ?? 20).at(-1);
  if (fast == null || slow == null)
    throw new MissingStrategyData("研究规则的均线预热窗口不足");
  if (held && fast < slow)
    return decision("SELL", "短均线低于长均线，趋势退出");
  if (!held && fast > slow)
    return decision("BUY", "短均线高于长均线，趋势入场");
  return observing(held);
}

function channel(
  spec: Extract<DecisionSpec, { kind: "dual-breakout" }>,
  { bars, held }: Pick<Context, "bars" | "held">,
) {
  const n = held ? spec.exitDays : spec.entryDays;
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error("通道周期必须为正整数");
  if (bars.length <= n) throw new MissingStrategyData("通道规则的日线窗口不足");
  const previous = bars.slice(-n - 1, -1),
    close = bars.at(-1)!.close;
  if (held && close < Math.min(...previous.map((b) => b.low)))
    return decision("SELL", `收盘跌破昨日以前 ${n} 日通道下沿`);
  if (!held && close > Math.max(...previous.map((b) => b.high))) {
    const range = atr(bars, spec.atrPeriod ?? 14).at(-1);
    const stop =
      range == null ? null : close - (spec.atrMultiplier ?? 2) * range;
    return decision(
      "BUY",
      `收盘突破昨日以前 ${n} 日通道上沿`,
      null,
      stop !== null && stop > 0 ? stop : null,
    );
  }
  return observing(held);
}

function theory(
  spec: Spec<"theory-screener">,
  { bars, held, symbol, fill }: Context,
) {
  const prepared = prepareTheoryScreeners(
    { bars, symbol },
    { methodIds: [spec.methodId], minScore: spec.minScore },
  );
  const index = bars.length - 1;
  if (held) {
    if (!fill) throw new MissingStrategyData("缺少本分仓可用的入场成交");
    if (index - fill.entryIndex >= spec.holdBars)
      return decision("SELL", "理论选股器成交持有期届满");
    if (spec.useScreenerStops && fill.entryIndex > 0) {
      const entry = prepared
        .at(fill.entryIndex - 1)
        .find((h) => h.direction === "long");
      const close = bars[index]!.close;
      if (
        entry &&
        ((entry.stopPrice !== null && close <= entry.stopPrice) ||
          (entry.targetPrice !== null && close >= entry.targetPrice))
      )
        return decision(
          "SELL",
          "触及理论买点的止损或目标价",
          entry.score,
          entry.stopPrice,
          entry.targetPrice,
        );
    }
  }
  const hit = prepared
    .at(index)
    .find((h) => h.direction === (held ? "short" : "long"));
  return hit
    ? decision(
        held ? "SELL" : "BUY",
        hit.summary,
        hit.score,
        spec.useScreenerStops ? hit.stopPrice : null,
        spec.useScreenerStops ? hit.targetPrice : null,
      )
    : observing(held);
}

function sleeveEntries(
  deployment: Pick<StrategyDeploymentRecord, "id" | "venueBinding">,
  date: string,
  db?: Database.Database,
) {
  const cutoff = Math.min(Date.now(), Date.parse(date + "T23:59:59.999+08:00"));
  return new Map(
    listOwnerSleeveHoldings(
      {
        ...planningAccount(deployment.venueBinding),
        ownerKind: "deployment",
        ownerId: deployment.id,
      },
      db,
    )
      .filter(
        (row) =>
          row.quantity > 0 &&
          row.avgEntryPrice !== null &&
          row.avgEntryPrice > 0 &&
          row.entryDate !== null &&
          row.entryDate <= date &&
          row.updatedAt <= cutoff,
      )
      .map((row) => [normalizePoolSymbol(row.symbol), row]),
  );
}

function normalizedWeights(weights: Weights) {
  const map = new Map<string, number>();
  for (const [raw, value] of Object.entries(weights)) {
    const symbol = normalizePoolSymbol(raw);
    if (!symbol || map.has(symbol) || !Number.isFinite(value))
      throw new Error(`权重或排名无效：${symbol}`);
    map.set(symbol, value);
  }
  return map;
}

export async function evaluateDeploymentStrategy({
  deployment,
  decisionDate,
  activePoolEntries,
  heldSymbols,
  deps = {},
  db,
  universeSkipReason,
}: {
  deployment: Omit<StrategyDeploymentRecord, "strategySpec"> & {
    strategySpec: DecisionSpec;
  };
  decisionDate: string;
  activePoolEntries: readonly PoolEntryRecord[];
  heldSymbols: readonly string[];
  deps?: StrategyEvaluatorDeps;
  db?: Database.Database;
  universeSkipReason?: "missing-data";
}): Promise<EvaluatedStrategyProposal> {
  const asOf = researchDateSchema.parse(decisionDate);
  const entries = new Map(
    activePoolEntries
      .filter(
        (e) => e.status === "watching" && e.deploymentId === deployment.id,
      )
      .map((e) => [normalizePoolSymbol(e.symbol), e]),
  );
  const held = new Set(heldSymbols.map(normalizePoolSymbol));
  const symbols = [...new Set([...entries.keys(), ...held])].sort();
  const spec = deployment.strategySpec;
  const cache = cacheFor(deps, db);
  const marketSessions = () =>
    once(cache.sessions, asOf, async () =>
      validatedSessions(
        await (deps.readTradingSessions?.(asOf) ??
          localMarketSessions(asOf, db)),
      ),
    );
  const root = () => strategySettings(db).tdxRoot;
  const identity: StrategyEvidence = {};
  let disclosure = "";
  let weights: Weights | null | undefined;
  let evaluate: ((ctx: Context) => MaybePromise<Decision>) | undefined;
  const signals: Signal[] = [];
  const targets: Record<string, number> = {};
  let targetMode = false;
  let verifiedCash = false;
  let exactTargets = false;
  const unavailablePool = universeSkipReason
    ? "决策日证券池数据不完整"
    : activePoolEntries.some(
          (entry) =>
            entry.deploymentId === deployment.id &&
            (entry.enteredDate > asOf || entry.lastCheckedDate > asOf),
        )
      ? "证券池包含晚于决策日的记录"
      : null;
  function noAction(message: string, skipReason?: StrategySkipReason) {
    return evaluatedStrategyProposalSchema.parse({
      ...identity,
      ...(skipReason && { skipReason }),
      mode: "delta-signals",
      asOf,
      targets: {},
      signals: [...held].sort().map((symbol) => ({
        symbol,
        ...decision("HOLD", message),
      })),
      regimeScale: null,
      disclosure: [message, disclosure].filter(Boolean).join("。"),
    });
  }
  function skip(reason: StrategySkipReason) {
    return noAction(
      reason === "non-rebalance-day"
        ? "非冻结策略调仓日，维持现有持仓"
        : "缺少决策日或调仓周期的市场交易日历依据，维持现有持仓",
      reason,
    );
  }
  function cadenceFor(): RebalanceCadence | undefined {
    switch (spec.kind) {
      case "etf-rotation":
        return spec.config.strategyId === "etf-risk-budget"
          ? "month-end"
          : spec.config.cadence;
      case "macro-clock":
      case "value-pit":
        return spec.rebalanceCadence;
      case "pair-switch":
        return "daily";
    }
  }
  try {
    if (spec.kind === "double-breakout") {
      identity.trendMode = spec.trendMode ?? "trendline";
      identity.levelMode = spec.levelMode ?? "all";
    }
    if (spec.kind === "chan-native") {
      identity.chanConfig = {
        profile: spec.profile,
        configs:
          spec.config === undefined
            ? [0, 1100]
            : [chanConfigSchema.parse(spec.config)],
        anchor: 1,
        sourceCommit: czscSourceCommit,
        ...(spec.configId && { configId: spec.configId }),
      };
    }
    if (spec.kind === "alpha-composite" && spec.panelSnapshotId !== undefined)
      identity.panelSnapshotId = panelIdSchema.parse(spec.panelSnapshotId);
    if (
      deployment.market === "cn-equity" &&
      !completedBar(asOf, "day", Date.now())
    )
      return noAction("决策日尚未收盘，维持现有持仓", "missing-data");
    const cadence = cadenceFor();
    const sessions = cadence ? await marketSessions() : [];
    const cadenceSkip = cadence && rebalanceSkip(asOf, sessions, cadence);
    if (cadenceSkip) return skip(cadenceSkip);
    if (unavailablePool && spec.kind !== "alpha-composite")
      throw new MissingStrategyData(unavailablePool);
    switch (spec.kind) {
      case "etf-rotation": {
        weights = deps.resolveEtfRotation
          ? await deps.resolveEtfRotation(spec.config, asOf)
          : await localEtf(spec.config, asOf, root(), sessions);
        break;
      }
      case "alpha-composite": {
        const source = deployment.provenance;
        const frozen = await once(
          cache.archives,
          JSON.stringify([
            source.sourceKind,
            source.sourceRefId,
            spec.compositeId,
            spec.topN,
            spec.panelSnapshotId,
          ]),
          () => readFrozenAlpha(spec, source, db),
        );
        let archivedEmpty = false;
        let panelRoot: string | undefined;
        const panel = async () => {
          panelRoot ??= root();
          const id = frozen?.panelId ?? spec.panelSnapshotId;
          const key = JSON.stringify([
            panelRoot,
            id,
            frozen?.calendarIndex,
            !!frozen,
          ]);
          const result = await once(cache.panels, key, () =>
            readAlphaPanelIdentity(
              panelRoot!,
              id,
              frozen?.calendarIndex,
              !!frozen,
            ),
          );
          if (id && result.id !== id)
            throw new MissingStrategyData("打开的 Alpha 面板与冻结身份不一致");
          identity.panelSnapshotId = result.id;
          return result;
        };
        if (frozen) {
          exactTargets = true;
          identity.panelSnapshotId = frozen.panelId;
          if (asOf < frozen.start) return skip("non-rebalance-day");
          const panelSessions = validatedSessions(
            (await panel()).sessions ?? [],
          );
          // Older Alpha archives may use the panel union. A separate actual
          // session calendar must establish that the union left no gaps.
          const actual = frozen.calendarIndex
            ? panelSessions
            : await marketSessions();
          if (!frozen.calendarIndex) {
            const from = frozen.start;
            const to = asOf > frozen.end ? asOf : frozen.end;
            const covered = (date: string) => date >= from && date <= to;
            if (
              !isDeepStrictEqual(
                actual.filter(covered),
                panelSessions.filter(covered),
              )
            )
              throw new MissingStrategyData(
                "Alpha 面板并集未覆盖实际调仓交易日",
              );
          }
          if (
            !actual.length ||
            actual[0]! > frozen.start ||
            actual.at(-1)! < frozen.end
          )
            return skip("missing-data");
          const epochIndex = actual.findIndex((date) => date >= frozen.start);
          const epoch = actual[epochIndex]!;
          if (epoch > frozen.end) return skip("missing-data");
          const rebalance = {
            epoch,
            every: frozen.options.every,
          };
          const scheduled = actual.filter(
            (date, index) =>
              index >= epochIndex &&
              date <= frozen.end &&
              (index - epochIndex) % rebalance.every === 0,
          );
          if (
            !isDeepStrictEqual(
              scheduled,
              frozen.scheduledTargets.map((row) => row.date),
            )
          )
            throw new MissingStrategyData("Alpha 冻结调仓日与面板交易日不一致");
          const reason = rebalanceSkip(asOf, actual, rebalance);
          if (reason) return skip(reason);
          if (unavailablePool) throw new MissingStrategyData(unavailablePool);
          const archived = frozen.scheduledTargets.find(
            (row) => row.date === asOf,
          );
          if (archived && Object.keys(archived.targets).length) {
            weights = archived.targets;
            break;
          }
          // An empty archive row has no coverage flag. Replay the same close
          // to distinguish an observed empty selection from an absent section.
          archivedEmpty = archived !== undefined;
        } else {
          const reason = rebalanceSkip(
            asOf,
            await marketSessions(),
            spec.rebalanceCadence,
          );
          if (reason) return skip(reason);
          if (unavailablePool) throw new MissingStrategyData(unavailablePool);
          if (spec.panelSnapshotId || !deps.resolveAlphaComposite)
            await panel();
        }
        const options =
          frozen?.options ??
          alphaTargetOptionsSchema.parse({ topN: spec.topN });
        weights = deps.resolveAlphaComposite
          ? await deps.resolveAlphaComposite(
              spec.compositeId,
              spec.topN,
              asOf,
              {
                ...(identity.panelSnapshotId && {
                  panelSnapshotId: identity.panelSnapshotId,
                }),
                ...(frozen?.config && { config: frozen.config }),
                options,
              },
            )
          : await evaluateAlphaOnPanel(
              spec,
              asOf,
              panelRoot!,
              identity.panelSnapshotId!,
              frozen,
            );
        if (frozen && weights) {
          const positive = Object.values(weights).filter(
            (weight) => weight > 0,
          );
          if (
            (archivedEmpty && positive.length) ||
            positive.length > options.topN ||
            positive.some(
              (weight) =>
                weight !== Math.min(1 / options.topN, options.maxWeight),
            )
          )
            throw new MissingStrategyData("Alpha 目标权重与冻结参数不一致");
        }
        break;
      }
      case "macro-clock": {
        const snapshot = deps.resolveMacroClock
          ? deps.resolveMacroClock(asOf)
          : previewMacroClockAllocation({ asOfDate: asOf });
        disclosure = [snapshot.regime, snapshot.disclosure]
          .filter(Boolean)
          .join("。");
        weights = snapshot.regime === "unknown" ? null : snapshot.targets;
        break;
      }
      case "pair-switch": {
        const snapshot = deps.resolvePairSwitch
          ? await deps.resolvePairSwitch(spec.pairId, asOf, spec)
          : await localPair(spec, asOf, deps.readBars, sessions, root());
        disclosure = snapshot.disclosure ?? "";
        weights = snapshot.targets;
        break;
      }
      case "value-pit": {
        const pool = [...entries.keys()].sort();
        if (deps.resolveValuePit)
          weights = await deps.resolveValuePit(
            spec.strategyId,
            spec.topK,
            pool,
            asOf,
          );
        else if (pool.length) {
          const snapshot = await evaluateValuePitSnapshot({
            strategyId: spec.strategyId,
            symbols: pool,
            asOfDate: asOf,
            topK: spec.topK,
            tdxRoot: root(),
          });
          weights = Object.keys(snapshot.targets).length
            ? snapshot.targets
            : null;
          disclosure = snapshot.disclosure;
        } else weights = {};
        break;
      }
      case "multi-book":
        weights = deps.resolveMultiBook
          ? await deps.resolveMultiBook(spec.preset, symbols, asOf)
          : await localCoreBook(deployment.venueBinding, asOf, db);
        break;
      case "study-rule":
        evaluate = (ctx) => study(spec, ctx);
        break;
      case "theory-screener":
        evaluate = (ctx) => theory(spec, ctx);
        break;
      case "dual-breakout":
        evaluate = (ctx) => channel(spec, ctx);
        break;
      case "double-breakout":
        evaluate = ({ bars, held }) => {
          const point = analyzeBreakout(bars, 0, false, {
            trendMode: identity.trendMode,
            levelMode: identity.levelMode,
          }).latest!;
          const hit = evaluateBreakoutFilter(point, bars.at(-1)!, {
            direction: held ? "short" : "long",
            minVolumeRatio: spec.minVolumeRatio,
          });
          return hit.matched
            ? decision(
                held ? "SELL" : "BUY",
                hit.summary,
                hit.side?.score ?? null,
                hit.stopPrice,
                hit.targetPrice,
              )
            : observing(held);
        };
        break;
      case "chan-native":
        evaluate = async ({ bars, held }) => {
          const config = identity.chanConfig!;
          const { configId, ...action } = await (
            deps.resolveChan ?? evaluateLocalChan
          )(spec.profile, bars, held, config.configs);
          if (config.configId && config.configId !== configId)
            throw new MissingStrategyData("原生缠论的配置身份与冻结定义不一致");
          if (configId) config.configId = configId;
          return action;
        };
        break;
      case "crypto-dual-ma":
        evaluate = ({ bars, held }) => {
          const action = cryptoDualMa(
            bars.map((b) => b.close),
            spec.fast,
            spec.slow,
          )?.signal;
          return (held && action === "SELL") || (!held && action === "BUY")
            ? decision(action, "双均线交叉")
            : observing(held);
        };
        break;
      case "rps-momentum": {
        const section = deps.readRpsRanks
          ? await deps.readRpsRanks(spec.rpsPeriod, asOf, symbols)
          : readDecisionRps(spec.rpsPeriod, asOf, db);
        if (!section) throw new MissingStrategyData("缺少决策日 RPS 截面");
        const ranks = normalizedWeights(section);
        evaluate = ({ symbol, bars, held }) => {
          const rank = ranks.get(symbol),
            avg = ma(bars, spec.maDays ?? 20).at(-1),
            close = bars.at(-1)!.close;
          if (rank === undefined || avg == null)
            throw new MissingStrategyData("缺少决策日 RPS 或均线窗口");
          if (
            held &&
            (close < avg || rank < (spec.exitRps ?? spec.minRps - 10))
          )
            return decision("SELL", "跌破均线或 RPS 排名回落", rank);
          if (!held && rank >= spec.minRps && close > avg)
            return decision("BUY", "RPS 达标且收盘站上均线", rank);
          return observing(held);
        };
        break;
      }
      case "formula":
      case "formula-signal": {
        const buy = spec.kind === "formula" ? spec.name : spec.formulaId;
        const sell =
          spec.kind === "formula-signal" ? spec.exitFormulaId : undefined;
        let predicate = deps.evaluateFormula;
        if (!predicate) {
          const formulas =
            spec.kind === "formula"
              ? [
                  {
                    id: buy,
                    name: buy,
                    source: spec.source,
                    parameters: spec.parameters,
                  },
                ]
              : (
                  await import("../screening/formula-screen-service")
                ).savedFormulas();
          const compiled = new Map(
            [buy, ...(sell ? [sell] : [])].map((id) => {
              const formula = formulas.find((f) => f.id === id);
              if (!formula) throw new Error(`未找到选股公式 ${id}`);
              const { name, source, parameters } = formula;
              return [
                id,
                compileScreenFormula({ name, source, parameters }).compiled,
              ] as const;
            }),
          );
          predicate = (id, _symbol, bars) =>
            Boolean(compiled.get(id)!.evaluate(bars).outputs[0]?.values.at(-1));
        }
        evaluate = ({ symbol, bars, held }) => {
          const id = held ? sell : buy;
          return id && predicate(id, symbol, bars)
            ? decision(held ? "SELL" : "BUY", `触发公式 ${id}`)
            : observing(held);
        };
        break;
      }
      case "sentiment-dragon": {
        if (
          !deps.resolveSentimentDragon &&
          asOf !== beijingClock(Date.now()).date
        )
          throw new MissingStrategyData(
            "情绪龙头仅允许使用当日可观察的收盘快照",
          );
        const snapshot: Sentiment = deps.resolveSentimentDragon
          ? deps.resolveSentimentDragon(asOf)
          : sentimentRegimeSnapshot({ asOfDate: asOf });
        disclosure = `forwardOnly：${snapshot.disclosure ?? "候选仅供前向观察"}（${snapshot.phase}）`;
        if (snapshot.phase === "unknown")
          throw new MissingStrategyData("缺少决策日市场情绪数据");
        const hits = new Map(
          snapshot.candidates.map((c) => [normalizePoolSymbol(c.symbol), c]),
        );
        evaluate = ({ symbol, held }) => {
          const hit = hits.get(symbol);
          if (held && ["ebb", "ice"].includes(snapshot.phase))
            return decision("SELL", "情绪退潮，退出持仓");
          return !held &&
            hit &&
            ["recovery", "ferment"].includes(snapshot.phase)
            ? decision(
                "BUY",
                hit.reason ?? "情绪回暖，触发龙头候选",
                hit.score ?? null,
              )
            : observing(held);
        };
        break;
      }
      default:
        return spec satisfies never;
    }
    if (weights === null)
      throw new MissingStrategyData("缺少有效的决策日调仓数据");
    if (weights !== undefined) {
      const bySymbol = normalizedWeights(weights);
      if ([...bySymbol.values()].some((weight) => weight < 0 || weight > 1))
        throw new MissingStrategyData("决策日目标权重超出有效范围");
      const positive = [...bySymbol].filter(([, weight]) => weight > 0);
      if (!positive.length) {
        // A dated local allocation (or explicitly zero weights) is evidence of
        // cash. Legacy resolvers can also return an empty object for missing data.
        verifiedCash =
          bySymbol.size > 0 ||
          (spec.kind === "etf-rotation" && !deps.resolveEtfRotation) ||
          (spec.kind === "alpha-composite" && !deps.resolveAlphaComposite);
        if (!verifiedCash)
          return noAction(
            "调仓日没有可用的正权重目标，维持现有持仓",
            "missing-data",
          );
      }
      const compatible = positive.filter(
        ([symbol]) => held.has(symbol) || entries.has(symbol),
      );
      if (
        (positive.length > 0 && !compatible.length) ||
        (exactTargets && compatible.length !== positive.length)
      )
        throw new MissingStrategyData("调仓目标与部署证券池不匹配");
      targetMode = true;
      for (const symbol of symbols) {
        const weight = bySymbol.get(symbol);
        if (weight !== undefined || held.has(symbol))
          targets[symbol] = weight ?? 0;
      }
    } else if (evaluate) {
      const fills =
        held.size &&
        (spec.kind === "study-rule" || spec.kind === "theory-screener")
          ? sleeveEntries(deployment, asOf, db)
          : null;
      for (const symbol of symbols) {
        const owned = held.has(symbol);
        const bars =
          spec.kind === "sentiment-dragon"
            ? []
            : spec.kind === "crypto-dual-ma"
              ? await cryptoBars(symbol, asOf, spec, deps.readBars)
              : await readDecisionBars(symbol, asOf, deps.readBars);
        if (
          spec.kind !== "sentiment-dragon" &&
          bars.at(-1)?.date.slice(0, 10) !== asOf
        ) {
          throw new MissingStrategyData(`${symbol} 缺少决策日已收盘行情`);
        }
        const position = owned ? fills?.get(symbol) : undefined;
        const entryIndex = position
          ? bars.findIndex((bar) => bar.date === position.entryDate)
          : -1;
        const fill =
          position && entryIndex >= 0
            ? { entry: position.avgEntryPrice!, entryIndex }
            : null;
        signals.push({
          symbol,
          ...(await evaluate({ symbol, held: owned, bars, fill })),
        });
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return noAction(`${reason}，维持现有持仓`, "missing-data");
  }
  const result = evaluatedStrategyProposalSchema.parse({
    ...identity,
    ...(verifiedCash && { allocation: "cash" }),
    mode: targetMode ? "target-weights" : "delta-signals",
    asOf,
    targets,
    signals,
    regimeScale: null,
    disclosure,
  });
  if (db) {
    const trades = result.signals.filter(
      (s) => s.action !== "HOLD" && entries.has(s.symbol),
    );
    if (trades.length)
      new AccountWorkspaceRepository(db).atomic(() => {
        const current = new Map(
          getActivePoolEntries(deployment.id, db).map((e) => [e.symbol, e]),
        );
        for (const { symbol, action } of trades) {
          const entry = current.get(symbol);
          if (
            entry?.status === "watching" &&
            entry.lastCheckedDate <= asOf &&
            (!entry.lastSignalDate ||
              entry.lastSignalDate < asOf ||
              (entry.lastSignalDate === asOf &&
                entry.lastSignalAction !== action))
          )
            recordPoolEntrySignal(
              deployment.id,
              symbol,
              { signalDate: asOf, action },
              db,
            );
        }
      });
  }
  return result;
}
