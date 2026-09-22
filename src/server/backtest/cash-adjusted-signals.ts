import type { Bar } from "~/lib/domain";
import {
  cashDividendPlanSchema,
  type CashDividendPlan,
} from "~/lib/cash-dividends";
export function cashAdjustedSignals(bars: Bar[], input: CashDividendPlan) {
  const plan = cashDividendPlanSchema.parse(input),
    events = [...plan.events].sort((a, b) => a.ex.localeCompare(b.ex));
  const changes: {
    id: string;
    effectiveDate: string;
    appliedOn: string;
    previousReference: number;
    exReference: number;
    factor: number;
  }[] = [];
  const normalizedBeforeFirst: string[] = [];
  let cursor = 0,
    factor = 1,
    previousClose = bars[0]?.close ?? 0;
  while (
    cursor < events.length &&
    bars[0] &&
    events[cursor]!.ex <= bars[0].date
  )
    normalizedBeforeFirst.push(events[cursor++]!.id);
  const adjusted = bars.map((bar, i) => {
    if (
      (i > 0 && bar.date <= bars[i - 1]!.date) ||
      [bar.open, bar.high, bar.low, bar.close].some(
        (p) => !Number.isFinite(p) || p <= 0,
      )
    )
      throw new Error("复权信号行情顺序或价格非法");
    let reference = previousClose;
    while (cursor < events.length && events[cursor]!.ex <= bar.date) {
      const event = events[cursor++]!,
        exReference = reference - event.perShare;
      if (exReference <= 0)
        throw new Error("现金除息参考价非正，不能计算复权信号");
      factor *= reference / exReference;
      if (!Number.isFinite(factor) || factor <= 0)
        throw new Error("复权信号因子溢出");
      changes.push({
        id: event.id,
        effectiveDate: event.ex,
        appliedOn: bar.date,
        previousReference: reference,
        exReference,
        factor,
      });
      reference = exReference;
    }
    previousClose = bar.close;
    const result = {
      ...bar,
      open: bar.open * factor,
      high: bar.high * factor,
      low: bar.low * factor,
      close: bar.close * factor,
    };
    if (
      [result.open, result.high, result.low, result.close].some(
        (p) => !Number.isFinite(p),
      )
    )
      throw new Error("复权信号价格溢出");
    return result;
  });
  return {
    bars: adjusted,
    metadata: {
      version: "cash-backward-1" as const,
      normalizationDate: bars[0]?.date ?? null,
      changes,
      normalizedBeforeFirst,
      warnings: [
        "仅纯现金后复权信号：因子在除息日及之后变化，未来事件不改写此前价格。成交、持仓估值和成交量仍用原值。",
        "参考价为前收减税前每股现金的理论值，未按交易所价格最小单位取整，不冒称官方复权因子。",
        "首根及以前事件归入首根因子为1的归一化；缺行情日事件在下一观测生效，不证明交易日完整。",
        ...(plan.warmupWarnings ?? []),
      ],
    },
  };
}
export type CashSignalAdjustment = ReturnType<
  typeof cashAdjustedSignals
>["metadata"];
