import { freeChartHistory } from "../market/free-chart-sources";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import type { ChartSnapshot } from "~/lib/chart/chart-snapshot";
import {
  chartAdjustmentSchema,
  type ChartAdjustment,
} from "~/lib/chart/chart-adjustment";
import {
  chartPeriodSchema,
  isMinutePeriod,
  type ChartPeriod,
} from "~/lib/chart/chart-view";
import { get, put } from "../db";
import { isCryptoSymbol } from "~/lib/market/crypto";
import { cryptoChartSnapshot } from "../market/crypto-chart";
import { isFuturesSymbol } from "~/lib/market/futures";
import { futuresChartSnapshot } from "../market/futures-chart";
import { settings } from "../infra/settings";
import { readBars } from "../market/bar-store/read-bars";
import {
  aggregateChartBars,
  chartPeriodEnd,
} from "~/lib/market/bar-aggregation";
import { localCalendarReference } from "../market/data-health";
// g4day 暂停：import { overlayDailyIncrements } from "./tdx-daily-overlay";
/**
 * Chart data remains raw until its final source is known. Adjustments use the
 * local GBBQ event file and a full local daily series when available, so a
 * bounded online/minute response cannot silently reset its cumulative factor.
 */
async function adjustChartSeries<
  T extends {
    symbol: string;
    period: ChartPeriod;
    source: string;
    bars: Snapshot["bars"];
  },
>(series: T, mode: ChartAdjustment, root: string): Promise<T> {
  if ("adjustment" in series && series.adjustment === mode) return series;
  const resolved = await readBars(
    {
      instrument: { market: "cn-equity", symbol: series.symbol },
      root,
      period: series.period,
      adjustment: mode,
      chartFunds: true,
    },
    {
      ...series,
      adjustment: "none",
      id: "chart-input",
      hash: "hash" in series ? String(series.hash) : "",
      createdAt: Date.now(),
    },
  );
  return {
    ...series,
    bars: resolved.bars,
    barStore: {
      ...resolved.barStore,
      overlay: (series as unknown as Snapshot).barStore?.overlay ?? null,
    },
  };
}

export const chartBarsInput = z.object({
  snapshotId: z.string().min(1),
  period: chartPeriodSchema,
  limit: z.number().int().min(100).max(20000).default(2000),
  adjustment: chartAdjustmentSchema.default("none"),
});

/**
 * A saved formula candidate owns its archived bars. Reading today's source,
 * re-adjusting or resampling would show different evidence, so only the
 * recorded period and adjustment are served.
 */
