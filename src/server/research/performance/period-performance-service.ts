import { z } from "zod";
import { performanceBases } from "~/lib/backtest/daily-performance";
import {
  naturalPeriodWinRates,
  periodPerformance,
  periodicReturns,
  type PeriodicReturns,
  type PeriodInput,
} from "~/lib/backtest/period-performance";
import type { replayTradeReview } from "../../portfolio/trade-review-service";

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
