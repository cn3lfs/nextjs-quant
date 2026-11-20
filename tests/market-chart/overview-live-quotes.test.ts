import { describe, expect, it, vi } from "vitest";
import { parseLiveMarketBreadth } from "../../src/server/market/live-market-breadth";
import {
  fetchOverviewQuotes,
  parseTencentOverviewQuotes,
} from "../../src/server/market/overview-quotes";

describe("大盘总览实时市场宽度（东方财富）", () => {
  it("汇总沪/深/京三市上涨、下跌、平盘家数与总成交额", () => {
    const raw = {
      rc: 0,
      data: {
        total: 3,
        diff: [
          {
            f12: "000001",
            f14: "上证指数",
            f2: 3511.35,
            f3: -1.85,
            f6: 427084458154.9,
            f104: 173,
            f105: 2159,
            f106: 23,
          },
          {
            f12: "399001",
            f14: "深证成指",
            f2: 10300.09,
            f3: -2.68,
            f6: 475354622127.4,
            f104: 244,
            f105: 2673,
            f106: 21,
          },
          {
            f12: "899050",
            f14: "北证50",
            f2: 785.77,
            f3: -1.61,
            f6: 6188977873,
            f104: 34,
            f105: 321,
            f106: 1,
          },
        ],
      },
    };

    const result = parseLiveMarketBreadth(
      raw,
      Date.UTC(2026, 10, 20, 5, 10, 0),
    );

    expect(result.source).toBe("东方财富实时");
    expect(result.quoteDate).toBe("2026-11-20");
    expect(result.up).toBe(451);
    expect(result.down).toBe(5153);
    expect(result.flat).toBe(45);
    expect(result.total).toBe(5649);
    expect(result.amount).toBeCloseTo(908628058155.3, 1);
    expect(result.markets.map((m) => m.key)).toEqual(["sh", "sz", "bj"]);
  });

  it("缺少任一市场或字段非法时显式报错，不补零凑数", () => {
    expect(() =>
      parseLiveMarketBreadth({
        data: {
          diff: [
            { f12: "000001", f6: 100, f104: 10, f105: 20, f106: 1 },
            { f12: "399001", f6: 100, f104: 10, f105: 20, f106: 1 },
          ],
        },
      }),
    ).toThrow(/缺少北交所/);

    expect(() =>
      parseLiveMarketBreadth({
        data: {
          diff: [
            { f12: "000001", f6: 100, f104: -1, f105: 20, f106: 1 },
            { f12: "399001", f6: 100, f104: 10, f105: 20, f106: 1 },
            { f12: "899050", f6: 100, f104: 1, f105: 2, f106: 0 },
          ],
        },
      }),
    ).toThrow(/缺少沪市/);

    expect(() => parseLiveMarketBreadth({ data: null })).toThrow(
      /响应格式异常/,
    );
  });
});

describe("大盘总览实时报价（腾讯主源 + 通达信回退）", () => {
  function tencentLine(
    symbol: string,
    market: string,
    name: string,
    price: string,
    preClose: string,
    time: string,
    amountYuan: string,
    amountWan: string,
  ) {
    const fields = Array.from({ length: 40 }, () => "");
    fields[0] = market;
    fields[1] = name;
    fields[2] = symbol.slice(2);
    fields[3] = price;
    fields[4] = preClose;
    fields[30] = time;
    fields[35] = `${price}/1000/${amountYuan}`;
    fields[37] = amountWan;
    return `v_${symbol}="${fields.join("~")}";`;
  }

  it("解析沪/深/北实时价格、昨收、成交额（元）与秒级时间，过滤非法行", () => {
    const text = [
      tencentLine(
        "sh000001",
        "1",
        "上证指数",
        "3506.61",
        "3577.62",
        "20261120131124",
        "431282077641",
        "43128208",
      ),
      tencentLine(
        "bj899050",
        "62",
        "北证50",
        "784.50",
        "798.64",
        "20261120131117",
        "6221622916",
        "622162.29",
      ),
      // 市场标识不匹配，忽略
      tencentLine(
        "sz399001",
        "1",
        "错配",
        "10290.02",
        "10583.20",
        "20261120131124",
        "479865879732",
        "47986588",
      ),
    ].join("\n");

    const parsed = parseTencentOverviewQuotes(text, [
      "sh000001",
      "bj899050",
      "sz399001",
    ]);

    expect(parsed).toEqual([
      {
        symbol: "sh000001",
        price: 3506.61,
        preClose: 3577.62,
        amount: 431282077641,
        quoteTime: "2026-11-20 13:11:24",
      },
      {
        symbol: "bj899050",
        price: 784.5,
        preClose: 798.64,
        amount: 6221622916,
        quoteTime: "2026-11-20 13:11:17",
      },
    ]);
  });

  it("腾讯缺失或失败时自动用通达信 TCP 回退补齐，且过滤非 A 股自选代码", async () => {
    const text = tencentLine(
      "sh000001",
      "1",
      "上证指数",
      "3506.61",
      "3577.62",
      "20261120131124",
      "431282077641",
      "43128208",
    );
    const fetcher = vi.fn(async () => new Response(text, { status: 200 }));
    const tdxFallback = vi.fn(async (symbols: string[]) => {
      expect(symbols).toEqual(["sz399001"]);
      return [
        {
          symbol: "sz399001",
          price: 10290.02,
          preClose: 10583.2,
          amount: 479865879732,
          quoteTime: "13:11:20",
        },
      ];
    });

    const result = await fetchOverviewQuotes(
      ["sh000001", "sz399001", "cxBTCUSDT"],
      { fetcher: fetcher as unknown as typeof fetch, tdxFallback },
    );

    expect(result.source).toBe("腾讯实时+通达信实时");
    expect(result.quotes.map((q) => q.symbol)).toEqual([
      "sh000001",
      "sz399001",
    ]);
    expect(tdxFallback).toHaveBeenCalledTimes(1);
  });

  it("腾讯完全失败时回退通达信；双源都失败则抛出中文错误", async () => {
    const failFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const okTdx = vi.fn(async () => [
      { symbol: "sh000001", price: 3500, preClose: 3570, amount: 4e11 },
    ]);

    const recovered = await fetchOverviewQuotes(["sh000001"], {
      fetcher: failFetch as unknown as typeof fetch,
      tdxFallback: okTdx,
    });
    expect(recovered.source).toBe("通达信实时");
    expect(recovered.quotes[0]?.price).toBe(3500);

    const failTdx = vi.fn(async () => {
      throw new Error("tdx timeout");
    });
    await expect(
      fetchOverviewQuotes(["sh000001"], {
        fetcher: failFetch as unknown as typeof fetch,
        tdxFallback: failTdx,
      }),
    ).rejects.toThrow(/实时行情获取失败/);
  });
});
