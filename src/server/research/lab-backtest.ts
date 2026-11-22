import { loadTheoryMultiperiodSource } from "./theory-multiperiod-source";
import { loadTheoryOrbSource } from "./theory-orb-source";
import { labBacktestEvidence } from "./lab-backtest-evidence";
import { freezePortfolioExecution } from "./freeze-portfolio-execution";
import { forwardExecutionBuildHash } from "./forward-identity";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  runPortfolio,
  type PortfolioExecution,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import { createPerformanceReport } from "quant-performance";
import { strategyBuildHash, usesStrategyBook } from "trading-strategies";
import { labBacktestSchema } from "~/lib/research/lab-backtest";
import type { Settings } from "~/lib/domain";
import { researchStrategyVersion } from "~/lib/research/strategy-version";
import { readBars } from "../market/bar-store/read-bars";
import { BarResourceBudget } from "../market/bar-store/resource-budget";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";
import { corporateActions } from "../market/bar-store/corporate-actions";
import {
  researchCorporateActions,
  researchExecutionEvidence,
} from "./corporate-actions";
import { settings } from "../infra/settings";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";
import { dailyEquity } from "~/lib/backtest/daily-equity";
import { isAShareStockSymbol } from "~/lib/market/security-classification";
import {
  causalResearchPrices,
  hasCausalPriceProof,
  missingCausalPriceBasis,
  readResearchPriceActions,
  requiresCausalPriceBasis,
  type CausalPriceProof,
} from "./causal-price-basis";

function isExecutionFact(
  value: PortfolioInstrument["execution"],
): value is PortfolioExecution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    typeof candidate.evidence === "string" &&
    typeof candidate.minimum === "number"
  );
}

/** Freeze the price and quantity assumptions actually handed to the engine.
 * Board/limit facts remain scenario evidence, never historical certification. */
function frozenMarketPolicy(
  market: "cn-equity" | "crypto",
  instruments: readonly PortfolioInstrument[],
  theory: boolean,
  source: "local" | "thsdk",
  causal: boolean,
) {
  const cells = new Set<string>();
  for (const instrument of instruments) {
    const execution = instrument.execution;
    if (typeof execution === "function") {
      cells.add("per-date");
      continue;
    }
    if (isExecutionFact(execution)) {
      cells.add(`${execution.minimum}/${execution.step}`);
      continue;
    }
    for (const fact of Object.values(execution))
      cells.add(`${fact.minimum ?? "unknown"}/${fact.step ?? "unknown"}`);
  }
  return {
    signalBars:
      market === "crypto"
        ? "none（原始归档）"
        : source === "thsdk"
          ? "同花顺原生前复权 qfq（frozen.sources[].adjustment）"
          : theory
            ? "per-symbol GBBQ anchor（frozen.sources[].adjustmentId）"
            : causal
              ? "逐 bar 因果 GBBQ 因子，首根原价固定锚（frozen.sources[].causalPrice）"
              : "forward（frozen.sources[].adjustment）",
    executionBars: "raw（未复权原价，仅用原价成交）",
    quantityGrid:
      market === "cn-equity"
        ? {
            kind: "cn-board-research-scenario",
            minimumStepCells: [...cells].sort(),
            evidence:
              "主板100/100，科创板200/1，创业板2020-08-24起100/100；历史ST/IPO/排队未认证",
          }
        : {
            kind: "crypto-research-step",
            minimumStepCells: [...cells].sort(),
            evidence: "固定研究数量网格，非场所可成交量认证",
          },
    priceLimits:
      market === "cn-equity"
        ? "板块涨跌停研究情景；历史ST/IPO/排队未认证"
        : "无涨跌停；场所过滤未认证",
  };
}

export type LabBacktestWork = {
  type: "lab-backtest";
  input: z.input<typeof labBacktestSchema>;
};
type LabProgress = (n: number, phase: string) => void;
export type LabBacktestPrepareOptions = {
  /** Supplied by diagnostic CLIs so no production settings database is opened. */
  config?: Settings;
  /** Force the causal price basis even when the rule alone does not require it. */
  forceCausalPrice?: boolean;
  /** `record-only` keeps repaired bars visible instead of rejecting the run. */
  dataQualityMode?: "strict" | "record-only";
  /**
   * Whole-file GBBQ parse issues and category 13/14 warrant entitlements are
   * rejected by default. `record-only` skips those per symbol, passes the
   * filtered events downstream and discloses the counts/dates in `sources`.
   * It only takes effect together with `dataQualityMode: "record-only"`.
   */
  gbbqIssuePolicy?: "strict" | "record-only";
};

