import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import type { Bar } from "trading-strategy-core/bars";
import { atr, ma } from "trading-strategy-core/indicators";
import { completedBar } from "trading-strategy-core/completed-bars";
import {
  createExtendedStudyRule,
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
import { compileScreenFormula } from "trading-strategies/formula/formula-screen";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { readLocalTradingDates } from "tstdx/local";
import { alphaExperimentSchema } from "~/lib/research/alpha-experiment";
import { cryptoSymbol } from "~/lib/market/crypto";
import {
  cryptoPeriodEnd,
  cryptoPeriodMs,
} from "~/lib/market/crypto-aggregation";
import type { DeploymentRecord as StrategyDeploymentRecord } from "../db/deployment-repository";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { getFactorComposite } from "../db/factor-composite-repository";
import { PaperRepository } from "../db/paper-repository";
import {
  getActivePoolEntries,
  listPoolEntries,
  normalizePoolSymbol,
  recordPoolEntrySignal,
  type PoolEntryRecord,
} from "../db/pool-repository";
import { settings } from "../infra/settings";
import { sentimentRegimeSnapshot } from "../market/limit-sentiment-regime";
import { resolveEtfRotationPresetTargets } from "../paper/ticket-source-catalog";
import { runAlphaEvaluation } from "../research/alpha";
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

type Spec<K extends DeployableStrategySpec["kind"]> = Extract<
  DeployableStrategySpec,
  { kind: K }
>;
// These four decision rules can also be used directly before their deployment schemas are registered.
type DecisionSpec =
  | DeployableStrategySpec
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
type Sentiment = {
  phase: string;
  candidates: readonly {
    symbol: string;
    score?: number | null;
    reason?: string;
  }[];
  disclosure?: string;
};
export type StrategyEvaluatorDeps = {
  readBars?: UniversePoolDeps["readBars"];
  resolveEtfRotation?: (
    config: Spec<"etf-rotation">["config"],
    decisionDate: string,
  ) => MaybePromise<Weights>;
  resolveAlphaComposite?: (
    compositeId: string,
    topN: number,
    decisionDate: string,
  ) => MaybePromise<Weights>;
  resolveMacroClock?: (decisionDate: string) => {
    regime: string;
    targets: Weights;
    disclosure?: string;
  };
  resolvePairSwitch?: (
    pairId: string,
    decisionDate: string,
  ) => Promise<{ targets: Weights; disclosure?: string }>;
  resolveValuePit?: (
    strategyId: string,
    topN: number,
    symbols: readonly string[],
    decisionDate: string,
  ) => Promise<Weights>;
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
  ) => MaybePromise<Weights>;
  resolveMultiBook?: (
    preset: "core-4",
    symbols: readonly string[],
    decisionDate: string,
  ) => MaybePromise<Weights>;
  resolveChan?: typeof evaluateLocalChan;
};
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

async function localEtf(config: Spec<"etf-rotation">["config"], date: string) {
  if (!completedBar(date, "day", Date.now()))
    throw new Error("ETF 决策日尚未收盘");
  const root = settings().tdxRoot;
  const preset = etfRotationCatalog.find((p) => p.id === config.strategyId);
  if (preset && isDeepStrictEqual(config, preset.defaults))
    return (await resolveEtfRotationPresetTargets(preset.id, date, root))
      .targets;
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
  const index = market.calendar.indexOf(date);
  if (index < 0) throw new Error("ETF 日历缺少决策日");
  const calendar = market.calendar.slice(0, index + 2);
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
  if (row.evidence.rows.some((r) => r.reason === "missing-history"))
    throw new Error("ETF 调仓历史窗口不足");
  return row.targets;
}

async function localAlpha(compositeId: string, topN: number, date: string) {
  const saved = getFactorComposite(compositeId);
  if (!saved) throw new Error(`未找到 Alpha 合成配置 ${compositeId}`);
  const config = alphaExperimentSchema.parse({
    ...saved.config.parameters,
    factors: saved.config.factors,
    weightingMethod: saved.weightingMethod,
    neutralizationMode: saved.neutralizationMode,
    winsorizeMethod: saved.winsorizeMethod,
  });
  const result = await runAlphaEvaluation({
    root: settings().tdxRoot,
    now: Math.min(Date.now(), Date.parse(date + "T23:59:59+08:00")),
    config,
    input: { start: date, end: date, targetOptions: { topN, every: 1 } },
  });
  const row = result.targetSnapshot.scheduledTargets.find(
    (r) => r.date === date,
  );
  if (!row) throw new Error("缺少决策日 Alpha 冻结目标");
  return row.targets;
}

