import { createHash } from "node:crypto";
import type { FinancialReportSnapshot } from "trading-strategy-core/financial";
import { z } from "zod";
import {
  replayAllocationStudy,
  engineVersion,
  studySignalBars,
} from "quant-backtest";
import {
  evaluateStrategy,
  strategyBuildHash,
  type Csi800Stock,
  type Csi800Allocation,
  strategyObjectSchema,
} from "trading-strategies";
import { backtestStrategy } from "./drivers/backtest";
import { equityResearchRules } from "trading-strategy-core/market-rules";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import {
  strategyCenterCandidateFields,
  captureStrategyCandidates,
} from "./strategy-center-candidates";

import { readBars } from "~/server/market/bar-store/read-bars";
import { readBacktestActions } from "../backtest/backtest-actions";
import { isStudyStockSymbol } from "~/lib/research/strategy-center-input";
import {
  readLocalFinancialHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";

const day = strategyCenterCandidateFields.asOf;
export const strategyCenterPortfolioSchema = z
  .object({
    strategyId: strategyCenterCandidateFields.strategyId,
    symbols: strategyCenterCandidateFields.symbols.refine(
      (v) => v.every(isStudyStockSymbol),
      "当前组合撮合只支持100股整手股票",
    ),
    start: day,
    end: day,
    initial: z.number().positive().finite().max(1e10).default(1000000),
    strategy: strategyObjectSchema.optional(),
  })
  .refine((v) => v.start <= v.end, "开始日期不能晚于结束日期");
type CandidateReaders = NonNullable<
  Parameters<typeof captureStrategyCandidates>[2]
>;
type Readers = CandidateReaders & {
  readBacktestActions: typeof readBacktestActions;
};
function isoWeek(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  return `${d.getUTCFullYear()}-${Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 604800000)}`;
}

type Capture = Awaited<ReturnType<typeof captureStrategyCandidates>>;
function compactCapture(
  capture: Capture,
  archive: Record<string, FinancialReportSnapshot>,
) {
  const { benchmarkBars: _benchmarkBars, evidence, ...rest } = capture;
  return {
    ...rest,
    evidence: evidence.map(({ bars, reportInputs, ...record }) => {
      const reportRefs = (reportInputs ?? []).map((report) => {
        const key = `${record.symbol}:${report.sourceSha256}:${report.reportDate}:${report.recordOffset}`;
        archive[key] ??= report;
        return key;
      });
      const factorEvidence = Array.isArray(record.factorEvidence)
        ? record.factorEvidence.map((item: unknown) => {
            if (typeof item !== "object" || item === null) return item;
            const factor = item as Record<string, unknown>;
            return {
              ...factor,
              inputs: Array.isArray(factor.inputs)
                ? factor.inputs.filter(
                    (value: unknown) =>
                      typeof value !== "object" ||
                      value === null ||
                      !["stock-day", "sh000300-day"].includes(
                        String((value as Record<string, unknown>).source),
                      ),
                  )
                : factor.inputs,
              priceReference: "frozen-stocks-and-benchmark",
            };
          })
        : record.factorEvidence;
      return {
        ...record,
        factorEvidence,
        reportRefs,
        priceRange: bars?.length
          ? { start: bars[0]!.date, end: bars.at(-1)!.date }
          : null,
      };
    }),
  };
}

/** Shared-cash historical replay; no database writes, one raw snapshot per symbol. */
export async function executeStrategyCenterPortfolio(
  raw: z.input<typeof strategyCenterPortfolioSchema>,
  root: string,
  readers: Readers = {
    readSnapshot: (root, symbol, period, options) =>
      readBars({
        instrument: { market: "cn-equity", symbol },
        root,
        period,
        adjustment: "forward",
        freezeRaw: true,
        to: raw.end,
        from: new Date(Date.parse(raw.start) - 540 * 86400000)
          .toISOString()
          .slice(0, 10),
        ...options,
      }),
    readBacktestActions,
    readLocalFinancialHistory,
    readLocalFinancialSeries,
  },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const input = strategyCenterPortfolioSchema.parse(raw);
  if (
    input.strategy &&
    (input.strategy.market !== "cn-equity" || input.strategy.period !== "day")
  )
    throw new Error("当前策略中心组合入口仅支持A股日线策略对象");
  if (
    input.end >= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  )
    throw new Error("仅支持已结束历史交易日");
  const snapshots = new Map<string, ReturnType<Readers["readSnapshot"]>>();
  const series = new Map<
    string,
    ReturnType<Readers["readLocalFinancialSeries"]>
  >();
  const reports = new Map<
    string,
    ReturnType<Readers["readLocalFinancialHistory"]>
  >();
  const cached: CandidateReaders = {
    readSnapshot: (dir, symbol, period) => {
      if (!snapshots.has(symbol))
        snapshots.set(
          symbol,
          readers.readSnapshot(dir, symbol, period).then((snapshot) => {
            // BarStore keeps the raw base history for chart consumers. This job
            // retains only its bounded warmup/window, rather than every raw bar.
            if (!snapshot.rawBars) return snapshot;
            const from = new Date(Date.parse(input.start) - 540 * 86400000)
              .toISOString()
              .slice(0, 10);
            return {
              ...snapshot,
              rawBars: snapshot.rawBars.filter(
                (b) => b.date >= from && b.date <= input.end,
              ),
            };
          }),
        );
      return snapshots.get(symbol)!;
    },
    readLocalFinancialSeries: (dir, symbol) => {
      if (!series.has(symbol))
        series.set(symbol, readers.readLocalFinancialSeries(dir, symbol));
      return series.get(symbol)!;
    },
    // Cache by historical asOf, never reuse a later date's visible report set.
    readLocalFinancialHistory: (dir, symbol, options) => {
      const key = `${symbol}:${options.asOf}`;
      if (!reports.has(key))
        reports.set(
          key,
          readers.readLocalFinancialHistory(dir, symbol, options),
        );
      return reports.get(key)!;
    },
  };
  const benchmarkSource = await cached.readSnapshot(root, "sh000300", "day");
  if (
    benchmarkSource.barStore?.priceRepaired ??
    Boolean(benchmarkSource.sourceNote)
  )
    throw new Error("基准行情含修复或丢弃");
  const first = benchmarkSource.bars.findIndex((b) => b.date >= input.start);
  if (first < 270) throw new Error("指数预热不足270日");
  if (benchmarkSource.bars.at(-1)!.date < input.end)
    throw new Error("结束日期超出基准覆盖");
  const benchmark = benchmarkSource.bars
    .slice(first - 270)
    .filter((b) => b.date <= input.end);
  if (!benchmark.some((b) => b.date >= input.start))
    throw new Error("研究区间没有交易日");
  const dates = benchmark.map((b) => b.date);
  const decisionDates = benchmarkSource.bars
    .filter(
      (b, i, all) =>
        b.date >= input.start &&
        b.date <= input.end &&
        ((all[i + 1] && isoWeek(all[i + 1]!.date) !== isoWeek(b.date)) ||
          (!all[i + 1] && new Date(`${b.date}T00:00:00Z`).getUTCDay() === 5)),
    )
    .map((b) => b.date);
  if (decisionDates.length * input.symbols.length > 100_000)
    throw new Error(
      "组合资源边界：最多10万标的×决策观察（控制财务证据与排序成本）",
    );
  const stocks: Csi800Stock[] = [];
  const sources: {
    symbol: string;
    hash: string;
    actions: Awaited<ReturnType<typeof readBacktestActions>>;
  }[] = [];
  let totalBars = benchmark.length;
  for (const symbol of input.symbols) {
    signal?.throwIfAborted();
    const source = await cached.readSnapshot(root, symbol, "day");
    if (source.barStore?.priceRepaired ?? Boolean(source.sourceNote))
      throw new Error(`${symbol}行情含修复或丢弃`);
    const bars = (source.rawBars ?? source.bars).filter(
      (b) => b.date >= dates[0]! && b.date <= input.end,
    );
    totalBars += bars.length;
    if (totalBars > 2_000_000)
      throw new Error(
        "组合资源边界：最多200万根冻结行情（控制Node堆与导出载荷）",
      );
    if (JSON.stringify(bars.map((b) => b.date)) !== JSON.stringify(dates))
      throw new Error(`${symbol}行情与基准日历不一致，不能补造停牌行情`);
    const actions = await readers.readBacktestActions(
      { ...source, bars },
      root,
    );
    if (actions.status === "missing")
      throw new Error(`${symbol}公司行动来源缺失`);
    if (
      actions.events.some(
        (e) =>
          [11, 12, 13, 14].includes(e.category) ||
          (e.category === 1 &&
            ((e.bonusRatio ?? 0) !== 0 || (e.rightsRatio ?? 0) !== 0)),
      )
    )
      throw new Error(`${symbol}存在不支持的非现金公司行动`);
    stocks.push({
      symbol,
      bars,
      ...(source.adjustment === "forward"
        ? {
            signalBars: source.bars.filter(
              (b) => b.date >= dates[0]! && b.date <= input.end,
            ),
          }
        : {}),
      actions: actions.events
        .filter((e) => e.category === 1)
        .map((e) => ({
          date: e.date,
          dividend: e.dividend ?? 0,
          bonus: 0,
          unsupported: false,
        })),
    });
    sources.push({ symbol, hash: source.hash, actions });
  }
  const schedule: Csi800Allocation[] = [];
  const decisions: {
    date: string;
    capture: ReturnType<typeof compactCapture>;
  }[] = [];
  const reportArchive: Record<string, FinancialReportSnapshot> = {};
  for (const date of input.strategy ? [] : decisionDates) {
    signal?.throwIfAborted();
    const capture = await captureStrategyCandidates(
      { strategyId: input.strategyId, symbols: input.symbols, asOf: date },
      root,
      cached,
    );
    const output = evaluateStrategy(
      { strategyId: input.strategyId },
      { asOf: date, candidates: capture.candidates },
    );
    if (output.kind !== "weights") throw new Error("组合策略未返回目标权重");
    schedule.push({
      date,
      weights: Object.fromEntries(
        output.weights.map((w) => [w.symbol, w.weight]),
      ),
    });
    decisions.push({ date, capture: compactCapture(capture, reportArchive) });
  }
  const options = {
    start: input.start,
    end: input.end,
    initial: input.initial,
    mode: "scheduled" as const,
    maximumWeight: 1,
    slippageBps: 10,
    delay: 1,
  };
  const frozen = {
    version: "strategy-center-portfolio-input-1",
    input,
    engineVersion,
    strategyBuildHash,
    benchmarkHash: benchmarkSource.hash,
    benchmark,
    stocks,
    sources,
    schedule,
    decisions,
    reportArchive,
    options,
    ...(input.strategy ? { strategyObject: input.strategy } : {}),
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(frozen))
    .digest("hex");
  signal?.throwIfAborted();
  const portfolio = input.strategy
    ? backtestStrategy({
        market: "cn-equity",
        initial: input.initial,
        costs: { ...defaultExecutionCosts, slippageBps: options.slippageBps },
        observationDetail: "full",
        start: input.start,
        end: input.end,
        calendar: dates,
        strategies: [input.strategy],
        sleeves: [
          {
            id: input.strategy.sleeve,
            share: 1,
            riskPerTrade: 0.02,
            maxPositions: input.symbols.length,
          },
        ],
        memberships: dates.map((date) => ({
          strategyId: input.strategy!.id,
          date,
          availableAt: date,
          symbols: input.symbols,
        })),
        instruments: stocks.map((stock) => ({
          symbol: stock.symbol,
          market: "cn-equity" as const,
          bars: stock.bars,
          signalBars:
            stock.signalBars ??
            studySignalBars(
              stock.bars,
              stock.actions.map((a) => ({
                date: a.date,
                perShare: a.dividend,
              })),
            ),
          execution: Object.fromEntries(
            stock.bars.map((b, i) => {
              const rules = equityResearchRules(stock.symbol, b.date);
              const action = stock.actions.find((a) => a.date === b.date);
              const reference =
                (stock.bars[i - 1]?.close ?? b.close) - (action?.dividend ?? 0);
              return [
                b.date,
                {
                  evidence:
                    "explicit-non-ST-board-scenario-not-certified-history",
                  minimum: rules.minimum,
                  step: rules.step,
                  limitUp:
                    Math.round(reference * (1 + rules.limit) * 100) / 100,
                  limitDown:
                    Math.round(reference * (1 - rules.limit) * 100) / 100,
                  tradable: true,
                },
              ];
            }),
          ),
          actions: stock.actions.map((a) => ({
            date: a.date,
            availableAt: a.date,
            evidence: "frozen-gbbq-scenario",
            dividend: a.dividend,
            bonus: 0,
          })),
        })),
      })
    : null;
  const holdingCounts = new Map<string, number>();
  for (const p of portfolio?.positionSnapshots ?? [])
    holdingCounts.set(p.date, (holdingCounts.get(p.date) ?? 0) + 1);
  const result = portfolio
    ? {
        version: "strategy-object-portfolio-1",
        options,
        initial: input.initial,
        curve: portfolio.curve.map((row) => ({
          date: row.date,
          cash: row.cash,
          equity: row.equity,
          exposure: 1 - row.cash / row.equity,
          holdings: holdingCounts.get(row.date) ?? 0,
        })),
        fills: portfolio.fills.map((fill) => ({
          date: fill.date,
          signalDate: fill.signalAt,
          symbol: fill.symbol,
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
        })),
        rejected: portfolio.rejections.map((rejection) => ({
          date: rejection.date,
          symbol: portfolio.orders.find((o) => o.id === rejection.orderId)!
            .symbol,
          side: portfolio.orders.find((o) => o.id === rejection.orderId)!.side,
          reason: rejection.reason,
        })),
        snapshots: portfolio.positionSnapshots.map((p) => ({
          date: p.date,
          symbol: p.symbol,
          quantity: p.quantity,
          weight: p.weight,
        })),
        rebalances: [],
      }
    : replayAllocationStudy(stocks, benchmark, options, schedule);
  return {
    frozen,
    inputHash,
    result,
    ...(portfolio ? { portfolio } : {}),
    quality: "rule-check-only" as const,
    limitations: [
      "用户显式固定证券池，存在幸存者偏差，不代表历史全市场证券池。",
      input.strategy
        ? "策略对象逐完成日线求值，按策略分批与退出，下一交易日开盘撮合；sleeve风险上限2%，100股整手、T+1及固定实验费用。"
        : "每ISO周最后交易日收盘决策，下一交易日开盘撮合；使用共享现金、100股整手、T+1及现有费用。",
      "单股目标权重上限为100%，不额外叠加中证800旧15%限制；未成交资金留现金。",
      "排序因子使用BarStore前复权行情、成交使用对应原价；财报采用当前下载版本的严格公告可见日期，不保证首次披露版本。",
      "历史交易状态、成交容量、排队、分红实际到账日尚未认证；结果仅为规则自检。",
    ],
  };
}