function chartBarsFromFormulaArchive(
  source: Snapshot,
  input: z.output<typeof chartBarsInput>,
): ChartSnapshot {
  const { period, adjustment, limit } = input;
  if (period !== source.period)
    throw new Error(
      `冻结候选快照只存档 ${source.period} 周期，无法读取 ${period}`,
    );
  if (adjustment !== source.adjustment)
    throw new Error(
      `冻结候选快照只存档 ${source.adjustment} 复权，无法读取 ${adjustment}`,
    );
  return finalizeChartBars(source, period, adjustment, limit, {
    ...source,
    period,
    adjustment,
    bars: source.bars,
    formingDates: source.barStore?.formingDates ?? [],
    excluded: source.barStore?.excluded ?? [],
    historyExhausted: true,
    ...(source.barStore
      ? {
          barStore: {
            ...source.barStore,
            availablePeriods: [period],
            formingDates: source.barStore.formingDates ?? [],
            excluded: source.barStore.excluded ?? [],
          },
        }
      : {}),
  });
}
export async function chartBars(
  input: z.input<typeof chartBarsInput>,
): Promise<ChartSnapshot> {
  const parsed = chartBarsInput.parse(input);
  const source = get<Snapshot>(parsed.snapshotId);
  if (!source) throw new Error("行情快照不存在");
  if (isCryptoSymbol(source.symbol) || isFuturesSymbol(source.symbol)) {
    if (parsed.adjustment !== "none")
      throw new Error("加密货币和期货不支持复权");
    const chart = await (
      isCryptoSymbol(source.symbol) ? cryptoChartSnapshot : futuresChartSnapshot
    )(source, parsed.period, parsed.limit);
    if (!get(chart.id)) put("chart-snapshot", chart.id, chart);
    return chart;
  }
  if (["4h", "1h"].includes(parsed.period)) throw new Error("A股不支持该周期");
  if (source.id.startsWith("snapshot-formula-"))
    return chartBarsFromFormulaArchive(source, parsed);
  const now = Date.now(),
    period = parsed.period,
    { limit, adjustment } = parsed;
  const wall = new Date(now + 8 * 3600000).toISOString();
  const today = wall.slice(0, 10),
    time = wall.slice(11, 16);
  const base = isMinutePeriod(period) ? "5m" : "day";
  const reasons: string[] = [];
  const errors: string[] = [];
  let resolved: Omit<ChartSnapshot, "id"> | undefined;
  const thsdkSeries = async (): Promise<Omit<ChartSnapshot, "id">> => {
    const series = await readBars({
      instrument: { market: "cn-equity", symbol: source.symbol },
      root: source.dataRoot,
      source: "thsdk",
      period,
      adjustment,
      limit,
      now,
      chartFunds: true,
    });
    return {
      ...series,
      name: series.name ?? source.name,
      requestedSource: source.requestedSource,
      formingDates: series.barStore.formingDates,
      excluded: series.barStore.excluded,
      historyExhausted: series.barStore.coverage.historyExhausted,
    };
  };
  if (source.requestedSource === "thsdk" && adjustment !== "none")
    return finalizeChartBars(
      source,
      period,
      adjustment,
      limit,
      await thsdkSeries(),
    );
  try {
    if (
      source.requestedSource &&
      !["local", "auto"].includes(source.requestedSource)
    )
      throw new Error("使用手动指定的数据源");
    let local: Snapshot;
    try {
      local =
        source.source === "tdx-local" && source.period === base
          ? source.adjustment !== "none" &&
            source.rawBars &&
            adjustment !== source.adjustment
            ? { ...source, bars: source.rawBars, adjustment: "none" as const }
            : source
          : await readBars({
              instrument: { market: "cn-equity", symbol: source.symbol },
              root: source.dataRoot ?? settings().tdxRoot,
              period: base,
              adjustment: "none",
              chartFunds: true,
            });
    } catch (error) {
      if (base !== "day") throw error;
      const minutes =
        source.period === "5m"
          ? source
          : await readBars({
              instrument: { market: "cn-equity", symbol: source.symbol },
              root: source.dataRoot ?? settings().tdxRoot,
              period: "5m",
              adjustment: "none",
              chartFunds: true,
            });
      const daily = aggregateChartBars(minutes.bars, "5m", "day", now);
      local = { ...minutes, period: "day", bars: daily.bars };
      if (daily.excluded.length) {
        const message = "5分钟合成日线存在缺口，继续在线补齐";
        reasons.push(message);
        errors.push(message);
      }
    }
    // g4day 暂停（见 docs/decisions.md WF3）：全量包替换的准确率更高，叠加增量暂时停用。
    // if (base === "day") {
    //   try {
    //     local = overlayDailyIncrements(local, today);
    //   } catch (error) {
    //     reasons.push(
    //       `日线增量不可用：${error instanceof Error ? error.message : "读取失败"}`,
    //     );
    //   }
    // }
    const calendar =
      period === "week" || period === "month"
        ? await localCalendarReference(
            source.dataRoot ?? settings().tdxRoot,
            settings().calendar,
          )
        : undefined;
    let series = local;
    // 先判断 base 序列（日线）本身是否可用：当前周/月那一格永远缺当日，若按合成结果
    // 判断缺口，周/月图每次视图都会整段在线取数，补当日也救不回来。
    const dayTail = base === "day" ? series.bars.at(-1) : undefined;
    const baseAge = dayTail
      ? now - chartPeriodEnd(dayTail.date, "day")
      : Infinity;
    if (
      source.requestedSource !== "local" &&
      dayTail &&
      series.bars.length >= limit &&
      baseAge <= 4 * 86400000 &&
      time >= "09:30" &&
      dayTail.date.slice(0, 10) !== today
    ) {
      // 本地日线齐备、只差当日那一根：一次小的在线尾段，不重取整段历史。
      try {
        series = await readBars(
          {
            instrument: { market: "cn-equity", symbol: source.symbol },
            root: source.dataRoot ?? settings().tdxRoot,
            period: "day",
            adjustment: "none",
            live: true,
            now,
            chartFunds: true,
          },
          series,
        );
      } catch (error) {
        reasons.push(
          `当日增量不可用：${error instanceof Error ? error.message : "读取失败"}`,
        );
        errors.push(reasons.at(-1)!);
      }
    }
    series = await adjustChartSeries(
      series,
      adjustment,
      source.dataRoot ?? settings().tdxRoot,
    );
    const aggregated = aggregateChartBars(
      series.bars,
      base,
      period,
      now,
      calendar,
    );
    const latest = aggregated.bars.at(-1);
    const age = latest ? now - chartPeriodEnd(latest.date, period) : Infinity;
    // 周/月图的深度按 base（日线）判断：要 2000 根本地周线（=10000 个交易日）不可能成立。
    // 日线图与分钟合成仍按目标周期根数判断。
    const depthEnough =
      base === "day" && period !== "day"
        ? series.bars.length >= limit
        : aggregated.bars.length >= limit;
    const deficient =
      !latest ||
      !depthEnough ||
      age > (isMinutePeriod(period) ? 18 * 3600000 : 4 * 86400000) ||
      (isMinutePeriod(period) &&
        ((time >= "09:30" && time < "11:30") ||
          (time >= "13:00" && time < "15:00")) &&
        age > 300000);
    resolved = { ...series, ...aggregated, period, historyExhausted: true };
    if (deficient || aggregated.excluded.length) {
      const message = "本地目标周期历史不足、存在缺口或可能过期";
      reasons.push(message);
      errors.push(message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "本地行情不可用";
    reasons.push(message);
    errors.push(message);
  }
  if (source.requestedSource === "local" && !resolved)
    throw new Error(reasons.join("；"));
  if (resolved && source.requestedSource === "local") {
    if (reasons.length) resolved.sourceNote = reasons.join("；");
    if (errors.length) resolved.sourceErrors = errors;
  }
  if (source.requestedSource !== "local" && (!resolved || reasons.length)) {
    try {
      const remote = await freeChartHistory(
        source.symbol,
        period,
        limit,
        source.requestedSource ?? "auto",
      );
      if (remote.source === "thsdk-hq" && adjustment !== "none") {
        const native = await thsdkSeries();
        return finalizeChartBars(source, period, adjustment, limit, {
          ...native,
          sourceNote: [...reasons, remote.sourceNote]
            .filter(Boolean)
            .join("；"),
          sourceErrors: [...errors, ...(remote.sourceErrors ?? [])],
        });
      }
      const remoteSeries = await adjustChartSeries(
        {
          ...source,
          ...remote,
          period,
          createdAt: now,
          adjustment: "none" as const,
        },
        adjustment,
        source.dataRoot ?? settings().tdxRoot,
      );
      resolved = {
        ...remoteSeries,
        excluded: [],
        historyExhausted: remote.historyExhausted,
        formingDates: remoteSeries.bars
          .filter((b) => chartPeriodEnd(b.date, period) > now)
          .map((b) => b.date),
        sourceNote: [
          ...reasons.filter((r) => r !== "使用手动指定的数据源"),
          remote.sourceNote,
        ]
          .filter(Boolean)
          .join("；"),
        sourceErrors: [
          ...errors.filter((error) => error !== "使用手动指定的数据源"),
          ...(remote.sourceErrors ?? []),
        ],
      };
    } catch (error) {
      if (!resolved?.bars.length) throw error;
      const message = `在线读取失败，显示本地历史：${error instanceof Error ? error.message : "读取失败"}`;
      resolved.sourceNote = `${reasons.join("；")}；${message}`;
      resolved.sourceErrors = [...errors, message];
    }
  }
  if (!resolved) throw new Error("目标周期没有可用行情");
  return finalizeChartBars(source, period, adjustment, limit, resolved);
}

/** Shared tail: the limit slice, coverage metadata, content hash and id. */
function finalizeChartBars(
  source: Snapshot,
  period: ChartPeriod,
  adjustment: ChartAdjustment,
  limit: number,
  resolved: Omit<ChartSnapshot, "id">,
): ChartSnapshot {
  const bars = resolved.bars.slice(-limit);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        period,
        adjustment,
        source: resolved.source,
        baseVersion: resolved.hash,
        bars,
        formingDates: resolved.formingDates,
      }),
    )
    .digest("hex");
  const result: ChartSnapshot = {
    ...resolved,
    adjustment,
    historyExhausted:
      resolved.historyExhausted && resolved.bars.length <= limit,
    bars,
    ...(resolved.barStore
      ? {
          barStore: {
            ...resolved.barStore,
            adjustment,
            adjustmentReference:
              adjustment === "none"
                ? null
                : resolved.barStore.adjustmentReference,
            coverage: {
              from: bars[0]?.date ?? null,
              to: bars.at(-1)?.date ?? null,
              count: bars.length,
              historyExhausted:
                resolved.historyExhausted && resolved.bars.length <= limit,
            },
            formingDates: resolved.formingDates,
            excluded: resolved.excluded,
          },
        }
      : {}),
    hash,
    id: `chart-snapshot-${source.symbol}-${period}-${hash.slice(0, 20)}`,
  };
  if (!get(result.id)) put("chart-snapshot", result.id, result);
  return result;
}

export const compareBarsInput = z.object({
  symbol: z.string().regex(/^(sh|sz|bj)\d{6}$/),
  period: chartPeriodSchema,
  limit: z.number().int().min(100).max(20000).default(2000),
});
/**
 * Bars of a comparison symbol (TDX 叠加 / TradingView compare) for the main
 * chart's period: local TDX, unadjusted, grouped exactly as `chartBars`
 * groups the main symbol. Read-only — unlike loading a symbol it persists no
 * snapshot record, since a comparison is a transient view.
 */
export async function compareBars(input: z.input<typeof compareBarsInput>) {
  const { symbol, period, limit } = compareBarsInput.parse(input);
  const base = isMinutePeriod(period) ? "5m" : "day";
  const local = await readBars({
    instrument: { market: "cn-equity", symbol },
    root: settings().tdxRoot,
    period: base,
    adjustment: "none",
    chartFunds: true,
  });
  const bars =
    period === base
      ? local.bars
      : aggregateChartBars(local.bars, base, period, Date.now()).bars;
  return { symbol, period, bars: bars.slice(-limit) };
}
