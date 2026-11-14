import { z } from "zod";
import {
  calculateFactor,
  calculateLocalDataFactors,
  type FactorSpec,
  type LocalFactorSource,
} from "trading-strategy-core/factors";
import {
  financialMetrics,
  financialVisibleAt,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { classifySecurityCode } from "trading-strategy-core/security";
import { isLocalFund } from "tstdx/local";
import {
  getStrategyDefinition,
  portfolioClassicDefinitions,
  portfolioRpsDefinitions,
  portfolioRpsFactorMetadata,
  portfolioClassicFactorMetadata,
  classicFinancialFeatures,
  type StrategyCandidate,
} from "trading-strategies";
import type { Snapshot } from "~/lib/domain";

import { readBars } from "~/server/market/bar-store/read-bars";
import {
  readLocalFinancialHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";

const required: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    [...portfolioClassicDefinitions, ...portfolioRpsDefinitions].map(
      (definition) => [definition.id, definition.factors],
    ),
  ),
  "rank-momentum": ["momentum"],
  "rank-reversal": ["shortReturn"],
  "rank-value": ["earningsYield"],
  "rank-book-value": ["bookToPrice"],
  "rank-cashflow": ["cashflowYield"],
  "rank-quality": ["roe"],
  "rank-growth": ["profitGrowth"],
  "rank-small-cap": ["marketCap"],
  "rank-low-volatility": ["volatility"],
  "rank-low-beta": ["beta"],
  "rank-quality-momentum": ["roe", "momentum"],
  "allocation-equal": [],
  "allocation-inverse-volatility": ["volatility"],
  "allocation-risk-parity": ["volatility"],
};
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "日期无效",
  );
function isExchangeFund(symbol: string) {
  if (!/^(sh|sz)\d{6}$/.test(symbol)) return false;
  const classified = classifySecurityCode(symbol.slice(2));
  return (
    classified.instrument === "fund" &&
    classified.market === symbol.slice(0, 2) &&
    isLocalFund(symbol)
  );
}
/** Field contracts are shared with the narrower stock-only execution request. */
export const strategyCenterCandidateFields = {
  strategyId: z
    .string()
    .refine(
      (id) =>
        !!required[id] &&
        getStrategyDefinition(id)?.implementation === "implemented",
      "不支持本地候选取数的策略",
    ),
  symbols: z
    .array(
      z
        .string()
        .refine(
          (symbol) =>
            /^(sh(?:60|68)|sz(?:00|30))\d{4}$/.test(symbol) ||
            isExchangeFund(symbol),
          "仅支持A股及现有本地读取器支持的沪深场内基金",
        ),
    )
    .min(1)
    .max(200)
    .refine((v) => new Set(v).size === v.length, "证券代码重复"),
  asOf: day,
};
export const strategyCenterCandidatesSchema = z
  .object(strategyCenterCandidateFields)
  .superRefine((input, context) => {
    const factors = required[input.strategyId];
    if (
      factors &&
      input.symbols.some(isExchangeFund) &&
      !factors.every((factor) => technical[factor] || factor === "beta")
    )
      context.addIssue({
        code: "custom",
        path: ["symbols"],
        message: "财务或市值策略不支持基金候选",
      });
  });
type Readers = {
  readSnapshot: (
    root: string,
    symbol: string,
    period: "day",
    options?: { chartFunds?: boolean },
  ) => Promise<Snapshot>;
  readLocalFinancialHistory: (
    root: string,
    symbol: string,
    options: { asOf: string; strict: true; limit: number },
  ) => Promise<{ reports: FinancialReportSnapshot[] }>;
  readLocalFinancialSeries: (
    root: string,
    symbol: string,
  ) => Promise<LocalFactorSource>;
};
const technical: Record<string, FactorSpec> = {
  ...Object.fromEntries(
    Object.entries(portfolioRpsFactorMetadata).map(([id, metadata]) => [
      id,
      { id: "roc", parameters: { period: metadata.period } } as FactorSpec,
    ]),
  ),
  momentum: { id: "skip-momentum", parameters: { period: 250, skip: 20 } },
  shortReturn: { id: "short-reversal", parameters: { period: 5 } },
  volatility: { id: "return-volatility", parameters: { period: 60 } },
};
const local: Record<string, string> = {
  earningsYield: "earnings-yield",
  bookToPrice: "book-to-price",
  cashflowYield: "cashflow-yield",
  marketCap: "GP16-0",
  beta: "market-beta-60",
};

