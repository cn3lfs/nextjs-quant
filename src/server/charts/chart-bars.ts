import { freeChartHistory } from "../market/free-chart-sources";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import type { ChartSnapshot } from "~/lib/chart-snapshot";
import {
  chartAdjustmentLabels,
  chartAdjustmentSchema,
  type ChartAdjustment,
} from "~/lib/chart-adjustment";
import {
  chartPeriodSchema,
  isMinutePeriod,
  type ChartPeriod,
} from "~/lib/chart-view";
import { get, put } from "../db";
import { settings } from "../infra/settings";
import { readVipdocChart } from "../data-sources/tdx/vipdoc-adapter";
import {
  aggregateChartBars,
  chartPeriodEnd,
} from "../market/chart-aggregation";
import { localCalendarReference } from "../market/data-health";
// g4day 暂停：import { overlayDailyIncrements } from "./tdx-daily-overlay";
import { mergeOnlineDailyTail } from "../market/chart-online-delta";
import {
  adjustmentFactors,
  applyAdjustmentByDate,
  readGbbq,
} from "../data-sources/tdx/tdx-gbbq";

/** 补齐本地尾部之后所需的在线根数：长假缺口最多约 11 个交易日，另需至少 2 根与本地重叠。 */
const deltaWindow = 20;
/** 尾段的起始日期：本地尾部再往前留 180 个自然日，够覆盖长假并保证有重叠。 */
function deltaSince(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 180 * 86400000)
    .toISOString()
    .slice(0, 10);
}
/** Online tails remain unadjusted; cross-source units are checked by the merger. */
async function onlineDailyTail(symbol: string, _since: string) {
  const remote = await freeChartHistory(symbol, "day", deltaWindow);
  if (remote.source === "tencent/westock-data")
    throw new Error("腾讯成交量单位未核验，不能拼接本地尾段");
  return { bars: remote.bars, source: remote.source };
}

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
  if (mode === "none") return series;
  let reference = { bars: series.bars };
  if (series.period !== "day" || series.source !== "tdx-local") {
    try {
      reference = await readVipdocChart(root, series.symbol, "day");
    } catch (error) {
      if (series.period !== "day")
        throw new Error(
          `${chartAdjustmentLabels[mode]}需要本地完整日线作为复权基准：${error instanceof Error ? error.message : "本地日线不可用"}`,
        );
    }
  }
  let corporateActions: Awaited<ReturnType<typeof readGbbq>>;
  try {
    corporateActions = await readGbbq(root);
  } catch (error) {
    throw new Error(
      `${chartAdjustmentLabels[mode]}需要本地 GBBQ 分红信息：${error instanceof Error ? error.message : "读取失败"}`,
    );
  }
  const factors = adjustmentFactors(
    reference.bars,
    corporateActions.events.get(series.symbol) ?? [],
  );
  return {
    ...series,
    bars: applyAdjustmentByDate(series.bars, factors, mode),
  } as T;
}

export const chartBarsInput = z.object({
  snapshotId: z.string().min(1),
  period: chartPeriodSchema,
  limit: z.number().int().min(100).max(20000).default(2000),
  adjustment: chartAdjustmentSchema.default("none"),
});
export async function chartBars(
  input: z.input<typeof chartBarsInput>,
): Promise<ChartSnapshot> {
  const parsed = chartBarsInput.parse(input);
  const source = get<Snapshot>(parsed.snapshotId);
  if (!source) throw new Error("行情快照不存在");
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
          ? source
          : await readVipdocChart(
              source.dataRoot ?? settings().tdxRoot,
              source.symbol,
              base,
            );
    } catch (error) {
      if (base !== "day") throw error;
      const minutes =
        source.period === "5m"
          ? source
          : await readVipdocChart(
              source.dataRoot ?? settings().tdxRoot,
              source.symbol,
              "5m",
            );
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
        const tail = await onlineDailyTail(
          source.symbol,
          deltaSince(dayTail.date),
        );
        const merged = mergeOnlineDailyTail(series, tail.bars, {
          source: tail.source,
          requests: 1,
        });
        if (merged.added) series = merged.snapshot;
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
    hash,
    id: `chart-snapshot-${source.symbol}-${period}-${hash.slice(0, 20)}`,
  };
  if (!get(result.id)) put("chart-snapshot", result.id, result);
  return result;
}
