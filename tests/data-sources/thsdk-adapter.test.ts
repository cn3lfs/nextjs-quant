import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  thsdkCallAuction,
  thsdkDailyCapitalFlows,
  thsdkIntraday,
  thsdkKlines,
  thsdkOrderBooks,
  thsdkPopularityRank,
  thsdkPriceVolumeLevels,
  type ThsdkInvoker,
} from "../../src/server/data-sources/thsdk/thsdk-adapter";
import { ThsdkError } from "../../src/server/data-sources/thsdk/thsdk-contract";

// Market-data fields only, from the Wave 0 probe and sample-verification.md.
// Quotes altered to exercise missing values and malformed bars are marked below.
const maotai = { market: "USHA", code: "600519" };
const tonghuashun = { market: "USZA", code: "300033" };
const csi300Etf = { market: "USHJ", code: "510300" };
const shanghaiComposite = { market: "USHI", code: "1A0001" };
const date = "2026-11-19";
const maotaiDay = {
  time: 20261119,
  open: 1442,
  high: 1464.99,
  low: 1432.1,
  close: 1460.21,
  volume: 4269153,
  turnover: 6192213100,
};
const etfDay = {
  time: 20261119,
  open: 4.068,
  high: 4.075,
  low: 4.036,
  close: 4.054,
  volume: 2790941700,
  turnover: 11293465500,
};

function recordingInvoker() {
  const mock = vi.fn<ThsdkInvoker>();
  const invoke: ThsdkInvoker = async <T>(...args: Parameters<ThsdkInvoker>) =>
    (await mock(...args)) as T;
  return { mock, invoke };
}

