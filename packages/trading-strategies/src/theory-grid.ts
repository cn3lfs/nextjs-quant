/**
 * F12.11 fixed grid / F12.12 dynamic grid — pure reference components.
 *
 * This module never owns cash, equity or order execution. It freezes a grid
 * plan from explicit parameters, and (in the reducer half) records only actual
 * host fills. A buy/sell intent is evidence for a host order, never inventory.
 *
 * Dynamic grids are an engineering proxy: the cited platform describes fixed
 * levels and inventory risk, not a canonical dynamic-grid formula. Version
 * identity is caller-supplied and immutable; the reducer never edits it.
 */

import type { Bar } from "trading-strategy-core/bars";
import { atr, maSeries } from "trading-strategy-core/indicators";
import {
  confirmationEpoch,
  type ConfirmationTime,
} from "./theory-confirmation.js";
import {
  areDailyDatesStrictlyAscending,
  dailyBarEpoch,
  isValidOhlc,
} from "./theory-input.js";

export type GridConstruction = "arithmetic" | "geometric";
export type GridPlanKind = "fixed" | "dynamic";

export type FixedGridParams = {
  /** Immutable parameter identity; never derived from a clock. */
  versionId: string;
  construction: GridConstruction;
  /** Explicit increasing levels p_0..p_N; p_0=L, p_N=U. */
  levels: readonly number[];
  /** q: units opened by one grid intent. */
  unitsPerGrid: number;
  /** M: per-grid inventory ceiling (q <= M). */
  maxUnitsPerGrid: number;
  /** Qmax: all inventory plus reserved buys. */
  maxTotalUnits: number;
  /** Absolute stop S < L. */
  stopPrice: number;
  /** Equity drawdown fraction in (0, 1]. */
  maxDrawdown: number;
  /** Required per-unit round-trip cost estimate; every spacing must exceed it. */
  estimatedRoundtripCost: number;
};

export type DynamicGridParams = {
  versionId: string;
  /** n: both SMA_n centre and simple-TR ATR_n spacing. */
  period: number;
  /** c: spacing multiplier (spacing = c * ATR_n). */
  multiplier: number;
  /** J >= 1: centre has J buy grids below and J sell targets above. */
  halfLevels: number;
  /** K: completed-bar rebuild period. */
  rebuildPeriod: number;
  /** Long trend filter SMA period. */
  longMaPeriod: number;
  /** k: long MA must be higher than its value k completed bars ago. */
  risingLookback: number;
  unitsPerGrid: number;
  maxUnitsPerGrid: number;
  maxTotalUnits: number;
  stopPrice: number;
  maxDrawdown: number;
  estimatedRoundtripCost: number;
};

export type GridLevel = {
  index: number;
  price: number;
  /** Frozen next-higher sell target. */
  sellTarget: number;
};

export type GridPlan = {
  kind: GridPlanKind;
  construction: GridConstruction | "dynamic";
  versionId: string;
  levels: readonly number[];
  /** Buy grids 0..N-1; every buy grid has one higher frozen sell grid. */
  buyLevels: readonly GridLevel[];
  unitsPerGrid: number;
  maxUnitsPerGrid: number;
  maxTotalUnits: number;
  stopPrice: number;
  maxDrawdown: number;
  estimatedRoundtripCost: number;
  /** Only present for dynamic plans; frozen with the same version identity. */
  dynamic: Readonly<DynamicGridParams> | null;
};

export type GridBuildReason =
  | "insufficient-history"
  | "invalid-history"
  | "atr-invalid"
  | "trend-failed"
  | "spacing-below-cost"
  | "lower-bound-invalid";

export type DynamicGridBuild =
  | { status: "ready"; plan: GridPlan }
  | { status: "paused" | "unknown"; reason: GridBuildReason; detail: string };

export type GridTime = ConfirmationTime;

/** A frozen buy reference. It reserves Qmax/cash before the host fills it;
 * it is never inventory. `generation` identifies the grid instance, not the
 * parameter version. */
export type GridBuyIntent = {
  intentId: string;
  versionId: string;
  generation: number;
  createdBarIndex: number;
  gridIndex: number;
  levelPrice: number;
  target: number;
  protection: number;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: "open" | "cancel-requested" | "cancelled" | "rejected" | "filled";
  createdAt: number;
  /** Our request only; it is not a host termination fact. */
  cancelRequestedAt: number | null;
  cancelReason: string | null;
  /** Set only by an explicit host termination acknowledgement. */
  terminatedAt: number | null;
  terminationOutcome: "cancelled" | "rejected" | null;
  terminationAckId: string | null;
};

/** One actual buy fill. Partial fills stay separate lots, each retaining its
 * own actual price/fee and the intent's immutable target/protection. */
export type GridLot = {
  lotId: string;
  fillId: string;
  intentId: string;
  versionId: string;
  generation: number;
  /** Current mapped grid after a dynamic rebuild. */
  gridIndex: number;
  originalGridIndex: number;
  originalGridPrice: number;
  target: number;
  protection: number;
  entryPrice: number;
  entryFee: number;
  quantity: number;
  remainingQuantity: number;
  boughtAt: number;
};

export type GridPendingExit = {
  lotId: string;
  reason: "target" | "protection" | "global-stop";
  at: number;
};

/** An explicit host order-termination fact. Only this releases unfilled
 * reservation; a local cancel request never does. */
export type GridOrderTermination = {
  ackId: string;
  intentId: string;
  time: number;
  outcome: "cancelled" | "rejected";
  cumulativeFilledQuantity: number | null;
  reason: string | null;
};

export type GridOrderTerminationInput = {
  ackId: string;
  intentId: string;
  time: GridTime;
  outcome: "cancelled" | "rejected";
  /** Host cumulative filled quantity known at acknowledgement. If supplied it
   * must equal the reducer's recorded filled quantity; unseen fills are not
   * discarded. */
  cumulativeFilledQuantity?: number;
  reason?: string;
};

/** Conservative A-choice: a failed scheduled rebuild keeps new buys paused
 * until the next successful fixed-K rebuild. */
export type GridRebuildPause = {
  status: "paused" | "unknown";
  reason: GridBuildReason | "missing-bars" | "bar-mismatch" | "invalid-point";
  at: number;
};

