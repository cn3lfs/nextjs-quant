import type { runPortfolio } from "quant-backtest";

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

/** Equity attribution includes internal transfers on both sides of the ledger.
 * Daily correlations use consecutive session closes, excluding zero denominators. */
export function computeSleeveAttribution(result: PortfolioResult) {
  const { curve, fills, equity } = result;
  const first = curve[0];
  if (!first || !equity.length) throw new Error("缺少组合权益曲线");
  // The first purchase precedes any transfer. Idle sleeves have only the
  // closing cash and any transfers posted at the end of the first bar.
  const opening = first.sleeves.map(({ id, cash }) => {
    const buy = fills.find((f) => f.date === first.date && f.sleeve === id);
    const initial = buy
      ? buy.cashAfter + buy.quantity * buy.price + buy.fee
      : cash -
        result.transfers.reduce(
          (net, t) =>
            net + (t.date === first.date && t.sleeve === id ? t.amount : 0),
          0,
        );
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
  const ids = curve[0]!.sleeves.map((s) => s.id).sort();
  const series = new Map<string, (number | null)[]>();
  const sleeves = ids.map((id) => {
    const valueAt = (row: PortfolioResult["curve"][number]) => {
      const value = row.sleeves.find((s) => s.id === id)?.equity;
      if (value === undefined || !Number.isFinite(value))
        throw new Error(`分仓权益缺失 ${id} ${row.date}`);
      return value;
    };
    const marks = marksByDay.map(valueAt);
    const closes = marks.slice(1);
    series.set(
      id,
      closes
        .slice(1)
        .map((value, i) => (closes[i]! > 0 ? value / closes[i]! - 1 : null)),
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
      trades: fills.filter((fill) => fill.sleeve === id).length,
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
  const correlations = ids.flatMap((left, i) =>
    ids.slice(i + 1).map((right) => ({
      left,
      right,
      ...pairCorrelation(series.get(left)!, series.get(right)!),
    })),
  );
  return {
    sleeves,
    correlations,
    peakDate: peakRow.date,
    troughDate: troughRow.date,
    peakEquity: peakRow.equity,
    troughEquity: troughRow.equity,
    maxDrawdown: maximum,
    contributionSum,
    transferBasis:
      "按分仓账面权益计算。分仓收益、相关性与峰谷贡献包含内部现金划转，转出与转入在组合层面相抵。",
  };
}

export type SleeveAttribution = ReturnType<typeof computeSleeveAttribution>;
