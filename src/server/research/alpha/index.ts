import { z } from "zod";
import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioExecution,
} from "quant-backtest";
import {
  executionInstrumentKind,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import type { Bar } from "trading-strategy-core/bars";
import { researchNavStatistics } from "~/lib/research/strategy-research";
import {
  alphaExperimentSchema,
  alphaEvaluationInputSchema,
  evaluateAlphaExperiment,
  alphaBacktestInputSchema,
  type AlphaBacktestInput,
  toScheduledTargets,
  type AlphaEvaluationResult,
} from "~/lib/research/alpha-experiment";
import { panelFlags, type MarketPanelHandle } from "../../market/market-panel";
import {
  researchCorporateActions,
  researchExecutionAt,
} from "../corporate-actions";
import {
  alphaPanelDates,
  barAt,
  compileFactors,
  loadAlphaPanel,
  pinnedPanel,
} from "./panel";

const evaluateSchema = z
  .object({
    root: z.string().min(1),
    now: z.number().int().safe().nonnegative(),
    config: alphaExperimentSchema,
    input: alphaEvaluationInputSchema,
  })
  .strict();
export type AlphaEvaluationWorkInput = z.input<typeof evaluateSchema>;
export async function runAlphaEvaluation(
  raw: AlphaEvaluationWorkInput,
  progress?: (percent: number, phase: string) => void,
): Promise<AlphaEvaluationResult> {
  const { root, input, config, now } = evaluateSchema.parse(raw);
  const programs = compileFactors(config);
  const handle = await pinnedPanel(root, input.snapshotId);
  try {
    const panel = loadAlphaPanel(
      handle,
      input,
      config,
      programs,
      now,
      progress,
    );
    progress?.(80, "截面中性化、成熟标签合成与分组评估");
    return await evaluateAlphaExperiment(panel, config, input);
  } finally {
    handle.close();
  }
}

export {
  alphaBacktestInputSchema,
  type AlphaBacktestInput,
} from "~/lib/research/alpha-experiment";
const backtestSchema = alphaBacktestInputSchema.extend({
  root: z.string().min(1),
});

function instrument(
  handle: MarketPanelHandle,
  symbol: string,
  start: string,
  end: string,
  warmRiskIndicators: boolean,
  sessions: ReadonlySet<string> | undefined,
): PortfolioInstrument {
  const s = handle.manifest.symbols.find(
    (s) => s.symbol === symbol && s.kind === "stock",
  );
  if (!s) throw new Error("冻结目标股票不在面板中 " + symbol);
  if (s.firstDate > end)
    throw new Error("冻结目标早于股票的首条行情 " + symbol);
  const actions = researchCorporateActions(
    handle
      .events(symbol, end)
      .flatMap((e) => (e.kind === "gbbq" ? [e.raw] : [])),
    handle.snapshotId,
    start,
    end,
  );
  const bars: Bar[] = [],
    signalBars: Bar[] = [],
    execution: Record<string, PortfolioExecution> = {};
  const row = handle.sliceSymbol(symbol, s.firstDate, end);
  let previous: Bar | undefined, industry: number | undefined;
  for (const [i, date] of row.dates.entries()) {
    if (sessions && !sessions.has(date)) continue;
    if (date <= start && row.industryCode[i]! > 0)
      industry = row.industryCode[i];
    if (!(row.closeAtoms[i]! > 0 && row.volume[i]! > 0)) continue;
    const b = barAt(row, i, date, s.priceScale);
    if (row.valid[i] && (date >= start || warmRiskIndicators)) {
      bars.push(b);
      if (warmRiskIndicators) {
        const factor = row.adjFactor[i]!;
        if (!(Number.isFinite(factor) && factor > 0))
          throw new Error("ATR 风控缺少因果复权价格 " + symbol + " " + date);
        signalBars.push(barAt(row, i, date, s.priceScale, factor));
      }
    }
    if (date >= start && row.valid[i]) {
      const flags = row.statusFlags[i]!,
        status =
          flags & panelFlags.stKnown
            ? {
                st: Boolean(flags & panelFlags.st),
                date,
                source: "冻结面板 GP29",
              }
            : undefined;
      const facts = researchExecutionAt(symbol, b, previous, actions, status)!;
      // Verified GP15 one-price limits supersede the estimated board band.
      if (flags & panelFlags.onePriceLimitUp) facts.limitUp = b.open;
      if (flags & panelFlags.onePriceLimitDown) facts.limitDown = b.open;
      execution[date] = facts;
    }
    previous = b;
  }
  return {
    symbol,
    market: "cn-equity",
    instrumentKind: executionInstrumentKind(symbol, end),
    bars,
    signalBars: warmRiskIndicators ? signalBars : bars,
    actions,
    execution,
    industry: industry === undefined ? undefined : String(industry),
  };
}
export async function runAlphaTopNBacktest(
  raw: AlphaBacktestInput & { root: string },
) {
  const { root, snapshot, initial, riskPolicy, costScenario } =
    backtestSchema.parse(raw);
  const scheduledTargets = await toScheduledTargets(snapshot);
  const handle = await pinnedPanel(root, snapshot.panelId);
  try {
    const sessions = alphaPanelDates(handle, snapshot.calendarIndex);
    const calendar = sessions.filter(
      (d) => d >= snapshot.start && d <= snapshot.end,
    );
    if (!calendar.length) throw new Error("冻结目标与面板日历无交集");
    const scheduled = calendar.filter(
      (_, i) => i % snapshot.options.every === 0,
    );
    if (
      scheduled.length !== scheduledTargets.length ||
      scheduled.some((d, i) => d !== scheduledTargets[i]!.date)
    )
      throw new Error("冻结调仓日与面板日历不一致");
    const symbols = [
      ...new Set(scheduledTargets.flatMap((d) => Object.keys(d.targets))),
    ].sort();
    const start = calendar[0]!,
      end = calendar.at(-1)!;
    const indexSessions = snapshot.calendarIndex
      ? new Set(sessions)
      : undefined;
    const instruments = symbols.map((s) =>
      instrument(
        handle,
        s,
        start,
        end,
        riskPolicy !== undefined,
        indexSessions,
      ),
    );
    if (!instruments.length) {
      const anchor = handle.manifest.symbols.find((s) => s.kind === "stock");
      if (!anchor) throw new Error("面板缺少股票");
      symbols.push(anchor.symbol);
      // runPortfolio requires an instrument even for an all-cash schedule.
      instruments.push({
        symbol: anchor.symbol,
        market: "cn-equity",
        instrumentKind: executionInstrumentKind(anchor.symbol, end),
        bars: [],
        signalBars: [],
        execution: {},
      });
    }
    const matched = runPortfolio({
      market: "cn-equity",
      initial,
      start,
      end,
      calendar,
      scheduledTargets,
      instruments,
      sleeves: [
        {
          id: "alpha",
          share: 1,
          riskPerTrade: 1,
          maxPositions: snapshot.options.topN,
        },
      ],
      strategies: [
        {
          id: "alpha-top-n",
          version: 1,
          market: "cn-equity",
          period: "day",
          universe: { kind: "symbols", symbols },
          entry: { kind: "constant", value: false },
          exit: { rule: { kind: "constant", value: false } },
          sizing: { kind: "weight", weight: 1 },
          sleeve: "alpha",
        },
      ],
      accountMaxUniqueSymbols: snapshot.options.topN,
      accountMaxSymbolWeight: snapshot.options.maxWeight,
      riskPolicy,
      costs: researchExecutionCosts("cn-equity", costScenario),
    });
    return {
      panelId: handle.snapshotId,
      costScenario,
      initial,
      portfolio: matched,
      metrics: researchNavStatistics(
        initial,
        matched.equity.map((p) => p.equity),
        0,
      ),
      basis:
        "冻结收盘目标；下一交易日由组合引擎按原价、T+1、历史费税与板块涨跌停规则尝试撮合。受阻买单按引擎规则拒单，卖单可继续等待。GP29/ST 及 GP15 一字板以本地证据为准。行业风控使用区间首日已知分类。IPO、成交排队与 GBBQ 除权日现金到账为研究假设。",
    };
  } finally {
    handle.close();
  }
}
export type AlphaBacktestResult = Awaited<
  ReturnType<typeof runAlphaTopNBacktest>
>;
export type AlphaWork =
  | {
      type: "factor-eval";
      mode: "alpha-composite";
      payload: z.infer<typeof evaluateSchema>;
    }
  | {
      type: "factor-eval";
      mode: "alpha-backtest";
      payload: z.infer<typeof backtestSchema>;
    };
