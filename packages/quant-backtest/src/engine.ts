import {
  backtestRequestSchema,
  type BacktestRequest,
  type Bar,
  type BaselineOrder,
  type BaselineFill,
  type SignalSeries,
  type CashEquityAccount,
} from "./model.js";
import { validateFiveMinuteFeed, baselineBarOpenTime } from "./data-feed.js";
import {
  fillMarketOrder,
  affordableQuantity,
  type ExecutionRules,
} from "./execution.js";
import { bookFill, canSellTPlusOne } from "./account.js";
import { EquityAnalyzer } from "./analyzers.js";
import { engineVersion, maBaselineBuildHash } from "./identity.js";

/** Deterministic cash-equity event loop: execute pending -> observe close ->
 * create next-bar order -> mark account. No IO, clocks, database or app state.
 * Current profile is long-only equity with T+1, not a multi-market simulator.
 */
export function runBacktest(
  raw: BacktestRequest,
  bars: readonly Bar[],
  signals: SignalSeries,
  rules: ExecutionRules,
  progress: (completed: number, total: number) => void = () => {},
) {
  const input = backtestRequestSchema.parse(raw);
  if (input.start > input.end) throw new Error("开始日期不能晚于结束日期");
  if (
    !signals.id ||
    !Number.isInteger(signals.warmupBars) ||
    signals.warmupBars < 0 ||
    signals.values.length !== bars.length ||
    signals.values.some((v) => v !== -1 && v !== 0 && v !== 1)
  )
    throw new Error("策略信号、长度或预热声明非法");
  const startIndex = validateFiveMinuteFeed(input, bars, signals.warmupBars);
  const account: CashEquityAccount = {
    cash: input.initial,
    shares: 0,
    buyDay: "",
  };
  const analyzer = new EquityAnalyzer(input.initial);
  const orders: BaselineOrder[] = [],
    fills: BaselineFill[] = [];
  let pending: BaselineOrder | null = null,
    evaluated = 0;
  for (let i = startIndex; i < bars.length; i++) {
    const bar = bars[i]!,
      day = bar.date.slice(0, 10);
    if (day > input.end) break;
    if (pending) {
      pending.attempts++;
      if (pending.side === "sell" && !canSellTPlusOne(account, day))
        pending.reason = "T+1：当日买入不可卖出";
      else {
        const fill = fillMarketOrder(bar, pending.side, rules, input.costs);
        if (fill.price === null) {
          pending.reason = fill.reason;
          if (pending.side === "buy") {
            pending.status = "rejected";
            pending = null;
          }
        } else {
          const quantity =
            pending.side === "buy"
              ? affordableQuantity(account.cash, fill.price, rules, input.costs)
              : account.shares;
          if (quantity <= 0) {
            pending.status = "rejected";
            pending.reason = "资金不足以支付一手及费用";
            pending = null;
          } else {
            const fee = bookFill(
              account,
              pending.side,
              fill.price,
              quantity,
              day,
              input.costs,
            );
            pending.status = "filled";
            pending.reason = null;
            fills.push({
              orderId: pending.id,
              signalAt: pending.signalAt,
              barEnd: bar.date,
              executedAt: baselineBarOpenTime(bar.date),
              side: pending.side,
              price: fill.price,
              shares: quantity,
              fee,
              cashAfter: account.cash,
              sharesAfter: account.shares,
            });
            pending = null;
          }
        }
      }
    }
    const side =
      signals.values[i] === 1 && account.shares === 0
        ? "buy"
        : signals.values[i] === -1 && account.shares > 0
          ? "sell"
          : null;
    if (!pending && side) {
      pending = {
        id: orders.length + 1,
        side,
        signalAt: bar.date,
        status: "pending",
        attempts: 0,
        reason: null,
      };
      orders.push(pending);
    }
    analyzer.observe(day, account.cash + account.shares * bar.close);
    evaluated++;
    if (evaluated % 4096 === 0) progress(evaluated, bars.length - startIndex);
  }
  progress(evaluated, evaluated);
  return {
    engineVersion,
    engineHash: maBaselineBuildHash,
    strategyId: signals.id,
    quality: "rule-check-only" as const,
    input,
    cash: account.cash,
    shares: account.shares,
    evaluated,
    totalReturn: analyzer.totalReturn,
    maxDrawdown: analyzer.maxDrawdown,
    equity: analyzer.equity,
    orders,
    fills,
  };
}
export type BacktestResult = ReturnType<typeof runBacktest>;
