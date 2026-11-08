import type { PerformanceMetric } from "./performance.js";

export type TradeCycle = {
  id: string;
  symbol: string;
  openedAt: string;
  closedAt: string | null;
  /** Net cash profit after all modeled fees/distributions; unknown until flat. */
  netPnl: number | null;
};
export type TradeFill = {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
};
export type TradeAction = {
  date: string;
  symbol: string;
  dividend: number;
  bonus: number;
  rights?: number;
  rightsPrice?: number;
  unsupported?: boolean;
};
const tolerance = 1e-8;
function validDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
function value(value: number | null, reason: string): PerformanceMetric {
  if (value !== null && !Number.isFinite(value))
    throw new Error("交易评价数值溢出");
  return { value, reason: value === null ? reason : null };
}

/** Read-only reconstruction: one symbol from flat to flat, not FIFO sale lots.
 * Actions precede same-day fills; input fill order within each day is preserved.
 */
export function pairPositionCycles(
  fills: readonly TradeFill[],
  actions: readonly TradeAction[] = [],
): TradeCycle[] {
  let previous = "";
  for (const f of fills) {
    if (
      !validDate(f.date) ||
      f.date < previous ||
      !f.symbol ||
      !["buy", "sell"].includes(f.side) ||
      ![f.quantity, f.price, f.fee].every(Number.isFinite) ||
      f.quantity <= 0 ||
      f.price <= 0 ||
      f.fee < 0
    )
      throw new Error("交易成交日期、顺序、数量、价格或费用非法");
    previous = f.date;
  }
  const actionKeys = new Set<string>();
  for (const a of actions) {
    const key = `${a.symbol}:${a.date}`;
    if (
      !validDate(a.date) ||
      !a.symbol ||
      actionKeys.has(key) ||
      ![a.dividend, a.bonus, a.rights ?? 0, a.rightsPrice ?? 0].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) ||
      ((a.rights ?? 0) > 0 && a.rightsPrice === undefined)
    )
      throw new Error("交易公司行动日期、数值或唯一性非法");
    actionKeys.add(key);
  }
  const events = [
    ...actions.map((a) => ({ date: a.date, action: a, fill: null })),
    ...fills.map((f) => ({ date: f.date, action: null, fill: f })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const active = new Map<
    string,
    { cycle: TradeCycle; quantity: number; cash: number }
  >();
  const cycles: TradeCycle[] = [];
  for (const event of events) {
    const a = event.action;
    if (a) {
      const h = active.get(a.symbol);
      if (!h) continue;
      if (a.unsupported) throw new Error(`${a.symbol} 持仓公司行动无法配对`);
      h.cash +=
        h.quantity * (a.dividend - (a.rights ?? 0) * (a.rightsPrice ?? 0));
      h.quantity *= 1 + a.bonus + (a.rights ?? 0);
      if (!Number.isFinite(h.cash) || !Number.isFinite(h.quantity))
        throw new Error("交易配对数值溢出");
      continue;
    }
    const f = event.fill!;
    let h = active.get(f.symbol);
    if (f.side === "buy") {
      if (!h) {
        const cycle = {
          id: `${f.symbol}:${cycles.length + 1}`,
          symbol: f.symbol,
          openedAt: f.date,
          closedAt: null,
          netPnl: null,
        };
        cycles.push(cycle);
        h = { cycle, quantity: 0, cash: 0 };
        active.set(f.symbol, h);
      }
      h.quantity += f.quantity;
      h.cash -= f.quantity * f.price + f.fee;
    } else {
      if (!h || f.quantity > h.quantity + tolerance)
        throw new Error(`${f.symbol} 卖出超过可配对持仓`);
      h.quantity -= f.quantity;
      h.cash += f.quantity * f.price - f.fee;
      if (h.quantity <= tolerance) {
        h.cycle.closedAt = f.date;
        h.cycle.netPnl = h.cash;
        active.delete(f.symbol);
      }
    }
    if (!Number.isFinite(h.cash) || !Number.isFinite(h.quantity))
      throw new Error("交易配对数值溢出");
  }
  return cycles;
}

export function evaluateTrades(cycles: readonly TradeCycle[]) {
  const ids = new Set<string>();
  let wins = 0,
    losses = 0,
    flat = 0,
    open = 0,
    grossProfit = 0,
    grossLoss = 0,
    netProfit = 0;
  for (const t of cycles) {
    if (
      !t.id ||
      ids.has(t.id) ||
      !t.symbol ||
      !validDate(t.openedAt) ||
      (t.closedAt !== null &&
        (!validDate(t.closedAt) || t.closedAt < t.openedAt))
    )
      throw new Error("交易轮次身份、日期或唯一性非法");
    ids.add(t.id);
    if (t.closedAt === null) {
      if (t.netPnl !== null) throw new Error("未平仓轮次不能标记已闭合净损益");
      open++;
      continue;
    }
    if (t.netPnl === null || !Number.isFinite(t.netPnl))
      throw new Error("已闭合交易缺少有限净损益");
    netProfit += t.netPnl;
    if (t.netPnl > tolerance) {
      wins++;
      grossProfit += t.netPnl;
    } else if (t.netPnl < -tolerance) {
      losses++;
      grossLoss -= t.netPnl;
    } else flat++;
  }
  const closed = wins + losses + flat;
  const averageWin = wins ? grossProfit / wins : null;
  const averageLoss = losses ? grossLoss / losses : null;
  return {
    version: "trade-performance-v1" as const,
    pairing: "position-cycle" as const,
    flatTolerance: tolerance,
    closedTrades: closed,
    openTrades: open,
    winningTrades: wins,
    losingTrades: losses,
    flatTrades: flat,
    averageWin: value(averageWin, "无盈利闭合交易"),
    averageLoss: value(averageLoss, "无亏损闭合交易"),
    payoffRatio: value(
      averageWin !== null && averageLoss !== null
        ? averageWin / averageLoss
        : null,
      "同时具有盈利与亏损闭合交易才能计算盈亏比",
    ),
    winRate: value(closed ? wins / closed : null, "没有已闭合交易"),
    profitFactor: value(
      grossLoss > 0 ? grossProfit / grossLoss : null,
      "没有亏损闭合交易，利润因子不显示无穷大",
    ),
    expectancy: value(closed ? netProfit / closed : null, "没有已闭合交易"),
    netProfit: value(netProfit, ""),
  };
}
export type TradeEvaluation = ReturnType<typeof evaluateTrades>;
