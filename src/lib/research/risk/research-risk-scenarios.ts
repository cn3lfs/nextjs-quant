import type { Bar } from "../../domain";
import type { BreakoutPoint } from "../../../server/strategies/breakout/breakout";
import type { ResearchTrade } from "../../../server/backtest/research-portfolio";

export function crowdedStop(
  point: BreakoutPoint | null,
  anchor: "round" | "swing-low" | "trend",
  atr: number | null,
  multiple: 0 | 0.3 | 0.5,
) {
  if (!point || atr == null || !Number.isFinite(atr) || atr <= 0) return null;
  const raw =
    anchor === "trend"
      ? point.long.line &&
        point.long.line.touches >= 3 &&
        point.long.line.confirmedAt <= point.date
        ? point.long.line.value
        : null
      : (point.levels
          .filter(
            (l) =>
              l.source === anchor &&
              l.confirmedAt <= point.date &&
              l.price < point.close,
          )
          .sort((a, b) => b.price - a.price)[0]?.price ?? null);
  if (raw == null || !Number.isFinite(raw) || raw <= 0 || raw >= point.close)
    return null;
  const price = raw - multiple * atr;
  return price > 0
    ? { price, anchor, raw, atr, multiple, observedDate: point.date }
    : null;
}

/** Exact no-fee source formula: slippage is reported after sizing, not budgeted. */
export function scriptSlipSizing(
  equity: number,
  riskFraction: number,
  entry: number,
  stop: number,
  lot: number,
  slippagePerShare: number,
  maxWeight: number,
) {
  if (
    ![equity, riskFraction, entry, stop, lot, maxWeight].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    stop >= entry ||
    !Number.isInteger(lot) ||
    !Number.isFinite(slippagePerShare) ||
    slippagePerShare < 0
  )
    return null;
  const distance = entry - stop,
    budget = equity * riskFraction;
  const quantity = Math.min(
    Math.floor(budget / distance / lot) * lot,
    Math.floor((equity * maxWeight) / entry / lot) * lot,
  );
  return {
    version: "source-script-slip-report-1",
    quantity,
    budget,
    distance,
    slippagePerShare,
    riskWithoutSlippage: quantity * distance,
    riskWithSlippage: quantity * (distance + slippagePerShare),
    feesIncluded: false,
    quantityResizedForSlippage: false,
  };
}

export function chopFrequency(
  mode: "pause" | "spacing",
  date: string,
  calendar: readonly string[],
  bars: readonly Bar[],
  trades: readonly ResearchTrade[],
) {
  const prior = calendar.filter((d) => d < date).slice(-21),
    byDate = new Map(bars.map((b) => [b.date, b]));
  const values = prior.map((d) => byDate.get(d));
  if (
    prior.length !== 21 ||
    values.some(
      (b) =>
        !b ||
        ![b.close, b.open, b.high, b.low, b.volume].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        b.high < Math.max(b.open, b.close) ||
        b.low > Math.min(b.open, b.close),
    )
  )
    return {
      allow: false,
      reason: "missing: 震荡诊断缺连续21日有效基准",
      losses: null,
      turns: null,
      choppy: null,
    };
  const changes = values
    .slice(1)
    .map((b, i) => Math.sign(b!.close - values[i]!.close));
  const turns = changes.slice(1).filter((v, i) => v * changes[i]! < 0).length;
  const choppy =
    turns >= 6 &&
    Math.abs(values.at(-1)!.close / values[0]!.close - 1) <= 0.03 + 1e-12;
  const losses = trades.filter(
    (t) =>
      t.exitDate &&
      t.exitDate >= prior[1]! &&
      t.exitDate < date &&
      t.profit != null &&
      t.profit < 0 &&
      t.exitReason?.includes("止损"),
  );
  const active = choppy && losses.length >= 3;
  const index = calendar.indexOf(date);
  const recent =
    mode === "pause"
      ? losses.some((t) => index - calendar.indexOf(t.exitDate!) <= 5)
      : trades.some(
          (t) =>
            t.entryDate <= date && index - calendar.indexOf(t.entryDate) < 5,
        );
  return {
    allow: !active || !recent,
    reason:
      active && recent
        ? mode === "pause"
          ? "震荡且20日止损至少3笔，末次止损后暂停5交易日"
          : "震荡且频繁止损，入场间隔至少5交易日"
        : null,
    losses: losses.length,
    turns,
    choppy,
  };
}

export const riskScenarioBoundary =
  "缓冲工程v1：复用双突破当时已确认整数阶梯/摆动低点/至少3触点趋势线，取低于信号收盘的最近对应线，对照0/0.3/0.5ATR14；距实际开盘重算含费风险股数，不把拥挤解释当盘口证据。原脚本滑点诊断按不含费距离及市值/整手先取股数，再报告股数*(距离+假设每股滑点)，与严格实际股数并列，绝不以诊断股数替换交易执行。震荡工程定义为此前21研究日收盘、20段相邻方向反转至少6次且区间净涨跌绝对值≤3%；同时此前20日已结算净亏止损至少3笔，比较最后止损后暂停5日与入场间隔至少5日，仅限制新仓。无单笔止损对照固定布林下轨回归入场与原信号退出、60日上限、10%单股/30%总仓/10%账户回撤暂停；5%线只作数量预算标尺，取消其价格退出，不能保证单笔损失封顶。全部阈值为冻结工程版本，保留亏损结果。";

/** Review every complete block, including losses. Never select parameters on this report. */
export function swingCalibration(
  records: readonly {
    version: string;
    complete?: boolean;
    mae: number;
    profit: number;
    atr: number;
    entry: number;
  }[],
) {
  const missing =
    records.length !== 100 ||
    new Set(records.map((r) => r.version)).size !== 1 ||
    records.some(
      (r) =>
        r.complete === false ||
        ![r.mae, r.profit, r.atr, r.entry].every(Number.isFinite) ||
        r.mae < 0 ||
        r.atr <= 0 ||
        r.entry <= 0,
    );
  const quantile = (xs: number[]) => {
    if (!xs.length) return null;
    xs.sort((a, b) => a - b);
    const i = (xs.length - 1) * 0.9;
    return (
      xs[Math.floor(i)]! +
      (xs[Math.ceil(i)]! - xs[Math.floor(i)]!) * (i - Math.floor(i))
    );
  };
  return {
    version: "swing-review-100-v1",
    count: records.length,
    reason: missing ? "百笔完整同版本记录/ATR缺失" : null,
    winnerMaeAtrQ90: missing
      ? null
      : quantile(records.filter((r) => r.profit > 0).map((r) => r.mae / r.atr)),
    loserMaeAtrQ90: missing
      ? null
      : quantile(
          records.filter((r) => r.profit <= 0).map((r) => r.mae / r.atr),
        ),
    currentBufferAtr: 0.3,
    currentMaxDistanceAtr: 2,
    parametersChanged: false,
    records,
  };
}
