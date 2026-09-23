import type { ReviewRound } from "../../portfolio/trade-review";

export type KeyTrade = Pick<
  ReviewRound,
  | "security"
  | "openingDate"
  | "closingDate"
  | "quantity"
  | "holdingTradingDays"
  | "netProfit"
  | "netReturn"
> & { id: string };
export type KeyTradeRanking = { highest: KeyTrade[]; lowest: KeyTrade[] };

/** U9: consume flat-to-flat rounds of one cost method, never per-sale realizations. */
export function keyTrades(rounds: readonly ReviewRound[], n = 3) {
  if (!Number.isInteger(n) || n < 1 || n > 20)
    throw new Error("N 必须是 1–20 的整数");
  let openCount = 0,
    missingCount = 0;
  const reasons = new Map<string, number>();
  const groups = new Map<string, KeyTrade[]>();
  rounds.forEach((round, index) => {
    if (round.closingDate === null) {
      openCount++;
      return;
    }
    const missing = (["netProfit", "netReturn"] as const).filter(
      (key) => round[key].value === null || !Number.isFinite(round[key].value),
    );
    if (missing.length) {
      missingCount++;
      for (const key of missing) {
        const reason = `${key === "netProfit" ? "净收益金额" : "净收益率"}：${round[key].reason ?? "数值不可得"}`;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      return;
    }
    const year = round.closingDate.slice(0, 4);
    const rows = groups.get(year) ?? [];
    const {
      security,
      openingDate,
      closingDate,
      quantity,
      holdingTradingDays,
      netProfit,
      netReturn,
    } = round;
    rows.push({
      id: `${round.costMethod}-${index}`,
      security,
      openingDate,
      closingDate,
      quantity,
      holdingTradingDays,
      netProfit,
      netReturn,
    });
    groups.set(year, rows);
  });
  return {
    n,
    openCount,
    missingCount,
    missingReasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    years: [...groups]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([year, rows]) => {
        const rank = (key: "netProfit" | "netReturn"): KeyTradeRanking => ({
          highest: [...rows]
            .sort((a, b) => b[key].value! - a[key].value!)
            .slice(0, n),
          lowest: [...rows]
            .sort((a, b) => a[key].value! - b[key].value!)
            .slice(0, n),
        });
        return {
          year,
          count: rows.length,
          amount: rank("netProfit"),
          returnRate: rank("netReturn"),
        };
      }),
  };
}
