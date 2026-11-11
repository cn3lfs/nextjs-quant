import { createHash } from "node:crypto";
import type { FinancialReportSnapshot } from "trading-strategy-core/financial";
import { z } from "zod";
import { runCsi800Study, engineVersion } from "quant-backtest";
import {
  evaluateStrategy,
  strategyBuildHash,
  type Csi800Stock,
  type Csi800Allocation,
} from "trading-strategies";
import {
  strategyCenterCandidateFields,
  captureStrategyCandidates,
} from "./strategy-center-candidates";
import { readSnapshot } from "../data-sources/tdx/tdx";
import { readBacktestActions } from "../backtest/backtest-actions";
import {
  readLocalFinancialHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";

const day = strategyCenterCandidateFields.asOf;
export const strategyCenterPortfolioSchema = z
  .object({
    strategyId: strategyCenterCandidateFields.strategyId,
    symbols: strategyCenterCandidateFields.symbols
      .refine((v) => v.length <= 50, "组合最多50只股票")
      .refine(
        (v) => v.every((s) => /^(sh60|sz00|sz30)\d{4}$/.test(s)),
        "当前组合撮合只支持100股整手股票",
      ),
    start: day,
    end: day,
    initial: z.number().positive().finite().max(1e10).default(1000000),
  })
  .refine((v) => v.start <= v.end, "开始日期不能晚于结束日期")
  .refine(
    (v) => (Date.parse(v.end) - Date.parse(v.start)) / 86400000 <= 731,
    "组合研究区间最多两年",
  );
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
    readSnapshot,
    readBacktestActions,
    readLocalFinancialHistory,
    readLocalFinancialSeries,
  },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const input = strategyCenterPortfolioSchema.parse(raw);
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
        snapshots.set(symbol, readers.readSnapshot(dir, symbol, period));
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
  if (benchmarkSource.sourceNote) throw new Error("基准行情含修复或丢弃");
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
  const stocks: Csi800Stock[] = [];
  const sources: {
    symbol: string;
    hash: string;
    actions: Awaited<ReturnType<typeof readBacktestActions>>;
  }[] = [];
  for (const symbol of input.symbols) {
    signal?.throwIfAborted();
    const source = await cached.readSnapshot(root, symbol, "day");
    if (source.sourceNote) throw new Error(`${symbol}行情含修复或丢弃`);
    const bars = source.bars.filter(
      (b) => b.date >= dates[0]! && b.date <= input.end,
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
  const decisionDates = benchmarkSource.bars
    .filter(
      (b, i, all) =>
        b.date >= input.start &&
        b.date <= input.end &&
        ((all[i + 1] && isoWeek(all[i + 1]!.date) !== isoWeek(b.date)) ||
          (!all[i + 1] && new Date(`${b.date}T00:00:00Z`).getUTCDay() === 5)),
    )
    .map((b) => b.date);
  if (decisionDates.length > 104) throw new Error("组合研究最多104个周度决策");
  const schedule: Csi800Allocation[] = [];
  const decisions: {
    date: string;
    capture: ReturnType<typeof compactCapture>;
  }[] = [];
  const reportArchive: Record<string, FinancialReportSnapshot> = {};
  for (const date of decisionDates) {
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
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(frozen))
    .digest("hex");
  signal?.throwIfAborted();
  const result = runCsi800Study(stocks, benchmark, options, schedule);
  return {
    frozen,
    inputHash,
    result,
    quality: "rule-check-only" as const,
    limitations: [
      "用户显式固定证券池，存在幸存者偏差，不代表历史全市场证券池。",
      "每ISO周最后交易日收盘决策，下一交易日开盘撮合；使用共享现金、100股整手、T+1及现有费用。",
      "单股目标权重上限为100%，不额外叠加中证800旧15%限制；未成交资金留现金。",
      "排序因子使用未复权行情，除权跳变影响排名；财报采用当前下载版本的严格公告可见日期，不保证首次披露版本。",
      "历史交易状态、成交容量、排队、分红实际到账日尚未认证；结果仅为规则自检。",
    ],
  };
}
