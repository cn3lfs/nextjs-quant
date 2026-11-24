import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as tdx from "tstdx/local";
import { StudioResultView } from "~/components/research/studio/studio-result-view";
import type { ParsedFill } from "~/lib/research/evidence/delivery-import";
import type { TradeReviewRef } from "~/lib/chart/trade-review-ref";
import { loadChartTradeReview } from "~/server/charts/chart-trade-review";
import { put } from "~/server/db";
import * as configuration from "~/server/infra/settings";
import * as accountWorkspace from "~/server/portfolio/account-workspace-service";
import * as diagnose from "~/server/research/diagnose/archive";
import { emptyStudioResult } from "~/server/research/studio/result-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  tradeChartHref,
  parseTradeReviewRef,
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

it("round-trips a full-source review while preserving the legacy chart URL", () => {
  const legacy = {
    symbol,
    at: "2026-03-05T07:00:00Z",
    diagnose: "lab-old",
    cell: "0",
    scenario: "strict",
  };
  const href = tradeChartHref(legacy);
  expect(href).toBe(
    "/scan?symbol=sh600000&period=day&adjustment=none&at=2026-03-05&diagnose=lab-old&cell=0&scenario=strict",
  );
  expect(parseTradeReviewRef(href.split("?")[1]!)).toBeNull();

  const ref = {
    source: "real-delivery",
    refId: "批次 42",
    label: "实盘交割",
    symbol,
    accountId: "A&B",
    unitKey: "0:strict",
    backHref: "/accounts?tab=trades&trade=delivery%3A42&batch=batch-1",
  } as const;
  const reviewSearch = tradeChartHref({ ...legacy, review: ref }).split(
    "?",
  )[1]!;
  expect(parseTradeReviewRef(reviewSearch)).toEqual(ref);
  const unsafe = new URLSearchParams(reviewSearch);
  unsafe.set("reviewBack", "//other.example");
  expect(parseTradeReviewRef(unsafe)).toBeNull();
});

