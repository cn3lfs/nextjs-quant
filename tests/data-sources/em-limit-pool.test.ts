import { afterEach, expect, it, vi } from "vitest";
import fixture from "../fixtures/eastmoney-limit-pools.json";
import { resetEastmoneyCooldowns } from "../../src/server/data-sources/eastmoney/em-fetch";
import {
  fetchLimitPool,
  parseLimitPool,
} from "../../src/server/data-sources/eastmoney/em-limit-pool";
import { summarizeLimitPools } from "../../src/server/market/limit-sentiment";

afterEach(() => resetEastmoneyCooldowns());

it("涨停池：价格 ÷1000、封板时间补零、市场前缀", () => {
  const rows = parseLimitPool(fixture.zt, "zt")!;
  expect(rows[0]).toMatchObject({
    symbol: "sz000498",
    name: "山东路桥",
    price: 5.65,
    streak: 1,
    firstSeal: "09:25:00",
    lastSeal: "09:31:36",
    breaks: 1,
    stat: "1天1板",
  });
  const y = parseLimitPool(fixture.yzt, "yzt")!;
  expect(y[0]).toMatchObject({ symbol: "sh600743", streak: 3, limitPrice: 3.1, firstSeal: "09:30:10" });
});

it("非交易日 data=null 返回 null，格式错误抛出", () => {
  expect(parseLimitPool({ rc: 0, data: null }, "zt")).toBeNull();
  expect(() => parseLimitPool({ foo: 1 }, "zt")).toThrow("格式无效");
});

it("请求参数：日期去横线、各池排序", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture.dt));
  await fetchLimitPool("dt", "2026-09-24", undefined, fetcher);
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.pathname).toBe("/getTopicDTPool");
  expect(url.searchParams.get("date")).toBe("20260924");
  expect(url.searchParams.get("sort")).toBe("fund:asc");
});

it("情绪汇总：炸板率、梯队、晋级率", () => {
  const row = (symbol: string, streak: number, changePct = 10) => ({
    symbol, name: symbol, price: 1, changePct, amount: null, floatCap: null, turnover: null,
    industry: "银行", streak, firstSeal: null, lastSeal: null, sealFund: null, breaks: null,
    limitPrice: null, stat: null,
  });
  const s = summarizeLimitPools("2026-09-24", {
    zt: [row("a", 3), row("b", 1), row("c", 1)],
    zb: [row("d", 0)],
    dt: [],
    yzt: [row("a", 2, 10), row("x", 1, -4)],
  });
  expect(s.stats).toMatchObject({ limitUp: 3, broken: 1, breakRate: 25, maxHeight: 3, promotionRate: 50, yesterdayAvgChange: 3 });
  expect(s.ladder).toEqual([
    { height: 3, count: 1, names: ["a"] },
    { height: 1, count: 2, names: ["b", "c"] },
  ]);
  expect(s.industries).toEqual([{ name: "银行", count: 3 }]);
});