/** Read-only, explicit historical date; missing inputs never become zero or a newer observation. */
export async function captureStrategyCandidates(
  raw: z.input<typeof strategyCenterCandidatesSchema>,
  root: string,
  readers: Readers = {
    readSnapshot: (root, symbol, period, options) =>
      readBars({
        instrument: { market: "cn-equity", symbol },
        root,
        period,
        adjustment: "none",
        ...options,
      }),
    readLocalFinancialHistory,
    readLocalFinancialSeries,
  },
) {
  const input = strategyCenterCandidatesSchema.parse(raw);
  if (
    input.asOf >= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  )
    throw new Error("仅支持已结束历史交易日");
  const factors = [...required[input.strategyId]!];
  const needsBars = factors.some((f) => technical[f] || f === "beta");
  const needsReports = factors.some((f) =>
    [
      "roe",
      "profitGrowth",
      "earningsYield",
      "bookToPrice",
      "cashflowYield",
      "grossProfitability",
      "cashAccrualQuality",
      "assetGrowth",
    ].includes(f),
  );
  const needsSeries = factors.some((f) =>
    ["marketCap", "earningsYield", "bookToPrice", "cashflowYield"].includes(f),
  );
  let benchmark: Snapshot | undefined;
  if (needsBars) {
    benchmark = await readers.readSnapshot(root, "sh000300", "day");
    if (benchmark.sourceNote) throw new Error("基准日历含修复或丢弃");
    if (!benchmark.bars.some((b) => b.date === input.asOf))
      throw new Error("基准日历缺少决策日");
  }
  const candidates: StrategyCandidate[] = [];
  const exclusions: { symbol: string; reason: string }[] = [];
  const evidence: {
    symbol: string;
    barsHash?: string;
    bars?: Snapshot["bars"];
    reportInputs?: FinancialReportSnapshot[];
    seriesHash?: string;
    reportHashes?: string[];
    factorEvidence?: unknown;
  }[] = [];
  for (const symbol of input.symbols) {
    const values: Record<string, number | null> = Object.fromEntries(
      factors.map((f) => [f, null]),
    );
    const record: (typeof evidence)[number] = { symbol };
    const problems: string[] = [];
    try {
      let snapshot: Snapshot | undefined;
      let returns: { date: string; value: number }[] | undefined;
      if (needsBars) {
        // Reuse the chart reader's explicit fund gate and three-decimal parser;
        // stock/benchmark source semantics and the global stock-only gate stay intact.
        snapshot = isExchangeFund(symbol)
          ? await readers.readSnapshot(root, symbol, "day", {
              chartFunds: true,
            })
          : await readers.readSnapshot(root, symbol, "day");
        if (snapshot.sourceNote) throw new Error("个股行情含修复或丢弃");
        const bars = snapshot.bars
          .filter((b) => b.date <= input.asOf)
          .slice(-251);
        if (bars.at(-1)?.date !== input.asOf)
          throw new Error("个股缺少决策日行情");
        const dates = benchmark!.bars
          .filter((b) => b.date >= bars[0]!.date && b.date <= input.asOf)
          .map((b) => b.date);
        if (JSON.stringify(dates) !== JSON.stringify(bars.map((b) => b.date)))
          throw new Error("个股与基准日历不一致");
        if (
          bars.some(
            (b, i) =>
              !Number.isFinite(b.close) ||
              b.close <= 0 ||
              (i > 0 && b.date <= bars[i - 1]!.date),
          )
        )
          throw new Error("行情收盘或日期顺序非法");
        snapshot = { ...snapshot, bars };
        record.barsHash = snapshot.hash;
        record.bars = bars;
        if (input.strategyId === "allocation-risk-parity") {
          const window = bars.slice(-61);
          if (window.length !== 61)
            throw new Error("风险平价需要61个完整收盘观测");
          const reference = benchmark!.bars
            .filter((b) => b.date <= input.asOf)
            .slice(-61);
          if (
            JSON.stringify(window.map((b) => b.date)) !==
            JSON.stringify(reference.map((b) => b.date))
          )
            throw new Error("风险平价收益日期必须与基准完全对齐");
          returns = window.slice(1).map((bar, i) => ({
            date: bar.date,
            value: bar.close / window[i]!.close - 1,
          }));
        }
        for (const factor of factors)
          if (technical[factor]) {
            const value =
              calculateFactor(bars, technical[factor]!).values.at(-1) ?? null;
            // Shared OHLCV factors expose percentages; candidate contracts use ratios.
            const rps =
              portfolioRpsFactorMetadata[
                factor as keyof typeof portfolioRpsFactorMetadata
              ];
            const endpointsTradable =
              !rps ||
              (bars.at(-1)!.volume > 0 &&
                (bars[bars.length - 1 - rps.period]?.volume ?? 0) > 0);
            values[factor] =
              value === null || !endpointsTradable
                ? null
                : (factor === "shortReturn" ? -value : value) / 100;
          }
      }
      let reports: FinancialReportSnapshot[] = [];
      if (needsReports) {
        try {
          reports = (
            await readers.readLocalFinancialHistory(root, symbol, {
              asOf: input.asOf,
              strict: true,
              limit: 160,
            })
          ).reports
            .filter((r) => financialVisibleAt(r, input.asOf))
            .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
          record.reportHashes = reports.map((r) => r.sourceSha256);
          record.reportInputs = reports.map((r) => ({
            ...r,
            fields: r.fields.filter((f) =>
              [
                "FN40",
                "FN74",
                "FN75",
                "FN95",
                "FN96",
                "FN107",
                "FN271",
              ].includes(f.code),
            ),
          }));
          const financial = classicFinancialFeatures(reports, input.asOf);
          for (const [factor, metadata] of Object.entries(
            portfolioClassicFactorMetadata,
          )) {
            if (!factors.includes(factor)) continue;
            const rawValue = financial?.values[metadata.sourceFeature] ?? null;
            const minimum =
              "exclusiveMinimum" in metadata
                ? metadata.exclusiveMinimum
                : undefined;
            values[factor] =
              rawValue === null ||
              (minimum !== undefined && rawValue <= minimum)
                ? null
                : rawValue;
          }
          if (factors.includes("roe"))
            values.roe = financial?.values["roe-ttm"] ?? null;
          if (factors.includes("profitGrowth")) {
            const growth =
              financialMetrics(reports).find((m) => m.id === "96-yoy")?.value ??
              null;
            values.profitGrowth = growth === null ? null : growth / 100;
          }
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
      }
      let stock: LocalFactorSource | undefined;
      if (needsSeries) {
        try {
          stock = await readers.readLocalFinancialSeries(root, symbol);
          record.seriesHash = stock.sourceSha256;
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
      }
      const ids = factors.filter((f) => local[f]).map((f) => local[f]!);
      if (ids.length) {
        const results = calculateLocalDataFactors({
          ids,
          asOf: input.asOf,
          stock,
          reports,
          bars: snapshot?.bars,
          benchmark: benchmark?.bars,
          barsHash: snapshot?.hash,
          benchmarkHash: benchmark?.hash,
        });
        record.factorEvidence = results;
        for (const factor of factors) {
          if (!local[factor]) continue;
          const value =
            results.find((r) => r.id === local[factor])?.value ?? null;
          values[factor] =
            value === null
              ? null
              : ["earningsYield", "bookToPrice", "cashflowYield"].includes(
                    factor,
                  )
                ? value / 100
                : value;
        }
      }
      const missing = factors.filter((f) => values[f] === null);
      if (missing.length) problems.push(`缺少因子：${missing.join("、")}`);
      candidates.push({
        symbol,
        availableAt: input.asOf,
        values,
        ...(returns ? { returns } : {}),
      });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (problems.length)
      exclusions.push({ symbol, reason: problems.join("；") });
    evidence.push(record);
  }
  return {
    candidates,
    exclusions,
    factors,
    evidence,
    benchmarkHash: benchmark?.hash ?? null,
    benchmarkBars:
      benchmark?.bars.filter((b) => b.date <= input.asOf).slice(-251) ?? [],
    limitations: [
      "输入为用户显式证券集合，不代表历史全市场证券池。",
      "行情因子使用本地未复权价格，除权跳变影响收益及风险因子；仅用于规则研究。",
      "财报严格按公告后可见口径；当前下载版本不保证首次披露版本。",
      "只生成时点候选，不撮合组合交易。",
      ...(input.symbols.some(isExchangeFund)
        ? [
            "沪深场内基金（含ETF）仅参与纯行情或等权目标权重；财务/市值输入不适用，历史撮合仍缺品种规则与费用模型。",
          ]
        : []),
    ],
  };
}
