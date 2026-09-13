import type { ParsedCashFlow, ParsedFill } from "./delivery-import";

type CashEvent = {
  date: string;
  fill: ParsedFill | null;
  flow: ParsedCashFlow | null;
};

export function tradeReviewCashMovement({
  fill,
  flow,
}: CashEvent): number | null {
  if (!fill) return flow && Number.isFinite(flow.amount) ? flow.amount : null;
  if (fill.netAmount !== null && Number.isFinite(fill.netAmount))
    return fill.netAmount;
  const out =
    fill.instrument === "reverseRepo"
      ? fill.kind === "sell"
      : fill.kind === "buy";
  return Number.isFinite(fill.amount) &&
    fill.amount >= 0 &&
    fill.fees.total !== null &&
    Number.isFinite(fill.fees.total) &&
    fill.fees.total >= 0
    ? (out ? -fill.amount : fill.amount) - fill.fees.total
    : null;
}

/** W10: move only known internal repayments before the first daily outflow.
 * The caller establishes chronological order; every other pair stays ordered. */
export function orderTradeReviewIntraday<T extends CashEvent>(
  events: readonly T[],
): T[] {
  const result: T[] = [];
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (events[end]?.date === events[start]!.date) end++;
    const day = events.slice(start, end);
    const firstOutflow = day.findIndex(
      (event) => (tradeReviewCashMovement(event) ?? 0) < 0,
    );
    const moved =
      firstOutflow < 0
        ? []
        : day
            .slice(firstOutflow)
            .filter(({ fill, flow }) =>
              fill
                ? fill.instrument === "reverseRepo" &&
                  Number.isFinite(fill.netAmount ?? NaN) &&
                  fill.netAmount! > 0
                : flow?.kind === "cashManagement" &&
                  Number.isFinite(flow.amount) &&
                  flow.amount > 0,
            );
    if (moved.length) {
      // An absolute balance belongs to its original path. Reusing it after moving
      // events would silently change the daily close; require source reconciliation.
      if (
        day.some(
          ({ fill }) =>
            fill?.balanceCash !== null && Number.isFinite(fill?.balanceCash),
        )
      )
        throw new Error(
          `${day[0]!.date} 同日内重排涉及柜台资金余额锚点，需先核对原始余额路径，未执行重排`,
        );
      const selected = new Set(moved);
      result.push(
        ...day.slice(0, firstOutflow),
        ...moved,
        ...day.slice(firstOutflow).filter((e) => !selected.has(e)),
      );
    } else result.push(...day);
    start = end;
  }
  return result;
}