export async function prepareLabBacktest(
  work: LabBacktestWork,
  progress: LabProgress = () => {},
  read = readBars,
  signal?: AbortSignal,
  options?: LabBacktestPrepareOptions,
) {
  signal?.throwIfAborted();
  const input = labBacktestSchema.parse(work.input),
    strategy = input.strategy,
    config = options?.config ?? settings();
  const causal =
    requiresCausalPriceBasis(strategy) || options?.forceCausalPrice === true;
  // Relaxed GBBQ handling is opt-in and only valid alongside record-only data.
  const recordOnlyGbbq =
    options?.dataQualityMode === "record-only" &&
    options?.gbbqIssuePolicy === "record-only";
  if (strategy.universe.kind !== "symbols")
    throw new Error(
      "请提交已冻结明确证券名单的策略对象；RPS/时点成分须从研究任务冻结",
    );
  const symbols = strategy.universe.symbols;
  if (
    strategy.market === "cn-equity" &&
    strategy.period !== "day" &&
    strategy.entry.kind !== "triple-screen"
  )
    throw new Error(
      "此组合入口要求A股日线执行证据；五分钟实验请使用下方现行入口",
    );
  if (!symbols.length || symbols.length > 6000)
    throw new Error("证券池须为1至6000只");
  if (input.source === "thsdk") {
    for (const symbol of symbols) {
      if (!isAShareStockSymbol(symbol))
        throw new Error(
          `同花顺回测仅支持 A 股股票标的，不支持指数或非股票代码：${symbol}`,
        );
    }
    if (causal)
      throw new Error(`${missingCausalPriceBasis}（同花顺仅提供区间前复权）`);
  }
  if (
    strategy.market === "crypto" &&
    symbols.some((s) => !["cxBTCUSDT", "cxETHUSDT"].includes(s))
  )
    throw new Error("实验室数字货币范围为BTC/ETH");
  if (
    JSON.stringify(strategy).match(
      /"kind":"(?:external|chan-third-buy|czsc-monitor|historical-low|rps)"/,
    )
  )
    throw new Error(
      "该策略需要原生/时点外部证据；请使用冻结研究任务及其报告，不能以缺失输入回测",
    );
  const budget = new BarResourceBudget();
  const readForTask: typeof readBars = (query, frozen, fetchHistory) =>
    read(query, frozen, fetchHistory, budget);
  const theory =
    strategy.entry.kind === "triple-screen"
      ? await loadTheoryMultiperiodSource({
          strategy,
          start: input.start,
          end: input.end,
          config,
          read: readForTask,
          progress,
        })
      : strategy.entry.kind === "utc-orb"
        ? await loadTheoryOrbSource({
            strategy,
            start: input.start,
            end: input.end,
            config,
            read: readForTask,
            progress,
          })
        : null;
  const actionSource =
    strategy.market === "cn-equity" && input.source === "local" && !theory
      ? causal
        ? await readResearchPriceActions(config.tdxRoot).catch(
            (error: unknown) => {
              throw new Error(
                `${missingCausalPriceBasis}：${error instanceof Error ? error.message : String(error)}`,
              );
            },
          )
        : await corporateActions(config.tdxRoot)
      : null;
  const corporateActionCoverage =
    strategy.market === "cn-equity" && input.source === "thsdk" && !theory
      ? ("excluded" as const)
      : ("included" as const);
  const instruments: PortfolioInstrument[] = theory?.instruments ?? [],
    sources: Record<string, unknown>[] = theory?.sources ?? [];
  for (const symbol of theory ? [] : symbols) {
    signal?.throwIfAborted();
    const archive =
      strategy.market === "crypto"
        ? await binanceArchiveSource({
            symbol,
            period: strategy.period,
            configuredRoot: config.binancePublicDataRoot,
            to: input.end,
            now: Date.now(),
          })
        : undefined;
    if (strategy.market === "crypto" && !archive)
      throw new Error(`${symbol}缺少本地原生周期官方归档，请在系统回填`);
    const snapshot = await readForTask(
      {
        instrument: { market: strategy.market, symbol },
        period: strategy.period,
        adjustment:
          strategy.market === "cn-equity" && !causal ? "forward" : "none",
        freezeRaw: true,
        root: config.tdxRoot,
        source: input.source,
        to: input.end,
        live: false,
      },
      archive ?? undefined,
    );
    signal?.throwIfAborted();
    if (snapshot.barStore.formingDates.length)
      throw new Error(`${symbol}包含未完成行情`);
    if (
      snapshot.barStore.priceRepaired &&
      options?.dataQualityMode !== "record-only"
    )
      throw new Error(`${symbol}包含修复行情`);
    if (input.source === "thsdk" && !snapshot.rawBars)
      throw new Error(`${symbol}缺少同花顺未复权成交原价`);
    const raw = snapshot.rawBars ?? snapshot.bars;
    if (
      raw.length !== snapshot.bars.length ||
      raw.some((b, i) => b.date !== snapshot.bars[i]!.date)
    )
      throw new Error(`${symbol}原价与信号周期未对齐`);
    const step = cryptoPeriodMs[strategy.period];
    if (
      strategy.market === "crypto" &&
      (!step ||
        raw.some(
          (b, i) =>
            i > 0 && Date.parse(b.date) - Date.parse(raw[i - 1]!.date) !== step,
        ))
    )
      throw new Error(`${symbol}原生周期行情存在缺口，不能跳过后回测`);
    if (
      !raw.some(
        (b) =>
          b.date.slice(0, 10) >= input.start &&
          b.date.slice(0, 10) <= input.end,
      )
    )
      throw new Error(`${symbol}区间行情缺失`);
    const rawSymbolEvents = actionSource?.events.get(symbol) ?? [];
    // Warrants (category 13/14) have no research action model; in record-only
    // mode drop them before the strict converters and disclose the dates.
    const skippedWarrants = recordOnlyGbbq
      ? [
          ...new Set(
            rawSymbolEvents
              .filter((event) => event.category === 13 || event.category === 14)
              .map((event) => event.date),
          ),
        ].sort()
      : [];
    const symbolEvents = recordOnlyGbbq
      ? rawSymbolEvents.filter(
          (event) => event.category !== 13 && event.category !== 14,
        )
      : rawSymbolEvents;
    const actionFingerprint =
      actionSource &&
      ("fingerprint" in actionSource
        ? actionSource.fingerprint
        : actionSource.sourceSha256);
    const actions =
      actionSource && actionFingerprint
        ? researchCorporateActions(
            symbolEvents,
            actionFingerprint,
            raw[0]!.date,
            input.end,
          )
        : [];
    const gbbqIssueCount =
      actionSource && "issues" in actionSource
        ? actionSource.issues.length
        : undefined;
    let signalBars = snapshot.bars;
    let causalPrice: CausalPriceProof | undefined;
    if (causal && actionSource && "issues" in actionSource) {
      if (snapshot.adjustment !== "none")
        throw new Error(`${symbol}：${missingCausalPriceBasis}（缺少原价）`);
      try {
        const price = causalResearchPrices(
          [...raw],
          symbolEvents,
          actionSource.sourceSha256,
          recordOnlyGbbq ? [] : actionSource.issues,
        );
        signalBars = price.bars;
        causalPrice = price.proof;
      } catch (error) {
        throw new Error(
          `${symbol}：${missingCausalPriceBasis}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    instruments.push({
      symbol,
      market: strategy.market,
      bars: raw,
      signalBars,
      actions,
      execution:
        strategy.market === "cn-equity"
          ? researchExecutionEvidence(symbol, raw, actions)
          : {
              evidence:
                "R2a-5 research quantity grid; not verified venue filters",
              minimum: 0.000001,
              step: 0.000001,
              limitUp: null,
              limitDown: null,
              tradable: true,
            },
    });
    sources.push({
      symbol,
      hash: snapshot.hash,
      source: snapshot.source,
      adjustment: causalPrice?.kind ?? snapshot.barStore.adjustmentReference,
      ...(causalPrice ? { causalPrice } : {}),
      adjustmentSource:
        snapshot.barStore.adjustmentSource ??
        (strategy.market === "crypto"
          ? null
          : input.source === "thsdk"
            ? "thsdk-native"
            : "local-gbbq"),
      volumeUnit: snapshot.volumeUnit ?? null,
      dataAsOf: snapshot.barStore.coverage?.to ?? null,
      priceRepaired: snapshot.barStore.priceRepaired ?? false,
      sourceNote: snapshot.sourceNote ?? null,
      // Only disclosed under the record-only GBBQ policy; strict runs that
      // reach this point have no issues or warrants to report.
      ...(recordOnlyGbbq
        ? {
            ...(gbbqIssueCount === undefined
              ? {}
              : {
                  gbbqIssueCount,
                  gbbqIssueNote: `整份 GBBQ 有 ${gbbqIssueCount} 条未解析记录（代码/市场/类别未识别等），属于全文件计数，不证明 ${symbol} 事件完整`,
                }),
            skippedWarrants,
          }
        : {}),
    });
    progress(
      Math.floor((instruments.length / symbols.length) * 70),
      `冻结 ${symbol}`,
    );
  }
  const calendar =
    theory?.calendar ??
    [...new Set(instruments.flatMap((i) => i.bars.map((b) => b.date)))].sort();
  const request: PortfolioRequest = {
    market: strategy.market,
    observationDetail: usesStrategyBook(strategy) ? "full" : "counts",
    initial: input.initial,
    start: theory?.start ?? input.start,
    end: theory?.end ?? input.end,
    calendar,
    instruments: instruments.map(freezePortfolioExecution),
    strategies: [strategy],
    sleeves: [
      {
        id: strategy.sleeve,
        share: 1,
        riskPerTrade: input.riskPerTrade,
        maxPositions: input.maxPositions,
      },
    ],
    costs: researchExecutionCosts(strategy.market, input.costScenario),
  };
  // The diagnostic CLIs run without the packaged validation worker. A missing
  // runtime identity only removes provenance there; production and paper paths
  // pass no options and keep failing as before.
  let executionBuildHash: string;
  try {
    executionBuildHash = forwardExecutionBuildHash();
  } catch (error) {
    if (!options) throw error;
    executionBuildHash = "diagnostic-no-runtime-identity";
  }
  const frozen = {
    timingContract: "p5" as const,
    request,
    sources,
    dataSource: input.source,
    corporateActionCoverage,
    costScenario: input.costScenario,
    marketPolicy: frozenMarketPolicy(
      strategy.market,
      request.instruments,
      !!theory,
      input.source,
      causal,
    ),
    strategyBuildHash,
    strategySemanticVersion: researchStrategyVersion(strategy),
    executionBuildHash,
    boundary:
      input.source === "thsdk"
        ? "规则自检；同花顺延迟行情，信号采用原生前复权 qfq，成交采用同源未复权原价；未计入公司行动分红送转，不可与本地源结果直接比较；历史ST/IPO/排队未认证；非可信策略业绩"
        : "规则自检；当前证券池、历史ST/IPO/排队及到账日未认证；公司行动沿R2a-5研究情景，币种数量网格未认证；非可信策略业绩",
  };
  if (signal) await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
  return frozen;
}

export type FrozenLabBacktest = Omit<
  Awaited<ReturnType<typeof prepareLabBacktest>>,
  "timingContract" | "strategySemanticVersion"
> & {
  timingContract?: "p5";
  strategySemanticVersion?: ReturnType<typeof researchStrategyVersion>;
};

export function replayLabBacktest(
  frozen: FrozenLabBacktest,
  progress: LabProgress = () => {},
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { request } = frozen;
  if (request.strategies.some(requiresCausalPriceBasis)) {
    const proofs = new Map(
      frozen.sources.map((source) => [
        source.symbol,
        source.causalPrice as CausalPriceProof | undefined,
      ]),
    );
    for (const instrument of request.instruments)
      if (
        !hasCausalPriceProof(
          proofs.get(instrument.symbol),
          instrument.bars,
          instrument.signalBars,
        )
      )
        throw new Error(`${instrument.symbol}：${missingCausalPriceBasis}`);
  }
  const inputHash = createHash("sha256")
    .update(JSON.stringify(frozen))
    .digest("hex");
  const result = runPortfolio(
    request,
    (done, count) => {
      signal?.throwIfAborted();
      progress(70 + Math.floor((done / Math.max(1, count)) * 30), "组合回放");
    },
    undefined,
    signal,
  );
  const performance = createPerformanceReport(
    request.initial,
    dailyEquity(result.curve),
    undefined,
    request.market === "crypto" ? 365 : 252,
  );
  const evidence = labBacktestEvidence(request, result);
  return {
    inputHash,
    timingStatus:
      frozen.strategyBuildHash !== strategyBuildHash
        ? ("drift" as const)
        : frozen.timingContract === "p5"
          ? ("p5" as const)
          : ("unknown" as const),
    frozen,
    result,
    overview: performance.overview,
    signalEvidence: evidence.signals,
    inputDiagnostics: evidence.diagnostics,
  };
}

export async function executeLabBacktest(
  work: LabBacktestWork,
  progress: LabProgress = () => {},
  read = readBars,
  signal?: AbortSignal,
) {
  const frozen = await prepareLabBacktest(work, progress, read, signal);
  return replayLabBacktest(frozen, progress, signal);
}
