import { describe, expect, it } from "vitest";
import {
  eastmoneyFuturesKlines,
  parseFuturesKlines,
  parseFuturesQuotes,
} from "../../../src/server/data-sources/eastmoney/eastmoney-futures";
import {
  chartPricePrecision,
  chartSymbolHref,
  chartSymbolSchema,
  isNonAShareChartSymbol,
  normalizeChartSymbol,
} from "../../../src/lib/chart/chart-symbol";
import {
  futuresContracts,
  isFuturesSymbol,
} from "../../../src/lib/market/futures";
import { symbolSchema } from "../../../src/lib/domain";
import {
  parseSinaFuturesDaily,
  parseSinaFuturesQuotes,
} from "../../../src/server/data-sources/sina/sina-futures";

const response = (klines: string[], code = "GC00Y", market = 101) => ({
  rc: 0,
  data: { code, market, name: "COMEX黄金", klines },
});

describe("commodity futures (Eastmoney)", () => {
  it("parses daily and minute klines, keeping foreign amount 0", () => {
    const daily = parseFuturesKlines(
      response([
        "2026-09-23,4394.7,4322.7,4407.5,4310.7,140658,0.0",
        "2026-09-24,4324.4,4321.0,4338.0,4300.0,1000,0.0",
      ]),
      "fuGC00Y",
      "day",
    );
    expect(daily.bars).toHaveLength(2);
    expect(daily.bars[1]).toMatchObject({
      date: "2026-09-24",
      close: 4321,
      amount: 0,
    });
    const minute = parseFuturesKlines(
      response(["2026-09-24 11:05,4325.4,4325.3,4328.7,4324.9,327,0.0"]),
      "fuGC00Y",
      "5m",
    );
    expect(minute.bars[0]!.date).toBe("2026-09-24T11:05:00+08:00");
  });

  it("rejects malformed input instead of repairing it", () => {
    const bad =
      (raw: unknown, symbol = "fuGC00Y") =>
      () =>
        parseFuturesKlines(raw, symbol, "day");
    expect(bad({ rc: 100, data: null })).toThrow("未返回有效");
    expect(bad(response(["2026-09-24,1,1,1,1,1"], "SI00Y"))).toThrow("不匹配");
    expect(bad(response(["2026-02-30,1,1,1,1,1"]))).toThrow("日期无效");
    expect(bad(response(["2026-09-24,1,2,1.5,1,1"]))).toThrow("价格");
    expect(bad(response(["2026-09-24,1,1,1,0,1"]))).toThrow("价格");
    expect(
      bad(response(["2026-09-24,1,1,1,1,1", "2026-09-23,1,1,1,1,1"])),
    ).toThrow("顺序");
    expect(bad(response(["2026-09-24,1,,1,1,1"]))).toThrow("字段缺失");
    expect(bad(response(["2026-09-24,1,1,1,1,1"]), "fuXX")).toThrow();
  });

  it("requests the mapped secid and period", async () => {
    let requested = "";
    const fetcher = (async (url: string) => {
      requested = url;
      return new Response(
        JSON.stringify(
          response(["2026-09-24,700,710,720,690,100,7000"], "scm", 142),
        ),
      );
    }) as never;
    const result = await eastmoneyFuturesKlines(
      { symbol: "fuSCM", period: "week", limit: 50 },
      { fetcher, proxy: "" },
    );
    const params = new URL(requested).searchParams;
    expect(params.get("secid")).toBe("142.scm");
    expect(params.get("klt")).toBe("102");
    expect(params.get("fqt")).toBe("0");
    expect(result.source).toBe("eastmoney-futures");
    expect(result.bars).toHaveLength(1);
  });

  it("routes futures symbols away from every A-share path", () => {
    for (const { symbol } of futuresContracts) {
      expect(isFuturesSymbol(symbol)).toBe(true);
      expect(chartSymbolSchema.safeParse(symbol).success).toBe(true);
      expect(isNonAShareChartSymbol(symbol)).toBe(true);
      expect(symbolSchema.safeParse(symbol).success).toBe(false);
      expect(normalizeChartSymbol(symbol)).toBeNull();
    }
    expect(new Set(futuresContracts.map((c) => c.secid)).size).toBe(
      futuresContracts.length,
    );
    expect(chartSymbolHref("fuGC00Y")).toBe("/futures?code=GC00Y");
    expect(chartPricePrecision("fuHG00Y")).toBe(4);
    expect(isFuturesSymbol("fuZZZ")).toBe(false);
  });
});

