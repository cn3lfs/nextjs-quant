import { createHash } from "node:crypto";
import { cashDividendPlanSchema } from "~/lib/cash-dividends";
import { validateActionRange } from "./backtest-actions";
import type { reconcileDividends } from "./dividend-reconciliation";
type Reconciliation = ReturnType<typeof reconcileDividends>;
export function reconciledCashPlan(
  review: Reconciliation,
  taxBps: number,
  start: string,
  end: string,
  signalStart = start,
) {
  validateActionRange(start, end);
  validateActionRange(signalStart, start);
  const { hash, ...payload } = review;
  if (
    createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== hash
  )
    throw new Error("分红对账档案校验失败");
  if (
    review.localStatus !== "partial" ||
    review.start > signalStart ||
    review.end < end
  )
    throw new Error("分红对账未覆盖模拟区间");
  const rows = review.rows.filter(
    (r) => r.date >= signalStart && r.date <= end,
  );
  if (
    rows.some((r) => r.status !== "matched-cash") ||
    review.otherLocalEvents.some((r) => r.date >= start && r.date <= end)
  )
    throw new Error(
      "区间内有缺项、冲突或非现金事件，不能仅计算已匹配部分冒充完整区间：" +
        [
          ...rows.filter((r) => r.status !== "matched-cash").map((r) => r.date),
          ...review.otherLocalEvents
            .filter((r) => r.date >= start && r.date <= end)
            .map((r) => `${r.date} ${r.name}`),
        ]
          .slice(0, 10)
          .join("；"),
    );
  const iso = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{8}$/.test(value))
      throw new Error("分红日期缺失");
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  };
  return cashDividendPlanSchema.parse({
    version: "cash-dividends-2",
    signalStart,
    warmupWarnings: review.otherLocalEvents
      .filter((r) => r.date >= signalStart && r.date < start)
      .map(
        (r) =>
          `预热区间存在${r.date} ${r.name}，纯现金调整不覆盖其可能影响，信号仍为部分研究口径。`,
      ),
    reconciliationHash: hash,
    taxBps,
    events: rows.map((r) => ({
      id: `${review.symbol}:${r.date}`,
      announcement: iso(r.remote?.announcement),
      record: iso(r.remote?.record),
      ex: r.date,
      pay: iso(r.remote?.pay),
      perShare: r.remote?.dividend,
    })),
  });
}
