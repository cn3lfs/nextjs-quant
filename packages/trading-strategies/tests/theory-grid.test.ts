import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  acknowledgeGridOrderTermination,
  applyGridFill,
  buildFixedGrid,
  createGridState,
  observeGrid,
  rebuildDynamicGrid,
  type DynamicGridParams,
  type FixedGridParams,
  type GridBuyIntent,
  type GridObservationPoint,
  type GridObservationSnapshot,
  type GridPlan,
  type GridState,
} from "../src/theory-grid.js";

const fixedParams: FixedGridParams = {
  versionId: "fixed-v1",
  construction: "arithmetic",
  levels: [10, 11, 12, 13],
  unitsPerGrid: 10,
  maxUnitsPerGrid: 20,
  maxTotalUnits: 40,
  stopPrice: 8,
  maxDrawdown: 0.25,
  estimatedRoundtripCost: 0.1,
};

const dynamicParams: DynamicGridParams = {
  versionId: "dynamic-v1",
  period: 3,
  multiplier: 1,
  halfLevels: 1,
  rebuildPeriod: 2,
  longMaPeriod: 3,
  risingLookback: 1,
  unitsPerGrid: 1,
  maxUnitsPerGrid: 1,
  maxTotalUnits: 2,
  stopPrice: 9,
  maxDrawdown: 0.5,
  estimatedRoundtripCost: 0.1,
};

function bar(date: string, close: number): Bar {
  return {
    date,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
    amount: close * 1000,
  };
}

const risingBars = [
  bar("2026-01-05", 10),
  bar("2026-01-06", 11),
  bar("2026-01-07", 12),
  bar("2026-01-08", 13),
];

describe("fixed grid plan", () => {
  it("freezes explicit increasing levels into buy grids with higher sell targets", () => {
    const plan = buildFixedGrid(fixedParams);
    expect(plan.kind).toBe("fixed");
    expect(plan.construction).toBe("arithmetic");
    expect(plan.levels).toEqual([10, 11, 12, 13]);
    expect(plan.buyLevels).toEqual([
      { index: 0, price: 10, sellTarget: 11 },
      { index: 1, price: 11, sellTarget: 12 },
      { index: 2, price: 12, sellTarget: 13 },
    ]);
    expect(plan.stopPrice).toBe(8);
    expect(plan.versionId).toBe("fixed-v1");
    expect(plan.dynamic).toBeNull();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.levels)).toBe(true);
    expect(Object.isFrozen(plan.buyLevels[0])).toBe(true);
  });

  it("accepts a consistent geometric grid", () => {
    const plan = buildFixedGrid({
      ...fixedParams,
      construction: "geometric",
      levels: [10, 11, 12.1],
    });
    expect(plan.construction).toBe("geometric");
    expect(plan.buyLevels.at(-1)?.sellTarget).toBe(12.1);
  });

  it("rejects non-increasing, inconsistent, underfunded and unprotected grids", () => {
    expect(() =>
      buildFixedGrid({ ...fixedParams, levels: [10, 12, 11] }),
    ).toThrow("严格递增");
    expect(() =>
      buildFixedGrid({ ...fixedParams, levels: [10, 11, 12.5] }),
    ).toThrow("等差");
    expect(() =>
      buildFixedGrid({
        ...fixedParams,
        construction: "geometric",
        levels: [10, 11, 12],
      }),
    ).toThrow("等比");
    expect(() => buildFixedGrid({ ...fixedParams, unitsPerGrid: 21 })).toThrow(
      "每格库存上限",
    );
    expect(() => buildFixedGrid({ ...fixedParams, stopPrice: 10 })).toThrow(
      "止损",
    );
    expect(() =>
      buildFixedGrid({ ...fixedParams, estimatedRoundtripCost: 1.1 }),
    ).toThrow("双边成本");
  });
});

describe("dynamic grid plan", () => {
  it("freezes centre, simple-TR spacing and the long-trend gate", () => {
    const built = rebuildDynamicGrid({
      params: dynamicParams,
      bars: risingBars,
      index: 3,
    });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    // SMA3 = 12; TR = 1.5 on each of the three completed ranges.
    expect(built.plan.levels).toEqual([10.5, 12, 13.5]);
    expect(built.plan.buyLevels).toEqual([
      { index: 0, price: 10.5, sellTarget: 12 },
      { index: 1, price: 12, sellTarget: 13.5 },
    ]);
    expect(built.plan.versionId).toBe("dynamic-v1");
    expect(built.plan.dynamic).toMatchObject({
      versionId: "dynamic-v1",
      period: 3,
      multiplier: 1,
      halfLevels: 1,
    });
    expect(Object.isFrozen(built.plan)).toBe(true);
    expect(Object.isFrozen(built.plan.dynamic)).toBe(true);
  });

  it("returns UNKNOWN before the SMA/ATR/long-MA history is complete", () => {
    const built = rebuildDynamicGrid({
      params: dynamicParams,
      bars: risingBars,
      index: 1,
    });
    expect(built).toMatchObject({
      status: "unknown",
      reason: "insufficient-history",
    });
  });

  it("pauses on a failed long-trend gate instead of shifting the centre", () => {
    const falling = [
      bar("2026-01-05", 13),
      bar("2026-01-06", 12),
      bar("2026-01-07", 11),
      bar("2026-01-08", 10),
    ];
    expect(
      rebuildDynamicGrid({ params: dynamicParams, bars: falling, index: 3 }),
    ).toMatchObject({ status: "paused", reason: "trend-failed" });
  });

  it("pauses on zero ATR, insufficient spacing or a non-positive lower bound", () => {
    const flat = risingBars.map((item) => ({
      ...item,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
    }));
    expect(
      rebuildDynamicGrid({ params: dynamicParams, bars: flat, index: 3 }),
    ).toMatchObject({ status: "paused", reason: "atr-invalid" });

    expect(
      rebuildDynamicGrid({
        params: { ...dynamicParams, multiplier: 0.01 },
        bars: risingBars,
        index: 3,
      }),
    ).toMatchObject({ status: "paused", reason: "spacing-below-cost" });

    expect(
      rebuildDynamicGrid({
        params: { ...dynamicParams, multiplier: 10 },
        bars: risingBars,
        index: 3,
      }),
    ).toMatchObject({ status: "paused", reason: "lower-bound-invalid" });
  });

  it("rejects duplicate daily labels rather than treating them as ordered bars", () => {
    const duplicated = [...risingBars];
    duplicated[3] = bar("2026-01-07", 13);
    expect(
      rebuildDynamicGrid({
        params: dynamicParams,
        bars: duplicated,
        index: 3,
      }),
    ).toMatchObject({ status: "unknown", reason: "insufficient-history" });
  });
});

