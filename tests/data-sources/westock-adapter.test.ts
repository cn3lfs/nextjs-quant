import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  westockKlines,
  requireWestockRows,
  westockAssetKind,
} from "../../src/server/data-sources/westock/westock-adapter";
const rows = (symbol: string) =>
  ["2026-09-14", "2026-09-11", "2026-09-10"].map((date) => ({
    symbol,
    date,
    open: 10,
    last: 11,
    high: 12,
    low: 9,
    volume: 100,
    amount: 1000,
  }));
beforeEach(() => vi.setSystemTime(new Date("2026-09-14T16:00:00+08:00")));
afterEach(() => vi.useRealTimers());
it("上市历史不足和零成交保留真实根数，不填补停牌日", async () => {
  const one = { ...rows("sh600000")[0]!, volume: 0, amount: 0 };
  const result = await westockKlines(
    { symbols: ["sh600000"], period: "day", limit: 20 },
    undefined,
    vi.fn().mockResolvedValue([one]),
  );
  expect(result.items[0]).toMatchObject({
    status: "ok",
    bars: [expect.objectContaining({ date: one.date, volume: 0, amount: 0 })],
  });
  if (result.items[0]?.status === "ok")
    expect(result.items[0].bars).toHaveLength(1);
});
it("退市或无历史空响应保持不可用，不生成零价格", async () => {
  const result = await westockKlines(
    { symbols: ["sh600001"], period: "day" },
    undefined,
    vi.fn().mockResolvedValue([]),
  );
  expect(result.items[0]?.status).toBe("unavailable");
});
it("recovers only omitted ETF once and preserves ordering, provenance and unadjusted args", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([...rows("sh000001"), ...rows("pt01801081")])
    .mockResolvedValueOnce(
      rows("sh510300").map(({ symbol: _symbol, ...r }) => r),
    );
  const result = await westockKlines(
    {
      symbols: ["sh000001", "pt01801081", "sh510300"],
      period: "day",
      limit: 3,
    },
    undefined,
    execute,
  );
  expect(result.items.map((r) => [r.symbol, r.status])).toEqual([
    ["sh000001", "ok"],
    ["pt01801081", "ok"],
    ["sh510300", "ok"],
  ]);
  expect(result.requests.map((r) => r.symbols)).toEqual([
    ["sh000001", "pt01801081", "sh510300"],
    ["sh510300"],
  ]);
  expect(result.requests.every((r) => r.args.includes("bfq"))).toBe(true);
  expect(requireWestockRows(result)).toHaveLength(9);
  expect(result.warnings.join()).toContain("遗漏");
  expect(
    result.items[2]?.status === "ok" && result.items[2].bars[0]?.date,
  ).toBe("2026-09-10");
});
it("does not silently accept persistent omissions or retry forever", async () => {
  const execute = vi.fn().mockResolvedValue([]);
  const result = await westockKlines(
    { symbols: ["sh000001", "sh510300"], period: "day" },
    undefined,
    execute,
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(result.items.every((r) => r.status === "unavailable")).toBe(true);
  expect(() => requireWestockRows(result)).toThrow("未返回行情");
});
it("does not retry provider failures and never switches source", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("provider denied"));
  const result = await westockKlines(
    { symbols: ["sh000001", "sh510300"], period: "day" },
    undefined,
    execute,
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(() => requireWestockRows(result)).toThrow("provider denied");
});
it("reports unsupported minutes per item without requesting those symbols", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue([
      { ...rows("sh510300")[0], date: "2026-09-14 15:00:00" },
    ]);
  const result = await westockKlines(
    {
      symbols: ["bj920002", "sh000001", "pt01801081", "sh510300"],
      period: "5m",
    },
    undefined,
    execute,
  );
  expect(result.items.map((r) => r.status)).toEqual([
    "unsupported",
    "unsupported",
    "unsupported",
    "ok",
  ]);
  expect(result.requests[0]?.symbols).toEqual(["sh510300"]);
  expect(result.start).toBe("2026-08-17");
  expect(result.end).toBe("2026-09-14");
  expect(result.adjustment).toBe("none");
});
it.each([
  { symbols: ["sh000001", "sh000001"], period: "day" },
  { symbols: ["sh000001;whoami"], period: "day" },
  { symbols: ["sh000001"], period: "day", start: "2026-02-30" },
  {
    symbols: ["sh000001"],
    period: "day",
    start: "2026-09-14",
    end: "2026-09-10",
  },
  { symbols: ["sh000001"], period: "day", end: "2026-09-15" },
  { symbols: ["sh600000"], period: "5m", start: "2026-07-01" },
  { symbols: ["sh600000"], period: "5m", adjustment: "qfq" },
  { symbols: ["sh600000"], period: "day", limit: 0 },
])("rejects malformed or unsupported request before IO: %j", async (input) => {
  const execute = vi.fn();
  await expect(
    westockKlines(
      input as Parameters<typeof westockKlines>[0],
      undefined,
      execute,
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it.each([
  { raw: [...rows("sh600000"), rows("sh600000")[0]] },
  { raw: rows("sh600000").map((r) => ({ ...r, high: 1 })) },
  { raw: rows("sh600000").map((r) => ({ ...r, volume: NaN })) },
  { raw: rows("sh600000").map((r) => ({ ...r, date: "2026-09-15" })) },
])(
  "rejects invalid response without retrying malformed candles",
  async ({ raw }) => {
    const execute = vi.fn().mockResolvedValue(raw);
    const result = await westockKlines(
      { symbols: ["sh600000"], period: "day" },
      undefined,
      execute,
    );
    expect(result.items[0]?.status).toBe("invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  },
);
it("rejects unknown batch identities rather than assigning rows by array position", async () => {
  const result = await westockKlines(
    { symbols: ["sh000001", "sh510300"], period: "day" },
    undefined,
    vi.fn().mockResolvedValue(rows("sz000001")),
  );
  expect(() => requireWestockRows(result)).toThrow("未知证券");
});
it("preserves range and qfq parameters and discloses the 2000 limit", async () => {
  const result = await westockKlines(
    {
      symbols: ["sh600000"],
      period: "day",
      start: "2026-09-10",
      end: "2026-09-14",
      adjustment: "qfq",
      limit: 4000,
    },
    undefined,
    vi.fn().mockResolvedValue(rows("sh600000")),
  );
  expect(result.limit).toBe(2000);
  expect(result.adjustment).toBe("qfq");
  expect(result.requests[0]?.args).toEqual([
    "kline",
    "sh600000",
    "--period",
    "day",
    "--limit",
    "2000",
    "--fq",
    "qfq",
    "--start",
    "2026-09-10",
    "--end",
    "2026-09-14",
  ]);
  expect(result.warnings.join()).toContain("2000");
});
it("propagates cancellation without producing unavailable results", async () => {
  const controller = new AbortController();
  controller.abort();
  const execute = vi.fn();
  await expect(
    westockKlines(
      { symbols: ["sh600000"], period: "day" },
      controller.signal,
      execute,
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it("recognizes alphanumeric concept identifiers from search", () =>
  expect(westockAssetKind("pt02GN2328")).toBe("sector"));
it("stops after cancellation during the first batch without retrying omissions", async () => {
  const controller = new AbortController();
  const execute = vi.fn().mockImplementation(async () => {
    controller.abort();
    return rows("sh000001");
  });
  await expect(
    westockKlines(
      { symbols: ["sh000001", "sh510300"], period: "day" },
      controller.signal,
      execute,
    ),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});