describe("whole-source trade review", () => {
  const calendar = ["2026-03-02", "2026-03-03", "2026-03-04"];
  const daily = [
    { ...bar(calendar[0]!), high: 11.5, low: 9.5 },
    { ...bar(calendar[1]!), high: 13, low: 8 },
    { ...bar(calendar[2]!), open: 11, high: 12, low: 10, close: 11 },
  ];
  const filled = [
    {
      symbol,
      strategyId: "s",
      date: calendar[0]!,
      side: "buy",
      price: 10,
      quantity: 200,
      holdingAfter: 200,
      fee: 5,
      orderId: 1,
    },
    {
      symbol,
      strategyId: "s",
      date: calendar[1]!,
      side: "sell",
      price: 11,
      quantity: 100,
      holdingAfter: 100,
      fee: 5,
      orderId: 2,
    },
    {
      symbol,
      strategyId: "s",
      date: calendar[2]!,
      side: "sell",
      price: 12,
      quantity: 100,
      holdingAfter: 0,
      fee: 5,
      orderId: 3,
    },
  ] as const;
  const reference = (
    source: TradeReviewRef["source"],
    refId: string,
  ): TradeReviewRef => ({
    source,
    refId,
    symbol,
    label: "证据",
    backHref: "/lab/backtest",
  });
  const snapshot = (quotes: Bar[]) => ({
    id: "fixture",
    symbol,
    period: "day" as const,
    source: "fixture",
    adjustment: "none" as const,
    createdAt: 0,
    hash: "fixture",
    bars: quotes,
  });

  beforeEach(() => {
    const config = configuration.settings();
    vi.spyOn(configuration, "settings").mockReturnValue({
      ...config,
      calendar,
    });
    vi.spyOn(tdx, "readSnapshot").mockResolvedValue(snapshot(daily));
    vi.spyOn(tdx, "readGbbq").mockResolvedValue({
      events: new Map(),
      path: "fixture",
      modified: 0,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["alpha-backtest", "etf-rotation"] as const)(
    "links to the exact completed %s ledger from the Studio trade row",
    async (source) => {
      const id = `fixture-${source}`;
      const common = { fills: filled, orders: [{ id: 3, trigger: "stop" }] };
      const input =
        source === "alpha-backtest"
          ? { mode: source }
          : { type: "etf-rotation-trade-review" };
      const result =
        source === "alpha-backtest"
          ? { portfolio: { ...common, corporateActions: [] } }
          : {
              ...common,
              actions: [],
              calendar,
              daily: [{ symbol, bars: daily }],
            };
      put("job", id, {
        id,
        type: "backtest",
        status: "completed",
        input,
        result,
      });
      const template = source === "alpha-backtest" ? "alpha-formula" : source;
      const html = renderToStaticMarkup(
        createElement(StudioResultView, {
          result: {
            ...emptyStudioResult(template),
            jobId: id,
            tradeExcursions: [
              {
                id: "round-1",
                symbol,
                openedAt: calendar[0]!,
                closedAt: calendar[2]!,
                entryAverage: 10,
                entryAverageReason: null,
                realizedNetReturn: 285 / 2005,
                realizedNetReturnReason: null,
                days: 3,
                daysReason: null,
                mae: -0.2,
                mfe: 0.3,
                reason: null,
              },
            ],
          },
        }),
      );
      const search = html
        .match(/href="\/scan\?([^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&");
      expect(search).toBeDefined();
      const ref = parseTradeReviewRef(search!);
      expect(ref).toMatchObject({
        source,
        refId: id,
        symbol,
        backHref: `/lab/backtest?view=result&run=${id}`,
      });
      expect(new URLSearchParams(search).get("at")).toBe(calendar[2]);
      const review = await loadChartTradeReview(ref!);
      expect(review.fills.at(-1)?.trigger).toBe("stop");
      expect(review.boxes).toHaveLength(1);
      expect(review.boxes[0]).toMatchObject({
        entryPrice: 10,
        exitPrice: 11.5,
        pnlAmount: 285,
        holdingDays: 3,
        maeDate: calendar[1],
        maePrice: 8,
        mfeDate: calendar[1],
        mfePrice: 13,
        excursionReason: null,
        tradeIds: review.fills.map((fill) => fill.tradeId),
      });
      expect(review.boxes[0]!.maePct).toBeCloseTo(-20);
      expect(review.boxes[0]!.mfePct).toBeCloseTo(30);
      expect(review.boxes[0]!.pnlPct).toBeCloseTo((285 / 2005) * 100);
    },
  );

  it.each([
    { side: "MAE", low: 11, high: 13 },
    { side: "MFE", low: 7, high: 9 },
  ])(
    "omits the $side ruler when its excursion is zero",
    async ({ side, low, high }) => {
      const id = `fixture-zero-${side}`;
      put("job", id, {
        id,
        type: "backtest",
        status: "completed",
        input: { type: "etf-rotation-trade-review" },
        result: {
          fills: filled,
          orders: [],
          actions: [],
          calendar,
          daily: [
            {
              symbol,
              bars: daily.map((bar) => ({
                ...bar,
                low,
                high,
                open: low,
                close: high,
              })),
            },
          ],
        },
      });
      const { boxes } = await loadChartTradeReview(
        reference("etf-rotation", id),
      );
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.excursionReason).toBeNull();
      if (side === "MAE") {
        expect(boxes[0]).toMatchObject({
          maePct: 0,
          maeDate: null,
          maePrice: null,
          mfePrice: high,
        });
        expect(boxes[0]!.mfePct).toBeCloseTo(30);
      } else {
        expect(boxes[0]).toMatchObject({
          mfePct: 0,
          mfeDate: null,
          mfePrice: null,
          maePrice: low,
        });
        expect(boxes[0]!.maePct).toBeCloseTo(-30);
      }
    },
  );

  it("keeps older Lab samples as marks without fabricating a closed round", async () => {
    const archive = vi.spyOn(diagnose, "readDiagnoseArchive");
    const scenario = {
      scenarioId: "strict",
      sampleFills: filled,
      sampleOrders: [{ id: 3, trigger: "stop" }],
      counts: { fills: 4 },
    };
    const detail = (row: object) =>
      ({
        cells: [{ symbols: [symbol], scenarios: [row] }],
      }) as unknown as NonNullable<
        Awaited<ReturnType<typeof diagnose.readDiagnoseArchive>>
      >;
    archive.mockResolvedValueOnce(detail(scenario));
    const ref = {
      ...reference("lab-diagnose", "lab-fixture"),
      unitKey: "0:strict",
    };
    const partial = await loadChartTradeReview(ref);
    expect(partial.fills).toHaveLength(3);
    expect(partial.boxes).toEqual([]);
    expect(partial.warnings).toContain(
      "归档只包含样本成交，无法确认完整持仓回合",
    );
    archive.mockResolvedValueOnce(
      detail({ ...scenario, counts: { fills: 3 }, fullFills: filled }),
    );
    const complete = await loadChartTradeReview(ref);
    expect(complete.boxes[0]?.pnlAmount).toBe(285);
    expect(complete.fills[2]?.trigger).toBe("stop");
  });

  it("keeps paper strategy trades and ignores another symbol's corporate action", async () => {
    vi.spyOn(accountWorkspace, "loadAccountBook").mockResolvedValue({
      bars: { [symbol]: daily },
      context: { evidence: () => ({ events: [] }) },
      facts: {
        paper: [
          {
            account: { id: "paper-first", market: "cn-equity" },
            state: {
              result: {
                fills: filled,
                corporateActions: [
                  {
                    symbol: "sh600001",
                    strategyId: "s",
                    cash: 900,
                    date: calendar[1],
                  },
                ],
              },
            },
          },
        ],
      },
    } as unknown as accountWorkspace.AccountBook);
    const review = await loadChartTradeReview(
      reference("paper-account", "paper-first"),
    );
    expect(review.boxes[0]).toMatchObject({
      pnlAmount: 285,
      excursionReason: null,
      tradeIds: [
        "paper:paper-first:0",
        "paper:paper-first:1",
        "paper:paper-first:2",
      ],
    });
  });

  it("pairs real fills across batches and withholds excursions for a missing daily bar", async () => {
    const rows = filled.map(
      (
        fill,
        index,
      ): ParsedFill & { id: string; account: string; batchId: string } => ({
        id: `fill-${index}`,
        account: "cash",
        batchId: index === 0 ? "buy-batch" : "sell-batch",
        kind: fill.side,
        rowIndex: index,
        tradeDate: fill.date,
        tradeTime: null,
        code: "600000",
        symbol,
        name: null,
        instrument: "stock",
        price: fill.price,
        quantity: fill.quantity,
        amount: fill.price * fill.quantity,
        fees: {
          total: fill.fee,
          commission: fill.fee,
          stampTax: null,
          transferFee: null,
          otherFee: null,
        },
        netAmount: null,
        balanceShares: null,
        balanceCash: null,
        orderId: null,
        dealId: null,
        businessFlag: null,
        summary: "",
        fingerprintSource: `fixture-${index}`,
        anomalies: [],
      }),
    );
    const loadBook = vi
      .spyOn(accountWorkspace, "loadAccountBook")
      .mockResolvedValue({
        bars: { [symbol]: [daily[0], daily[2]] },
        context: { evidence: () => ({ events: [] }) },
        facts: {
          fills: rows,
          cashFlows: [],
          batches: [
            { id: "buy-batch", account: "cash" },
            { id: "sell-batch", account: "cash" },
          ],
        },
      } as unknown as accountWorkspace.AccountBook);
    const review = await loadChartTradeReview({
      ...reference("real-delivery", "sell-batch"),
      accountId: "cash",
    });
    expect(loadBook).toHaveBeenCalledExactlyOnceWith(
      undefined,
      undefined,
      undefined,
      { localOnly: true },
    );
    expect(review.fills).toHaveLength(3);
    expect(review.fills[0]!.backHref).toContain("batch=buy-batch");
    expect(review.boxes[0]).toMatchObject({
      pnlAmount: 285,
      maePct: null,
      maeDate: null,
      maePrice: null,
      mfePct: null,
      mfeDate: null,
      mfePrice: null,
      excursionReason: "缺少持仓日日线：2026-03-03",
      backHref:
        "/accounts?tab=trades&symbol=sh600000&trade=delivery%3Afill-2&batch=sell-batch",
    });
    await expect(
      loadChartTradeReview({ ...review.ref, refId: "revoked-batch" }),
    ).rejects.toThrow("批次不可用");
  });
});