function stateWithBuyIntent(
  plan: GridPlan,
  overrides: Partial<GridBuyIntent> = {},
): GridState {
  const base = createGridState(plan);
  const level = plan.buyLevels[1]!;
  const intent: GridBuyIntent = {
    intentId: "buy:fixed-v1:g1:bar10:grid1",
    versionId: plan.versionId,
    generation: base.generation,
    createdBarIndex: 10,
    gridIndex: level.index,
    levelPrice: level.price,
    target: level.sellTarget,
    protection: plan.stopPrice,
    quantity: plan.unitsPerGrid,
    filledQuantity: 0,
    remainingQuantity: plan.unitsPerGrid,
    status: "open",
    createdAt: Date.parse("2026-01-02T15:00:00+08:00"),
    cancelRequestedAt: null,
    cancelReason: null,
    terminatedAt: null,
    terminationOutcome: null,
    terminationAckId: null,
    ...overrides,
  };
  return Object.freeze({
    ...base,
    buyIntents: Object.freeze([Object.freeze(intent)]),
  });
}

const firstBuyTime = "2026-01-02T15:00:00+08:00";

describe("grid fill reducer", () => {
  it("records only actual buy quantities and keeps immutable intent metadata", () => {
    const plan = buildFixedGrid(fixedParams);
    const state = stateWithBuyIntent(plan);
    const result = applyGridFill(state, {
      fillId: "fill-buy-1",
      side: "buy",
      intentId: state.buyIntents[0]!.intentId,
      price: 10.9,
      quantity: 10,
      fee: 0.5,
      time: firstBuyTime,
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.lot).toMatchObject({
      lotId: "lot:fill-buy-1",
      versionId: "fixed-v1",
      gridIndex: 1,
      originalGridIndex: 1,
      originalGridPrice: 11,
      target: 12,
      protection: 8,
      entryPrice: 10.9,
      entryFee: 0.5,
      quantity: 10,
      remainingQuantity: 10,
    });
    expect(result.intent).toMatchObject({
      status: "filled",
      filledQuantity: 10,
      remainingQuantity: 0,
    });
    expect(result.state.lots).toHaveLength(1);
    expect("cash" in result.state).toBe(false);
    expect("equity" in result.state).toBe(false);
  });

  it("keeps a partial buy reservation open instead of reopening the grid", () => {
    const plan = buildFixedGrid(fixedParams);
    const state = stateWithBuyIntent(plan);
    const first = applyGridFill(state, {
      fillId: "fill-buy-part-1",
      side: "buy",
      intentId: state.buyIntents[0]!.intentId,
      price: 10.95,
      quantity: 4,
      fee: 0.2,
      time: firstBuyTime,
    });
    expect(first.status).toBe("applied");
    if (first.status !== "applied") return;
    expect(first.lot?.quantity).toBe(4);
    expect(first.intent).toMatchObject({
      status: "open",
      filledQuantity: 4,
      remainingQuantity: 6,
    });

    const second = applyGridFill(first.state, {
      fillId: "fill-buy-part-2",
      side: "buy",
      intentId: state.buyIntents[0]!.intentId,
      price: 10.85,
      quantity: 6,
      fee: 0.3,
      time: "2026-01-03T15:00:00+08:00",
    });
    expect(second.status).toBe("applied");
    if (second.status !== "applied") return;
    expect(second.intent).toMatchObject({
      status: "filled",
      filledQuantity: 10,
      remainingQuantity: 0,
    });
    expect(second.state.lots.map((lot) => lot.entryPrice)).toEqual([
      10.95, 10.85,
    ]);
    expect(() =>
      applyGridFill(second.state, {
        fillId: "fill-buy-over",
        side: "buy",
        intentId: state.buyIntents[0]!.intentId,
        price: 10.8,
        quantity: 1,
        fee: 0,
        time: "2026-01-04T15:00:00+08:00",
      }),
    ).toThrow("已终止");
  });

  it("accepts an exact fill replay and rejects conflicting content under one id", () => {
    const plan = buildFixedGrid(fixedParams);
    const state = stateWithBuyIntent(plan);
    const fill = {
      fillId: "fill-replay",
      side: "buy" as const,
      intentId: state.buyIntents[0]!.intentId,
      price: 10.9,
      quantity: 10,
      fee: 0.5,
      time: firstBuyTime,
    };
    const applied = applyGridFill(state, fill);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") return;
    expect(Object.isFrozen(applied.fill)).toBe(true);
    expect(Object.isFrozen(applied.state.appliedFills[0])).toBe(true);
    expect(() => {
      (applied.fill as { price: number }).price = 0;
    }).toThrow();

    const replay = applyGridFill(applied.state, fill);
    expect(replay.status).toBe("replayed");
    expect(replay.state).toBe(applied.state);

    expect(() =>
      applyGridFill(applied.state, { ...fill, price: 10.8 }),
    ).toThrow("fillId 冲突");
    expect(() =>
      applyGridFill(applied.state, { ...fill, quantity: 9 }),
    ).toThrow("fillId 冲突");
  });

  it("rejects unknown sell lots and oversells while preserving original targets", () => {
    const plan = buildFixedGrid(fixedParams);
    const state = stateWithBuyIntent(plan);
    const bought = applyGridFill(state, {
      fillId: "fill-buy-sell",
      side: "buy",
      intentId: state.buyIntents[0]!.intentId,
      price: 10.9,
      quantity: 10,
      fee: 0.5,
      time: firstBuyTime,
    });
    expect(bought.status).toBe("applied");
    if (bought.status !== "applied") return;
    const lotId = bought.lot!.lotId;

    expect(() =>
      applyGridFill(bought.state, {
        fillId: "fill-sell-unknown",
        side: "sell",
        lotId: "lot:unknown",
        price: 12,
        quantity: 1,
        fee: 0,
        time: "2026-01-03T15:00:00+08:00",
      }),
    ).toThrow("未知卖出批次");
    expect(() =>
      applyGridFill(bought.state, {
        fillId: "fill-sell-over",
        side: "sell",
        lotId,
        price: 12,
        quantity: 11,
        fee: 0,
        time: "2026-01-03T15:00:00+08:00",
      }),
    ).toThrow("超过批次剩余");

    const partial = applyGridFill(bought.state, {
      fillId: "fill-sell-part",
      side: "sell",
      lotId,
      price: 12.1,
      quantity: 4,
      fee: 0.2,
      time: "2026-01-03T15:00:00+08:00",
    });
    expect(partial.status).toBe("applied");
    if (partial.status !== "applied") return;
    expect(partial.lot).toMatchObject({
      remainingQuantity: 6,
      target: 12,
      protection: 8,
      originalGridPrice: 11,
      entryPrice: 10.9,
    });
  });

  it("rejects missing/backdated timestamps and does not re-gate actual facts on cash", () => {
    const plan = buildFixedGrid(fixedParams);
    const state = stateWithBuyIntent(plan);
    expect(() =>
      applyGridFill(state, {
        fillId: "fill-bad-time",
        side: "buy",
        intentId: state.buyIntents[0]!.intentId,
        price: 11,
        quantity: 1,
        fee: 0,
        time: "2026-01-02",
      }),
    ).toThrow("成交时间");

    const first = applyGridFill(state, {
      fillId: "fill-time-1",
      side: "buy",
      intentId: state.buyIntents[0]!.intentId,
      price: 11,
      quantity: 1,
      fee: 0,
      time: firstBuyTime,
    });
    expect(first.status).toBe("applied");
    if (first.status !== "applied") return;
    expect(() =>
      applyGridFill(first.state, {
        fillId: "fill-time-0",
        side: "buy",
        intentId: state.buyIntents[0]!.intentId,
        price: 11,
        quantity: 1,
        fee: 0,
        time: "2026-01-01T15:00:00+08:00",
      }),
    ).toThrow("早于已处理事实");

    // The actual fill price can exceed any cash snapshot; no internal ledger.
    const expensive = applyGridFill(first.state, {
      fillId: "fill-expensive",
      side: "buy",
      intentId: state.buyIntents[0]!.intentId,
      price: 1000,
      quantity: 9,
      fee: 50,
      time: "2026-01-03T15:00:00+08:00",
    });
    expect(expensive.status).toBe("applied");
    if (expensive.status !== "applied") return;
    expect(expensive.lot?.entryPrice).toBe(1000);
    expect(expensive.lot?.entryFee).toBe(50);
  });
});

function snap(
  overrides: Partial<GridObservationSnapshot> = {},
): GridObservationSnapshot {
  return {
    cashAvailableBeforeGridReservations: 100000,
    totalEquity: 100000,
    canSellByLot: [],
    ...overrides,
  };
}

function pt(index: number, date: string, price: number): GridObservationPoint {
  return { index, date, price, asOf: `${date}T15:00:00+08:00` };
}

function observe(
  state: GridState,
  point: GridObservationPoint,
  snapshot: GridObservationSnapshot = snap(),
  bars?: readonly Bar[],
) {
  return observeGrid({ state, point, snapshot, bars });
}

function seedFixed(params: FixedGridParams = fixedParams) {
  const state = createGridState(buildFixedGrid(params));
  return observe(state, pt(0, "2026-01-05", 11.5)).state;
}

describe("grid observer", () => {
  it("seeds without retroactive buys and confirms a down-cross only below the level", () => {
    const params = { ...fixedParams, levels: [9, 10, 11], stopPrice: 8 };
    const plan = buildFixedGrid(params);
    const first = observe(createGridState(plan), pt(0, "2026-01-05", 9.95));
    expect(first.buys).toHaveLength(0);
    expect(first.reason).toBe("seeded");

    const seeded = observe(createGridState(plan), pt(0, "2026-01-05", 11));
    const atLevel = observe(seeded.state, pt(1, "2026-01-06", 10));
    expect(atLevel.buys).toHaveLength(0);
    expect(Object.isFrozen(atLevel.state.lastPoint)).toBe(true);
    const below = observe(atLevel.state, pt(2, "2026-01-07", 9.9));
    expect(below.buys).toHaveLength(1);
    expect(below.buys[0]).toMatchObject({
      gridIndex: 1,
      levelPrice: 10,
      target: 11,
      protection: 8,
    });
  });

  it("records actual fills, then keeps a target exit pending through T+1", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    expect(signal.buys).toHaveLength(1);
    expect(signal.state.lots).toHaveLength(0);
    expect(signal.state.buyIntents[0]).toMatchObject({
      status: "open",
      remainingQuantity: 10,
    });
    const bought = applyGridFill(signal.state, {
      fillId: "obs-buy",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 10,
      fee: 0.1,
      time: "2026-01-06T15:00:00+08:00",
    });
    expect(bought.status).toBe("applied");
    if (bought.status !== "applied") return;
    const lotId = bought.lot!.lotId;

    const target = observe(
      bought.state,
      pt(2, "2026-01-07", 12.1),
      snap({ canSellByLot: [] }),
    );
    expect(target.exits).toHaveLength(0);
    expect(target.state.pendingExits).toMatchObject([
      { lotId, reason: "target" },
    ]);

    const t1 = observe(
      target.state,
      pt(3, "2026-01-08", 11.9),
      snap({ canSellByLot: [{ lotId, quantity: 10 }] }),
    );
    expect(t1.exits).toHaveLength(1);
    expect(t1.exits[0]).toMatchObject({
      lotId,
      quantity: 10,
      reason: "target",
    });

    const partial = applyGridFill(t1.state, {
      fillId: "obs-sell-1",
      side: "sell",
      lotId,
      price: 11.9,
      quantity: 4,
      fee: 0.1,
      time: "2026-01-08T15:00:00+08:00",
    });
    expect(partial.status).toBe("applied");
    if (partial.status !== "applied") return;
    expect(partial.state.pendingExits).toMatchObject([
      { lotId, reason: "target" },
    ]);
    const rest = observe(
      partial.state,
      pt(4, "2026-01-09", 11.8),
      snap({ canSellByLot: [{ lotId, quantity: 6 }] }),
    );
    expect(rest.exits[0]).toMatchObject({ lotId, quantity: 6 });
    const closed = applyGridFill(rest.state, {
      fillId: "obs-sell-2",
      side: "sell",
      lotId,
      price: 11.8,
      quantity: 6,
      fee: 0.1,
      time: "2026-01-09T15:00:00+08:00",
    });
    expect(closed.status).toBe("applied");
    if (closed.status !== "applied") return;
    expect(closed.lot).toMatchObject({
      remainingQuantity: 0,
      target: 12,
      protection: 8,
    });
    expect(closed.state.pendingExits).toHaveLength(0);
  });

  it("does not open a second intent while a partial buy reservation remains", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const partial = applyGridFill(signal.state, {
      fillId: "obs-part",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 4,
      fee: 0.1,
      time: "2026-01-06T15:00:00+08:00",
    });
    expect(partial.status).toBe("applied");
    if (partial.status !== "applied") return;
    const up = observe(partial.state, pt(2, "2026-01-07", 11.5));
    const again = observe(up.state, pt(3, "2026-01-08", 10.5));
    expect(again.buys).toHaveLength(0);
    expect(again.reason).toBe("grid-occupied");
    expect(again.state.lots[0]?.remainingQuantity).toBe(4);
    expect(again.state.buyIntents[0]).toMatchObject({
      status: "open",
      remainingQuantity: 6,
    });
  });

  it("counts reserved intents and lots against cash and Qmax before a new intent", () => {
    const params = {
      ...fixedParams,
      levels: [9, 10, 11, 12],
      unitsPerGrid: 10,
      maxUnitsPerGrid: 10,
      maxTotalUnits: 40,
      stopPrice: 8,
    };
    const seeded = seedFixed(params);
    const reserved = observe(seeded, pt(1, "2026-01-06", 10.5));
    expect(reserved.buys).toHaveLength(1);
    // Open intent reserves 10 * (11 + 0.1) = 111.
    const cashBlocked = observe(
      reserved.state,
      pt(2, "2026-01-07", 9.5),
      snap({ cashAvailableBeforeGridReservations: 150 }),
    );
    expect(cashBlocked.buys).toHaveLength(0);
    expect(cashBlocked.reason).toBe("budget-gated");
    const cashAllows = observe(
      reserved.state,
      pt(2, "2026-01-07", 9.5),
      snap({ cashAvailableBeforeGridReservations: 300 }),
    );
    expect(cashAllows.buys).toHaveLength(1);

    const tight = seedFixed({ ...params, maxTotalUnits: 15 });
    const tightReserved = observe(tight, pt(1, "2026-01-06", 10.5));
    const qmaxBlocked = observe(
      tightReserved.state,
      pt(2, "2026-01-07", 9.5),
      snap({ cashAvailableBeforeGridReservations: 100000 }),
    );
    expect(qmaxBlocked.buys).toHaveLength(0);
    expect(qmaxBlocked.reason).toBe("budget-gated");
  });

  it("treats a global stop as terminal and keeps pending exits after recovery", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const bought = applyGridFill(signal.state, {
      fillId: "stop-buy",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 10,
      fee: 0.1,
      time: "2026-01-06T15:00:00+08:00",
    });
    expect(bought.status).toBe("applied");
    if (bought.status !== "applied") return;
    const lotId = bought.lot!.lotId;
    const stopped = observe(
      bought.state,
      pt(2, "2026-01-07", 8),
      snap({ canSellByLot: [{ lotId, quantity: 10 }] }),
    );
    expect(stopped.status).toBe("paused");
    expect(stopped.reason).toBe("global-stop");
    expect(stopped.state.terminal).toMatchObject({ code: "global-stop" });
    expect(Object.isFrozen(stopped.state.terminal)).toBe(true);
    expect(Object.isFrozen(stopped.state.pendingExits[0])).toBe(true);
    expect(stopped.exits[0]).toMatchObject({
      lotId,
      quantity: 10,
      reason: "global-stop",
    });

    const later = observe(
      stopped.state,
      pt(3, "2026-01-08", 11.5),
      snap({ canSellByLot: [{ lotId, quantity: 10 }] }),
    );
    expect(later.status).toBe("paused");
    expect(later.reason).toBe("global-stop");
    expect(later.buys).toHaveLength(0);
    expect(later.exits[0]).toMatchObject({ lotId, reason: "global-stop" });
  });

  it("handles zero equity as a known drawdown and keeps exits with unknown equity", () => {
    const seeded = observe(
      createGridState(buildFixedGrid(fixedParams)),
      pt(0, "2026-01-05", 11.5),
      snap({ totalEquity: 100 }),
    );
    const wiped = observe(
      seeded.state,
      pt(1, "2026-01-06", 11.5),
      snap({ totalEquity: 0 }),
    );
    expect(wiped.status).toBe("paused");
    expect(wiped.reason).toBe("drawdown");
    expect(wiped.state.terminal).toMatchObject({ code: "drawdown" });

    const zeroStart = observe(
      createGridState(buildFixedGrid(fixedParams)),
      pt(0, "2026-01-05", 11.5),
      snap({ cashAvailableBeforeGridReservations: 0, totalEquity: 0 }),
    );
    expect(zeroStart.state.terminal).toBeNull();
    expect(zeroStart.state.peakEquity).toBe(0);
    const zeroBuy = observe(
      zeroStart.state,
      pt(1, "2026-01-06", 10.5),
      snap({ cashAvailableBeforeGridReservations: 0, totalEquity: 0 }),
    );
    expect(zeroBuy.buys).toHaveLength(0);
    expect(zeroBuy.reason).toBe("budget-gated");

    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const bought = applyGridFill(signal.state, {
      fillId: "unknown-equity-buy",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 10,
      fee: 0.1,
      time: "2026-01-06T15:00:00+08:00",
    });
    expect(bought.status).toBe("applied");
    if (bought.status !== "applied") return;
    const lotId = bought.lot!.lotId;
    const unknown = observe(
      bought.state,
      pt(2, "2026-01-07", 12.1),
      snap({
        totalEquity: Number.NaN,
        canSellByLot: [{ lotId, quantity: 10 }],
      }),
    );
    expect(unknown.status).toBe("paused");
    expect(unknown.reason).toBe("invalid-snapshot");
    expect(unknown.exits[0]).toMatchObject({ lotId, quantity: 10 });
    expect(unknown.state.lots[0]).toMatchObject({
      target: 12,
      protection: 8,
      entryPrice: 10.5,
    });
  });

  it("keeps index/time watermarks when a price is missing and rejects old or equal timestamps", () => {
    const seeded = seedFixed();
    const first = observe(seeded, pt(1, "2026-01-06", 11.5));
    const duplicateTime = observe(first.state, {
      index: 2,
      date: "2026-01-06",
      price: 11.5,
      asOf: "2026-01-06T15:00:00+08:00",
    });
    expect(duplicateTime.status).toBe("invalid");
    expect(duplicateTime.reason).toBe("duplicate-time");
    expect(duplicateTime.state).toBe(first.state);

    const missingPrice = observe(first.state, {
      index: 2,
      date: "2026-01-07",
      price: Number.NaN,
      asOf: "2026-01-07T15:00:00+08:00",
    });
    expect(missingPrice.status).toBe("unknown");
    expect(missingPrice.reason).toBe("invalid-point");
    expect(missingPrice.state.lastObservationIndex).toBe(2);
    expect(missingPrice.state.lastPoint).toBeNull();

    const oldIndex = observe(missingPrice.state, pt(1, "2026-01-08", 11.5));
    expect(oldIndex.status).toBe("invalid");
    expect(oldIndex.reason).toBe("out-of-order-index");
    const equalTime = observe(missingPrice.state, {
      index: 3,
      date: "2026-01-07",
      price: 11.5,
      asOf: "2026-01-07T15:00:00+08:00",
    });
    expect(equalTime.status).toBe("invalid");
    expect(equalTime.reason).toBe("duplicate-time");

    const recovered = observe(missingPrice.state, pt(3, "2026-01-08", 11.5));
    expect(recovered.status).toBe("ready");
    expect(recovered.reason).toBe("seeded");
    expect(recovered.buys).toHaveLength(0);
  });

  it("breaks crossing continuity on a missing index gap or a future daily label", () => {
    const seeded = seedFixed();
    const gap = observe(seeded, pt(2, "2026-01-07", 10.5));
    expect(gap.status).toBe("unknown");
    expect(gap.reason).toBe("crossing-gap");
    expect(gap.buys).toHaveLength(0);
    expect(gap.state.lastObservationIndex).toBe(2);

    const future = observe(seeded, {
      index: 1,
      date: "2026-01-07",
      price: 11.5,
      asOf: "2026-01-06T15:00:00+08:00",
    });
    expect(future.status).toBe("invalid");
    expect(future.reason).toBe("invalid-point");
    expect(future.state).toBe(seeded);
  });

  it("retries a dynamic rebuild only on its fixed K-offset schedule", () => {
    const scheduleBars = [
      bar("2026-01-05", 10),
      bar("2026-01-06", 11),
      bar("2026-01-07", 12),
      bar("2026-01-08", 13),
      bar("2026-01-09", 11.5),
      bar("2026-01-12", 11),
      bar("2026-01-13", 11.2),
      bar("2026-01-14", 13.2),
      bar("2026-01-15", 13.3),
    ];
    const built = rebuildDynamicGrid({
      params: dynamicParams,
      bars: scheduleBars,
      index: 3,
    });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    let state = createGridState(built.plan);
    state = observe(state, pt(3, "2026-01-08", 13), snap(), scheduleBars).state;
    const signal = observe(
      state,
      pt(4, "2026-01-09", 11.5),
      snap(),
      scheduleBars,
    );
    expect(signal.buys).toHaveLength(1);
    const bought = applyGridFill(signal.state, {
      fillId: "schedule-buy",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 11.5,
      quantity: 1,
      fee: 0,
      time: "2026-01-09T15:00:00+08:00",
    });
    expect(bought.status).toBe("applied");
    if (bought.status !== "applied") return;
    const lotId = bought.lot!.lotId;

    const failedDue = observe(
      bought.state,
      pt(5, "2026-01-12", 11),
      snap(),
      scheduleBars,
    );
    expect(failedDue.status).toBe("paused");
    expect(failedDue.reason).toBe("trend-failed");
    expect(failedDue.state.plan).toBe(bought.state.plan);
    expect(failedDue.state.generation).toBe(1);
    expect(failedDue.state.lots[0]).toMatchObject({
      lotId,
      target: 13.5,
      protection: 9,
      entryPrice: 11.5,
    });

    const nonDue = observe(
      failedDue.state,
      pt(6, "2026-01-13", 11.2),
      snap(),
      scheduleBars,
    );
    expect(nonDue.status).toBe("paused");
    expect(nonDue.reason).toBe("trend-failed");
    expect(nonDue.state.plan).toBe(bought.state.plan);
    expect(nonDue.state.lastRebuildIndex).toBeNull();
    expect(nonDue.state.rebuildPause).toMatchObject({
      status: "paused",
      reason: "trend-failed",
    });

    const nextDue = observe(
      nonDue.state,
      pt(7, "2026-01-14", 13.2),
      snap(),
      scheduleBars,
    );
    expect(nextDue.reason).toBe("rebuilt");
    expect(nextDue.buys).toHaveLength(0);
    expect(nextDue.state.generation).toBe(2);
    expect(nextDue.state.lastRebuildIndex).toBe(7);
    expect(nextDue.state.scheduleOriginIndex).toBe(3);
    expect(nextDue.state.rebuildPause).toBeNull();
    expect(nextDue.state.lots[0]).toMatchObject({
      lotId,
      target: 13.5,
      protection: 9,
      entryPrice: 11.5,
    });
    expect(nextDue.state.lots[0]?.gridIndex).toBe(1);

    const afterDue = observe(
      nextDue.state,
      pt(8, "2026-01-15", 13.2),
      snap(),
      scheduleBars,
    );
    expect(afterDue.reason).toBe("not-due");
    expect(afterDue.state.plan).toBe(nextDue.state.plan);
  });

  it("maps every old lot to the nearest new buy grid, ties lower, and exits first", () => {
    const mappingParams = {
      ...dynamicParams,
      halfLevels: 2,
      rebuildPeriod: 3,
      stopPrice: 6,
    };
    const mappingBars = [
      bar("2026-01-05", 10),
      bar("2026-01-06", 11),
      bar("2026-01-07", 12),
      bar("2026-01-08", 13),
      bar("2026-01-09", 11.5),
      bar("2026-01-12", 10.4),
      bar("2026-01-13", 13.1),
    ];
    const future = rebuildDynamicGrid({
      params: mappingParams,
      bars: mappingBars,
      index: 6,
    });
    expect(future.status).toBe("ready");
    if (future.status !== "ready") return;
    const lowerGrid = future.plan.buyLevels[1]!;
    const upperGrid = future.plan.buyLevels[2]!;
    const tie = (lowerGrid.price + upperGrid.price) / 2;

    const firstPlan = rebuildDynamicGrid({
      params: mappingParams,
      bars: mappingBars,
      index: 3,
    });
    expect(firstPlan.status).toBe("ready");
    if (firstPlan.status !== "ready") return;

    const createLots = (secondEntry: number) => {
      let state = createGridState(firstPlan.plan);
      state = observe(
        state,
        pt(3, "2026-01-08", 13),
        snap(),
        mappingBars,
      ).state;
      const first = observe(
        state,
        pt(4, "2026-01-09", 11.5),
        snap(),
        mappingBars,
      );
      const firstFill = applyGridFill(first.state, {
        fillId: "map-buy-1",
        side: "buy",
        intentId: first.buys[0]!.intentId,
        price: 12.6,
        quantity: 1,
        fee: 0,
        time: "2026-01-09T15:00:00+08:00",
      });
      expect(firstFill.status).toBe("applied");
      if (firstFill.status !== "applied") throw new Error("first fill");
      const second = observe(
        firstFill.state,
        pt(5, "2026-01-12", 10.4),
        snap(),
        mappingBars,
      );
      const secondFill = applyGridFill(second.state, {
        fillId: "map-buy-2",
        side: "buy",
        intentId: second.buys[0]!.intentId,
        price: secondEntry,
        quantity: 1,
        fee: 0,
        time: "2026-01-12T15:00:00+08:00",
      });
      expect(secondFill.status).toBe("applied");
      if (secondFill.status !== "applied") throw new Error("second fill");
      return secondFill.state;
    };

    const shared = observe(
      createLots(upperGrid.price - 0.1),
      pt(6, "2026-01-13", 13.1),
      snap({ canSellByLot: [{ lotId: "lot:map-buy-2", quantity: 1 }] }),
      mappingBars,
    );
    expect(shared.reason).toBe("rebuilt");
    expect(shared.state.generation).toBe(2);
    expect(shared.state.lots.map((lot) => lot.gridIndex)).toEqual([2, 2]);
    expect(shared.exits).toHaveLength(1);
    expect(shared.exits[0]).toMatchObject({
      lotId: "lot:map-buy-2",
      reason: "target",
      quantity: 1,
    });
    expect(shared.state.lots[0]).toMatchObject({
      target: 13.5,
      protection: 6,
      entryPrice: 12.6,
      versionId: "dynamic-v1",
    });
    expect(shared.state.lots[1]).toMatchObject({
      target: 12,
      protection: 6,
      entryPrice: upperGrid.price - 0.1,
      versionId: "dynamic-v1",
    });

    const lowerMapped = observe(
      createLots(tie),
      pt(6, "2026-01-13", 13.1),
      snap({ canSellByLot: [{ lotId: "lot:map-buy-2", quantity: 1 }] }),
      mappingBars,
    );
    expect(lowerMapped.state.lots.map((lot) => lot.gridIndex)).toEqual([2, 1]);
    expect(lowerMapped.state.lots[1]?.target).toBe(12);
    expect(lowerMapped.state.lots[1]?.protection).toBe(6);

    const occupied = observe(
      shared.state,
      pt(7, "2026-01-14", 10),
      snap(),
      mappingBars,
    );
    expect(occupied.buys).toHaveLength(0);
    expect(occupied.reason).toBe("grid-occupied");
  });

  it("does not invent a multi-grid fill from one gap or buy outside the bounds", () => {
    const plan = buildFixedGrid(fixedParams);
    const seeded = observe(
      createGridState(plan),
      pt(0, "2026-01-05", 12.5),
    ).state;
    const ambiguous = observe(seeded, pt(1, "2026-01-06", 10.5));
    expect(ambiguous.status).toBe("unknown");
    expect(ambiguous.reason).toBe("ambiguous-crossing");
    expect(ambiguous.buys).toHaveLength(0);
    expect(ambiguous.state.lots).toHaveLength(0);

    const outside = observe(seeded, pt(1, "2026-01-06", 13.5));
    expect(outside.status).toBe("paused");
    expect(outside.reason).toBe("outside-bounds");
    expect(outside.buys).toHaveLength(0);
  });

  it("preserves pending exits when the current price or cash is unknown", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const bought = applyGridFill(signal.state, {
      fillId: "pending-buy",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 10,
      fee: 0.1,
      time: "2026-01-06T15:00:00+08:00",
    });
    expect(bought.status).toBe("applied");
    if (bought.status !== "applied") return;
    const lotId = bought.lot!.lotId;
    const target = observe(
      bought.state,
      pt(2, "2026-01-07", 12.1),
      snap({ canSellByLot: [] }),
    );
    expect(target.state.pendingExits).toMatchObject([
      { lotId, reason: "target" },
    ]);

    const missing = observe(
      target.state,
      {
        index: 3,
        date: "2026-01-08",
        price: Number.NaN,
        asOf: "2026-01-08T15:00:00+08:00",
      },
      snap({ canSellByLot: [{ lotId, quantity: 10 }] }),
    );
    expect(missing.status).toBe("unknown");
    expect(missing.reason).toBe("invalid-point");
    expect(missing.exits[0]).toMatchObject({
      lotId,
      quantity: 10,
      reason: "target",
    });
    expect(missing.state.pendingExits).toMatchObject([
      { lotId, reason: "target" },
    ]);
    expect(missing.state.lots[0]).toMatchObject({ target: 12, protection: 8 });

    const cashUnknown = observe(
      missing.state,
      pt(4, "2026-01-09", 11.9),
      snap({
        cashAvailableBeforeGridReservations: Number.NaN,
        canSellByLot: [{ lotId, quantity: 10 }],
      }),
    );
    expect(cashUnknown.status).toBe("paused");
    expect(cashUnknown.reason).toBe("invalid-snapshot");
    expect(cashUnknown.exits[0]).toMatchObject({
      lotId,
      quantity: 10,
      reason: "target",
    });
  });

  it("keeps a cancel request as a reservation until a host termination ack", () => {
    const params = {
      ...fixedParams,
      levels: [9, 10, 11, 12],
      unitsPerGrid: 10,
      maxUnitsPerGrid: 10,
      maxTotalUnits: 14,
      stopPrice: 8,
    };
    const seeded = seedFixed(params);
    const signal = observe(seeded, pt(1, "2026-01-06", 10.5));
    expect(signal.buys).toHaveLength(1);
    const requested = observe(signal.state, pt(2, "2026-01-07", 13.5));
    expect(requested.status).toBe("paused");
    expect(requested.reason).toBe("outside-bounds");
    expect(
      requested.events.filter((event) => event.kind === "buy-cancel-requested"),
    ).toHaveLength(1);
    expect(requested.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      remainingQuantity: 10,
      cancelReason: "outside-bounds",
    });

    const repeated = observe(requested.state, pt(3, "2026-01-08", 13.5));
    expect(
      repeated.events.filter((event) => event.kind === "buy-cancel-requested"),
    ).toHaveLength(0);
    expect(repeated.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      remainingQuantity: 10,
    });

    const partial = applyGridFill(requested.state, {
      fillId: "late-partial",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 4,
      fee: 0.1,
      time: "2026-01-07T15:00:00+08:00",
    });
    expect(partial.status).toBe("applied");
    if (partial.status !== "applied") return;
    expect(partial.intent).toMatchObject({
      status: "cancel-requested",
      filledQuantity: 4,
      remainingQuantity: 6,
    });
    expect(partial.lot).toMatchObject({
      target: 12,
      protection: 8,
      entryPrice: 10.5,
      quantity: 4,
    });

    const unackedStep = observe(partial.state, pt(3, "2026-01-08", 11.5));
    const unackedNext = observe(unackedStep.state, pt(4, "2026-01-09", 10.5));
    expect(unackedNext.reason).toBe("grid-occupied");
    const unacked = observe(unackedNext.state, pt(5, "2026-01-12", 9.5));
    expect(unacked.buys).toHaveLength(0);
    expect(unacked.reason).toBe("budget-gated");

    const acked = acknowledgeGridOrderTermination(partial.state, {
      ackId: "ack-release",
      intentId: signal.buys[0]!.intentId,
      time: "2026-01-07T16:00:00+08:00",
      outcome: "cancelled",
      cumulativeFilledQuantity: 4,
      reason: "host cancelled",
    });
    expect(acked.status).toBe("applied");
    if (acked.status !== "applied") return;
    expect(acked.intent).toMatchObject({
      status: "cancelled",
      filledQuantity: 4,
      remainingQuantity: 6,
      terminationAckId: "ack-release",
    });
    expect(Object.isFrozen(acked.ack)).toBe(true);
    expect(Object.isFrozen(acked.state.terminationAcks[0])).toBe(true);
    const replayedFill = applyGridFill(acked.state, {
      fillId: "late-partial",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 4,
      fee: 0.1,
      time: "2026-01-07T15:00:00+08:00",
    });
    expect(replayedFill.status).toBe("replayed");
    expect(replayedFill.state).toBe(acked.state);

    const ackedStep = observe(acked.state, pt(3, "2026-01-08", 11.5));
    const ackedNext = observe(ackedStep.state, pt(4, "2026-01-09", 10.5));
    const released = observe(ackedNext.state, pt(5, "2026-01-12", 9.5));
    expect(released.buys).toHaveLength(1);
    expect(released.buys[0]).toMatchObject({
      gridIndex: 1,
      levelPrice: 10,
      target: 11,
    });
  });

  it("acknowledges termination idempotently and rejects bad ack facts", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const intentId = signal.buys[0]!.intentId;
    const ack = {
      ackId: "ack-1",
      intentId,
      time: "2026-01-07T15:00:00+08:00",
      outcome: "rejected" as const,
      cumulativeFilledQuantity: 0,
    };
    const applied = acknowledgeGridOrderTermination(signal.state, ack);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") return;
    expect(applied.intent).toMatchObject({
      status: "rejected",
      remainingQuantity: 10,
      terminationOutcome: "rejected",
    });
    const replay = acknowledgeGridOrderTermination(applied.state, ack);
    expect(replay.status).toBe("replayed");
    expect(replay.state).toBe(applied.state);

    expect(() =>
      acknowledgeGridOrderTermination(applied.state, {
        ...ack,
        outcome: "cancelled",
      }),
    ).toThrow("ackId 冲突");
    expect(() =>
      acknowledgeGridOrderTermination(signal.state, {
        ...ack,
        ackId: "ack-unknown",
        intentId: "buy:unknown",
      }),
    ).toThrow("未知买入意图");
    expect(() =>
      acknowledgeGridOrderTermination(signal.state, {
        ...ack,
        ackId: "ack-negative",
        cumulativeFilledQuantity: -1,
      }),
    ).toThrow("累计成交数量无效");
    expect(() =>
      acknowledgeGridOrderTermination(signal.state, {
        ...ack,
        ackId: "ack-mismatch",
        cumulativeFilledQuantity: 1,
      }),
    ).toThrow("累计成交数量与已记录事实不一致");
    expect(() =>
      acknowledgeGridOrderTermination(signal.state, {
        ...ack,
        ackId: "ack-backdated",
        time: "2026-01-04T15:00:00+08:00",
      }),
    ).toThrow("早于已处理事实");
    expect(() =>
      acknowledgeGridOrderTermination(applied.state, {
        ...ack,
        ackId: "ack-second",
      }),
    ).toThrow("已终止");

    const full = applyGridFill(signal.state, {
      fillId: "ack-full-fill",
      side: "buy",
      intentId,
      price: 10.5,
      quantity: 10,
      fee: 0,
      time: "2026-01-07T15:00:00+08:00",
    });
    expect(full.status).toBe("applied");
    if (full.status !== "applied") return;
    expect(() =>
      acknowledgeGridOrderTermination(full.state, {
        ...ack,
        ackId: "ack-full",
        cumulativeFilledQuantity: 10,
      }),
    ).toThrow("已全部成交");
  });

  it("requests cancellation on a due-day missing price without releasing reservation", () => {
    const bars = [
      bar("2026-01-05", 10),
      bar("2026-01-06", 11),
      bar("2026-01-07", 12),
      bar("2026-01-08", 13),
      bar("2026-01-09", 11.5),
      bar("2026-01-12", 11.5),
    ];
    const built = rebuildDynamicGrid({
      params: dynamicParams,
      bars,
      index: 3,
    });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    let state = createGridState(built.plan);
    state = observe(state, pt(3, "2026-01-08", 13), snap(), bars).state;
    const signal = observe(state, pt(4, "2026-01-09", 11.5), snap(), bars);
    expect(signal.buys).toHaveLength(1);
    const due = observe(
      signal.state,
      {
        index: 5,
        date: "2026-01-12",
        price: Number.NaN,
        asOf: "2026-01-12T15:00:00+08:00",
      },
      snap(),
      bars,
    );
    expect(due.status).toBe("unknown");
    expect(due.reason).toBe("invalid-point");
    expect(due.state.rebuildPause).toMatchObject({
      status: "unknown",
      reason: "invalid-point",
    });
    expect(due.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      remainingQuantity: 1,
    });
    expect(
      due.events.filter((event) => event.kind === "buy-cancel-requested"),
    ).toHaveLength(1);

    const late = applyGridFill(due.state, {
      fillId: "missing-price-late",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 12,
      quantity: 1,
      fee: 0,
      time: "2026-01-12T15:00:00+08:00",
    });
    expect(late.status).toBe("applied");
    if (late.status !== "applied") return;
    expect(late.lot).toMatchObject({
      quantity: 1,
      target: 13.5,
      protection: 9,
    });
  });

  it("gives late fills after terminal global exits without losing old inventory", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const oldPartial = applyGridFill(signal.state, {
      fillId: "terminal-old",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.5,
      quantity: 4,
      fee: 0.1,
      time: "2026-01-06T15:00:00+08:00",
    });
    expect(oldPartial.status).toBe("applied");
    if (oldPartial.status !== "applied") return;
    const oldLotId = oldPartial.lot!.lotId;
    const pending = observe(
      oldPartial.state,
      pt(2, "2026-01-07", 12.1),
      snap({ canSellByLot: [] }),
    );
    expect(pending.state.pendingExits).toMatchObject([
      { lotId: oldLotId, reason: "target" },
    ]);
    const stopped = observe(pending.state, pt(3, "2026-01-08", 8));
    expect(stopped.status).toBe("paused");
    expect(stopped.reason).toBe("global-stop");
    expect(stopped.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      remainingQuantity: 6,
    });
    expect(stopped.state.pendingExits).toMatchObject([
      { lotId: oldLotId, reason: "global-stop" },
    ]);

    const late = applyGridFill(stopped.state, {
      fillId: "terminal-late",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 8,
      quantity: 2,
      fee: 0.1,
      time: "2026-01-08T15:00:00+08:00",
    });
    expect(late.status).toBe("applied");
    if (late.status !== "applied") return;
    expect(late.lot).toMatchObject({
      target: 12,
      protection: 8,
      entryPrice: 8,
      quantity: 2,
    });
    expect(
      late.state.lots.map((lot) => ({
        lotId: lot.lotId,
        quantity: lot.quantity,
        target: lot.target,
      })),
    ).toEqual([
      { lotId: oldLotId, quantity: 4, target: 12 },
      { lotId: late.lot!.lotId, quantity: 2, target: 12 },
    ]);
    expect(late.state.pendingExits).toHaveLength(2);
    expect(late.state.pendingExits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lotId: oldLotId,
          reason: "global-stop",
        }),
        expect.objectContaining({
          lotId: late.lot!.lotId,
          reason: "global-stop",
        }),
      ]),
    );

    const exit = observe(
      late.state,
      pt(4, "2026-01-09", 11.5),
      snap({
        canSellByLot: [
          { lotId: oldLotId, quantity: 4 },
          { lotId: late.lot!.lotId, quantity: 2 },
        ],
      }),
    );
    expect(exit.exits).toHaveLength(2);
    expect(exit.exits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lotId: oldLotId,
          quantity: 4,
          reason: "global-stop",
        }),
        expect.objectContaining({
          lotId: late.lot!.lotId,
          quantity: 2,
          reason: "global-stop",
        }),
      ]),
    );
  });

  it("maps an old-generation late fill to the current buy grid and keeps Qmax", () => {
    const params = {
      ...dynamicParams,
      halfLevels: 2,
      rebuildPeriod: 3,
      stopPrice: 6,
      maxUnitsPerGrid: 1,
      maxTotalUnits: 1,
    };
    const bars = [
      bar("2026-01-05", 10),
      bar("2026-01-06", 11),
      bar("2026-01-07", 12),
      bar("2026-01-08", 13),
      bar("2026-01-09", 11.5),
      bar("2026-01-12", 13.1),
      bar("2026-01-13", 13.2),
      bar("2026-01-14", 11.5),
      bar("2026-01-15", 10.5),
    ];
    const built = rebuildDynamicGrid({ params, bars, index: 3 });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    let state = createGridState(built.plan);
    state = observe(state, pt(3, "2026-01-08", 13), snap(), bars).state;
    const signal = observe(state, pt(4, "2026-01-09", 11.5), snap(), bars);
    expect(signal.buys).toHaveLength(1);
    expect(signal.buys[0]).toMatchObject({
      gridIndex: 2,
      levelPrice: 12,
      target: 13.5,
    });
    const nonDue = observe(
      signal.state,
      pt(5, "2026-01-12", 13.1),
      snap(),
      bars,
    );
    expect(nonDue.status).toBe("ready");
    expect(nonDue.reason).toBe("not-due");
    const rebuilt = observe(
      nonDue.state,
      pt(6, "2026-01-13", 13.2),
      snap(),
      bars,
    );
    expect(rebuilt.reason).toBe("rebuilt");
    expect(rebuilt.state.generation).toBe(2);
    expect(rebuilt.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      generation: 1,
      gridIndex: 2,
      levelPrice: 12,
      remainingQuantity: 1,
    });
    expect(rebuilt.state.plan.buyLevels[2]?.price).toBeCloseTo(12.6, 8);

    const occupied = observe(
      rebuilt.state,
      pt(7, "2026-01-14", 11.5),
      snap(),
      bars,
    );
    expect(occupied.reason).toBe("grid-occupied");
    const gated = observe(
      occupied.state,
      pt(8, "2026-01-15", 10.5),
      snap(),
      bars,
    );
    expect(gated.buys).toHaveLength(0);
    expect(gated.reason).toBe("budget-gated");

    const late = applyGridFill(gated.state, {
      fillId: "old-generation-late",
      side: "buy",
      intentId: signal.buys[0]!.intentId,
      price: 10.7,
      quantity: 1,
      fee: 0,
      time: "2026-01-15T15:00:00+08:00",
    });
    expect(late.status).toBe("applied");
    if (late.status !== "applied") return;
    expect(late.intent).toMatchObject({
      status: "filled",
      filledQuantity: 1,
      remainingQuantity: 0,
      gridIndex: 2,
      levelPrice: 12,
    });
    expect(late.lot).toMatchObject({
      gridIndex: 1,
      originalGridIndex: 2,
      originalGridPrice: 12,
      target: 13.5,
      protection: 6,
      entryPrice: 10.7,
    });
  });

  it("requests cancellation on unknown cash without releasing the reservation", () => {
    const signal = observe(seedFixed(), pt(1, "2026-01-06", 10.5));
    const paused = observe(
      signal.state,
      pt(2, "2026-01-07", 11.5),
      snap({ cashAvailableBeforeGridReservations: Number.NaN }),
    );
    expect(paused.status).toBe("paused");
    expect(paused.reason).toBe("invalid-snapshot");
    expect(
      paused.events.filter((event) => event.kind === "buy-cancel-requested"),
    ).toHaveLength(1);
    expect(paused.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      remainingQuantity: 10,
    });

    const repeated = observe(
      paused.state,
      pt(3, "2026-01-08", 11.5),
      snap({ cashAvailableBeforeGridReservations: Number.NaN }),
    );
    expect(
      repeated.events.filter((event) => event.kind === "buy-cancel-requested"),
    ).toHaveLength(0);
    expect(repeated.state.buyIntents[0]).toMatchObject({
      status: "cancel-requested",
      remainingQuantity: 10,
    });
  });

  it("persists a failed data gate until the next successful fixed-K rebuild", () => {
    const bars = [
      bar("2026-01-05", 10),
      bar("2026-01-06", 11),
      bar("2026-01-07", 12),
      bar("2026-01-08", 13),
      bar("2026-01-09", 13.1),
      bar("2026-01-12", 11.5),
      bar("2026-01-13", 13),
      bar("2026-01-14", 13.2),
    ];
    const built = rebuildDynamicGrid({
      params: dynamicParams,
      bars,
      index: 3,
    });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    let state = createGridState(built.plan);
    state = observe(state, pt(3, "2026-01-08", 13), snap(), bars).state;
    state = observe(state, pt(4, "2026-01-09", 13.1), snap(), bars).state;
    const missing = observe(state, pt(5, "2026-01-12", 11.5), snap());
    expect(missing.status).toBe("paused");
    expect(missing.reason).toBe("missing-bars");
    expect(missing.state.rebuildPause).toMatchObject({
      status: "paused",
      reason: "missing-bars",
    });

    const nonDue = observe(
      missing.state,
      pt(6, "2026-01-13", 13),
      snap(),
      bars,
    );
    expect(nonDue.status).toBe("paused");
    expect(nonDue.reason).toBe("missing-bars");
    expect(nonDue.state.plan).toBe(built.plan);

    const due = observe(nonDue.state, pt(7, "2026-01-14", 13.2), snap(), bars);
    expect(due.reason).toBe("rebuilt");
    expect(due.buys).toHaveLength(0);
    expect(due.state.rebuildPause).toBeNull();
    expect(due.state.scheduleOriginIndex).toBe(3);
  });

  it("handles a missing history slot as UNKNOWN instead of throwing", () => {
    const sparse = [...risingBars];
    sparse[2] = undefined as unknown as Bar;
    expect(() =>
      rebuildDynamicGrid({ params: dynamicParams, bars: sparse, index: 3 }),
    ).not.toThrow();
    expect(
      rebuildDynamicGrid({ params: dynamicParams, bars: sparse, index: 3 }),
    ).toMatchObject({ status: "unknown", reason: "insufficient-history" });

    const missingCurrent = [...risingBars];
    missingCurrent[3] = undefined as unknown as Bar;
    expect(() =>
      rebuildDynamicGrid({
        params: dynamicParams,
        bars: missingCurrent,
        index: 3,
      }),
    ).not.toThrow();
    expect(
      rebuildDynamicGrid({
        params: dynamicParams,
        bars: missingCurrent,
        index: 3,
      }),
    ).toMatchObject({ status: "unknown", reason: "insufficient-history" });
  });

  it("is prefix-causal and does not mutate the input state, bars or snapshot", () => {
    const scheduleBars = [
      bar("2026-01-05", 10),
      bar("2026-01-06", 11),
      bar("2026-01-07", 12),
      bar("2026-01-08", 13),
      bar("2026-01-09", 11.5),
      bar("2026-01-12", 11),
      bar("2026-01-13", 11.2),
      bar("2026-01-14", 13.2),
      bar("2026-01-15", 13.3),
    ];
    const run = (prefixOnly: boolean) => {
      const built = rebuildDynamicGrid({
        params: dynamicParams,
        bars: scheduleBars.slice(0, 4),
        index: 3,
      });
      expect(built.status).toBe("ready");
      if (built.status !== "ready") throw new Error("build");
      let state = createGridState(built.plan);
      const points = [
        pt(3, "2026-01-08", 13),
        pt(4, "2026-01-09", 11.5),
        pt(5, "2026-01-12", 11),
        pt(6, "2026-01-13", 11.2),
        pt(7, "2026-01-14", 13.2),
        pt(8, "2026-01-15", 13.3),
      ];
      for (const point of points) {
        const bars = prefixOnly
          ? scheduleBars.slice(0, point.index + 1)
          : scheduleBars;
        const result = observe(state, point, snap(), bars);
        state = result.state;
        if (point.index === 4) {
          const fill = applyGridFill(state, {
            fillId: "prefix-buy",
            side: "buy",
            intentId: result.buys[0]!.intentId,
            price: 11.5,
            quantity: 1,
            fee: 0,
            time: "2026-01-09T15:00:00+08:00",
          });
          expect(fill.status).toBe("applied");
          if (fill.status !== "applied") throw new Error("fill");
          state = fill.state;
        }
      }
      return state;
    };
    const full = run(false);
    const prefix = run(true);
    expect(prefix).toEqual(full);
    expect(Object.isFrozen(full)).toBe(true);

    const frozenBars = Object.freeze(
      scheduleBars.map((item) => Object.freeze({ ...item })),
    );
    const frozenSnapshot = Object.freeze({
      cashAvailableBeforeGridReservations: 100000,
      totalEquity: 100000,
      canSellByLot: Object.freeze([] as { lotId: string; quantity: number }[]),
    });
    const seed = observe(
      createGridState(buildFixedGrid(fixedParams)),
      pt(0, "2026-01-05", 11.5),
      frozenSnapshot,
    );
    expect(() =>
      observe(
        seed.state,
        pt(1, "2026-01-06", 10.5),
        frozenSnapshot,
        frozenBars,
      ),
    ).not.toThrow();
    expect(seed.state.lots).toHaveLength(0);
  });
});
