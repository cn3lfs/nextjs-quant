import { z } from "zod";
import { performanceBases } from "~/lib/daily-performance";
import {
  naturalPeriodWinRates,
  periodPerformance,
  periodicReturns,
  type PeriodicReturns,
  type PeriodInput,
} from "~/lib/period-performance";
import type { replayTradeReview } from "../../portfolio/trade-review-service";
import type {
  ResearchResult,
  ResearchStore,
} from "../../backtest/research-store";

export const periodPageSchema = z.object({
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(10),
  sort: z
    .enum([
      "id",
      "1",
      "3",
      "5",
      "10",
      "20",
      "30",
      "60",
      "90",
      "120",
      "180",
      "240",
      "360",
    ])
    .default("id"),
  desc: z.boolean().default(false),
  basis: z.enum(performanceBases).default("compound"),
});
export type PeriodPageInput = z.infer<typeof periodPageSchema>;

/** U3 的全量排序后分页模式；汇总始终基于全体，null 排末且不参与分母。 */
export function pagePeriodicReturns(
  matrix: PeriodicReturns,
  input: PeriodPageInput,
) {
  const rows = [...matrix.rows].sort((a, b) => {
    const x =
      input.sort === "id"
        ? a.id
        : a.cells.find((c) => c.window === Number(input.sort))!.value;
    const y =
      input.sort === "id"
        ? b.id
        : b.cells.find((c) => c.window === Number(input.sort))!.value;
    if (x === null || y === null)
      return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1;
    const order =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return (input.desc ? -order : order) || a.id.localeCompare(b.id);
  });
  return {
    rows: rows.slice(
      input.pageIndex * input.pageSize,
      (input.pageIndex + 1) * input.pageSize,
    ),
    rowCount: rows.length,
    summary: matrix.summary,
  };
}

function performancePage(
  input: PeriodInput,
  series: Record<string, readonly (number | null)[]>,
  page: PeriodPageInput,
  note: string,
) {
  return {
    periods: periodPerformance(input),
    natural: naturalPeriodWinRates(input),
    matrix: pagePeriodicReturns(periodicReturns({ ...input, series }), page),
    note,
  };
}

export function tradeReviewPeriodPage(
  snapshot: ReturnType<typeof replayTradeReview>,
  page: PeriodPageInput,
  tradingDays: readonly string[] = snapshot.replayInput.nav.tradingDays,
) {
  const dates = snapshot.nav.days.map((day) => day.date);
  const indices = new Map(tradingDays.map((date, i) => [date, i]));
  // §2.3 持仓标的按截止日实际持仓展开，不把已清仓或逆回购混进当前持仓矩阵。
  const symbols = Object.entries(snapshot.nav.days.at(-1)?.positions ?? {})
    .filter(([, quantity]) => quantity > 0)
    .map(([symbol]) => symbol);
  const series = Object.fromEntries(
    symbols.map((symbol) => {
      const closes = new Map(
        (snapshot.replayInput.trades.bars?.[symbol] ?? []).map((bar) => [
          bar.date,
          bar.close,
        ]),
      );
      return [
        symbol,
        dates.map((date) => {
          const previousDate = tradingDays[(indices.get(date) ?? 0) - 1];
          const current = closes.get(date),
            previous = previousDate ? closes.get(previousDate) : undefined;
          const value =
            current !== undefined &&
            previous !== undefined &&
            current > 0 &&
            previous > 0
              ? current / previous - 1
              : null;
          return value !== null && Number.isFinite(value) ? value : null;
        }),
      ];
    }),
  );
  return performancePage(
    {
      dates,
      tradingDays,
      returns: snapshot.nav.days.map((day) => day.dailyReturn.value),
      basis: page.basis,
      annualRiskFreeRate: snapshot.replayInput.nav.annualRiskFreeRate,
    },
    series,
    page,
    "账户分段来自日度 TWR；缺失按 U1 剔除并披露覆盖，不代表跨中断连续业绩。矩阵为截止日持仓标的未复权收盘涨跌幅，不是个人持仓盈亏；缺前一交易日价格留空，截止最后流水日。",
  );
}

export function researchDailyReturns(
  result: ResearchResult,
  partition: "development" | "validation",
  dates: readonly string[],
) {
  const nav = result.partitions.find((part) => part.partition === partition)
    ?.simulation?.nav;
  const points = new Map(nav?.map((point) => [point.date, point]));
  const indices = new Map(nav?.map((point, i) => [point.date, i]));
  return dates.map((date, i) => {
    const current = points.get(date);
    const previous = i > 0 ? points.get(dates[i - 1]!) : undefined;
    // 任务书 §2.3 假定已有策略日收益，与事实不符；仅从独立分区模拟净值派生，不拼接两期或使用事件收益替代。
    const base = i === 0 ? result.spec.initialCapital : previous?.value;
    if (
      !current ||
      (i === 0 && nav?.[0]?.date !== date) ||
      (i > 0 && indices.get(date) !== (indices.get(dates[i - 1]!) ?? -2) + 1) ||
      current.stale.length ||
      (i > 0 && (!previous || previous.stale.length)) ||
      base === undefined ||
      base <= 0 ||
      !Number.isFinite(base) ||
      !Number.isFinite(current.value)
    )
      return null;
    const value = current.value / base - 1;
    return Number.isFinite(value) ? value : null;
  });
}

export function researchPeriodPage(
  store: ResearchStore,
  id: string,
  partition: "development" | "validation",
  page: PeriodPageInput,
) {
  const result = store.result(id),
    dataset = store.dataset(id);
  if (!result || !dataset) throw new Error("研究结果或冻结交易日历尚不可得");
  const dates = dataset.calendar.filter(
    (date) =>
      date >= result.spec.start &&
      date <= result.spec.end &&
      (partition === "development"
        ? date < result.spec.validationStart
        : date >= result.spec.validationStart),
  );
  // 不使用 tasks() 的最近 100 条 UI 上限；全部匹配任务参与列汇总，响应只投影一页。
  const candidates = store.db
    .prepare(
      "SELECT id FROM records WHERE kind='research-task' AND json_extract(payload,'$.status')='complete' AND json_extract(payload,'$.spec.start')=? AND json_extract(payload,'$.spec.end')=? AND json_extract(payload,'$.spec.validationStart')=? ORDER BY id",
    )
    .all(result.spec.start, result.spec.end, result.spec.validationStart) as {
    id: string;
  }[];
  const series: Record<string, readonly (number | null)[]> = {};
  for (const candidate of candidates) {
    const other = candidate.id === id ? result : store.result(candidate.id);
    if (!other) continue;
    const label = `${other.spec.strategy} · 持有${other.spec.holdingDays}日 / 仓位${other.spec.maxPositions} / 配置${other.spec.czscConfig} · ${candidate.id}`;
    series[label] = researchDailyReturns(other, partition, dates);
  }
  return performancePage(
    {
      dates,
      tradingDays: dataset.calendar,
      returns: researchDailyReturns(result, partition, dates),
      basis: page.basis,
      annualRiskFreeRate: result.spec.annualRiskFreeRate,
    },
    series,
    page,
    `分段为当前任务${partition === "development" ? "开发期" : "保留验证期"}，两期本金独立。矩阵按同起止日期及分期的已完成策略/参数任务比较（含重试），共享当前任务冻结日历；证券池、费用和数据版本可能不同，详见任务导出。无模拟净值、缺价及缺价后首日留空；不是可信策略业绩。`,
  );
}