async function localPair(
  spec: Spec<"pair-switch">,
  date: string,
  read: StrategyEvaluatorDeps["readBars"],
) {
  if (spec.lookback === 60 && spec.entryZ === 1.5 && spec.exitZ === 0.25) {
    const preview = await previewPairSwitchAllocation({
      pairId: spec.pairId,
      asOfDate: date,
      readBars: read,
    });
    if (preview.zScore === null) throw new Error(preview.disclosure);
    return preview;
  }
  const pair = spotPairPresets.find((p) => p.id === spec.pairId)!;
  const [a, b, calendar] = await Promise.all([
    readDecisionBars(pair.legA, date, read),
    readDecisionBars(pair.legB, date, read),
    readLocalTradingDates(settings().tdxRoot),
  ]);
  const preview = evaluatePairSwitchZScore({
    ...spec,
    asOf: date,
    legA: { symbol: pair.legA, bars: a },
    legB: { symbol: pair.legB, bars: b },
    calendar: calendar.days.filter((d) => d <= date),
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
): Promise<Decision> {
  const { analyzeCzsc } = await import("../strategies/chan/czsc");
  const codes = {
    first: ["1B", "1S", "P1B", "P1S"],
    second: ["2B", "2S", "L2B", "L2S"],
    third: ["3B", "3S"],
    "hold-cash": undefined,
  } as const;
  const hit = evaluateChanSignal(
    await analyzeCzsc(bars, true, undefined, true, 1),
    bars,
    { codes: codes[profile], direction: held ? "short" : "long" },
  );
  return hit.matched
    ? decision(
        held ? "SELL" : "BUY",
        hit.summary,
        hit.signal?.quality ?? null,
        hit.stopPrice,
        hit.targetPrice,
      )
    : observing(held);
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
  buySignalDate: string | null;
};

function study(spec: Spec<"study-rule">, { bars, held }: Context) {
  const i = bars.length - 1;
  const rule = createExtendedStudyRule(spec.strategyId, bars);
  if (rule && !held) {
    if (i < studyWarmup(spec.strategyId)) return observing(held);
    const hit = rule(i, { entry: 0, entryIndex: -1 });
    return hit.enter
      ? decision("BUY", hit.reason ?? spec.strategyId + " 触发入场")
      : observing(held);
  }
  if (spec.strategyId === "breakout")
    return channel(
      { kind: "dual-breakout", entryDays: 55, exitDays: 20 },
      { bars, held },
    );
  // Position cost and fill date are absent from this API. Use a price-only trend exit
  // rather than treating the pool admission price/date as an account fill.
  const fast = ma(bars, spec.parameters?.fast ?? 5).at(-1);
  const slow = ma(bars, spec.parameters?.slow ?? 20).at(-1);
  if (fast == null || slow == null) return observing(held);
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
  if (bars.length <= n) return observing(held);
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
  { bars, held, symbol, buySignalDate }: Context,
) {
  const prepared = prepareTheoryScreeners(
    { bars, symbol },
    { methodIds: [spec.methodId], minScore: spec.minScore },
  );
  const index = bars.length - 1;
  if (held && buySignalDate) {
    const signalIndex = bars.findIndex((b) => b.date === buySignalDate);
    if (signalIndex >= 0 && signalIndex < index) {
      // Decisions execute no earlier than the following bar.
      const entry = prepared
        .at(signalIndex)
        .find((h) => h.direction === "long");
      const close = bars[index]!.close;
      if (
        spec.useScreenerStops &&
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
      if (index - signalIndex - 1 >= spec.holdBars)
        return decision("SELL", "理论选股器观察持有期届满");
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

function normalizedWeights(weights: Weights) {
  const map = new Map<string, number>();
  for (const [raw, value] of Object.entries(weights)) {
    const symbol = normalizePoolSymbol(raw);
    if (map.has(symbol) || !Number.isFinite(value))
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
}: {
  deployment: Omit<StrategyDeploymentRecord, "strategySpec"> & {
    strategySpec: DecisionSpec;
  };
  decisionDate: string;
  activePoolEntries: readonly PoolEntryRecord[];
  heldSymbols: readonly string[];
  deps?: StrategyEvaluatorDeps;
  db?: Database.Database;
}): Promise<StrategyTargetProposal> {
  const asOf = researchDateSchema.parse(decisionDate);
  const entries = new Map(
    activePoolEntries
      .filter((e) => e.status === "watching")
      .map((e) => [normalizePoolSymbol(e.symbol), e]),
  );
  const held = new Set(heldSymbols.map(normalizePoolSymbol));
  const symbols = [...new Set([...entries.keys(), ...held])].sort();
  const spec = deployment.strategySpec;
  let disclosure = "";
  let unavailableReason: string | undefined;
  let weights: Weights | undefined;
  let evaluate: ((ctx: Context) => MaybePromise<Decision>) | undefined;
  switch (spec.kind) {
    case "etf-rotation": {
      if (deps.resolveEtfRotation) {
        const targets = await deps.resolveEtfRotation(spec.config, asOf);
        if (Object.keys(targets).length) weights = targets;
        else unavailableReason = "ETF 轮动缺少有效调仓目标";
      } else {
        // A validated local rebalance may deliberately allocate entirely to cash.
        weights = await localEtf(spec.config, asOf);
      }
      break;
    }
    case "alpha-composite":
      weights = await (deps.resolveAlphaComposite ?? localAlpha)(
        spec.compositeId,
        spec.topN,
        asOf,
      );
      break;
    case "macro-clock": {
      const snapshot = deps.resolveMacroClock
        ? deps.resolveMacroClock(asOf)
        : previewMacroClockAllocation({ asOfDate: asOf });
      if (
        snapshot.regime === "unknown" ||
        !Object.keys(snapshot.targets).length
      ) {
        unavailableReason = "宏观时钟缺少有效配置目标";
        disclosure = snapshot.disclosure ?? "";
      } else {
        weights = snapshot.targets;
        disclosure = [snapshot.regime, snapshot.disclosure]
          .filter(Boolean)
          .join("。");
      }
      break;
    }
    case "pair-switch": {
      const snapshot = deps.resolvePairSwitch
        ? await deps.resolvePairSwitch(spec.pairId, asOf)
        : await localPair(spec, asOf, deps.readBars);
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
      else {
        const snapshot = await evaluateValuePitSnapshot({
          strategyId: spec.strategyId,
          symbols: pool,
          asOfDate: asOf,
          topK: spec.topK,
        });
        weights = snapshot.targets;
        disclosure = snapshot.disclosure;
      }
      const targets = Object.fromEntries(
        [...normalizedWeights(weights)].filter(([s]) => entries.has(s)),
      );
      if (Object.keys(targets).length) weights = targets;
      else {
        weights = undefined;
        unavailableReason = "价值 PIT 缺少可用的财务归档、行情或有效配置目标";
      }
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
        const point = analyzeBreakout(bars).latest!;
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
      evaluate = ({ bars, held }) =>
        (deps.resolveChan ?? evaluateLocalChan)(spec.profile, bars, held);
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
      const ranks = normalizedWeights(
        deps.readRpsRanks
          ? await deps.readRpsRanks(spec.rpsPeriod, asOf, symbols)
          : readDecisionRps(spec.rpsPeriod, asOf, db),
      );
      evaluate = ({ symbol, bars, held }) => {
        const rank = ranks.get(symbol),
          avg = ma(bars, spec.maDays ?? 20).at(-1),
          close = bars.at(-1)!.close;
        if (
          held &&
          ((avg != null && close < avg) ||
            (rank !== undefined && rank < (spec.exitRps ?? spec.minRps - 10)))
        )
          return decision("SELL", "跌破均线或 RPS 排名回落", rank ?? null);
        if (
          !held &&
          rank !== undefined &&
          rank >= spec.minRps &&
          avg != null &&
          close > avg
        )
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
      const snapshot: Sentiment = deps.resolveSentimentDragon
        ? deps.resolveSentimentDragon(asOf)
        : sentimentRegimeSnapshot({ asOfDate: asOf });
      disclosure = `forwardOnly：${snapshot.disclosure ?? "候选仅供前向观察"}（${snapshot.phase}）`;
      const hits = new Map(
        snapshot.candidates.map((c) => [normalizePoolSymbol(c.symbol), c]),
      );
      evaluate = ({ symbol, held }) => {
        const hit = hits.get(symbol);
        if (held && ["ebb", "ice"].includes(snapshot.phase))
          return decision("SELL", "情绪退潮，退出持仓");
        return !held && hit && ["recovery", "ferment"].includes(snapshot.phase)
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
  const signals: Signal[] = [];
  const targets: Record<string, number> = {};
  if (unavailableReason) {
    const reason = `${unavailableReason}，维持现有持仓`;
    disclosure = [reason, disclosure].filter(Boolean).join("。");
    for (const symbol of [...held].sort())
      signals.push({ symbol, ...decision("HOLD", reason) });
  } else if (weights) {
    const bySymbol = normalizedWeights(weights);
    for (const symbol of symbols) {
      const weight = bySymbol.get(symbol);
      if (weight !== undefined || held.has(symbol))
        targets[symbol] = weight ?? 0;
    }
  } else if (evaluate) {
    const anchors = new Map(entries);
    if (spec.kind === "theory-screener" && db) {
      const missing = new Set(
        [...held].filter((symbol) => !entries.has(symbol)),
      );
      let cursor: string | undefined;
      while (missing.size) {
        const page = listPoolEntries(
          deployment.id,
          { status: "evicted", limit: 1000, cursor },
          db,
        );
        for (const entry of page.items)
          if (missing.delete(entry.symbol)) anchors.set(entry.symbol, entry);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
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
        signals.push({ symbol, ...decision("HOLD", "缺少决策日已收盘行情") });
        continue;
      }
      const entry = anchors.get(symbol);
      const buySignalDate =
        entry?.lastSignalAction === "BUY" ? entry.lastSignalDate : null;
      signals.push({
        symbol,
        ...(await evaluate({ symbol, held: owned, bars, buySignalDate })),
      });
    }
  }
  const result = strategyTargetProposalSchema.parse({
    mode: weights ? "target-weights" : "delta-signals",
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
