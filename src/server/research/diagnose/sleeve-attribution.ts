import type { runPortfolio } from "quant-backtest";
import { big, toNumber } from "trading-strategy-core/money";

type PortfolioResult = ReturnType<typeof runPortfolio>;

export const coreBookCapacity = {
  maxParticipation: 0.005,
  capacityPolicy: "clip",
} as const;

function drawdown(points: readonly number[]) {
  let high = 0,
    peak = 0,
    trough = 0,
    maximum = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]! >= points[high]!) high = i;
    const decline =
      points[high]! > 0 ? (points[high]! - points[i]!) / points[high]! : 0;
    if (decline > maximum) {
      maximum = decline;
      peak = high;
      trough = i;
    }
  }
  return { peak, trough, maximum };
}

function pairCorrelation(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
) {
  let overlap = 0,
    meanX = 0,
    meanY = 0,
    xx = 0,
    yy = 0,
    xy = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (x == null || y == null) continue;
    const dx = x - meanX,
      dy = y - meanY;
    overlap++;
    meanX += dx / overlap;
    meanY += dy / overlap;
    xx += dx * (x - meanX);
    yy += dy * (y - meanY);
    xy += dx * (y - meanY);
  }
  if (overlap < 20)
    return { overlap, correlation: null, reason: "重叠有效交易日不足 20 天" };
  if (xx <= 0 || yy <= 0)
    return { overlap, correlation: null, reason: "分仓日收益零方差" };
  const value = xy / Math.sqrt(xx * yy);
  return Number.isFinite(value)
    ? { overlap, correlation: Math.min(1, Math.max(-1, value)), reason: null }
    : { overlap, correlation: null, reason: "相关性计算结果非有限值" };
}

/** Book equity is additive at the portfolio peak and trough. Investment returns
 * remove end-of-session transfers before linking each day's growth factor. */