describe("commodity futures quotes", () => {
  it("maps batched rows by secid and isolates bad rows", () => {
    const quotes = parseFuturesQuotes({
      rc: 0,
      data: {
        diff: [
          { f2: 4318, f3: -0.01, f12: "GC00Y", f13: 101, f124: 1790221362 },
          { f2: "-", f3: "-", f12: "aum", f13: 113 },
          { f2: 723.2, f3: 4.04, f12: "scm", f13: 142 },
        ],
      },
    });
    expect(quotes).toHaveLength(futuresContracts.length);
    expect(quotes.find((q) => q.symbol === "fuGC00Y")).toMatchObject({
      close: 4318,
      changePct: -0.01,
      time: 1790221362000,
    });
    expect(quotes.find((q) => q.symbol === "fuAUM")?.error).toBe("无报价");
    expect(quotes.find((q) => q.symbol === "fuCL00Y")?.error).toBe("无报价");
    expect(() => parseFuturesQuotes({ rc: 1 })).toThrow("未返回有效");
  });
});

describe("Sina fallback", () => {
  it("parses global and inner JSONP rows and applies the unit scale", () => {
    const global = parseSinaFuturesDaily(
      'var _=([{"date":"2026-09-24","open":"678.0","high":"679.7","low":"675.55","close":"675.65","volume":"0"}]);',
      "global",
      0.01,
    );
    expect(global.bars[0]!.close).toBeCloseTo(6.7565, 6);
    expect(global.bars[0]!.amount).toBe(0);
    const inner = parseSinaFuturesDaily(
      '/*x*/var _=([{"d":"2026-09-23","o":"939.2","h":"944.76","l":"935.7","c":"939.5","v":"122113","p":"1","s":"940"}]);',
      "inner",
    );
    expect(inner.bars[0]).toMatchObject({
      date: "2026-09-23",
      close: 939.5,
      volume: 122113,
    });
  });

  it("drops and lists broken rows instead of repairing them", () => {
    const parsed = parseSinaFuturesDaily(
      'var _=([{"date":"2019-07-31","open":"98.36","high":"98.09","low":"97.09","close":"97.23","volume":"1"},{"date":"2026-09-24","open":"98","high":"99","low":"97","close":"98.5","volume":"1"},{"date":"2026-09-24","open":"98","high":"99","low":"97","close":"98.5","volume":"1"}]);',
      "global",
    );
    expect(parsed.bars.map((b) => b.date)).toEqual(["2026-09-24"]);
    expect(parsed.excluded).toEqual([
      { date: "2019-07-31", reason: "新浪 OHLC 不自洽" },
      { date: "2026-09-24", reason: "日期重复或倒序" },
    ]);
    expect(() => parseSinaFuturesDaily("<html>", "global")).toThrow(
      "未返回有效",
    );
    expect(() => parseSinaFuturesDaily("var _=([]);", "inner")).toThrow(
      "未返回有效",
    );
  });

  it("parses realtime quotes against the previous settlement", () => {
    const quotes = parseSinaFuturesQuotes(
      [
        'var hq_str_hf_GC="4318.010,,4318.700,4319.000,4338.000,4308.000,11:59:09,4318.400,4324.400,0,1,3,2026-09-24,x,0";',
        'var hq_str_hf_HG="675.540,,675.550,675.650,679.700,675.450,11:58:46,675.350,678.050,0,1,4,2026-09-24,x,0";',
        'var hq_str_nf_AU0="x,113000,934.820,936.040,928.400,0.000,930.220,931.200,930.440,0.000,940.180,1,9";',
        'var hq_str_nf_SC0="";',
      ].join("\n"),
    );
    const by = (s: string) => quotes.find((q) => q.symbol === s)!;
    expect(by("fuGC00Y").close).toBeCloseTo(4318.01, 6);
    expect(by("fuHG00Y").close).toBeCloseTo(6.7554, 6);
    expect(by("fuAUM").changePct).toBeCloseTo((930.44 / 940.18 - 1) * 100, 6);
    expect(by("fuSCM").error).toBe("无报价");
  });
});