export type GridState = {
  plan: GridPlan;
  /** Increments only for a new grid instance (dynamic rebuild). */
  generation: number;
  originIndex: number | null;
  originTime: number | null;
  lots: readonly GridLot[];
  buyIntents: readonly GridBuyIntent[];
  pendingExits: readonly GridPendingExit[];
  peakEquity: number | null;
  terminal: { code: "global-stop" | "drawdown"; at: number } | null;
  /** Last valid completed point used for crossing continuity only. */
  lastPoint: { index: number; time: number; price: number } | null;
  /** Monotonic watermarks for accepted observations. They survive a missing
   * price, so an old index or an equal timestamp can never count as a new bar. */
  lastObservationIndex: number | null;
  lastObservationTime: number | null;
  /** Fixed anchor for the K-bar schedule; failures and successes never move it. */
  scheduleOriginIndex: number | null;
  /** Last successful rebuild only; not the schedule phase. */
  lastRebuildIndex: number | null;
  /** Persisted failed-rebuild pause; cleared only by a successful rebuild. */
  rebuildPause: GridRebuildPause | null;
  lastEventTime: number | null;
  appliedFills: readonly GridAppliedFill[];
  terminationAcks: readonly GridOrderTermination[];
};

export type GridAppliedFill = {
  fillId: string;
  side: "buy" | "sell";
  intentId: string | null;
  lotId: string | null;
  price: number;
  quantity: number;
  fee: number;
  time: number;
};

export type GridFill =
  | {
      fillId: string;
      side: "buy";
      intentId: string;
      price: number;
      quantity: number;
      fee: number;
      time: GridTime;
    }
  | {
      fillId: string;
      side: "sell";
      lotId: string;
      price: number;
      quantity: number;
      fee: number;
      time: GridTime;
    };

export type GridFillResult =
  | {
      status: "applied";
      state: GridState;
      fill: GridAppliedFill;
      lot: GridLot | null;
      intent: GridBuyIntent | null;
    }
  | { status: "replayed"; state: GridState };

export type GridTerminationAckResult =
  | {
      status: "applied";
      state: GridState;
      ack: GridOrderTermination;
      intent: GridBuyIntent;
    }
  | { status: "replayed"; state: GridState };

export type GridObservationPoint = {
  /** Completed-bar index; gaps break crossing continuity. */
  index: number;
  /** Daily bar label, validated by the shared daily-date helper. */
  date: string;
  price: number;
  /** Confirmation timestamp for the completed point. */
  asOf: GridTime;
};

export type GridObservationSnapshot = {
  /** Host cash BEFORE deducting this grid's still-open buy-intent reservations,
   * already after actual fills and other host commitments. Do not pre-deduct
   * the grid intents here, or reservedCash would be counted twice. */
  cashAvailableBeforeGridReservations: number;
  /** Host total equity; zero is a known value, not missing data. */
  totalEquity: number;
  canSellByLot: readonly { lotId: string; quantity: number }[];
};

export type GridObservationReason =
  | GridBuildReason
  | "seeded"
  | "rebuilt"
  | "not-due"
  | "outside-bounds"
  | "global-stop"
  | "drawdown"
  | "crossing-gap"
  | "ambiguous-crossing"
  | "grid-occupied"
  | "budget-gated"
  | "missing-bars"
  | "bar-mismatch"
  | "duplicate-index"
  | "out-of-order-index"
  | "duplicate-time"
  | "out-of-order-time"
  | "invalid-point"
  | "invalid-snapshot";

export type GridExitIntent = {
  lotId: string;
  quantity: number;
  referencePrice: number;
  reason: GridPendingExit["reason"];
};

export type GridObservationEvent =
  | { kind: "seeded"; index: number }
  | { kind: "rebuilt"; index: number; generation: number }
  | { kind: "terminal"; code: "global-stop" | "drawdown"; at: number }
  | { kind: "buy-cancel-requested"; intentId: string; reason: string };

export type GridObservationResult = {
  state: GridState;
  status: "ready" | "paused" | "unknown" | "invalid";
  reason: GridObservationReason | null;
  detail: string;
  /** Newly created reference intents; never inventory and never executed here. */
  buys: readonly GridBuyIntent[];
  /** Pending old-lot exits whose host sellable quantity is positive. */
  exits: readonly GridExitIntent[];
  events: readonly GridObservationEvent[];
};

export type GridObservationInput = {
  state: GridState;
  point: GridObservationPoint;
  snapshot: GridObservationSnapshot;
  /** Required for a dynamic rebuild; ignored on non-due bars. */
  bars?: readonly Bar[];
};

const FILL_EPSILON = 1e-9;

const EPSILON = 1e-12;

function finitePositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} 必须是有限正数`);
}

function finiteNonNegative(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} 必须是有限非负数`);
}

function positiveInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} 必须是正整数`);
}

function versionIdentity(versionId: string) {
  if (typeof versionId !== "string" || versionId.trim() === "")
    throw new Error("网格参数版本标识不能为空");
}

function budget(params: {
  unitsPerGrid: number;
  maxUnitsPerGrid: number;
  maxTotalUnits: number;
  stopPrice: number;
  maxDrawdown: number;
  estimatedRoundtripCost: number;
}) {
  finitePositive("每格交易单位", params.unitsPerGrid);
  positiveInteger("每格库存上限", params.maxUnitsPerGrid);
  positiveInteger("总库存上限", params.maxTotalUnits);
  if (params.unitsPerGrid > params.maxUnitsPerGrid)
    throw new RangeError("每格交易单位不能超过每格库存上限");
  if (params.unitsPerGrid > params.maxTotalUnits)
    throw new RangeError("每格交易单位不能超过总库存上限");
  finitePositive("绝对止损价", params.stopPrice);
  if (
    !Number.isFinite(params.maxDrawdown) ||
    params.maxDrawdown <= 0 ||
    params.maxDrawdown > 1
  )
    throw new RangeError("权益回撤上限必须在 (0, 1] 内");
  finiteNonNegative("预估双边成本", params.estimatedRoundtripCost);
}

function freezeLevels(levels: readonly number[]): readonly number[] {
  return Object.freeze([...levels]);
}

function freezeBuyLevels(levels: readonly GridLevel[]): readonly GridLevel[] {
  return Object.freeze(levels.map((level) => Object.freeze({ ...level })));
}

function freezePlan(plan: GridPlan): GridPlan {
  return Object.freeze({
    ...plan,
    levels: freezeLevels(plan.levels),
    buyLevels: freezeBuyLevels(plan.buyLevels),
    dynamic: plan.dynamic ? Object.freeze({ ...plan.dynamic }) : null,
  });
}

function assertSpacingAboveCost(levels: readonly number[], cost: number) {
  for (let index = 1; index < levels.length; index++) {
    const spacing = levels[index]! - levels[index - 1]!;
    if (!(spacing > cost + EPSILON))
      throw new RangeError("网格间距必须大于预估双边成本");
  }
}

/** F12.11: freeze explicit L..U levels, budgets and the absolute stop.
 * Throws on invalid parameters; no market data is read here. */
export function buildFixedGrid(params: FixedGridParams): GridPlan {
  versionIdentity(params.versionId);
  budget(params);
  const levels = [...params.levels];
  if (levels.length < 2) throw new RangeError("固定网格至少需要两个价格层级");
  for (let index = 0; index < levels.length; index++) {
    finitePositive("网格层级", levels[index]!);
    if (index > 0 && !(levels[index]! > levels[index - 1]!))
      throw new RangeError("网格层级必须严格递增");
  }
  const lower = levels[0]!;
  if (!(params.stopPrice < lower))
    throw new RangeError("绝对止损价必须低于网格下界");

  if (params.construction === "arithmetic") {
    const step = levels[1]! - levels[0]!;
    for (let index = 2; index < levels.length; index++)
      if (Math.abs(levels[index]! - levels[index - 1]! - step) > EPSILON)
        throw new RangeError("等差网格的相邻间距必须一致");
  } else if (params.construction === "geometric") {
    const ratio = levels[1]! / levels[0]!;
    for (let index = 2; index < levels.length; index++)
      if (Math.abs(levels[index]! / levels[index - 1]! - ratio) > EPSILON)
        throw new RangeError("等比网格的相邻比例必须一致");
  } else {
    throw new RangeError("固定网格构造方式无效");
  }

  assertSpacingAboveCost(levels, params.estimatedRoundtripCost);
  const buyLevels = levels.slice(0, -1).map((price, index) => ({
    index,
    price,
    sellTarget: levels[index + 1]!,
  }));
  return freezePlan({
    kind: "fixed",
    construction: params.construction,
    versionId: params.versionId,
    levels: freezeLevels(levels),
    buyLevels: freezeBuyLevels(buyLevels),
    unitsPerGrid: params.unitsPerGrid,
    maxUnitsPerGrid: params.maxUnitsPerGrid,
    maxTotalUnits: params.maxTotalUnits,
    stopPrice: params.stopPrice,
    maxDrawdown: params.maxDrawdown,
    estimatedRoundtripCost: params.estimatedRoundtripCost,
    dynamic: null,
  });
}

function dynamicBudget(params: DynamicGridParams) {
  versionIdentity(params.versionId);
  budget(params);
  positiveInteger("重估周期", params.rebuildPeriod);
  positiveInteger("中心单侧层数", params.halfLevels);
  positiveInteger("ATR/SMA周期", params.period);
  positiveInteger("长均线周期", params.longMaPeriod);
  positiveInteger("长均线上升比较间隔", params.risingLookback);
  finitePositive("间距倍数", params.multiplier);
}

function historyWindow(
  bars: readonly Bar[],
  index: number,
  period: number,
  longMaPeriod: number,
  risingLookback: number,
): readonly Bar[] | null {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bars.length)
    return null;
  const start = Math.max(
    0,
    index - Math.max(period, longMaPeriod + risingLookback),
  );
  const window = bars.slice(start, index + 1);
  // Prove every slot is an object with valid OHLC before reading any label.
  if (!window.every((bar) => isValidOhlc(bar))) return null;
  const current = window[window.length - 1]!;
  if (dailyBarEpoch(current.date) === null) return null;
  if (!areDailyDatesStrictlyAscending(window.map((bar) => bar.date)))
    return null;
  return window;
}

/** F12.12: rebuild the dynamic plan on a completed daily bar.
 *
 * Data insufficiency is UNKNOWN; a computed but unusable plan is PAUSED.
 * Neither mutates an existing plan: the caller keeps old lots and protections.
 */
export function rebuildDynamicGrid(input: {
  params: DynamicGridParams;
  bars: readonly Bar[];
  index: number;
}): DynamicGridBuild {
  const { params, bars, index } = input;
  dynamicBudget(params);

  const window = historyWindow(
    bars,
    index,
    params.period,
    params.longMaPeriod,
    params.risingLookback,
  );
  if (!window)
    return {
      status: "unknown",
      reason: "insufficient-history",
      detail: "动态网格的日线历史、日期顺序或OHLC不足",
    };

  const offset = index - window.length + 1;
  const closes = window.map((bar) => bar.close);
  // Plain SMA_n, not trading-strategy-core's TDX-style SMA(X,N,M) smoother.
  const smoothing = maSeries(closes, params.period);
  const longMa = maSeries(closes, params.longMaPeriod);
  const ranges = atr(window, params.period);
  const localIndex = index - offset;
  const required = Math.max(
    params.period + 1,
    params.longMaPeriod + params.risingLookback,
  );
  const center = smoothing[localIndex];
  const range = ranges[localIndex];
  const longNow = longMa[localIndex];
  const longBefore = longMa[localIndex - params.risingLookback];

  if (
    window.length < required ||
    localIndex < params.risingLookback ||
    center == null ||
    !Number.isFinite(center) ||
    longNow == null ||
    longBefore == null
  )
    return {
      status: "unknown",
      reason: "insufficient-history",
      detail: "SMA、ATR或长均线尚未完成预热",
    };
  if (range == null || !Number.isFinite(range) || range <= 0)
    return {
      status: "paused",
      reason: "atr-invalid",
      detail: "ATR缺失或不为正",
    };

  const price = window[localIndex]!.close;
  if (!(price >= longNow && longNow > longBefore))
    return {
      status: "paused",
      reason: "trend-failed",
      detail: "价格低于长均线或长均线未上升",
    };

  const spacing = params.multiplier * range;
  if (!(spacing > params.estimatedRoundtripCost + EPSILON))
    return {
      status: "paused",
      reason: "spacing-below-cost",
      detail: "动态网格间距不足以覆盖预估双边成本",
    };

  const levels = Array.from(
    { length: params.halfLevels * 2 + 1 },
    (_, level) => center + (level - params.halfLevels) * spacing,
  );
  if (!(levels[0]! > 0))
    return {
      status: "paused",
      reason: "lower-bound-invalid",
      detail: "动态网格下界不为正",
    };
  if (!(params.stopPrice < levels[0]!))
    return {
      status: "paused",
      reason: "lower-bound-invalid",
      detail: "绝对止损价必须低于动态网格下界",
    };

  const buyLevels = levels.slice(0, -1).map((levelPrice, level) => ({
    index: level,
    price: levelPrice,
    sellTarget: levels[level + 1]!,
  }));
  return {
    status: "ready",
    plan: freezePlan({
      kind: "dynamic",
      construction: "dynamic",
      versionId: params.versionId,
      levels: freezeLevels(levels),
      buyLevels: freezeBuyLevels(buyLevels),
      unitsPerGrid: params.unitsPerGrid,
      maxUnitsPerGrid: params.maxUnitsPerGrid,
      maxTotalUnits: params.maxTotalUnits,
      stopPrice: params.stopPrice,
      maxDrawdown: params.maxDrawdown,
      estimatedRoundtripCost: params.estimatedRoundtripCost,
      dynamic: Object.freeze({ ...params }),
    }),
  };
}

function freezeState(state: GridState): GridState {
  return Object.freeze({
    ...state,
    lots: Object.freeze([...state.lots]),
    buyIntents: Object.freeze([...state.buyIntents]),
    pendingExits: Object.freeze([...state.pendingExits]),
    appliedFills: Object.freeze([...state.appliedFills]),
    terminationAcks: Object.freeze([...state.terminationAcks]),
  });
}

/** Empty inventory. The first observation only seeds the grid; it cannot buy. */
export function createGridState(plan: GridPlan): GridState {
  return freezeState({
    plan,
    generation: 1,
    originIndex: null,
    originTime: null,
    lots: [],
    buyIntents: [],
    pendingExits: [],
    peakEquity: null,
    terminal: null,
    lastPoint: null,
    lastObservationIndex: null,
    lastObservationTime: null,
    scheduleOriginIndex: null,
    lastRebuildIndex: null,
    rebuildPause: null,
    lastEventTime: null,
    appliedFills: [],
    terminationAcks: [],
  });
}

function fillPrice(name: string, value: number, allowZero: boolean) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0))
    throw new RangeError(`${name} 必须是有限${allowZero ? "非负" : "正"}数`);
}

function appliedFill(fill: GridFill, time: number): GridAppliedFill {
  return {
    fillId: fill.fillId,
    side: fill.side,
    intentId: fill.side === "buy" ? fill.intentId : null,
    lotId: fill.side === "sell" ? fill.lotId : null,
    price: fill.price,
    quantity: fill.quantity,
    fee: fill.fee,
    time,
  };
}

function sameAppliedFill(
  record: GridAppliedFill,
  fill: GridFill,
  time: number,
) {
  return (
    record.side === fill.side &&
    record.intentId === (fill.side === "buy" ? fill.intentId : null) &&
    record.lotId === (fill.side === "sell" ? fill.lotId : null) &&
    record.price === fill.price &&
    record.quantity === fill.quantity &&
    record.fee === fill.fee &&
    record.time === time
  );
}

/** Record one actual host fill. This never reads cash/equity and never creates
 * an intent: budget gates belong before the intent, not to retrospective facts.
 *
 * A repeated fillId with identical content is a no-op replay; the same id with
 * different content is rejected. Unknown intents/lots and oversells are rejected.
 */
export function applyGridFill(
  state: GridState,
  fill: GridFill,
): GridFillResult {
  if (typeof fill.fillId !== "string" || fill.fillId.trim() === "")
    throw new Error("成交标识不能为空");
  fillPrice("成交价", fill.price, false);
  fillPrice("成交数量", fill.quantity, false);
  fillPrice("成交费用", fill.fee, true);
  const time = confirmationEpoch(fill.time);
  if (time === null) throw new Error("成交时间缺失或不是带时区的有效时间");

  const replay = state.appliedFills.find(
    (record) => record.fillId === fill.fillId,
  );
  if (replay) {
    if (sameAppliedFill(replay, fill, time))
      return { status: "replayed", state };
    throw new Error("fillId 冲突：相同成交标识对应不同成交内容");
  }

  const floor = Math.max(
    state.lastEventTime ?? Number.NEGATIVE_INFINITY,
    state.lastPoint?.time ?? Number.NEGATIVE_INFINITY,
  );
  if (time < floor) throw new Error("成交时间早于已处理事实，拒绝回溯写入");

  const applied = Object.freeze(appliedFill(fill, time));
  if (fill.side === "buy") {
    const intentIndex = state.buyIntents.findIndex(
      (intent) => intent.intentId === fill.intentId,
    );
    const intent = state.buyIntents[intentIndex];
    if (!intent) throw new Error("未知买入意图");
    if (
      (intent.status !== "open" && intent.status !== "cancel-requested") ||
      intent.remainingQuantity <= FILL_EPSILON
    )
      throw new Error("买入意图已终止，不能再成交");
    if (fill.quantity > intent.remainingQuantity + FILL_EPSILON)
      throw new Error("买入数量超过意图剩余预留");

    // A current-generation fill keeps its grid; a late old-generation fill is
    // mapped by actual entry price without rewriting original intent fields.
    const gridIndex =
      intent.generation === state.generation
        ? intent.gridIndex
        : nearestBuyGridIndex(fill.price, state.plan.buyLevels);
    const lot: GridLot = Object.freeze({
      lotId: `lot:${fill.fillId}`,
      fillId: fill.fillId,
      intentId: intent.intentId,
      versionId: intent.versionId,
      generation: intent.generation,
      gridIndex,
      originalGridIndex: intent.gridIndex,
      originalGridPrice: intent.levelPrice,
      target: intent.target,
      protection: intent.protection,
      entryPrice: fill.price,
      entryFee: fill.fee,
      quantity: fill.quantity,
      remainingQuantity: fill.quantity,
      boughtAt: time,
    });
    const remaining = Math.max(0, intent.remainingQuantity - fill.quantity);
    const status: GridBuyIntent["status"] =
      remaining <= FILL_EPSILON ? "filled" : intent.status;
    const updatedIntent: GridBuyIntent = Object.freeze({
      ...intent,
      filledQuantity: intent.filledQuantity + fill.quantity,
      remainingQuantity: status === "filled" ? 0 : remaining,
      status,
    });
    const buyIntents = state.buyIntents.map((item, index) =>
      index === intentIndex ? updatedIntent : item,
    );
    return {
      status: "applied",
      state: freezeState({
        ...state,
        buyIntents,
        lots: [...state.lots, lot],
        pendingExits: state.terminal
          ? pendingForAllLots([...state.lots, lot], state.pendingExits, time)
          : state.pendingExits,
        appliedFills: [...state.appliedFills, applied],
        lastEventTime: time,
      }),
      fill: applied,
      lot,
      intent: updatedIntent,
    };
  }

  const lotIndex = state.lots.findIndex((lot) => lot.lotId === fill.lotId);
  const lot = state.lots[lotIndex];
  if (!lot) throw new Error("未知卖出批次");
  if (lot.remainingQuantity <= FILL_EPSILON)
    throw new Error("卖出批次已无剩余数量");
  if (fill.quantity > lot.remainingQuantity + FILL_EPSILON)
    throw new Error("卖出数量超过批次剩余数量");

  const remaining = Math.max(0, lot.remainingQuantity - fill.quantity);
  const updatedLot: GridLot = Object.freeze({
    ...lot,
    remainingQuantity: remaining <= FILL_EPSILON ? 0 : remaining,
  });
  const lots = state.lots.map((item, index) =>
    index === lotIndex ? updatedLot : item,
  );
  const pendingExits =
    updatedLot.remainingQuantity === 0
      ? state.pendingExits.filter((exit) => exit.lotId !== lot.lotId)
      : state.pendingExits;
  return {
    status: "applied",
    state: freezeState({
      ...state,
      lots,
      pendingExits,
      appliedFills: [...state.appliedFills, applied],
      lastEventTime: time,
    }),
    fill: applied,
    lot: updatedLot,
    intent: null,
  };
}

function sameTerminationAck(
  record: GridOrderTermination,
  input: GridOrderTerminationInput,
  time: number,
) {
  return (
    record.intentId === input.intentId &&
    record.time === time &&
    record.outcome === input.outcome &&
    record.cumulativeFilledQuantity ===
      (input.cumulativeFilledQuantity ?? null) &&
    record.reason === (input.reason ?? null)
  );
}

/** Explicit host order-termination fact. Only this releases unfilled
 * reservation; local cancel requests remain reservations until this arrives.
 * A supplied cumulative fill count must match recorded fills, so unseen fills
 * are surfaced instead of discarded. */
export function acknowledgeGridOrderTermination(
  state: GridState,
  input: GridOrderTerminationInput,
): GridTerminationAckResult {
  if (typeof input !== "object" || input === null)
    throw new Error("终止确认缺失");
  if (typeof input.ackId !== "string" || input.ackId.trim() === "")
    throw new Error("终止确认标识不能为空");
  if (typeof input.intentId !== "string" || input.intentId.trim() === "")
    throw new Error("终止确认缺少买入意图");
  if (input.outcome !== "cancelled" && input.outcome !== "rejected")
    throw new Error("终止确认结果无效");
  const time = confirmationEpoch(input.time);
  if (time === null) throw new Error("终止确认时间缺失或不是带时区的有效时间");
  const cumulative = input.cumulativeFilledQuantity;
  if (
    cumulative !== undefined &&
    (!Number.isFinite(cumulative) || cumulative < 0)
  )
    throw new Error("终止确认的累计成交数量无效");
  if (input.reason !== undefined && typeof input.reason !== "string")
    throw new Error("终止确认原因无效");
  const reason = input.reason ?? null;

  const replay = state.terminationAcks.find(
    (record) => record.ackId === input.ackId,
  );
  if (replay) {
    if (sameTerminationAck(replay, input, time))
      return { status: "replayed", state };
    throw new Error("ackId 冲突：相同终止确认标识对应不同内容");
  }

  const floor = Math.max(
    state.lastEventTime ?? Number.NEGATIVE_INFINITY,
    state.lastPoint?.time ?? Number.NEGATIVE_INFINITY,
  );
  if (time < floor) throw new Error("终止确认时间早于已处理事实，拒绝回溯写入");

  const intentIndex = state.buyIntents.findIndex(
    (intent) => intent.intentId === input.intentId,
  );
  const intent = state.buyIntents[intentIndex];
  if (!intent) throw new Error("未知买入意图");
  if (intent.status === "cancelled" || intent.status === "rejected")
    throw new Error("买入意图已终止，不能重复确认");
  if (intent.status === "filled" || intent.remainingQuantity <= FILL_EPSILON)
    throw new Error("买入意图已全部成交，终止确认冲突");
  if (
    cumulative !== undefined &&
    Math.abs(cumulative - intent.filledQuantity) > FILL_EPSILON
  )
    throw new Error("累计成交数量与已记录事实不一致，请先补记成交");

  const ack: GridOrderTermination = Object.freeze({
    ackId: input.ackId,
    intentId: input.intentId,
    time,
    outcome: input.outcome,
    cumulativeFilledQuantity: cumulative ?? null,
    reason,
  });
  const updatedIntent: GridBuyIntent = Object.freeze({
    ...intent,
    status: input.outcome,
    terminatedAt: time,
    terminationOutcome: input.outcome,
    terminationAckId: input.ackId,
  });
  return {
    status: "applied",
    state: freezeState({
      ...state,
      buyIntents: state.buyIntents.map((item, index) =>
        index === intentIndex ? updatedIntent : item,
      ),
      terminationAcks: [...state.terminationAcks, ack],
      lastEventTime: time,
    }),
    ack,
    intent: updatedIntent,
  };
}

type SnapshotFacts = {
  cashKnown: boolean;
  equityKnown: boolean;
  canSellKnown: boolean;
  cashAvailableBeforeGridReservations: number;
  totalEquity: number;
  sellable: ReadonlyMap<string, number> | null;
};

function readSnapshot(snapshot: GridObservationSnapshot): SnapshotFacts {
  const value = snapshot as unknown;
  if (typeof value !== "object" || value === null)
    return {
      cashKnown: false,
      equityKnown: false,
      canSellKnown: false,
      cashAvailableBeforeGridReservations: 0,
      totalEquity: 0,
      sellable: null,
    };
  const record = value as Record<string, unknown>;
  const cashKnown =
    typeof record.cashAvailableBeforeGridReservations === "number" &&
    Number.isFinite(record.cashAvailableBeforeGridReservations) &&
    record.cashAvailableBeforeGridReservations >= 0;
  const equityKnown =
    typeof record.totalEquity === "number" &&
    Number.isFinite(record.totalEquity) &&
    record.totalEquity >= 0;
  const sellable = new Map<string, number>();
  let canSellKnown = Array.isArray(record.canSellByLot);
  if (canSellKnown) {
    for (const entry of record.canSellByLot as unknown[]) {
      if (typeof entry !== "object" || entry === null) {
        canSellKnown = false;
        break;
      }
      const item = entry as Record<string, unknown>;
      if (
        typeof item.lotId !== "string" ||
        item.lotId.trim() === "" ||
        typeof item.quantity !== "number" ||
        !Number.isFinite(item.quantity) ||
        item.quantity < 0 ||
        sellable.has(item.lotId)
      ) {
        canSellKnown = false;
        break;
      }
      sellable.set(item.lotId, item.quantity);
    }
  }
  return {
    cashKnown,
    equityKnown,
    canSellKnown,
    cashAvailableBeforeGridReservations: cashKnown
      ? (record.cashAvailableBeforeGridReservations as number)
      : 0,
    totalEquity: equityKnown ? (record.totalEquity as number) : 0,
    sellable: canSellKnown ? sellable : null,
  };
}

function requestCancelOpenIntents(
  intents: readonly GridBuyIntent[],
  at: number,
  reason: string,
) {
  const events: GridObservationEvent[] = [];
  const next = intents.map((intent) => {
    if (intent.status !== "open" || intent.remainingQuantity <= FILL_EPSILON)
      return intent;
    events.push({
      kind: "buy-cancel-requested",
      intentId: intent.intentId,
      reason,
    });
    return Object.freeze({
      ...intent,
      status: "cancel-requested" as const,
      cancelRequestedAt: at,
      cancelReason: reason,
    });
  });
  return { intents: next, events };
}

function reservesCapacity(intent: GridBuyIntent) {
  return (
    (intent.status === "open" || intent.status === "cancel-requested") &&
    intent.remainingQuantity > FILL_EPSILON
  );
}

function nearestBuyGridIndex(price: number, buyLevels: readonly GridLevel[]) {
  let best = buyLevels[0]!;
  for (const level of buyLevels) {
    const distance = Math.abs(price - level.price);
    const bestDistance = Math.abs(price - best.price);
    if (
      distance < bestDistance - EPSILON ||
      (Math.abs(distance - bestDistance) <= EPSILON && level.price < best.price)
    )
      best = level;
  }
  return best.index;
}

function mapLotsToPlan(lots: readonly GridLot[], plan: GridPlan) {
  return lots.map((lot) =>
    lot.remainingQuantity <= FILL_EPSILON
      ? lot
      : Object.freeze({
          ...lot,
          gridIndex: nearestBuyGridIndex(lot.entryPrice, plan.buyLevels),
        }),
  );
}

function pendingForAllLots(
  lots: readonly GridLot[],
  pending: readonly GridPendingExit[],
  at: number,
) {
  const exits = new Map(
    pending
      .filter((exit) => {
        const lot = lots.find((item) => item.lotId === exit.lotId);
        return !!lot && lot.remainingQuantity > FILL_EPSILON;
      })
      .map((exit) => [exit.lotId, exit]),
  );
  for (const lot of lots) {
    if (lot.remainingQuantity <= FILL_EPSILON) continue;
    exits.set(
      lot.lotId,
      Object.freeze({ lotId: lot.lotId, reason: "global-stop" as const, at }),
    );
  }
  return [...exits.values()];
}

function gridOccupied(
  gridIndex: number,
  lots: readonly GridLot[],
  intents: readonly GridBuyIntent[],
  plan: GridPlan,
) {
  return (
    lots.some(
      (lot) =>
        lot.remainingQuantity > FILL_EPSILON && lot.gridIndex === gridIndex,
    ) ||
    intents.some(
      (intent) =>
        reservesCapacity(intent) &&
        nearestBuyGridIndex(intent.levelPrice, plan.buyLevels) === gridIndex,
    )
  );
}

function reservedUnits(
  lots: readonly GridLot[],
  intents: readonly GridBuyIntent[],
) {
  return (
    lots.reduce((sum, lot) => sum + lot.remainingQuantity, 0) +
    intents.reduce(
      (sum, intent) =>
        sum + (reservesCapacity(intent) ? intent.remainingQuantity : 0),
      0,
    )
  );
}

function reservedCash(intents: readonly GridBuyIntent[], cost: number) {
  return intents.reduce(
    (sum, intent) =>
      sum +
      (reservesCapacity(intent)
        ? intent.remainingQuantity * (intent.levelPrice + cost)
        : 0),
    0,
  );
}

function exitIntents(
  pending: readonly GridPendingExit[],
  lots: readonly GridLot[],
  sellable: ReadonlyMap<string, number>,
) {
  const byLot = new Map(lots.map((lot) => [lot.lotId, lot]));
  const exits: GridExitIntent[] = [];
  for (const exit of pending) {
    const lot = byLot.get(exit.lotId);
    if (!lot || lot.remainingQuantity <= FILL_EPSILON) continue;
    const available = sellable.get(exit.lotId) ?? 0;
    const quantity = Math.min(lot.remainingQuantity, available);
    if (quantity <= FILL_EPSILON) continue;
    exits.push(
      Object.freeze({
        lotId: exit.lotId,
        quantity,
        referencePrice: exit.reason === "target" ? lot.target : lot.protection,
        reason: exit.reason,
      }),
    );
  }
  return exits;
}

/** Observe one completed point against the frozen grid.
 *
 * Order: terminal/drawdown and old-lot exits, then a due dynamic rebuild
 * (cancel unfilled buy parts, map every old lot to the nearest new buy grid),
 * then fresh buys only on crossings after the seed. The host owns cash,
 * equity, sellability and execution; this returns reference intents only. */
export function observeGrid(
  input: GridObservationInput,
): GridObservationResult {
  const state = input.state;
  const point = input.point as unknown;
  if (typeof point !== "object" || point === null)
    return {
      state,
      status: "invalid",
      reason: "invalid-point",
      detail: "观察点缺失",
      buys: [],
      exits: [],
      events: [],
    };
  const record = point as Record<string, unknown>;
  const index = record.index;
  if (!Number.isSafeInteger(index) || (index as number) < 0)
    return {
      state,
      status: "invalid",
      reason: "invalid-point",
      detail: "观察序号无效",
      buys: [],
      exits: [],
      events: [],
    };
  const time = confirmationEpoch(record.asOf as GridTime);
  if (time === null)
    return {
      state,
      status: "invalid",
      reason: "invalid-point",
      detail: "观察时间缺失或不是带时区的有效时间",
      buys: [],
      exits: [],
      events: [],
    };
  const dateEpoch = dailyBarEpoch(record.date);
  if (dateEpoch === null)
    return {
      state,
      status: "invalid",
      reason: "invalid-point",
      detail: "观察日期不是严格 YYYY-MM-DD",
      buys: [],
      exits: [],
      events: [],
    };
  if (dateEpoch > time)
    return {
      state,
      status: "invalid",
      reason: "invalid-point",
      detail: "观察日期晚于确认时间，拒绝未来日线标签",
      buys: [],
      exits: [],
      events: [],
    };

  if (state.lastObservationIndex !== null) {
    if (index === state.lastObservationIndex)
      return {
        state,
        status: "invalid",
        reason: "duplicate-index",
        detail: "观察序号重复",
        buys: [],
        exits: [],
        events: [],
      };
    if ((index as number) < state.lastObservationIndex)
      return {
        state,
        status: "invalid",
        reason: "out-of-order-index",
        detail: "观察序号倒退",
        buys: [],
        exits: [],
        events: [],
      };
  }
  if (state.lastObservationTime !== null) {
    if (time === state.lastObservationTime)
      return {
        state,
        status: "invalid",
        reason: "duplicate-time",
        detail: "同一时间戳不能对应新的观察序号",
        buys: [],
        exits: [],
        events: [],
      };
    if (time < state.lastObservationTime)
      return {
        state,
        status: "invalid",
        reason: "out-of-order-time",
        detail: "观察时间倒退",
        buys: [],
        exits: [],
        events: [],
      };
  }
  if (state.lastEventTime !== null && time < state.lastEventTime)
    return {
      state,
      status: "invalid",
      reason: "out-of-order-time",
      detail: "观察时间早于已处理成交",
      buys: [],
      exits: [],
      events: [],
    };

  const observationIndex = index as number;
  const previousPoint = state.lastPoint;
  const previousObservationIndex = state.lastObservationIndex;
  const continuityBreak =
    previousObservationIndex !== null &&
    observationIndex > previousObservationIndex + 1;
  const price =
    typeof record.price === "number" &&
    Number.isFinite(record.price) &&
    record.price > 0
      ? record.price
      : null;
  const facts = readSnapshot(input.snapshot);

  const events: GridObservationEvent[] = [];
  let status: GridObservationResult["status"] = "ready";
  let reason: GridObservationReason | null = null;
  let detail = "";
  let terminal = state.terminal;
  let peakEquity = state.peakEquity;
  if (facts.equityKnown)
    peakEquity =
      peakEquity === null
        ? facts.totalEquity
        : Math.max(peakEquity, facts.totalEquity);

  let intents = state.buyIntents;
  let lots = state.lots;
  let plan = state.plan;
  let generation = state.generation;
  let scheduleOriginIndex = state.scheduleOriginIndex;
  let lastRebuildIndex = state.lastRebuildIndex;
  let rebuildPause = state.rebuildPause;
  let pending = state.pendingExits.filter((exit) => {
    const lot = lots.find((item) => item.lotId === exit.lotId);
    return !!lot && lot.remainingQuantity > FILL_EPSILON;
  });

  if (!terminal) {
    const stopHit = price !== null && price <= state.plan.stopPrice;
    const drawdownHit =
      facts.equityKnown &&
      peakEquity !== null &&
      peakEquity > 0 &&
      (peakEquity - facts.totalEquity) / peakEquity >=
        state.plan.maxDrawdown - EPSILON;
    if (stopHit || drawdownHit) {
      const code = stopHit ? "global-stop" : "drawdown";
      terminal = Object.freeze({ code, at: time });
      events.push({ kind: "terminal", code, at: time });
      const requested = requestCancelOpenIntents(intents, time, code);
      intents = requested.intents;
      events.push(...requested.events);
      pending = pendingForAllLots(lots, pending, time);
    }
  }

  if (price !== null && !terminal) {
    const pendingIds = new Set(pending.map((exit) => exit.lotId));
    const additions: GridPendingExit[] = [];
    for (const lot of lots) {
      if (lot.remainingQuantity <= FILL_EPSILON) continue;
      if (pendingIds.has(lot.lotId)) continue;
      const exitReason =
        price >= lot.target
          ? "target"
          : price <= lot.protection
            ? "protection"
            : null;
      if (exitReason)
        additions.push(
          Object.freeze({ lotId: lot.lotId, reason: exitReason, at: time }),
        );
    }
    if (additions.length > 0) pending = [...pending, ...additions];
  }

  const exits = facts.sellable
    ? exitIntents(pending, lots, facts.sellable)
    : [];

  let seededThisBar = previousPoint === null;
  if (!terminal) {
    if (plan.kind === "dynamic") {
      if (scheduleOriginIndex === null) {
        scheduleOriginIndex = observationIndex;
      } else if (
        observationIndex > scheduleOriginIndex &&
        (observationIndex - scheduleOriginIndex) %
          plan.dynamic!.rebuildPeriod ===
          0
      ) {
        if (price === null) {
          status = "unknown";
          reason = "invalid-point";
          detail = "重估日缺少有效完成价，保留旧网格与旧保护";
          rebuildPause = Object.freeze({
            status: "unknown" as const,
            reason: "invalid-point" as const,
            at: time,
          });
        } else if (!input.bars) {
          status = "paused";
          reason = "missing-bars";
          detail = "重估日缺少完成日线，暂停新买";
          rebuildPause = Object.freeze({
            status: "paused" as const,
            reason: "missing-bars" as const,
            at: time,
          });
          const requested = requestCancelOpenIntents(
            intents,
            time,
            "missing-bars",
          );
          intents = requested.intents;
          events.push(...requested.events);
        } else if (input.bars[observationIndex]?.date !== record.date) {
          status = "paused";
          reason = "bar-mismatch";
          detail = "观察点与日线序号不一致，暂停新买";
          rebuildPause = Object.freeze({
            status: "paused" as const,
            reason: "bar-mismatch" as const,
            at: time,
          });
          const requested = requestCancelOpenIntents(
            intents,
            time,
            "bar-mismatch",
          );
          intents = requested.intents;
          events.push(...requested.events);
        } else {
          const rebuilt = rebuildDynamicGrid({
            params: plan.dynamic!,
            bars: input.bars,
            index: observationIndex,
          });
          if (rebuilt.status === "ready") {
            const requested = requestCancelOpenIntents(
              intents,
              time,
              "rebuilt",
            );
            intents = requested.intents;
            events.push(...requested.events);
            plan = rebuilt.plan;
            generation += 1;
            lots = mapLotsToPlan(lots, plan);
            lastRebuildIndex = observationIndex;
            rebuildPause = null;
            seededThisBar = true;
            events.push({
              kind: "rebuilt",
              index: observationIndex,
              generation,
            });
            reason = "rebuilt";
          } else {
            const requested = requestCancelOpenIntents(
              intents,
              time,
              `rebuild:${rebuilt.reason}`,
            );
            intents = requested.intents;
            events.push(...requested.events);
            status = rebuilt.status;
            reason = rebuilt.reason;
            detail = rebuilt.detail;
            rebuildPause = Object.freeze({
              status: rebuilt.status,
              reason: rebuilt.reason,
              at: time,
            });
          }
        }
      }
    }
  }

  if (!terminal && rebuildPause) {
    const requested = requestCancelOpenIntents(
      intents,
      time,
      `rebuild:${rebuildPause.reason}`,
    );
    intents = requested.intents;
    events.push(...requested.events);
  }
  if (!terminal && rebuildPause && status === "ready") {
    status = rebuildPause.status;
    reason = rebuildPause.reason;
    detail = "上次固定K重估失败，暂停新买直到下一次成功重估";
  }

  const lower = plan.levels[0]!;
  const upper = plan.levels[plan.levels.length - 1]!;
  const outsideBounds = price !== null && (price < lower || price > upper);
  const cashBlocked = !facts.cashKnown || !facts.equityKnown;
  if (!terminal && (outsideBounds || cashBlocked)) {
    const requested = requestCancelOpenIntents(
      intents,
      time,
      outsideBounds ? "outside-bounds" : "invalid-snapshot",
    );
    intents = requested.intents;
    events.push(...requested.events);
  }
  const canBuy =
    !terminal &&
    price !== null &&
    !seededThisBar &&
    !continuityBreak &&
    !rebuildPause &&
    status === "ready" &&
    reason !== "rebuilt" &&
    !outsideBounds &&
    !cashBlocked;

  const buys: GridBuyIntent[] = [];
  let gridOccupiedBlocked = false;
  let budgetGated = false;
  let ambiguous = false;
  if (canBuy && previousPoint) {
    const crossed = plan.buyLevels.filter(
      (level) => previousPoint.price >= level.price && price < level.price,
    );
    if (crossed.length > 1) ambiguous = true;
    else if (crossed.length === 1) {
      const level = crossed[0]!;
      if (gridOccupied(level.index, lots, intents, plan)) {
        gridOccupiedBlocked = true;
      } else {
        const units = reservedUnits(lots, intents);
        const cost = plan.estimatedRoundtripCost;
        const cash = reservedCash(intents, cost);
        const required = plan.unitsPerGrid * (level.price + cost);
        if (
          units + plan.unitsPerGrid > plan.maxTotalUnits + FILL_EPSILON ||
          facts.cashAvailableBeforeGridReservations + FILL_EPSILON <
            cash + required
        )
          budgetGated = true;
        else {
          const intent: GridBuyIntent = Object.freeze({
            intentId: `buy:${plan.versionId}:g${generation}:bar${observationIndex}:grid${level.index}`,
            versionId: plan.versionId,
            generation,
            createdBarIndex: observationIndex,
            gridIndex: level.index,
            levelPrice: level.price,
            target: level.sellTarget,
            protection: plan.stopPrice,
            quantity: plan.unitsPerGrid,
            filledQuantity: 0,
            remainingQuantity: plan.unitsPerGrid,
            status: "open",
            createdAt: time,
            cancelRequestedAt: null,
            cancelReason: null,
            terminatedAt: null,
            terminationOutcome: null,
            terminationAckId: null,
          });
          buys.push(intent);
          intents = [...intents, intent];
        }
      }
    }
  }

  if (terminal) {
    status = "paused";
    reason = terminal.code;
    detail =
      terminal.code === "global-stop"
        ? "触及绝对止损，网格终止，只保留退出"
        : "权益回撤达到上限，网格终止，只保留退出";
  } else if (price === null) {
    status = "unknown";
    reason = "invalid-point";
    detail = "完成价缺失或无效，跨越连续性中断";
  } else if (status === "ready" && continuityBreak) {
    status = "unknown";
    reason = "crossing-gap";
    detail = "缺少中间观察点，不补认跨格";
  } else if (status === "ready" && outsideBounds) {
    status = "paused";
    reason = "outside-bounds";
    detail = "价格在网格上下界之外，暂停新买";
  } else if (status === "ready" && cashBlocked) {
    status = "paused";
    reason = "invalid-snapshot";
    detail = "可用现金或总权益不可验证，暂停新买";
  } else if (status === "ready" && seededThisBar) {
    if (reason !== "rebuilt") {
      reason = "seeded";
      detail = "新网格或当前完成点仅作种子，不回溯补买";
    }
  } else if (status === "ready" && ambiguous) {
    status = "unknown";
    reason = "ambiguous-crossing";
    detail = "单次观察跨越多格，缺少有序逐笔证据，不虚构多次往返";
  } else if (status === "ready" && buys.length > 0) {
    reason = null;
    detail = "产生新的买入参考意图";
  } else if (status === "ready" && gridOccupiedBlocked) {
    reason = "grid-occupied";
    detail = "该格已有批次或未完成买入预留";
  } else if (status === "ready" && budgetGated) {
    reason = "budget-gated";
    detail = "现金、总库存或单位约束未通过";
  } else if (status === "ready" && reason === null) {
    reason =
      plan.kind === "dynamic" &&
      scheduleOriginIndex !== null &&
      (observationIndex === scheduleOriginIndex ||
        (observationIndex - scheduleOriginIndex) %
          plan.dynamic!.rebuildPeriod !==
          0)
        ? "not-due"
        : null;
  }

  return {
    state: freezeState({
      ...state,
      plan,
      generation,
      originIndex:
        state.originIndex ?? (price !== null ? observationIndex : null),
      originTime: state.originTime ?? (price !== null ? time : null),
      lots,
      buyIntents: intents,
      pendingExits: pending,
      peakEquity,
      terminal,
      lastPoint:
        price !== null
          ? Object.freeze({
              index: observationIndex,
              time,
              price,
            })
          : null,
      lastObservationIndex: observationIndex,
      lastObservationTime: time,
      scheduleOriginIndex,
      lastRebuildIndex,
      rebuildPause,
      lastEventTime:
        state.lastEventTime === null
          ? time
          : Math.max(state.lastEventTime, time),
    }),
    status,
    reason,
    detail,
    buys,
    exits,
    events,
  };
}
