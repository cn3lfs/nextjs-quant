import { expect, it, vi } from "vitest";
import {
  tstdxKlines,
  tstdxSearch,
  tstdxMinutes,
  tstdxAssetKind,
  requireTstdxRows,
} from "../src/server/data-sources/tstdx/tstdx-adapter";
type Client = ReturnType<NonNullable<Parameters<typeof tstdxKlines>[2]>>;
const bar = (date = "2026-09-14", close = 10) => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  amount: 1000,
});
function fake() {
  return {
    barPage: vi.fn<Client["barPage"]>().mockResolvedValue([bar()]),
    indexBarPage: vi.fn<Client["indexBarPage"]>().mockResolvedValue([bar()]),
    xdxr: vi.fn<Client["xdxr"]>().mockResolvedValue([]),
    stocks: vi.fn<Client["stocks"]>().mockResolvedValue([]),
    blockInfo: vi.fn<Client["blockInfo"]>().mockResolvedValue([]),
    minutes: vi
      .fn<Client["minutes"]>()
      .mockResolvedValue([{ price: 10, volume: 1 }]),
    historyMinutes: vi
      .fn<Client["historyMinutes"]>()
      .mockResolvedValue([{ price: 9, volume: 2 }]),
    close: vi.fn<Client["close"]>().mockResolvedValue(),
  };
}
it("统一批量状态、请求记录，沪深创科北及 ETF 路由正确", async () => {
  const c = fake();
  const result = await tstdxKlines(
    {
      symbols: [
        "sh600000",
        "sz000001",
        "sz300750",
        "sh688981",
        "bj920002",
        "sh510300",
        "sh000001",
        "sh880001",
      ],
      period: "day",
      limit: 3,
    },
    undefined,
    () => c,
  );
  expect(result.items.every((i) => i.status === "ok")).toBe(true);
  expect(c.barPage).toHaveBeenCalledTimes(6);
  expect(c.indexBarPage).toHaveBeenCalledTimes(2);
  expect(result.requests).toHaveLength(8);
  expect(result.requests.every((r) => r.completedAt! >= r.startedAt)).toBe(
    true,
  );
  expect(requireTstdxRows(result)).toHaveLength(8);
  expect(c.close).toHaveBeenCalledTimes(8);
});
it("板块代码隔离，未知调整能力不发请求", async () => {
  const c = fake(),
    make = vi.fn(() => c);
  const r = await tstdxKlines(
    {
      symbols: ["ptBK0475", "sh000001", "sh510300"],
      period: "day",
      adjustment: "qfq",
    },
    undefined,
    make,
  );
  expect(r.items.map((i) => i.status)).toEqual([
    "unsupported",
    "unsupported",
    "unsupported",
  ]);
  expect(make).not.toHaveBeenCalled();
  expect(() => requireTstdxRows(r)).toThrow("ptBK0475");
  for (const symbol of [
    "sh500001",
    "sh520500",
    "sh530000",
    "sh560000",
    "sh588000",
    "sz159915",
    "sz161725",
  ])
    expect(tstdxAssetKind(symbol)).toBe("etf");
});
it("拒绝非法参数、日期、重复证券及未来区间", async () => {
  const make = vi.fn(() => fake());
  for (const input of [
    { symbols: ["sh600000", "sh600000"], period: "day" },
    { symbols: ["sh600000"], period: "day", start: "2026-02-30" },
    { symbols: ["sh600000"], period: "day", end: "2099-01-01" },
    {
      symbols: ["sh600000"],
      period: "day",
      start: "2026-09-14",
      end: "2026-09-10",
    },
  ] as const)
    await expect(
      tstdxKlines({ ...input, symbols: [...input.symbols] }, undefined, make),
    ).rejects.toThrow();
  expect(make).not.toHaveBeenCalled();
});
it("部分失败保留其他证券结果且不更换提供商", async () => {
  const c = fake();
  c.barPage.mockImplementation(async (symbol) => {
    if (symbol === "sh600000") throw Error("upstream empty packet");
    return [bar()];
  });
  const r = await tstdxKlines(
    { symbols: ["sh600000", "sz300750"], period: "day" },
    undefined,
    () => c,
  );
  expect(r.items.map((i) => i.status)).toEqual(["unavailable", "ok"]);
  expect(r.requests[0]?.error).toContain("upstream");
});
it.each(
  [
    [],
    [{ ...bar(), high: 1 }],
    [bar(), bar()],
    [{ ...bar(), amount: NaN }],
    [bar("2026-02-30")],
  ].map((raw) => ({ raw })),
)("空数据和坏 OHLC 不伪装成功 %#", async ({ raw }) => {
  const c = fake();
  c.barPage.mockResolvedValue(raw);
  const r = await tstdxKlines(
    { symbols: ["sh600000"], period: "day" },
    undefined,
    () => c,
  );
  expect(r.items[0]?.status).toBe(raw.length ? "invalid" : "unavailable");
});
it("分页去重排序，重复页必须报错而不是历史耗尽", async () => {
  const c = fake();
  const page = Array.from({ length: 800 }, (_, i) =>
    bar(
      new Date(Date.UTC(2026, 8, 14) - (799 - i) * 86400000)
        .toISOString()
        .slice(0, 10),
    ),
  );
  c.barPage.mockResolvedValue(page);
  const r = await tstdxKlines(
    { symbols: ["sh600000"], period: "day", limit: 1600 },
    undefined,
    () => c,
  );
  expect(r.items[0]).toMatchObject({
    status: "invalid",
    message: expect.stringContaining("无进展"),
  });
  expect(c.barPage).toHaveBeenCalledTimes(2);
});
it("日期过滤和数量限制同时生效，不把区间外数据交给图表", async () => {
  const c = fake();
  c.barPage.mockResolvedValue([
    bar("2026-09-10"),
    bar("2026-09-11"),
    bar("2026-09-14"),
  ]);
  const r = await tstdxKlines(
    {
      symbols: ["sh600000"],
      period: "day",
      start: "2026-09-11",
      end: "2026-09-14",
      limit: 1,
    },
    undefined,
    () => c,
  );
  expect(requireTstdxRows(r).map((b) => b.date)).toEqual(["2026-09-14"]);
});
it("日线复权使用区间前历史并保持原始成交量", async () => {
  const c = fake();
  c.barPage.mockResolvedValue([bar("2026-09-10"), bar("2026-09-11", 9)]);
  c.xdxr.mockResolvedValue([
    {
      date: "2026-09-11",
      category: 1,
      name: "除权",
      dividend: 1,
      bonusRatio: 0,
      rightsRatio: 0,
      rightsPrice: 0,
    },
  ]);
  const r = await tstdxKlines(
    {
      symbols: ["sh600000"],
      period: "day",
      adjustment: "hfq",
      start: "2026-09-11",
    },
    undefined,
    () => c,
  );
  expect(requireTstdxRows(r)).toMatchObject([{ close: 10, volume: 100 }]);
});
it("取消后停止下一只证券并释放连接", async () => {
  const c = fake(),
    controller = new AbortController();
  c.barPage.mockImplementation(async () => {
    controller.abort();
    return [bar()];
  });
  await expect(
    tstdxKlines(
      { symbols: ["sh600000", "sz000001"], period: "day" },
      controller.signal,
      () => c,
    ),
  ).rejects.toThrow();
  expect(c.barPage).toHaveBeenCalledTimes(1);
  expect(c.close).toHaveBeenCalled();
});
it("搜索严格过滤品种，默认沪深，北交所错误不伪装无结果", async () => {
  const c = fake();
  c.stocks.mockResolvedValue([
    {
      symbol: "sh600000",
      code: "600000",
      market: "sh",
      name: "浦发银行",
      volumeUnit: 100,
      decimalPoint: 2,
      preClose: 10,
      unknown1: "",
      unknown2: "",
    },
    {
      symbol: "sh510300",
      code: "510300",
      market: "sh",
      name: "沪深300ETF",
      volumeUnit: 100,
      decimalPoint: 3,
      preClose: 4,
      unknown1: "",
      unknown2: "",
    },
  ]);
  const r = await tstdxSearch(
    { keyword: "ETF", type: "etf", markets: ["sh"] },
    undefined,
    () => c,
  );
  expect(r).toEqual([{ code: "sh510300", name: "沪深300ETF", type: "etf" }]);
  c.stocks.mockRejectedValue(Error("北交所超时"));
  await expect(
    tstdxSearch({ keyword: "920002", markets: ["bj"] }, undefined, () => c),
  ).rejects.toThrow("北交所超时");
});
it("历史分时保留点序列，不能生成假的蜡烛图", async () => {
  const c = fake();
  const r = await tstdxMinutes(
    { symbol: "sz300750", date: "2026-09-14" },
    undefined,
    () => c,
  );
  expect(c.historyMinutes).toHaveBeenCalledWith("sz300750", 20260914);
  expect(r.points).toEqual([{ price: 9, volume: 2 }]);
  expect(r).not.toHaveProperty("bars");
});

it.each(["day", "week", "month", "5m", "15m", "30m", "60m"] as const)(
  "图表周期 %s 的时间格式与原生周期保持一致",
  async (period) => {
    const c = fake();
    c.barPage.mockResolvedValue([
      bar(period.endsWith("m") ? "2026-09-14T15:00:00+08:00" : "2026-09-14"),
    ]);
    const r = await tstdxKlines(
      { symbols: ["sh600000"], period, limit: 3 },
      undefined,
      () => c,
    );
    expect(r.items[0]?.status).toBe("ok");
    expect(c.barPage).toHaveBeenCalledWith("sh600000", period, 0, 3);
  },
);
it("当前分时没有源日期，不宣称已核验为今日行情", async () => {
  const c = fake();
  const r = await tstdxMinutes({ symbol: "sz300750" }, undefined, () => c);
  expect(r.date).toBeNull();
  expect(r.dateBasis).toBe("current-response-date-unverified");
});
