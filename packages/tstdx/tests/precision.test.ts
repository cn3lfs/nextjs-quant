import { describe, expect, it } from "vitest";
import rows from "./fixtures/precision-market-response.json";
import {
  formatQuoteTime,
  parseBars,
  parseMinutes,
  parseQuotes,
  parseTransactions,
  priceDivisor,
} from "../src/wire";

describe("证券价格精度的真实报文回归", () => {
  for (const row of rows) {
    it(`${row.symbol} 分时、成交、报价与独立 K 线收盘一致`, () => {
      const hex = (value: string) => Buffer.from(value, "hex");
      const close = parseBars(
        hex(row.bars),
        "day",
        row.symbol === "sh000001",
      )[0]!.close;
      const quote = parseQuotes(
        hex(row.quotes),
        [row.symbol],
        new Map([[row.symbol, row.decimals]]),
      )[0]!;
      expect(quote.price).toBeCloseTo(close, 6);
      expect(
        parseMinutes(hex(row.minutes), row.symbol, true, row.decimals).at(-1)!
          .price,
      ).toBeCloseTo(close, 6);
      expect(
        parseTransactions(hex(row.transactions), true, row.decimals).at(-1)!
          .price,
      ).toBeCloseTo(close, 6);
      if (row.decimals === 3) {
        expect(
          parseQuotes(hex(row.quotes), [row.symbol])[0]!.price,
        ).toBeCloseTo(close * 10, 6);
        expect(quote.bids[0]!.price).toBeLessThan(close * 1.01);
        expect(quote.asks[0]!.price).toBeLessThan(close * 1.01);
      }
    });
  }
  it("拒绝无法解释的价格精度", () => {
    for (const value of [-1, 7, 2.5, NaN, Infinity])
      expect(() => priceDivisor(value)).toThrow();
  });
  it("时间两种布局与未知值分开处理", () => {
    expect(formatQuoteTime(14999212)).toBe("14:59:57.163");
    expect(formatQuoteTime(15000000)).toBe("15:00:00.000");
    expect(formatQuoteTime(10301250)).toBe("10:30:07.500");
    for (const value of [-1, 153046016, NaN, 24000000])
      expect(formatQuoteTime(value)).toBeNull();
  });
});
