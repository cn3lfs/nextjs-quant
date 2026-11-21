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
import { readBars } from "../market/bar-store/read-bars";
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

export async function prepareLabBacktest(
  work: LabBacktestWork,
  progress: LabProgress = () => {},
  read = readBars,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const input = labBacktestSchema.parse(work.input),
    strategy = input.strategy,
    config = settings();
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
  const theory =
    strategy.entry.kind === "triple-screen"
      ? await loadTheoryMultiperiodSource({
          strategy,
          start: input.start,
          end: input.end,
          config,
          read,
          progress,
        })
      : strategy.entry.kind === "utc-orb"
        ? await loadTheoryOrbSource({
            strategy,
            start: input.start,
            end: input.end,
            config,
            read,
            progress,
          })
        : null;
  const actionSource =
    strategy.market === "cn-equity" && input.source === "local" && !theory
      ? await corporateActions(config.tdxRoot)
      : null;
  const corporateActionCoverage =
    strategy.market === "cn-equity" && input.source === "thsdk" && !theory
      ? ("excluded" as const)
      : ("included" as const);
  const instruments: PortfolioInstrument[] = theory?.instruments ?? [],
    sources: Record<string, unknown>[] = theory?.sources ?? [];
  let total = 0;
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
    const snapshot = await read(
      {
        instrument: { market: strategy.market, symbol },
        period: strategy.period,
        adjustment: strategy.market === "cn-equity" ? "forward" : "none",
        freezeRaw: true,
        root: config.tdxRoot,
        source: input.source,
        to: input.end,
        live: false,
      },
      archive ?? undefined,
    );
    signal?.throwIfAborted();
    if (
      snapshot.barStore.formingDates.length ||
      snapshot.barStore.priceRepaired
    )
      throw new Error(`${symbol}包含未完成或修复行情`);
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
    total += raw.length;
    if (total > 2000000) throw new Error("冻结行情超过200万根资源边界");
    if (
      !raw.some(
        (b) =>
          b.date.slice(0, 10) >= input.start &&
          b.date.slice(0, 10) <= input.end,
      )
    )
      throw new Error(`${symbol}区间行情缺失`);
    const actions = actionSource
      ? researchCorporateActions(
          actionSource.events.get(symbol) ?? [],
          actionSource.fingerprint,
          raw[0]!.date,
          input.end,
        )
      : [];
    instruments.push({
      symbol,
      market: strategy.market,
      bars: raw,
      signalBars: snapshot.bars,
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
      adjustment: snapshot.barStore.adjustmentReference,
      adjustmentSource:
        snapshot.barStore.adjustmentSource ??
        (strategy.market === "crypto"
          ? null
          : input.source === "thsdk"
            ? "thsdk-native"
            : "local-gbbq"),
      volumeUnit: snapshot.volumeUnit ?? null,
      dataAsOf: snapshot.barStore.coverage?.to ?? null,
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
  const frozen = {
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
    ),
    strategyBuildHash,
    executionBuildHash: forwardExecutionBuildHash(),
    boundary:
      input.source === "thsdk"
        ? "规则自检；同花顺延迟行情，信号采用原生前复权 qfq，成交采用同源未复权原价；未计入公司行动分红送转，不可与本地源结果直接比较；历史ST/IPO/排队未认证；非可信策略业绩"
        : "规则自检；当前证券池、历史ST/IPO/排队及到账日未认证；公司行动沿R2a-5研究情景，币种数量网格未认证；非可信策略业绩",
  };
  if (signal) await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
  return frozen;
}

export type FrozenLabBacktest = Awaited<ReturnType<typeof prepareLabBacktest>>;

export function replayLabBacktest(
  frozen: FrozenLabBacktest,
  progress: LabProgress = () => {},
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { request } = frozen;
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
