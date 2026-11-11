export const researchLossPauseVersion = "research-loss-pause-1";

/** One instance per independently funded research partition. Settlement order
 * is the portfolio's deterministic open-fill order, not future return sorting. */
export function researchLossPause(
  calendar: readonly string[],
  restDays: 1 | 2,
) {
  let streak = 0,
    through = -1,
    lastSettlement = -1;
  const records: {
    date: string;
    symbol: string;
    eventKey: string;
    entryDate: string;
    profit: number;
    consecutiveLosses: number;
    triggered: boolean;
    pausedThrough: string | null;
    nextEligibleDate: string | null;
  }[] = [];
  return {
    settle(
      index: number,
      trade: {
        symbol: string;
        eventKey: string;
        entryDate: string;
        profit: number;
      },
    ) {
      if (
        !Number.isInteger(index) ||
        index < lastSettlement ||
        !calendar[index] ||
        !Number.isFinite(trade.profit)
      )
        throw new Error("连亏暂停的完整交易结算或时序无效");
      lastSettlement = index;
      streak = trade.profit < 0 ? streak + 1 : 0;
      const triggered = streak === 3;
      if (triggered) through = Math.max(through, index + restDays);
      records.push({
        date: calendar[index]!,
        ...trade,
        consecutiveLosses: streak,
        triggered,
        pausedThrough: through >= 0 ? (calendar[through] ?? null) : null,
        nextEligibleDate: through >= 0 ? (calendar[through + 1] ?? null) : null,
      });
      if (triggered) streak = 0;
    },
    blocked: (index: number) => index >= 0 && index <= through,
    snapshot(lastIndex: number) {
      return {
        version: researchLossPauseVersion,
        restDays,
        consecutiveLosses: streak,
        paused: lastIndex >= 0 && lastIndex <= through,
        remainingTradingDays: Math.max(0, through - lastIndex),
        pausedThrough: through >= 0 ? (calendar[through] ?? null) : null,
        nextEligibleDate: through >= 0 ? (calendar[through + 1] ?? null) : null,
        records: records.map((row) => ({ ...row })),
      };
    },
  };
}