describe("THSDK Wave 2 market data", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T16:00:00+08:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("maps stock, ETF, and index requests to distinct THSDK identities and retains ETF precision", async () => {
    const { mock, invoke } = recordingInvoker();
    mock
      .mockResolvedValueOnce([maotaiDay])
      .mockResolvedValueOnce([etfDay])
      .mockResolvedValueOnce([
        // Synthetic index bar with the same native field layout.
        { ...maotaiDay, open: 4000, high: 4100, low: 3900, close: 4050 },
      ]);
    const response = await thsdkKlines(
      {
        symbols: ["sh600519", "sh510300", "sh000001"],
        period: "day",
        limit: 5,
      },
      undefined,
      invoke,
    );

    expect(mock.mock.calls.map(([method, params]) => [method, params])).toEqual(
      [maotai, csi300Etf, shanghaiComposite].map((security) => [
        "list_security_k_lines",
        expect.objectContaining({ security, adjust: 0, period: 0x4000 }),
      ]),
    );
    expect(response).toMatchObject({
      version: "thsdk-adapter-1",
      source: "thsdk-hq",
      period: "day",
      adjustment: "none",
      currency: "CNY",
      delayed: true,
      items: [
        {
          symbol: "sh600519",
          status: "ok",
          volumeUnit: "股",
          bars: [
            {
              date,
              open: 1442,
              high: 1464.99,
              low: 1432.1,
              close: 1460.21,
              volume: 4269153,
              amount: 6192213100,
            },
          ],
        },
        {
          symbol: "sh510300",
          status: "ok",
          volumeUnit: "份",
          bars: [
            {
              date,
              open: 4.068,
              high: 4.075,
              low: 4.036,
              close: 4.054,
              volume: 2790941700,
              amount: 11293465500,
            },
          ],
        },
        {
          symbol: "sh000001",
          status: "ok",
          volumeUnit: "指数源字段",
          bars: [{ date, close: 4050 }],
        },
      ],
    });
  });

  it("decodes the native 5m time as a Shanghai timestamp and requests by negative count", async () => {
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue([
      {
        time: 132881344,
        open: 1464,
        high: 1464.99,
        low: 1460.14,
        close: 1460.21,
        volume: 326694,
        turnover: 477499500,
      },
    ]);
    const result = await thsdkKlines(
      { symbols: ["sh600519"], period: "5m", limit: 5 },
      undefined,
      invoke,
    );
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "list_security_k_lines",
      { security: maotai, period: 0x3005, adjust: 0, start: -5, end: 0 },
    ]);
    expect(result.items).toMatchObject([
      {
        status: "ok",
        bars: [
          {
            date: "2026-11-19T15:00:00+08:00",
            close: 1460.21,
            volume: 326694,
            amount: 477499500,
          },
        ],
      },
    ]);
  });

  it.each([
    { caseName: "invalid OHLC", rows: [{ ...maotaiDay, high: 1400 }] },
    { caseName: "duplicate session date", rows: [maotaiDay, { ...maotaiDay }] },
  ])("rejects a K-line sample with $caseName", async ({ rows }) => {
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue(rows);
    const result = await thsdkKlines(
      { symbols: ["sh600519"], period: "day" },
      undefined,
      invoke,
    );
    expect(result.items).toMatchObject([
      { symbol: "sh600519", status: "invalid" },
    ]);
    expect(result.items[0]).not.toHaveProperty("bars");
  });

  it.each(["empty result", "no_data"] as const)(
    "reports %s as an empty K-line sample",
    async (kind) => {
      const { mock, invoke } = recordingInvoker();
      if (kind === "no_data") {
        mock.mockRejectedValue(new ThsdkError("no_data", "样本为空"));
      } else {
        mock.mockResolvedValue([]);
      }
      const result = await thsdkKlines(
        { symbols: ["sh600519"], period: "day" },
        undefined,
        invoke,
      );
      expect(result.items).toMatchObject([
        { symbol: "sh600519", status: "unavailable", reason: "empty" },
      ]);
      expect(result.items[0]).not.toHaveProperty("bars");
    },
  );

  it("returns five bid and ask levels and distinguishes an absent slot from zero and unknown volume", async () => {
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue([
      {
        security: maotai,
        depth: "5",
        bids: [
          { price: 1460.21, volume: 442 },
          // Deliberate variations of the native bid shape.
          { price: 0, volume: 0 },
          { price: 1460.11, volume: 0 },
          { price: 1460.1 },
        ],
        asks: [{ price: 1460.25, volume: 200 }],
      },
      {
        security: tonghuashun,
        depth: "5",
        bids: [{ price: 197.93, volume: 15671 }],
        asks: [{ price: 197.95, volume: 3500 }],
      },
    ]);
    const result = await thsdkOrderBooks(
      ["sh600519", "sz300033"],
      undefined,
      invoke,
    );
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "list_security_order_books",
      { securities: [maotai, tonghuashun], depth: "5" },
    ]);
    expect(result).toMatchObject({
      source: "thsdk-hq",
      items: [
        {
          symbol: "sh600519",
          status: "ok",
          volumeUnit: "股",
          dataAsOf: null,
          delayed: "unverified",
          bids: [
            { level: 1, state: "quoted", price: 1460.21, volume: 442 },
            { level: 2, state: "empty", price: 0, volume: 0 },
            { level: 3, state: "unknown", price: 1460.11, volume: 0 },
            { level: 4, state: "unknown", price: 1460.1, volume: null },
            { level: 5, state: "unknown", price: null, volume: null },
          ],
        },
        { symbol: "sz300033", status: "ok", volumeUnit: "股" },
      ],
    });
    expect(result.items[0]?.asks).toHaveLength(5);
    expect(result.items[1]?.bids[0]).toEqual({
      level: 1,
      state: "quoted",
      price: 197.93,
      volume: 15671,
    });
  });

  it("maps price-volume levels including omitted sides and out-volume rate", async () => {
    const security = { market: "USHA", code: "USHA600519" };
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue([
      {
        security,
        price: 1432.11,
        volume: 11100,
        in_volume: 11100,
        transaction_count: 68,
      },
      {
        security,
        price: 1464.97,
        volume: 8500,
        out_volume: 8500,
        transaction_count: 79,
        out_volume_rate: 100,
      },
    ]);
    const result = await thsdkPriceVolumeLevels("sh600519", undefined, invoke);
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "list_security_price_volume_levels",
      { security: maotai },
    ]);
    expect(result).toMatchObject({
      source: "thsdk-hq",
      symbol: "sh600519",
      dataAsOf: null,
      levels: [
        {
          price: 1432.11,
          volume: 11100,
          inVolume: 11100,
          outVolume: null,
          transactionCount: 68,
          outVolumeRate: null,
        },
        {
          price: 1464.97,
          volume: 8500,
          inVolume: null,
          outVolume: 8500,
          transactionCount: 79,
          outVolumeRate: 100,
        },
      ],
    });
  });

  it("maps auction seconds and sends the requested Shanghai trading date and phase", async () => {
    // Constructed values in the native shape documented in the Wave 0 report.
    const timestamp = Date.parse("2026-11-19T14:58:00+08:00");
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue([
      {
        time: timestamp / 1000,
        price: 1460.25,
        cur_volume: 1200,
        bid2_vol: 0,
        ask2_vol: 300,
      },
    ]);
    const result = await thsdkCallAuction(
      "sh600519",
      "closing",
      date,
      undefined,
      invoke,
    );
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "list_security_call_auction_quotes",
      { security: maotai, phase: "closing", date: "2026-11-19T00:00:00+08:00" },
    ]);
    expect(result).toMatchObject({
      source: "thsdk-hq",
      symbol: "sh600519",
      date,
      phase: "closing",
      points: [
        {
          price: 1460.25,
          curVolume: 1200,
          bid2Vol: 0,
          ask2Vol: 300,
          timestamp,
          time: "2026-11-19T14:58:00+08:00",
        },
      ],
    });
  });

  it("keeps the cumulative intraday volume and turnover with their native trading date", async () => {
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue([
      {
        time: 132880990,
        price: 1442,
        volume: 99400,
        turnover: 143334800,
        lead_indicator: 4294967295,
      },
      {
        time: 132881344,
        price: 1460.21,
        volume: 4269153,
        turnover: 6192213100,
        lead_indicator: 4294967295,
      },
    ]);
    const result = await thsdkIntraday("sh600519", date, undefined, invoke);
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "list_security_intraday_bars",
      { security: maotai, date: "20261119" },
    ]);
    expect(result).toMatchObject({
      source: "thsdk-hq",
      symbol: "sh600519",
      date,
      points: [
        {
          time: "2026-11-19T09:30:00+08:00",
          price: 1442,
          volume: 99400,
          turnover: 143334800,
        },
        {
          time: "2026-11-19T15:00:00+08:00",
          price: 1460.21,
          volume: 4269153,
          turnover: 6192213100,
        },
      ],
    });
  });

  it("retains the daily amounts and leaves main net inflow null if a required flow is absent", async () => {
    const flowAmounts = {
      turnover: 6192213100,
      active_buy_large: 626617230,
      active_sell_large: 587550310,
      passive_buy_x_large: 799305460,
      passive_sell_x_large: 879787290,
      passive_buy_large: 357132020,
      passive_sell_large: 519697450,
      active_buy_small: 505163.16,
      active_sell_small: 769247.16,
      active_buy_medium: 1922417900,
      active_sell_medium: 1403560200,
      passive_buy_medium: 1617624200,
      passive_sell_medium: 2016688700,
    };
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue([
      {
        ...flowAmounts,
        security: maotai,
        active_buy_x_large: 867917010,
        active_sell_x_large: 782894390,
      },
      // Omit only the extra-large active sell amount and retain a known zero.
      { ...flowAmounts, security: tonghuashun, active_buy_x_large: 0 },
    ]);
    const result = await thsdkDailyCapitalFlows(
      ["sh600519", "sz300033"],
      undefined,
      invoke,
    );
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "list_security_daily_capital_flows",
      { securities: [maotai, tonghuashun] },
    ]);
    expect(result).toMatchObject({
      source: "thsdk-hq",
      items: [
        {
          symbol: "sh600519",
          turnover: 6192213100,
          activeBuyXLarge: 867917010,
          activeSellXLarge: 782894390,
          activeBuyLarge: 626617230,
          activeSellLarge: 587550310,
          passiveBuyXLarge: 799305460,
          passiveSellXLarge: 879787290,
          passiveBuyLarge: 357132020,
          passiveSellLarge: 519697450,
          activeBuyMedium: 1922417900,
          activeSellMedium: 1403560200,
          passiveBuyMedium: 1617624200,
          passiveSellMedium: 2016688700,
          activeBuySmall: 505163.16,
          activeSellSmall: 769247.16,
          // Large and extra-large active/passive buys (2650971720)
          // minus corresponding sells (2769929440), in CNY.
          mainNetInflow: -118957720,
        },
        {
          symbol: "sz300033",
          turnover: 6192213100,
          activeBuyXLarge: 0,
          activeSellXLarge: null,
          mainNetInflow: null,
        },
      ],
    });
  });

  it("reads the popularity rank, comparison population and signed rank change", async () => {
    const { mock, invoke } = recordingInvoker();
    mock.mockResolvedValue({
      status_code: 0,
      status_message: "success",
      security: maotai,
      benchmark: { security: shanghaiComposite },
      rank_info: { rank: 142, rank_amount: 5584, rank_change: -34 },
    });
    const result = await thsdkPopularityRank("sh600519", undefined, invoke);
    expect(mock.mock.calls[0]?.slice(0, 2)).toEqual([
      "get_security_popularity_rank",
      expect.objectContaining({ security: maotai }),
    ]);
    expect(result).toMatchObject({
      source: "thsdk-hq",
      symbol: "sh600519",
      rank: 142,
      rankAmount: 5584,
      rankChange: -34,
    });
  });
});
