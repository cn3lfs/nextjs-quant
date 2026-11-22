import {
  actionPrice,
  type PortfolioExecution,
  type PortfolioInstrument,
} from "quant-backtest";
import {
  defaultExecutionCosts,
  executionCostsForDate,
} from "trading-strategy-core/costs";
import type { Bar } from "trading-strategy-core/bars";
import type {
  DiagnosticCheck,
  DiagnosticReport,
  DiagnoseCounts,
  DiagnoseLayer,
  DiagnosticsInput,
} from "./types";
import { reconcileFills } from "./reconcile";

/** Ratio drift tolerated from integer-cent adjusted prices. */
const RATIO_TOLERANCE = 5e-3;
const MONEY_TOLERANCE = 1e-6;

function executionFor(
  instrument: PortfolioInstrument,
  bar: Bar | undefined,
  previous: Bar | undefined,
): PortfolioExecution | undefined {
  const execution = instrument.execution;
  if (typeof execution === "function") return execution(bar, previous);
  if ("evidence" in execution) return execution as PortfolioExecution;
  return bar ? execution[bar.date] : undefined;
}

/** Latest observed bar at or before `date`; a suspended day keeps its stale bar. */
function lastBarOnOrBefore(bars: readonly Bar[], date: string): Bar | null {
  let low = 0,
    high = bars.length - 1,
    best: Bar | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (bars[middle]!.date <= date) {
      best = bars[middle]!;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/**
 * Mark for a held position on `date`. A suspended date keeps the last observed
 * bar, but actions effective after that bar still adjust the stale close, the
 * same way the engine re-marks a position on the action date.
 */
function adjustedCloseOnOrBefore(
  instrument: PortfolioInstrument,
  date: string,
): number | null {
  const bar = lastBarOnOrBefore(instrument.bars, date);
  if (!bar) return null;
  let price = bar.close;
  const actions = [...(instrument.actions ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  for (const action of actions) {
    const actionDate =
      action.date.length === 10 ? action.date : action.date.slice(0, 10);
    if (actionDate > bar.date && actionDate <= date)
      price = actionPrice(price, action);
  }
  return price;
}

function calendarOnOrAfter(
  calendar: readonly string[],
  date: string,
): string | null {
  let low = 0,
    high = calendar.length - 1,
    best: string | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (calendar[middle]! >= date) {
      best = calendar[middle]!;
      high = middle - 1;
    } else low = middle + 1;
  }
  return best;
}

function ratioAt(instrument: PortfolioInstrument, index: number) {
  const raw = instrument.bars[index]!,
    signal = instrument.signalBars[index]!;
  if (!(raw.close > 0) || !(signal.close > 0)) return null;
  return signal.close / raw.close;
}

function priceBasisOf(
  instrument: PortfolioInstrument,
  sources: readonly Record<string, unknown>[],
): "causal" | "forward" | "raw" {
  const source = sources.find((row) => row.symbol === instrument.symbol);
  if (source && typeof source.causalPrice === "object" && source.causalPrice)
    return "causal";
  if (instrument.bars === instrument.signalBars) return "raw";
  return "forward";
}

const layerByCheck: Record<string, DiagnoseLayer> = {
  fillAfterSignal: "order",
  orderFillConservation: "order",
  orderFillCardinality: "order",
  noDuplicateFill: "order",
  fillPriceWithinBar: "fill",
  feeMatches: "fee",
  cashNonNegative: "ledger",
  equityIdentity: "ledger",
  ledgerReconcile: "ledger",
  ledgerReconcileUnavailable: "ledger",
  corporateActionDates: "corporate-action",
  priceBasisChangeWithoutAction: "causal-price",
};
const layerPriority: DiagnoseLayer[] = [
  "order",
  "fill",
  "fee",
  "ledger",
  "corporate-action",
  "causal-price",
  "gbbq",
  "signal",
  "data",
  "internal",
];

/**
 * Reconcile one replayed cell against the frozen request. Rules that detect a
 * correctness violation (`fail`) are kept separate from data limitations,
 * which stay `warn` so an incomplete source never reads as an engine defect.
 */
export function runDiagnostics(input: DiagnosticsInput): DiagnosticReport {
  const { request, frozen, replay } = input;
  const result = replay.result;
  const checks: DiagnosticCheck[] = [];
  const findings: string[] = [];
  const add = (check: DiagnosticCheck) => {
    checks.push(check);
    if (check.status !== "pass") findings.push(`${check.id}: ${check.message}`);
  };

  let bars = 0,
    warmup = 0;
  for (const instrument of request.instruments) {
    bars += instrument.bars.length;
    warmup += instrument.bars.filter(
      (bar) => bar.date.slice(0, 10) < request.start,
    ).length;
  }
  const observations = result.observations ?? [];
  const useEvidence = replay.signalEvidence.length > 0;
  const signals = useEvidence
    ? replay.signalEvidence.length
    : observations.filter(
        (row) => row.decision.entry === true || row.decision.exit === true,
      ).length;
  const counts: DiagnoseCounts = {
    bars,
    warmup,
    signals,
    orders: result.orders.length,
    fills: result.fills.length,
    rejections: result.rejections.length,
    closedTrades: result.fills.filter((fill) => fill.holdingAfter === 0).length,
  };

  const rejectionCounts = new Map<string, number>();
  for (const rejection of result.rejections)
    rejectionCounts.set(
      rejection.reason,
      (rejectionCounts.get(rejection.reason) ?? 0) + 1,
    );
  const topRejections = [...rejectionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}×${count}`)
    .join("；");

  // A missing side means the rule has not warmed up, even though the engine
  // coerces the entry side to false when the exit side is still null. A
  // decision is only "evaluated" once both sides are boolean. The constant
  // entry control has no rule to warm up, so nulls there are not a warmup story.
  const controlOnly =
    request.strategies.length > 0 &&
    request.strategies.every((strategy) => strategy.entry.kind === "constant");
  const allWarmup =
    observations.length > 0 &&
    observations.every(
      (row) => row.decision.entry === null || row.decision.exit === null,
    );
  const anyEvaluated = observations.some(
    (row) => row.decision.entry !== null && row.decision.exit !== null,
  );
  const signalEvidence = {
    source: useEvidence ? "signalEvidence" : "observations",
    observations: observations.length,
  };
  if (signals > 0)
    add({
      id: "signalCount",
      status: "pass",
      message: `窗口内 ${signals} 个信号`,
      evidence: signalEvidence,
    });
  else if (controlOnly)
    add({
      id: "signalCount",
      status: "warn",
      message:
        "对照策略没有 rule 级 entry/exit 信号（constant 入场）；这不是预热，对照本身不产生 rule 决策",
      evidence: signalEvidence,
    });
  else if (allWarmup)
    add({
      id: "signalCount",
      status: "warn",
      message: `窗口内 rule 尚未完成预热（warmup）：${observations.length} 条逐日决策缺少完整的 entry/exit 结果`,
      evidence: signalEvidence,
    });
  else if (anyEvaluated)
    add({
      id: "signalCount",
      status: "warn",
      message: "窗口内已评估但没有 rule 级 entry/exit 信号",
      evidence: signalEvidence,
    });
  else
    add({
      id: "signalCount",
      status: "warn",
      message:
        "窗口内没有 rule 级 entry/exit 信号；缺少逐日观察记录，无法区分预热与已评估",
      evidence: signalEvidence,
    });
  for (const [id, threshold] of [
    ["signalsToFills", signals],
    ["ordersToFills", counts.orders],
  ] as const)
    if (threshold > 0 && counts.fills === 0)
      add({
        id,
        status: "warn",
        message: `${id === "signalsToFills" ? "有信号" : "有订单"}但没有成交；拒绝原因：${topRejections || "未记录"}`,
        evidence: { rejections: [...rejectionCounts.entries()] },
      });

  const ordersById = new Map(result.orders.map((order) => [order.id, order]));
  const orderFillCounts = new Map<number, number>();
  const fillsByOrder = new Map<number, (typeof result.fills)[number][]>();
  const duplicateFills: string[] = [];
  const seenFills = new Set<string>();
  for (const fill of result.fills) {
    orderFillCounts.set(
      fill.orderId,
      (orderFillCounts.get(fill.orderId) ?? 0) + 1,
    );
    const rows = fillsByOrder.get(fill.orderId) ?? [];
    rows.push(fill);
    fillsByOrder.set(fill.orderId, rows);
    const key = [
      fill.orderId,
      fill.date,
      fill.side,
      fill.price,
      fill.quantity,
    ].join("|");
    if (seenFills.has(key)) duplicateFills.push(key);
    seenFills.add(key);
  }

  // Protective exits are pushed and executed inside the same completed bar as
  // the price that tripped them (`pushOrder(strategy, symbol, date, date, ...)`
  // then `execute(order, date, protection.price)`), so their fill date equals
  // the signal date by design. Entries and signal-driven exits must still wait
  // for a strictly later tradable bar.
  const protectiveTriggers = new Set(["stop", "target", "trailing"]);
  const earlyFills: typeof result.fills = [];
  const regularSameDayFills: typeof result.fills = [];
  let protectiveSameBar = 0;
  for (const fill of result.fills) {
    const fillAt = Date.parse(fill.date),
      signalAt = Date.parse(fill.signalAt);
    if (fillAt < signalAt) {
      earlyFills.push(fill);
      continue;
    }
    if (fillAt > signalAt) continue;
    const order = ordersById.get(fill.orderId);
    if (order && protectiveTriggers.has(order.trigger)) protectiveSameBar++;
    else regularSameDayFills.push(fill);
  }
  const timingViolations = [...earlyFills, ...regularSameDayFills];
  const timingParts: string[] = [];
  if (earlyFills.length)
    timingParts.push(`${earlyFills.length} 笔成交早于信号日`);
  if (regularSameDayFills.length)
    timingParts.push(
      `${regularSameDayFills.length} 笔常规入场/出场在信号当日成交（应等下一可交易 bar）`,
    );
  add({
    id: "fillAfterSignal",
    status: timingViolations.length ? "fail" : "pass",
    message: timingViolations.length
      ? timingParts.join("；")
      : protectiveSameBar
        ? `常规成交均严格晚于信号日；${protectiveSameBar} 笔保护性退出（stop/target/trailing）与信号同 bar 成交`
        : "所有成交均严格晚于信号日",
    evidence: {
      violations: timingViolations.slice(0, 5),
      early: earlyFills.length,
      regularSameDay: regularSameDayFills.length,
      protectiveSameBar,
    },
  });

  const mismatched = result.fills.filter((fill) => {
    const order = ordersById.get(fill.orderId);
    return (
      !order ||
      order.symbol !== fill.symbol ||
      order.side !== fill.side ||
      order.strategyId !== fill.strategyId
    );
  });
  add({
    id: "fillOrderMatch",
    status: mismatched.length ? "fail" : "pass",
    message: mismatched.length
      ? `${mismatched.length} 笔成交找不到匹配订单`
      : "每笔成交都能匹配订单号、方向与标的",
    evidence: mismatched.slice(0, 5),
  });

  // A superseded target order keeps its prior partial fills when a new
  // completed-bar target replaces it. That is the only rejected-with-fills
  // lifecycle supported on this path.
  const supersededTarget = (order: (typeof result.orders)[number]) =>
    order.targetWeight !== undefined &&
    order.reason === "被新的完成bar调仓目标替代";
  // Partial/multi-fill execution is supported only for target-weight orders and
  // explicitly capacity-clipped orders. A plain signal order must still fill
  // in one executable slice.
  const partialFillPath = (order: (typeof result.orders)[number]) =>
    order.targetWeight !== undefined || order.capacityClipped === true;
  const distinctFillDates = (fills: readonly { date: string }[]) =>
    new Set(fills.map((fill) => fill.date)).size === fills.length;

  const conservation = result.orders.filter((order) => {
    const fills = orderFillCounts.get(order.id) ?? 0;
    return (
      (order.status === "filled" && fills === 0) ||
      (order.status === "rejected" && fills > 0 && !supersededTarget(order))
    );
  });
  add({
    id: "orderFillConservation",
    status: conservation.length ? "fail" : "pass",
    message: conservation.length
      ? `${conservation.length} 个订单状态与成交记录不一致`
      : "订单状态与成交记录一致",
    evidence: conservation.slice(0, 5),
  });

  const cardinalityViolations: unknown[] = [];
  for (const order of result.orders) {
    const fills = fillsByOrder.get(order.id) ?? [];
    if (order.status === "filled" && fills.length < 1)
      cardinalityViolations.push({
        order: { id: order.id, status: order.status },
        fillCount: fills.length,
        reason: "filled 订单至少一笔成交",
      });
    else if (
      order.status === "rejected" &&
      fills.length > 0 &&
      !supersededTarget(order)
    )
      cardinalityViolations.push({
        order: { id: order.id, status: order.status },
        fillCount: fills.length,
        reason: "rejected 订单仅允许被新目标替代的已成交调仓单",
        fills,
      });
    if (
      fills.length > 1 &&
      (!partialFillPath(order) || !distinctFillDates(fills))
    )
      cardinalityViolations.push({
        order: { id: order.id, status: order.status },
        fillCount: fills.length,
        reason: "多笔成交仅允许目标/容量裁剪路径，且每笔成交日期不同",
        fills,
      });
    if (
      order.status === "pending" &&
      fills.length > 0 &&
      !partialFillPath(order)
    )
      cardinalityViolations.push({
        order: { id: order.id, status: order.status },
        fillCount: fills.length,
        reason: "pending 有成交仅允许目标/容量裁剪路径",
        fills,
      });
    for (const fill of fills) {
      const mismatchedFields = (
        ["signalAt", "side", "symbol", "strategyId"] as const
      ).filter((field) => fill[field] !== order[field]);
      if (mismatchedFields.length)
        cardinalityViolations.push({
          order: { id: order.id, status: order.status },
          fill,
          mismatchedFields,
        });
    }
  }
  const cardinalityOrderIds = [
    ...new Set(
      cardinalityViolations.map(
        (violation) => (violation as { order: { id: number } }).order.id,
      ),
    ),
  ];
  add({
    id: "orderFillCardinality",
    status: cardinalityViolations.length ? "fail" : "pass",
    message: cardinalityViolations.length
      ? `${cardinalityViolations.length} 个订单的成交笔数或归属与订单不一致（订单 ${cardinalityOrderIds.join(", ")}）；filled 至少一笔；rejected 仅允许被替代的调仓单；pending 仅允许目标/容量分笔；多笔须日期不同`
      : "filled 至少一笔；rejected 仅允许被替代的调仓单；pending 仅允许目标/容量分笔且日期不同；成交归属一致",
    evidence: {
      orderIds: cardinalityOrderIds,
      violations: cardinalityViolations.slice(0, 5),
    },
  });

  add({
    id: "noDuplicateFill",
    status: duplicateFills.length ? "fail" : "pass",
    message: duplicateFills.length
      ? `${duplicateFills.length} 笔重复成交`
      : "没有重复成交",
    evidence: duplicateFills.slice(0, 5),
  });

  const instruments = new Map(
    request.instruments.map((instrument) => [instrument.symbol, instrument]),
  );
  const perInstrumentIndex = new Map(
    request.instruments.map((instrument) => [
      instrument.symbol,
      new Map(instrument.bars.map((bar, index) => [bar.date, index])),
    ]),
  );
  const priceViolations: unknown[] = [];
  for (const fill of result.fills) {
    const instrument = instruments.get(fill.symbol);
    const index = perInstrumentIndex.get(fill.symbol)?.get(fill.date);
    if (!instrument || index === undefined) {
      priceViolations.push({ fill, reason: "无当日原始 bar" });
      continue;
    }
    const bar = instrument.bars[index]!;
    const previous = instrument.bars[index - 1];
    const execution = executionFor(instrument, bar, previous);
    const tolerance = 1e-6 * Math.max(1, fill.price);
    if (fill.price < bar.low - tolerance || fill.price > bar.high + tolerance)
      priceViolations.push({
        fill,
        reason: "价格超出当日 low/high",
        bar: { low: bar.low, high: bar.high },
      });
    else if (
      (execution?.limitUp != null &&
        fill.price > execution.limitUp + tolerance) ||
      (execution?.limitDown != null &&
        fill.price < execution.limitDown - tolerance)
    )
      priceViolations.push({
        fill,
        reason: "价格超出当日涨跌停",
        limits: {
          limitUp: execution.limitUp,
          limitDown: execution.limitDown,
        },
      });
  }
  add({
    id: "fillPriceWithinBar",
    status: priceViolations.length ? "fail" : "pass",
    message: priceViolations.length
      ? `${priceViolations.length} 笔成交价越出可观察范围`
      : "成交价均在原始 bar 与涨跌停范围内",
    evidence: priceViolations.slice(0, 5),
  });

  const costs = request.costs ?? defaultExecutionCosts;
  const feeViolations: unknown[] = [];
  for (const fill of result.fills) {
    // Independent expectation: do not call `portfolioExecutionFee`, so a shared
    // commission/transfer/stamp bug cannot make the diagnostic agree with the
    // engine. The arithmetic here is the documented fee definition.
    const rate = executionCostsForDate(costs, fill.date);
    const amount = fill.price * fill.quantity;
    const commission = Math.max(
      rate.minimumCommission,
      (amount * rate.commissionBps) / 10000,
    );
    const transfer = (amount * (rate.transferBps ?? 0)) / 10000;
    const stamp = fill.side === "sell" ? (amount * rate.sellTaxBps) / 10000 : 0;
    const expected = commission + transfer + stamp;
    // `Math.abs(NaN - expected) > tolerance` is false, so a non-finite fee or
    // a non-finite expectation would silently pass the tolerance check.
    if (!Number.isFinite(fill.fee) || !Number.isFinite(expected)) {
      feeViolations.push({
        orderId: fill.orderId,
        date: fill.date,
        fee: fill.fee,
        expected,
        reason: "non-finite fee",
        amount,
        commission,
        transfer,
        stamp,
      });
      continue;
    }
    if (Math.abs(fill.fee - expected) > MONEY_TOLERANCE)
      feeViolations.push({
        fill,
        expected,
        amount,
        commission,
        transfer,
        stamp,
      });
  }
  add({
    id: "feeMatches",
    status: feeViolations.length ? "fail" : "pass",
    message: feeViolations.length
      ? `${feeViolations.length} 笔费用与公式重算不一致`
      : "逐笔费用与费用公式一致",
    evidence: feeViolations.slice(0, 5),
  });

  const negativeCash = result.curve.filter(
    (row) => row.cash < -MONEY_TOLERANCE,
  );
  add({
    id: "cashNonNegative",
    status: negativeCash.length ? "fail" : "pass",
    message: negativeCash.length
      ? `现金为负，首次 ${negativeCash[0]!.date}`
      : "现金始终非负",
    evidence: negativeCash.slice(0, 5),
  });

  const snapshotsByDate = new Map<
    string,
    { symbol: string; quantity: number }[]
  >();
  for (const snapshot of result.positionSnapshots) {
    const rows = snapshotsByDate.get(snapshot.date) ?? [];
    rows.push({ symbol: snapshot.symbol, quantity: snapshot.quantity });
    snapshotsByDate.set(snapshot.date, rows);
  }
  const equityViolations: unknown[] = [];
  for (const row of result.curve) {
    const positions = snapshotsByDate.get(row.date) ?? [];
    let holdings = 0;
    let missing = false;
    for (const position of positions) {
      const instrument = instruments.get(position.symbol);
      const close = instrument
        ? adjustedCloseOnOrBefore(instrument, row.date)
        : null;
      if (close === null) {
        missing = true;
        break;
      }
      holdings += position.quantity * close;
    }
    if (missing) continue;
    const identity = row.cash + holdings;
    if (
      Math.abs(identity - row.equity) >
      MONEY_TOLERANCE * Math.max(1, Math.abs(row.equity))
    )
      equityViolations.push({
        date: row.date,
        cash: row.cash,
        holdings,
        identity,
        equity: row.equity,
      });
  }
  add({
    id: "equityIdentity",
    status: equityViolations.length ? "fail" : "pass",
    message: equityViolations.length
      ? `权益不等于现金+持仓收盘市值，首次 ${String((equityViolations[0] as { date: string }).date)}`
      : "权益等于现金+持仓收盘市值（停牌期间公司行动已调整）",
    evidence: equityViolations.slice(0, 5),
  });

  const expectedActions = new Set<string>();
  for (const instrument of request.instruments)
    for (const action of instrument.actions ?? []) {
      const date =
        action.date.length === 10 ? action.date : action.date.slice(0, 10);
      const mapped = calendarOnOrAfter(request.calendar, date);
      if (mapped) expectedActions.add(`${instrument.symbol}|${mapped}`);
    }
  const actualActions = new Set(
    result.corporateActions.map((row) => `${row.symbol}|${row.date}`),
  );
  const extraActions = [...actualActions].filter(
    (key) => !expectedActions.has(key),
  );
  const missingActions = [...expectedActions].filter(
    (key) => !actualActions.has(key),
  );
  add({
    id: "corporateActionDates",
    status: extraActions.length
      ? "fail"
      : missingActions.length
        ? "warn"
        : "pass",
    message: extraActions.length
      ? `${extraActions.length} 个公司行动不在请求事件内`
      : missingActions.length
        ? `${missingActions.length} 个请求事件未触发（未持仓或动作日未到）`
        : "公司行动日期与请求事件一致",
    evidence: {
      extra: extraActions.slice(0, 5),
      missing: missingActions.slice(0, 5),
    },
  });

  const basisViolations: unknown[] = [];
  const basisWarnings: string[] = [];
  for (const instrument of request.instruments) {
    const basis = priceBasisOf(instrument, frozen.sources);
    const actionDates = (instrument.actions ?? []).map((action) =>
      action.date.length === 10 ? action.date : action.date.slice(0, 10),
    );
    const firstRatio = ratioAt(instrument, 0);
    const lastRatio = ratioAt(instrument, instrument.bars.length - 1);
    if (
      basis === "forward" &&
      lastRatio !== null &&
      Math.abs(lastRatio - 1) > RATIO_TOLERANCE
    )
      basisWarnings.push(
        `${instrument.symbol} 前复权末根比例 ${lastRatio.toFixed(6)} 不为 1`,
      );
    if (
      basis === "causal" &&
      firstRatio !== null &&
      Math.abs(firstRatio - 1) > RATIO_TOLERANCE
    )
      basisWarnings.push(
        `${instrument.symbol} 因果锚首根比例 ${firstRatio.toFixed(6)} 不为 1`,
      );
    for (let index = 1; index < instrument.bars.length; index++) {
      const previous = ratioAt(instrument, index - 1),
        current = ratioAt(instrument, index);
      if (previous === null || current === null) continue;
      if (
        Math.abs(current - previous) <=
        RATIO_TOLERANCE * Math.max(1, Math.abs(previous))
      )
        continue;
      const from = instrument.bars[index - 1]!.date,
        to = instrument.bars[index]!.date;
      if (!actionDates.some((date) => date > from && date <= to))
        basisViolations.push({
          symbol: instrument.symbol,
          from,
          to,
          previous,
          current,
          basis,
        });
    }
  }
  add({
    id: "priceBasisChangeWithoutAction",
    status: basisViolations.length ? "fail" : "pass",
    message: basisViolations.length
      ? `${basisViolations.length} 处信号/原价比值变化没有对应公司行动`
      : "信号/原价比值只在公司行动日变化",
    evidence: basisViolations.slice(0, 5),
  });
  if (basisWarnings.length)
    add({
      id: "priceBasisAnchor",
      status: "warn",
      message: basisWarnings.join("；"),
    });

  let capacity5 = 0,
    capacity20 = 0,
    largestShare = 0,
    largestVsAverage = 0,
    capacitySample: unknown[] = [];
  for (const fill of result.fills) {
    const instrument = instruments.get(fill.symbol);
    const index = perInstrumentIndex.get(fill.symbol)?.get(fill.date);
    if (!instrument || index === undefined) continue;
    const bar = instrument.bars[index]!;
    if (!(bar.amount > 0)) continue;
    const notional = fill.price * fill.quantity;
    const share = notional / bar.amount;
    const window = instrument.bars.slice(Math.max(0, index - 20), index);
    const average =
      window.length >= 20
        ? window.reduce((sum, row) => sum + row.amount, 0) / window.length
        : 0;
    const versusAverage = average > 0 ? notional / average : 0;
    if (share > 0.05) capacity5++;
    if (share > 0.2) capacity20++;
    largestShare = Math.max(largestShare, share);
    largestVsAverage = Math.max(largestVsAverage, versusAverage);
    if (capacitySample.length < 5 && (share > 0.05 || versusAverage > 0.2))
      capacitySample.push({
        orderId: fill.orderId,
        date: fill.date,
        notional,
        barAmount: bar.amount,
        share,
        versusAverage,
      });
  }
  add({
    id: "capacityRatio",
    status: capacity5 ? "warn" : "pass",
    message: capacity5
      ? `${capacity5} 笔成交超过当日成交额 5%（其中 ${capacity20} 笔超过 20%）；无容量约束，不代表可成交`
      : "成交额占比未超过 5% 提示线",
    evidence: {
      largestShare,
      largestVsAverage,
      sample: capacitySample,
    },
  });

  const repaired = frozen.sources.filter(
    (source) => source.priceRepaired === true,
  );
  const noted = frozen.sources.filter(
    (source) => typeof source.sourceNote === "string" && source.sourceNote,
  );
  // GBBQ coverage fields are optional until the policy task writes them, so
  // read them defensively and treat gaps as data limitations, never failures.
  const gbbqCount = (source: Record<string, unknown>, key: string) =>
    typeof source[key] === "number" ? (source[key] as number) : 0;
  const gbbqIssues = frozen.sources.filter(
    (source) =>
      gbbqCount(source, "gbbqIssueCount") +
        gbbqCount(source, "gbbqUnattributedIssueCount") >
      0,
  );
  const skippedWarrants = frozen.sources.filter((source) => {
    const value = source.skippedWarrants;
    if (Array.isArray(value)) return value.length > 0;
    return (
      !!value && typeof value === "object" && Object.keys(value).length > 0
    );
  });
  // Off-calendar bars were dropped from replay inputs by the prepare step, so
  // they are a disclosed data limitation, not a reason to fail the cell.
  const offCalendar = frozen.sources.filter(
    (source) =>
      Array.isArray(source.offCalendarDates) &&
      source.offCalendarDates.length > 0,
  );
  const dataLimits =
    repaired.length +
    noted.length +
    gbbqIssues.length +
    skippedWarrants.length +
    offCalendar.length;
  add({
    id: "dataQuality",
    status: dataLimits ? "warn" : "pass",
    message: dataLimits
      ? `${repaired.length} 个标的含修复价，${noted.length} 个标的含源备注，${gbbqIssues.length} 个标的含 GBBQ 问题，${skippedWarrants.length} 个标的含跳过权证，${offCalendar.length} 个标的含基准日历外 bar`
      : "没有修复价、源备注或 GBBQ 覆盖缺口",
    evidence: {
      repaired: repaired.map((source) => source.symbol),
      noted: noted.map((source) => ({
        symbol: source.symbol,
        sourceNote: source.sourceNote,
      })),
      gbbqIssues: gbbqIssues.map((source) => ({
        symbol: source.symbol,
        count: gbbqCount(source, "gbbqIssueCount"),
        unattributed: gbbqCount(source, "gbbqUnattributedIssueCount"),
      })),
      skippedWarrants: skippedWarrants.map((source) => ({
        symbol: source.symbol,
        skippedWarrants: source.skippedWarrants,
      })),
      offCalendar: offCalendar.map((source) => {
        const dates = (source.offCalendarDates as unknown[]).filter(
          (date): date is string => typeof date === "string",
        );
        return {
          symbol: source.symbol,
          count: dates.length,
          first: dates.slice(0, 5),
          note: source.offCalendarNote ?? null,
        };
      }),
    },
  });

  // Independent replay of every fill receipt plus request entitlements into
  // fresh ledgers. A limitation here is a diagnostic gap, not an engine defect,
  // so a thrown reconciler only warns.
  try {
    const mismatches = reconcileFills(request, result);
    if (mismatches.length) {
      const show = (value: number | string | null) =>
        value === null ? "null" : String(value);
      const first = mismatches
        .slice(0, 3)
        .map(
          (row) =>
            `${row.date} ${row.field}（期望 ${show(row.expected)}，实际 ${show(row.actual)}）`,
        )
        .join("；");
      add({
        id: "ledgerReconcile",
        status: "fail",
        message: `独立账本重放有 ${mismatches.length} 处不一致：${first}`,
        evidence: mismatches.slice(0, 5),
      });
    } else
      add({
        id: "ledgerReconcile",
        status: "pass",
        message: "逐笔成交回执、现金与持仓可由冻结请求独立重放一致",
      });
  } catch (error) {
    add({
      id: "ledgerReconcileUnavailable",
      status: "warn",
      message: `独立账本重放不可用：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (counts.rejections > 0) findings.push(`主要拒绝原因：${topRejections}`);

  const failed = checks.filter((check) => check.status === "fail");
  let layer: DiagnoseLayer | undefined;
  if (failed.length) {
    const layers = new Set(failed.map((check) => layerByCheck[check.id]));
    layer =
      layerPriority.find((candidate) => layers.has(candidate)) ?? "internal";
  } else {
    // A clean run can still stop between orders and fills. Attribute that warn
    // to the funnel stage so the report names where the tape dried up.
    const warned = new Set(
      checks.filter((check) => check.status === "warn").map(({ id }) => id),
    );
    if (warned.has("ordersToFills")) layer = "order";
    else if (warned.has("signalsToFills")) layer = "signal";
  }
  return {
    status: failed.length ? "failed" : "ok",
    ...(layer ? { layer } : {}),
    counts,
    checks,
    findings,
  };
}
