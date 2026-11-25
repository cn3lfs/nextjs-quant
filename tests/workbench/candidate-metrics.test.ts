import { describe, expect, it, vi } from "vitest";
import { settingsSchema, type Bar } from "~/lib/domain";
import { ema } from "~/lib/indicators";
import {
  type CandidateTechnicalMetrics,
  computeCandidateMetricsFromBars,
  enrichCandidatePageWithMetrics,
  loadCandidateMarketMetrics,
} from "~/server/alerts/candidate-metrics";

// Hand-calculated from the first close, then (close + 2 × EMA5) / 3
// and (2 × close + 19 × EMA20) / 21. The closes yield exact integers.
const worksheet = [
  // Close, EMA5, EMA20
  [94, 94, 94],
  [94, 94, 94],
  [157, 115, 100],
  [58, 96, 96],
  [33, 75, 90],
  [132, 94, 94],
  [157, 115, 100],
  [184, 138, 108],
  [150, 142, 112],
  [154, 146, 116],
  [95, 129, 114],
  [72, 110, 110],
  [47, 89, 104],
  [83, 87, 102],
  [144, 106, 106],
  [169, 127, 112],
  [133, 129, 114],
  [135, 131, 116],
  [137, 133, 118],
  [139, 135, 120],
  [78, 116, 116],
  [53, 95, 110],
  [89, 93, 108],
  [150, 112, 112],
  [175, 133, 118],
] as const;

function dailyBar(date: string, close: number): Bar {
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    amount: close * 100,
  };
}

const bars = worksheet.map(([close], index) =>
  dailyBar(`2026-11-${String(index + 1).padStart(2, "0")}`, close),
);
const completedMetrics = {
  currentPrice: 175,
  ema5: 133,
  ema20: 118,
  asOfDate: "2026-11-25",
  priceBasis: "close",
  adjustment: "forward",
  quoteTime: null,
} as const;
const config = settingsSchema.parse({});
const now = Date.parse("2026-11-26T06:00:00Z");
const equity = { market: "cn-equity", symbol: "sh600000" } as const;

describe("computeCandidateMetricsFromBars", () => {
  it("matches the exact hand-calculated daily EMA5 and EMA20, including the first-close seed", () => {
    expect(ema(bars, 5)).toEqual(worksheet.map(([, ema5]) => ema5));
    expect(ema(bars, 20)).toEqual(worksheet.map(([, , ema20]) => ema20));
    expect(computeCandidateMetricsFromBars(bars, "forward")).toEqual(
      completedMetrics,
    );
  });

  it("leaves every market metric unknown when the daily series is empty", () => {
    expect(computeCandidateMetricsFromBars([], "forward")).toEqual({
      currentPrice: null,
      ema5: null,
      ema20: null,
      asOfDate: null,
      priceBasis: null,
      adjustment: null,
      quoteTime: null,
    });
  });

  it.each([
    [4, null, null],
    [5, 75, null],
    [19, 133, null],
    [20, 135, 120],
  ])(
    "exposes only warmed-up EMAs at exactly %i completed bars",
    (count, ema5, ema20) => {
      expect(
        computeCandidateMetricsFromBars(bars.slice(0, count), "forward"),
      ).toMatchObject({
        currentPrice: bars[count - 1]!.close,
        ema5,
        ema20,
      });
    },
  );
});

describe("loadCandidateMarketMetrics", () => {
  it("excludes the forming daily bar from the current price, date, and both EMAs", async () => {
    const forming = dailyBar("2026-11-26", 1_000);
    const loadEquityBars = vi.fn().mockResolvedValue({
      bars: [...bars, forming],
      formingDates: [forming.date],
    });

    const metrics = await loadCandidateMarketMetrics([equity], config, now, {
      loadEquityBars,
    });

    expect(loadEquityBars).toHaveBeenCalledExactlyOnceWith(
      equity.symbol,
      "forward",
    );
    expect(metrics.get(`cn-equity:${equity.symbol}`)).toEqual(completedMetrics);
  });

  it("retries with raw daily bars after a forward-adjusted read throws and labels the result unadjusted", async () => {
    const loadEquityBars = vi
      .fn()
      .mockRejectedValueOnce(new Error("Missing adjustment history"))
      .mockResolvedValueOnce({ bars });

    const metrics = await loadCandidateMarketMetrics([equity], config, now, {
      loadEquityBars,
    });

    expect(loadEquityBars.mock.calls).toEqual([
      [equity.symbol, "forward"],
      [equity.symbol, "none"],
    ]);
    expect(metrics.get(`cn-equity:${equity.symbol}`)).toEqual({
      ...completedMetrics,
      adjustment: "none",
    });
  });
});

describe("enrichCandidatePageWithMetrics", () => {
  it("loads once per market and symbol and shares the result across duplicate candidate rows", async () => {
    // A shared symbol string across markets catches deduplication by symbol alone.
    const crypto = { market: "crypto", symbol: equity.symbol } as const;
    const otherEquity = { market: "cn-equity", symbol: "sh600001" } as const;
    const page = {
      total: 12,
      items: [equity, crypto, equity, otherEquity, crypto, otherEquity].map(
        (candidate, index) => ({
          ...candidate,
          key: `event-${index}`,
          marketMetrics: null as CandidateTechnicalMetrics | null,
        }),
      ),
    };
    const loadEquityBars = vi.fn(async (symbol: string) => ({
      bars: symbol === equity.symbol ? bars : bars.slice(0, 5),
    }));
    const loadCryptoBars = vi
      .fn()
      .mockResolvedValue({ bars: bars.slice(0, 4) });

    const enriched = await enrichCandidatePageWithMetrics(page, config, now, {
      loadEquityBars,
      loadCryptoBars,
    });

    expect(loadEquityBars).toHaveBeenCalledTimes(2);
    expect(loadEquityBars).toHaveBeenCalledWith(equity.symbol, "forward");
    expect(loadEquityBars).toHaveBeenCalledWith(otherEquity.symbol, "forward");
    expect(loadCryptoBars).toHaveBeenCalledExactlyOnceWith(crypto.symbol);
    expect(enriched.total).toBe(page.total);
    expect(enriched.items.map(({ key }) => key)).toEqual(
      page.items.map(({ key }) => key),
    );
    expect(
      enriched.items.map(({ marketMetrics }) => marketMetrics?.currentPrice),
    ).toEqual([175, 58, 175, 33, 58, 33]);
  });

  it.each([
    ["throws", "throws"],
    ["empty", "empty"],
    ["throws", "empty"],
    ["empty", "throws"],
  ])(
    "keeps market metrics null and preserves the historical signal price when forward is %s and raw is %s",
    async (forward, raw) => {
      const loadEquityBars = vi.fn(
        async (_symbol: string, adjustment: "forward" | "none") => {
          if ((adjustment === "forward" ? forward : raw) === "throws") {
            throw new Error(`Missing ${adjustment} daily bars`);
          }
          return { bars: [] };
        },
      );
      const event = { ...equity, price: 10, marketMetrics: null };
      const page = { total: 1, items: [event] };

      await expect(
        enrichCandidatePageWithMetrics(page, config, now, { loadEquityBars }),
      ).resolves.toEqual({
        total: 1,
        items: [{ ...event, price: 10, marketMetrics: null }],
      });
      expect(loadEquityBars.mock.calls).toEqual([
        [equity.symbol, "forward"],
        [equity.symbol, "none"],
      ]);
    },
  );
});
