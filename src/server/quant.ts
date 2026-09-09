import type { Bar, Strategy, Metrics, Backtest, Trade } from "~/lib/domain";
import type { CashDividendPlan } from "~/lib/cash-dividends";
import { DividendLedger } from "./dividend-ledger";
import { cashAdjustedSignals } from "./cash-adjusted-signals";
import {
  backtestCostsSchema,
  defaultBacktestCosts,
  type BacktestCosts,
} from "~/lib/backtest-costs";
const avg = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;
export function metrics(bars: Bar[], strategy: Strategy): Metrics | null {
  // CZSC is a monitor slot, never silently evaluated as moving averages.
  if (strategy.type === "czsc" || strategy.type === "dual-breakout") return null;
  if (bars.length < strategy.slow + 1) return null;
  const last = bars.at(-1)!,
    previous = bars.at(-2)!,
    fast = avg(bars.slice(-strategy.fast).map((b) => b.close)),
    slow = avg(bars.slice(-strategy.slow).map((b) => b.close)),
    base = avg(bars.slice(-6, -1).map((b) => b.volume)),
    change = (last.close / previous.close - 1) * 100,
    volumeRatio = base > 0 ? last.volume / base : 0;
  return {
    close: last.close,
    change,
    fast,
    slow,
    volumeRatio,
    date: last.date,
    score: (fast / slow - 1) * 100,
    matched:
      fast > slow &&
      last.close > fast &&
      change >= strategy.minChange &&
      change <= strategy.maxChange &&
      volumeRatio >= strategy.minVolumeRatio,
  };
}
export function backtest(
  bars: Bar[],
  strategy: Strategy,
  snapshotId: string,
  initial = 100000,
  costInput: BacktestCosts = defaultBacktestCosts,
  evaluationStart = strategy.slow,
  dividendPlan?: CashDividendPlan,
): Backtest {
  const costs = backtestCostsSchema.parse(costInput);
  const commission = costs.commissionBps / 10000,
    tax = costs.sellTaxBps / 10000,
    slippage = costs.slippageBps / 10000;
  if (bars.length < strategy.slow + 2) throw new Error("历史数据不足");
  if (
    !Number.isInteger(evaluationStart) ||
    evaluationStart < strategy.slow ||
    evaluationStart >= bars.length
  )
    throw new Error("回测评估起点或预热长度非法");
  if (
    dividendPlan &&
    bars.some(
      (b, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        !Number.isFinite(Date.parse(b.date)) ||
        new Date(b.date).toISOString().slice(0, 10) !== b.date ||
        (i > 0 && b.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("现金分红模拟需要严格递增的有效日线日期");
  const dividendLedger = dividendPlan
    ? new DividendLedger(dividendPlan)
    : undefined;
  const benchmarkLedger = dividendPlan
    ? new DividendLedger(dividendPlan)
    : undefined;
  const adjusted =
    dividendPlan?.version === "cash-dividends-2"
      ? cashAdjustedSignals(bars, dividendPlan)
      : undefined;
  if (
    adjusted &&
    dividendPlan!.signalStart! >
      bars[Math.max(0, evaluationStart - strategy.slow - 2)]!.date
  )
    throw new Error("分红复权来源未覆盖指标预热区间");
  const signalBars = adjusted?.bars ?? bars;
  let cash = initial,
    shares = 0,
    peak = initial,
    drawdown = 0,
    buyDay = "";
  const trades: Trade[] = [],
    equity: { date: string; value: number }[] = [];
  let benchmarkCash = initial,
    benchmarkShares = 0,
    benchmarkPeak = initial,
    benchmarkDrawdown = 0,
    benchmarkTrade: Trade | null = null;
  const benchmarkEquity: { date: string; value: number }[] = [];
  const diagnostics = {
    entrySignals: 0,
    insufficientCash: 0,
    untradable: 0,
    initial,
  };
  for (let i = evaluationStart; i < bars.length; i++) {
    const bar = bars[i]!,
      signal = metrics(
        signalBars.slice(Math.max(0, i - strategy.slow - 2), i),
        strategy,
      ),
      tradable = bar.volume > 0 && bar.high > bar.low;
    cash += dividendLedger?.beforeOpen(bar.date, shares) ?? 0;
    benchmarkCash +=
      benchmarkLedger?.beforeOpen(bar.date, benchmarkShares) ?? 0;
    // Same retrospective execution restrictions and costs as the strategy.
    // If the first eligible bar is unaffordable, cash waits for an affordable lot.
    if (!benchmarkTrade && tradable) {
      const price = bar.open * (1 + slippage);
      const qty = Math.max(
        0,
        Math.floor(
          (benchmarkCash - costs.minimumCommission) /
            (price * (1 + commission)) /
            100,
        ) * 100,
      );
      if (qty > 0) {
        const fee = Math.max(costs.minimumCommission, qty * price * commission);
        benchmarkCash -= qty * price + fee;
        benchmarkShares = qty;
        benchmarkTrade = {
          date: bar.date,
          side: "buy",
          price,
          shares: qty,
          fee,
        };
      }
    }
    benchmarkCash +=
      benchmarkLedger?.afterClose(bar.date, benchmarkShares) ?? 0;
    const benchmarkValue =
      benchmarkCash +
      benchmarkShares * bar.close +
      (benchmarkLedger?.receivable ?? 0);
    benchmarkPeak = Math.max(benchmarkPeak, benchmarkValue);
    benchmarkDrawdown = Math.max(
      benchmarkDrawdown,
      (benchmarkPeak - benchmarkValue) / benchmarkPeak,
    );
    benchmarkEquity.push({ date: bar.date, value: benchmarkValue });
    if (signal?.matched && shares === 0) {
      diagnostics.entrySignals++;
      if (!tradable) diagnostics.untradable++;
    }
    if (signal?.matched && shares === 0 && tradable) {
      const price = bar.open * (1 + slippage),
        qty = Math.max(
          0,
          Math.floor(
            (cash - costs.minimumCommission) / (price * (1 + commission)) / 100,
          ) * 100,
        );
      if (qty > 0) {
        const fee = Math.max(costs.minimumCommission, qty * price * commission);
        cash -= qty * price + fee;
        shares = qty;
        buyDay = bar.date.slice(0, 10);
        trades.push({ date: bar.date, side: "buy", price, shares: qty, fee });
      } else diagnostics.insufficientCash++;
    } else if (
      signal &&
      !signal.matched &&
      shares > 0 &&
      tradable &&
      buyDay !== bar.date.slice(0, 10)
    ) {
      const price = bar.open * (1 - slippage),
        fee =
          Math.max(costs.minimumCommission, shares * price * commission) +
          shares * price * tax;
      cash += shares * price - fee;
      trades.push({ date: bar.date, side: "sell", price, shares, fee });
      shares = 0;
    }
    cash += dividendLedger?.afterClose(bar.date, shares) ?? 0;
    const value = cash + shares * bar.close + (dividendLedger?.receivable ?? 0);
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, (peak - value) / peak);
    equity.push({ date: bar.date, value });
  }
  return {
    ...(adjusted ? { signalAdjustment: adjusted.metadata } : {}),
    ...(dividendLedger && benchmarkLedger
      ? {
          dividends: {
            strategy: dividendLedger.snapshot(),
            benchmark: benchmarkLedger.snapshot(),
          },
        }
      : {}),
    benchmark: {
      version: dividendPlan ? "buy-hold-2" : "buy-hold-1",
      label: "同标的买入持有（同窗口、同成本，非市场指数）",
      equity: benchmarkEquity,
      trade: benchmarkTrade,
      totalReturn: (benchmarkEquity.at(-1)!.value / initial - 1) * 100,
      maxDrawdown: benchmarkDrawdown * 100,
      excessReturnPoints:
        ((equity.at(-1)!.value - benchmarkEquity.at(-1)!.value) / initial) *
        100,
      cash: benchmarkCash,
      shares: benchmarkShares,
    },
    snapshotId,
    engineVersion: adjusted
      ? "backtest-5"
      : dividendPlan
        ? "backtest-4"
        : "backtest-3",
    evaluationStart,
    costs,
    strategy,
    equity,
    trades,
    totalReturn: (equity.at(-1)!.value / initial - 1) * 100,
    maxDrawdown: drawdown * 100,
    cash,
    shares,
    diagnostics,
    assumptions: [
      ...(dividendPlan
        ? [
            `纯现金分红实验：固定红利税率 ${dividendPlan.taxBps / 100}%，分别按策略和基准登记持仓计算；未到账应收计入净值，不可用于交易。`,
            adjusted
              ? "信号使用纯现金后复权价格，成交和估值使用原始价格，现金分红另记账；股份变动及历史税制未还原，不是完整总回报回测。"
              : "信号仍使用不复权行情；本模式没有解决除息价差对信号、股份变动及历史税制的影响，不是完整总回报回测。",
            ...(adjusted?.metadata.warnings ?? []),
            "事件依据已归档双源观测，未发现记录不等于证明无事件；账簿计算通过不代表公司行动历史完整。",
          ]
        : []),
      "研究模拟：信号只使用上一根及以前行情，按下一根开盘模拟成交",
      "100 股一手，T+1；无量及一字 K 线不成交",
      "成交过滤使用整根K线的成交量与高低价，属于事后保守限制，不能证明开盘时已知可成交；尚无逐时点交易状态及排队还原",
      `佣金 ${costs.commissionBps / 100}% 最低 ${costs.minimumCommission} 元；卖出税费 ${costs.sellTaxBps / 100}%；单边滑点 ${costs.slippageBps / 100}%（${costs.version} 固定实验参数，非历史费率还原）`,
      "未单独建模过户费和其他杂费；买入数量预留最低佣金，按整手取整",
      adjusted
        ? "单只 A 股、仅纯现金信号调整；未完整还原跨除权事件，不能用于正式收益评价"
        : "单只 A 股、不复权；跨除权事件不能用于正式收益评价",
      "买入持有基准在评估窗口首个可成交且买得起整手的开盘买入，期末持仓估值不虚构卖出；超额为收益率百分点差，非风险调整alpha",
      "未完整建模涨跌停排队、流动性、分红送转与退市；期末持仓按收盘估值",
    ],
  };
}
