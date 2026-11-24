import { describe, expect, it, vi } from "vitest";
import { observeRangeGesture } from "~/components/market/market-chart-instance";
import { updateMarketBase } from "~/components/market/market-chart-base";
import type { MarketChartState } from "~/components/market/market-chart-state";
import {
  readRpsTableState,
  recoverRpsPage,
} from "~/components/market/stock-rps-ranking";
import { tradeChartMarkers } from "~/lib/chart/chart-data";
import {
  TRADE_MARKS_DAILY_ONLY,
  tradeMarkFocusRange,
  tradeMarks,
  type TradeMarkFill,
} from "~/lib/chart/chart-trade-marks";
import {
  rememberChartRange,
  restoreChartRange,
} from "~/lib/chart/chart-viewport";
import type { Bar } from "~/lib/domain";
import { useMarketSession } from "~/lib/stores/market-session";

const bar = (date: string): Bar => ({
  date,
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  amount: 1000,
  volume: 100,
});
const bars = ["2026-03-02", "2026-03-04", "2026-03-05"].map(bar);
const symbol = "sh600000";
const fills: TradeMarkFill[] = [
  { symbol: " SH600000 ", date: "2026-03-02T01:30:00Z", side: "buy" },
  { symbol, date: "2026-03-03", side: "buy" },
  { symbol, date: "2026-03-03", side: "sell", trigger: "stop" },
  { symbol, date: "2026-03-04", side: "sell", trigger: "stop", price: 9 },
  { symbol, date: "2026-03-05", side: "sell" },
  { symbol: "sz000001", date: "2026-03-04", side: "buy" },
];

describe("trade mark projection", () => {
  it.each(["1d", "daily", "day"])(
    "projects exact %s fills and counts distinct missing fills",
    (period) => {
      const result = tradeMarks({ symbol, bars, period, fills });
      expect(result).toEqual({
        marks: [
          {
            date: bars[0]!.date,
            side: "buy",
            trigger: undefined,
            shape: "arrowUp",
            position: "belowBar",
            text: "买",
            color: expect.any(String),
          },
          {
            date: bars[1]!.date,
            side: "sell",
            trigger: "stop",
            shape: "arrowDown",
            position: "aboveBar",
            text: "止损",
            color: expect.any(String),
          },
          {
            date: bars[2]!.date,
            side: "sell",
            trigger: undefined,
            shape: "arrowDown",
            position: "aboveBar",
            text: "卖",
            color: expect.any(String),
          },
        ],
        matchedCount: 3,
        unknownTriggerCount: 1,
        droppedCount: 2,
        droppedDates: ["2026-03-03"],
        hiddenReason: null,
        fillCount: 5,
      });
      expect(tradeChartMarkers(result.marks, bars[1], "day")).toEqual([
        {
          time: bars[1]!.date,
          position: "aboveBar",
          shape: "arrowDown",
          color: expect.any(String),
          text: "止损",
        },
        {
          time: bars[2]!.date,
          position: "aboveBar",
          shape: "arrowDown",
          color: expect.any(String),
          text: "卖",
        },
      ]);
    },
  );

  it.each(["week", "month", "5m"])(
    "hides %s even if the exact bar date exists",
    (period) => {
      expect(tradeMarks({ symbol, bars, period, fills })).toEqual({
        marks: [],
        matchedCount: 0,
        unknownTriggerCount: 1,
        droppedCount: 0,
        droppedDates: [],
        hiddenReason: TRADE_MARKS_DAILY_ONLY,
        fillCount: 5,
      });
      expect(
        tradeChartMarkers(
          tradeMarks({ symbol, bars, period: "day", fills }).marks,
          bars[0],
          period as "week" | "month" | "5m",
        ),
      ).toEqual([]);
    },
  );

  it("joins a diagnose stop order to its real execution date", () => {
    const identity = {
      symbol,
      strategyId: "dual-ma",
      sleeve: "main",
      side: "sell" as const,
      signalAt: "2026-03-03",
    };
    const result = tradeMarks({
      symbol,
      bars,
      period: "1d",
      scenario: {
        sampleFills: [
          {
            ...identity,
            orderId: 9,
            date: "2026-03-04",
            price: 9,
            quantity: 100,
            fee: 1,
            cashAfter: 1000,
            holdingAfter: 0,
          },
        ],
        sampleOrders: [
          {
            ...identity,
            id: 9,
            due: "2026-03-04",
            status: "filled",
            reason: null,
            attempts: 1,
            trigger: "stop",
          },
        ],
      },
    });
    expect(result.marks).toMatchObject([{ date: "2026-03-04", text: "止损" }]);
    expect(result.unknownTriggerCount).toBe(0);
  });

  it("uses the fill trigger beyond the order sample and discloses legacy unknown sells", () => {
    const fill = {
      symbol,
      strategyId: "dual-ma",
      sleeve: "main",
      side: "sell" as const,
      signalAt: bars[0]!.date,
      date: bars[1]!.date,
      orderId: 51,
      quantity: 100,
      price: 9,
      fee: 1,
      cashAfter: 1000,
      holdingAfter: 0,
    };
    const projection = tradeMarks({
      symbol,
      bars,
      period: "day",
      scenario: {
        sampleOrders: [],
        sampleFills: [
          { ...fill, trigger: "stop" },
          { ...fill, orderId: 52 },
        ],
      },
    });
    expect(projection.marks.map((mark) => mark.text)).toEqual(["止损", "卖"]);
    expect(projection.unknownTriggerCount).toBe(1);
  });
});

