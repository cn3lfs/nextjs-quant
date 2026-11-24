import {
  runPortfolio,
  replayFiveMinute,
  type PortfolioRequest,
} from "quant-backtest";
import {
  researchCostScenarios,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import type {
  TradeExcursionBarsBySymbol,
  TradeExcursionBar,
} from "quant-performance";
import type {
  ResearchStudioDraft,
  StudioResult,
} from "~/lib/research/studio-result";
import { alphaExperimentSchema } from "~/lib/research/alpha-experiment";
import { getFactorComposite } from "../../db/factor-composite-repository";
import { settings } from "../../infra/settings";
import { executeMaBaseline } from "../../backtest/ma-baseline-work";
import { runAlphaEvaluation, runAlphaTopNBacktest } from "../alpha";
import { pinnedPanel, barAt } from "../alpha/panel";
import {
  runEtfRotationBacktest,
  type EtfRotationDataSource,
} from "../etf-rotation";
import type { ExecutionRealityInput } from "../execution-reality";
import {
  costRow,
  dailyRangeDisclosure,
  emptyStudioResult,
  ledgerExcursions,
  performanceView,
  unavailableCostRow,
} from "./result-view";

type Result = ReturnType<typeof runPortfolio>;
export const closingEquity = (result: Result) =>
  result.equity.map(({ date, equity: value }) => ({ date, value }));
export function portfolioView(
  template: StudioResult["template"],
  scenario: ResearchStudioDraft["costScenario"],
  req: Readonly<PortfolioRequest>,
  selected: Result,
  signal?: AbortSignal,
): StudioResult {
  const capital = req.initial;
  const marketBars = Object.fromEntries(
    req.instruments.map((i) => [i.symbol, i.bars]),
  );
  const dates = selected.equity.map((p) => p.date);
  const excursions = ledgerExcursions(
    selected.fills,
    selected.corporateActions,
    dates,
    marketBars,
  );
  return {
    ...emptyStudioResult(template),
    ...performanceView(capital, closingEquity(selected), excursions),
    symbols: req.instruments.map((i) => i.symbol),
    strategyKey: req.strategies[0]?.id ?? null,
    costScenario: scenario,
    costScenarios: researchCostScenarios.map((cost) => {
      signal?.throwIfAborted();
      try {
        const result =
          cost === scenario
            ? selected
            : runPortfolio(
                { ...req, costs: researchExecutionCosts(req.market, cost) },
                undefined,
                undefined,
                signal,
              );
        return costRow(cost, capital, closingEquity(result), result.fills);
      } catch (error) {
        signal?.throwIfAborted();
        return unavailableCostRow(
          cost,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
    disclosures: [
      dailyRangeDisclosure,
      "成本敏感性使用同一冻结输入逐档重新撮合。历史回放仅供规则自检。",
    ],
  };
}

export async function runStudioEtfRotation(
  draft: Extract<ResearchStudioDraft, { template: "etf-rotation" }>,
  options: {
    source?: EtfRotationDataSource;
    lc5?: ExecutionRealityInput["lc5"];
    signal?: AbortSignal;
  } = {},
) {
  const run = await runEtfRotationBacktest(
    {
      config: draft.config,
      start: draft.start,
      end: draft.end,
      initial: draft.initial,
      costs: researchExecutionCosts("cn-equity", draft.costScenario),
      riskPolicy: draft.riskPolicy,
      source: options.source ?? { kind: "tdx", root: settings().tdxRoot },
      executionReality: draft.executionReality
        ? { includeExtendedWindows: false, lc5: options.lc5 }
        : undefined,
    },
    options.signal,
  );
  const result = portfolioView(
    "etf-rotation",
    draft.costScenario,
    run.portfolio,
    run.backtest,
    options.signal,
  );
  result.disclosures.push(
    "固定 ETF 研究池存在选样偏差。跨境 ETF 使用已完成的境内人民币收盘价，溢折价及 IOPV 未观测。",
    run.data.calendarBasis,
    run.data.actionsSource,
  );
  if (run.executionReality) {
    const { matrix, targetStreamHash, portfolioSourceHash } =
      run.executionReality;
    result.executionReality = {
      targetStreamHash,
      portfolioSourceHash,
      matrix: matrix.map((r) => ({
        initial: r.initial,
        window: r.window,
        totalReturn: r.performance?.totalReturn.value ?? null,
        maxDrawdown: r.performance?.maxDrawdown.value ?? null,
        fills: r.fills.length,
        requestedQuotes: r.executionCoverage.requestedQuotes,
        missingQuotes: r.executionCoverage.missingQuotes,
        firstUncertainExecutionDate: r.firstUncertainExecutionDate,
        totalFees: r.totalFees,
      })),
    };
    if (matrix.some((r) => r.executionCoverage.missingQuotes > 0))
      result.disclosures.push(
        "执行现实含缺失报价。窗口成交量或价格证据不足的情景保留缺失覆盖。",
      );
    if (!options.lc5?.length)
      result.disclosures.push(
        "本次未提供经过独立审计的 LC5 量价源，盘中窗口无法认证成交。",
      );
  } else if (draft.executionReality)
    result.disclosures.push("研究窗口没有冻结调仓目标，无法计算九格执行现实。");
  return result;
}

export async function runStudioBaseline(
  draft: Extract<ResearchStudioDraft, { template: "ma-baseline-5m" }>,
) {
  const symbol = draft.universe[0]!;
  const input = {
    symbol,
    start: draft.start,
    end: draft.end,
    initial: draft.initial,
    costs: researchExecutionCosts("cn-equity", draft.costScenario),
  };
  const { result, inputSnapshot } = await executeMaBaseline({
    type: "ma-baseline",
    root: settings().tdxRoot,
    input,
  });
  const daily = new Map<string, TradeExcursionBar>();
  for (const b of inputSnapshot.bars) {
    const date = b.date.slice(0, 10),
      prev = daily.get(date);
    daily.set(date, {
      date,
      high: Math.max(prev?.high ?? b.high, b.high),
      low: Math.min(prev?.low ?? b.low, b.low),
    });
  }
  const fills = result.fills.map((f) => ({
    ...f,
    symbol,
    date: f.barEnd,
    strategyId: result.strategyId,
    quantity: f.shares,
    holdingAfter: f.sharesAfter,
  }));
  return {
    ...emptyStudioResult(draft.template),
    ...performanceView(
      input.initial,
      result.equity,
      ledgerExcursions(fills, [], inputSnapshot.calendar, {
        [symbol]: [...daily.values()],
      }),
    ),
    costScenario: draft.costScenario,
    symbols: [symbol],
    strategyKey: result.strategyId,
    disclosures: [...result.assumptions, dailyRangeDisclosure],
    costScenarios: researchCostScenarios.map((cost) => {
      const r =
        cost === draft.costScenario
          ? result
          : replayFiveMinute(
              { ...input, costs: researchExecutionCosts("cn-equity", cost) },
              inputSnapshot.bars,
              undefined,
              inputSnapshot.signalBars,
            );
      return costRow(cost, input.initial, r.equity, r.fills);
    }),
  };
}

export async function runStudioAlpha(
  d: Extract<ResearchStudioDraft, { template: "alpha-formula" }>,
) {
  const root = settings().tdxRoot;
  const snapshot = await (async () => {
    if ("snapshot" in d.source) return d.source.snapshot;
    const saved = getFactorComposite(d.source.compositeId);
    if (!saved) throw new Error("合成配置不存在");
    const config = alphaExperimentSchema.parse({
      ...saved.config.parameters,
      factors: saved.config.factors,
      weightingMethod: saved.weightingMethod,
      neutralizationMode: saved.neutralizationMode,
      winsorizeMethod: saved.winsorizeMethod,
    });
    return (
      await runAlphaEvaluation({
        root,
        now: Date.now(),
        config,
        input: {
          start: d.start,
          end: d.end,
          snapshotId: d.source.panelId,
          targetOptions: d.source.targetOptions,
        },
      })
    ).targetSnapshot;
  })();
  const run = (costScenario: "base" | "double-cost") =>
    runAlphaTopNBacktest({
      root,
      snapshot,
      costScenario,
      initial: d.initial,
      riskPolicy: d.riskPolicy,
    });
  const base = await run("base"),
    doubled = await run("double-cost");
  const selected = d.costScenario === "base" ? base : doubled;
  const p = selected.portfolio,
    symbols = [
      ...new Set(
        snapshot.scheduledTargets.flatMap((t) => Object.keys(t.targets)),
      ),
    ];
  const bars: Record<string, TradeExcursionBar[]> = {};
  if (p.fills.length) {
    const panel = await pinnedPanel(root, snapshot.panelId);
    try {
      for (const symbol of new Set(p.fills.map((f) => f.symbol))) {
        const series = panel.sliceSymbol(symbol, snapshot.start, snapshot.end);
        const scale = panel.manifest.symbols.find(
          (s) => s.symbol === symbol,
        )!.priceScale;
        bars[symbol] = series.dates.flatMap((date, i) =>
          series.valid[i] && series.volume[i]! > 0
            ? [barAt(series, i, date, scale)]
            : [],
        );
      }
    } finally {
      panel.close();
    }
  }
  const equity = closingEquity(p);
  const view = emptyStudioResult(d.template);
  view.costScenarios[0]!.reason =
    "Alpha Top-N 执行器支持历史基础和双倍成本两档";
  return {
    ...view,
    ...performanceView(
      d.initial,
      equity,
      ledgerExcursions(
        p.fills,
        p.corporateActions,
        equity.map((r) => r.date),
        bars satisfies TradeExcursionBarsBySymbol,
      ),
    ),
    costScenario: d.costScenario,
    symbols,
    strategyKey: "alpha-top-n",
    disclosures: [
      selected.basis,
      dailyRangeDisclosure,
      "冻结面板 " + snapshot.panelId,
      "冻结目标 " + snapshot.snapshotHash,
    ],
    costScenarios: [
      view.costScenarios[0]!,
      ...[base, doubled].map((r) =>
        costRow(
          r.costScenario,
          d.initial,
          closingEquity(r.portfolio),
          r.portfolio.fills,
        ),
      ),
    ],
  };
}