export function computeSleeveAttribution(result: PortfolioResult) {
  const { curve, fills, equity } = result;
  const first = curve[0];
  if (!first || !equity.length) throw new Error("缺少组合权益曲线");
  // The first purchase precedes any transfer. Idle sleeves have only the
  // closing cash and any transfers posted at the end of the first bar.
  const ids = first.sleeves.map((s) => s.id).sort();
  const transfersBySleeve = new Map(
    ids.map((id) => [id, new Map<string, ReturnType<typeof big>>()]),
  );
  const firstTransfers = new Map<string, ReturnType<typeof big>>();
  for (const transfer of result.transfers) {
    const series = transfersBySleeve.get(transfer.sleeve);
    if (!series) throw new Error(`未知划转分仓 ${transfer.sleeve}`);
    const day = transfer.date.slice(0, 10);
    series.set(day, (series.get(day) ?? big(0)).plus(transfer.amount));
    if (transfer.date === first.date)
      firstTransfers.set(
        transfer.sleeve,
        (firstTransfers.get(transfer.sleeve) ?? big(0)).plus(transfer.amount),
      );
  }
  const firstBuys = new Map<string, PortfolioResult["fills"][number]>();
  const fillCounts = new Map<string, number>();
  for (const fill of fills) {
    fillCounts.set(fill.sleeve, (fillCounts.get(fill.sleeve) ?? 0) + 1);
    if (
      fill.date === first.date &&
      fill.side === "buy" &&
      !firstBuys.has(fill.sleeve)
    )
      firstBuys.set(fill.sleeve, fill);
  }
  const opening = first.sleeves.map(({ id, cash }) => {
    const buy = firstBuys.get(id);
    const initial = buy
      ? toNumber(
          big(buy.cashAfter)
            .plus(big(buy.quantity).times(buy.price))
            .plus(buy.fee),
        )
      : toNumber(big(cash).minus(firstTransfers.get(id) ?? 0));
    return { id, cash: initial, equity: initial };
  });
  const initial = opening.reduce((sum, sleeve) => sum + sleeve.equity, 0);
  const marksByDay = [
    { date: equity[0]!.date, sleeves: opening, cash: initial, equity: initial },
    ...equity,
  ];
  const { peak, trough, maximum } = drawdown(
    marksByDay.map((row) => row.equity),
  );
  const peakRow = marksByDay[peak]!,
    troughRow = marksByDay[trough]!;
  if (!(peakRow.equity > 0)) throw new Error("组合峰值权益必须为正");
  const bookSeries = new Map<string, (number | null)[]>();
  const investmentSeries = new Map<string, (number | null)[]>();
  const sleeves = ids.map((id) => {
    const valueAt = (row: PortfolioResult["curve"][number]) => {
      const value = row.sleeves.find((s) => s.id === id)?.equity;
      if (value === undefined || !Number.isFinite(value))
        throw new Error(`分仓权益缺失 ${id} ${row.date}`);
      return value;
    };
    const marks = marksByDay.map(valueAt);
    const closes = marks.slice(1);
    bookSeries.set(
      id,
      closes
        .slice(1)
        .map((value, i) => (closes[i]! > 0 ? value / closes[i]! - 1 : null)),
    );
    let tradingPnl = big(0);
    let investmentValue: number | null = 1;
    const investmentMarks = [1];
    const flows = transfersBySleeve.get(id)!;
    const dailyInvestmentReturns = equity.map(({ date, sleeves }, i) => {
      const previous = marks[i]!;
      const current = closes[i]!;
      const transfer = flows.get(date) ?? big(0);
      const pnl = big(current).minus(transfer).minus(previous);
      // The ledger exports decimal balances as Numbers. Treat only transfer
      // reconciliation differences within their floating-point resolution as zero.
      const resolution =
        Number.EPSILON *
        Math.max(
          Math.abs(current),
          Math.abs(previous),
          Math.abs(toNumber(transfer)),
        );
      const reconciled =
        !transfer.eq(0) && Math.abs(toNumber(pnl)) <= resolution ? big(0) : pnl;
      tradingPnl = tradingPnl.plus(reconciled);
      const dailyReturn =
        previous > 0
          ? toNumber(reconciled.div(previous))
          : reconciled.eq(0)
            ? 0
            : null;
      investmentValue =
        investmentValue === null || dailyReturn === null
          ? null
          : investmentValue * (1 + dailyReturn);
      if (investmentValue !== null) investmentMarks.push(investmentValue);
      return {
        date,
        return: dailyReturn,
        invested: current > sleeves.find((s) => s.id === id)!.cash,
      };
    });
    investmentSeries.set(
      id,
      dailyInvestmentReturns.map((row) => row.return),
    );
    const initialEquity = marks[0]!,
      finalEquity = marks.at(-1)!;
    const weights = equity.flatMap((row, i) =>
      row.equity > 0 ? [closes[i]! / row.equity] : [],
    );
    return {
      id,
      initialEquity,
      finalEquity,
      return: initialEquity > 0 ? finalEquity / initialEquity - 1 : null,
      maxDrawdown: drawdown(marks).maximum,
      investmentReturn: investmentValue === null ? null : investmentValue - 1,
      investmentMaxDrawdown:
        investmentValue === null ? null : drawdown(investmentMarks).maximum,
      dailyInvestmentReturns,
      tradingPnlContribution: toNumber(tradingPnl),
      trades: fillCounts.get(id) ?? 0,
      averageWeight: weights.length
        ? weights.reduce((a, b) => a + b, 0) / weights.length
        : null,
      drawdownContribution: (marks[peak]! - marks[trough]!) / peakRow.equity,
    };
  });
  const contributionSum = sleeves.reduce(
    (sum, s) => sum + s.drawdownContribution,
    0,
  );
  if (!(Math.abs(contributionSum - maximum) < 1e-12))
    throw new Error("分仓峰谷权益与组合回撤不一致");
  const correlate = (series: ReadonlyMap<string, readonly (number | null)[]>) =>
    ids.flatMap((left, i) =>
      ids.slice(i + 1).map((right) => ({
        left,
        right,
        ...pairCorrelation(series.get(left)!, series.get(right)!),
      })),
    );
  return {
    sleeves,
    correlations: correlate(bookSeries),
    investmentCorrelations: correlate(investmentSeries),
    peakDate: peakRow.date,
    troughDate: troughRow.date,
    peakEquity: peakRow.equity,
    troughEquity: troughRow.equity,
    maxDrawdown: maximum,
    contributionSum,
    transferBasis:
      "账面收益、相邻收盘收益相关性和峰谷贡献包含内部现金划转。投资日收益从期初计，复合收益、最大回撤、相关性及账户币种交易损益均剔除内部现金划转。",
  };
}

export type SleeveAttribution = ReturnType<typeof computeSleeveAttribution>;