it.each(["mousemove", "touchmove", "wheel"] as const)(
  "only releases a temporary viewport when %s changes a horizontal endpoint",
  (type) => {
    const target = new EventTarget();
    const release = vi.fn();
    let range = { from: 20, to: 60 };
    let after = range;
    const read = vi.fn(() => range);
    const remove = observeRangeGesture(target, type, read, release);
    const gesture = () => {
      read.mockReturnValueOnce(range).mockReturnValueOnce(after);
      target.dispatchEvent(new Event(type));
      range = after;
    };
    range = after = { from: 60, to: 180 }; // programmatic at= focus
    gesture(); // unchanged horizontal range
    after = { from: 60.0000001, to: 180 };
    gesture();
    expect(release).not.toHaveBeenCalled();
    after = { ...range, to: 170 };
    gesture();
    expect(release).toHaveBeenCalledTimes(1);
    remove();
    after = { ...range, from: 65 };
    gesture();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it("keeps a matching weekly or monthly focus pending until the daily series arrives", () => {
  const consume = vi.fn(() => true);
  const setRange = vi.fn();
  const state = {
    chart: { timeScale: () => ({ setVisibleLogicalRange: setRange }) },
    candles: { setData: vi.fn() },
    markers: { setMarkers: vi.fn() },
    baseLines: [],
    compareLines: [],
    temporaryRange: false,
  } as unknown as MarketChartState;
  for (const period of ["week", "month", "day"] as const) {
    updateMarketBase(state, {
      bars: [...bars],
      period,
      breakoutIndex: 0,
      viewport: { current: null },
      showCzsc: false,
      showBreakout: false,
      setHistoryStart: vi.fn(),
      focusAt: { date: bars[1]!.date, consume },
    });
    expect(consume).toHaveBeenCalledTimes(period === "day" ? 1 : 0);
    expect(state.temporaryRange).toBe(period === "day");
  }
});

it("centres once on the exact bar while preserving the saved viewport", () => {
  const history = Array.from({ length: 360 }, (_, i) =>
    bar(new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)),
  );
  const key = "trade-focus-test";
  rememberChartRange(key, history, 220, { from: 12, to: 30 });
  const saved = restoreChartRange(key, history);
  const session = useMarketSession.getState();
  const at = history[159]!.date;
  try {
    session.setTradeContext({ symbol, at });
    const token = useMarketSession.getState().tradeContext!.focusToken;
    const focus = tradeMarkFocusRange(history, at);
    expect(focus).toEqual({
      index: 159,
      start: 39,
      range: { from: 60, to: 180 },
    });
    expect(tradeMarkFocusRange(history, "2023-01-02")).toBeNull();
    expect(session.consumeTradeFocus(token)).toBe(true);
    expect(session.consumeTradeFocus(token)).toBe(false);
    expect(restoreChartRange(key, history)).toEqual(saved);
    session.clearTradeContext();
    session.setTradeContext({ symbol, at });
    expect(session.consumeTradeFocus(token)).toBe(false);
  } finally {
    session.clearTradeContext();
  }
});

it("restores RPS columns and a bounded one-based start page", () => {
  expect(
    readRpsTableState("tab=rps&rpsCols=10,20,10,999&page=2", 50, 120),
  ).toEqual({ columns: [10, 20, 50, 120], page: 2 });
  expect(readRpsTableState("rpsCols=120&page=2.5", 50, undefined)).toEqual({
    columns: [50, 120],
    page: 1,
  });
  expect(readRpsTableState("page=1002", 50, undefined).page).toBe(1);
});

it("recovers a stale RPS page to the last nonempty page after the result set shrinks", () => {
  expect(recoverRpsPage(8, 0, 41)).toBe(3);
  expect(recoverRpsPage(8, 0, 40)).toBe(2);
  expect(recoverRpsPage(8, 0, 1)).toBe(1);
  expect(recoverRpsPage(8, 0, 0)).toBeNull();
  expect(recoverRpsPage(3, 1, 41)).toBeNull();
  expect(recoverRpsPage(1, 0, 1)).toBeNull();
});
