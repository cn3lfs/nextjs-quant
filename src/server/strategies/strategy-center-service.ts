import { createHash } from "node:crypto";
import { z } from "zod";
import {
  replayDailyStudy,
  studySignalBars,
  engineVersion,
} from "quant-backtest";
import {
  studyStrategies,
  studyWarmup,
  getStrategyDefinition,
  strategyBuildHash,
  nativeStudyStrategies,
  nativeStudyDefinition,
  isNativeStudyStrategy,
} from "trading-strategies";

import { readBars } from "~/server/market/bar-store/read-bars";
import { readBacktestActions } from "../backtest/backtest-actions";
import { settings } from "../infra/settings";
import { background, updateJob } from "../jobs/jobs";
import { captureNativeChanObservations } from "./strategy-center-native";
import type { projectCzsc } from "./chan/czsc";
import { isStudyStockSymbol } from "~/lib/research/strategy-center-input";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = Date.parse(v);
    return (
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === v
    );
  }, "日期无效");
export const strategyCenterRunSchema = z
  .object({
    strategyId: z.enum([...studyStrategies, ...nativeStudyStrategies]),
    symbol: z
      .string()
      .refine(isStudyStockSymbol, "当前日线实验仅支持沪深100股整手股票"),
    start: day,
    end: day,
    initial: z.number().positive().finite().max(1e10).default(1000000),
  })
  .refine((v) => v.start <= v.end, "开始日期不能晚于结束日期")
  .refine(
    (v) =>
      !isNativeStudyStrategy(v.strategyId) ||
      Date.parse(v.end) - Date.parse(v.start) < 366 * 86400000,
    "原生日线任务最多366自然日",
  );

/** Pure capture/execute seam: all IO is supplied, so tests never open the user database. */
export async function executeStrategyCenterStudy(
  raw: z.input<typeof strategyCenterRunSchema>,
  root: string,
  readers: {
    readSnapshot: (
      root: string,
      symbol: string,
      period: "day" | "5m",
      options?: { chartFunds?: boolean },
    ) => Promise<import("~/lib/domain").Snapshot>;
    readBacktestActions: typeof readBacktestActions;
    projectCzsc?: typeof projectCzsc;
  } = {
    readSnapshot: (root, symbol, period, options) =>
      readBars({
        instrument: { market: "cn-equity", symbol },
        root,
        period,
        adjustment: "forward",
        freezeRaw: true,
        to: raw.end,
        ...options,
      }),
    readBacktestActions,
  },
  signal?: AbortSignal,
  nativeProgress?: (done: number, total: number) => void,
) {
  const input = strategyCenterRunSchema.parse(raw);
  signal?.throwIfAborted();
  if (
    input.end >= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  )
    throw new Error("仅支持已结束历史交易日");
  const source = await readers.readSnapshot(root, input.symbol, "day");
  signal?.throwIfAborted();
  const calendar = await readers.readSnapshot(root, "sh000001", "day");
  signal?.throwIfAborted();
  if (source.barStore?.priceRepaired ?? Boolean(source.sourceNote))
    throw new Error("源行情含修复或丢弃，需先核验");
  if (calendar.barStore?.priceRepaired ?? Boolean(calendar.sourceNote))
    throw new Error("日历源含修复或丢弃，需先核验");
  const native = isNativeStudyStrategy(input.strategyId);
  const warmup = native
    ? nativeStudyDefinition.warmupBars
    : studyWarmup(input.strategyId as (typeof studyStrategies)[number]);
  const first = source.bars.findIndex((bar) => bar.date >= input.start);
  if (first < warmup) throw new Error(`历史行情不足 ${warmup} 根预热`);
  const bars = (source.rawBars ?? source.bars)
    .slice(first - warmup)
    .filter((bar) => bar.date <= input.end);
  const dates = calendar.bars
    .filter((bar) => bar.date >= bars[0]!.date && bar.date <= input.end)
    .map((bar) => bar.date);
  if (
    !dates.length ||
    source.bars.at(-1)!.date < dates.at(-1)! ||
    calendar.bars.at(-1)!.date < input.end
  )
    throw new Error("结束日期超出行情或日历覆盖");
  if (JSON.stringify(dates) !== JSON.stringify(bars.map((bar) => bar.date)))
    throw new Error("股票与交易日历不一致，不补造停牌行情");
  const actions = await readers.readBacktestActions({ ...source, bars }, root);
  signal?.throwIfAborted();
  if (actions.status === "missing")
    throw new Error("公司行动来源缺失，不能按无事件回测");
  for (const event of actions.events) {
    if (
      [11, 12, 13, 14].includes(event.category) ||
      (event.category === 1 &&
        ((event.bonusRatio ?? 0) !== 0 || (event.rightsRatio ?? 0) !== 0))
    )
      throw new Error("当前日线实验不支持该区间非现金公司行动");
  }
  const dividends = actions.events
    .filter((event) => event.category === 1)
    .map((event) => ({ date: event.date, perShare: event.dividend! }));
  const barDates = new Set(bars.map((b) => b.date));
  const signalBars =
    source.adjustment === "forward"
      ? source.bars.filter((b) => barDates.has(b.date))
      : studySignalBars(bars, dividends);
  const nativeCapture = native
    ? await captureNativeChanObservations(
        signalBars,
        warmup,
        signal,
        readers.projectCzsc,
        nativeProgress,
      )
    : undefined;
  const frozen = {
    version: "strategy-center-input-1",
    engineVersion,
    strategyBuildHash,
    strategy: getStrategyDefinition(input.strategyId),
    input,
    bars,
    signalBars,
    dividends,
    actions,
    sourceHash: source.hash,
    calendarHash: calendar.hash,
    ...(nativeCapture ? { native: nativeCapture } : {}),
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(frozen))
    .digest("hex");
  signal?.throwIfAborted();
  const result = isNativeStudyStrategy(input.strategyId)
    ? replayDailyStudy(bars, dividends, {
        ...input,
        signalBars,
        strategy: input.strategyId,
        nativeObservations: nativeCapture!.observations,
      })
    : replayDailyStudy(bars, dividends, {
        ...input,
        signalBars,
        strategy: input.strategyId,
      });
  return {
    frozen,
    inputHash,
    result,
    limitations: [
      "规则自检：历史状态、成交容量与分红支付时间未认证；下一交易日开盘撮合，费用沿用固定实验口径。",
      ...(nativeCapture
        ? [
            nativeCapture.boundary,
            "原生结构复用现金分红因果前向调整与有限固定起点；DLL身份已冻结不等于理论全覆盖或可信历史收益。",
          ]
        : []),
    ],
  };
}

export function strategyCenterJob(
  raw: z.input<typeof strategyCenterRunSchema>,
) {
  const input = strategyCenterRunSchema.parse(raw);
  const root = settings().tdxRoot;
  return background(
    "backtest",
    { type: "strategy-center", ...input },
    async (job, signal) => {
      updateJob(job.id, {
        phase: "冻结日线、交易日历与公司行动",
        progress: 10,
      });
      const result = await executeStrategyCenterStudy(
        input,
        root,
        undefined,
        signal,
        (done, total) =>
          updateJob(job.id, {
            phase: `冻结原生逐收盘观察 ${done}/${total}`,
            progress: 10 + Math.round((done / total) * 80),
          }),
      );
      if (signal.aborted) throw new Error("任务已取消");
      return result;
    },
  );
}
