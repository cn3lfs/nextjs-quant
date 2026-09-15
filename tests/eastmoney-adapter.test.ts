import { afterEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/eastmoney-index-day.json";
import { eastmoneyKlines } from "../src/server/eastmoney-adapter";
import { onlinePeriodHistory } from "../src/server/chart-history";

afterEach(() => vi.unstubAllGlobals());
const response = () => new Response(JSON.stringify(fixture));
it("限量不依赖供应商 lmt，原始返回不足也不宣称历史完整", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const result = await eastmoneyKlines(
    { symbols: ["sh000001"], period: "day", limit: 2 },
    undefined,
    fetcher,
  );
  expect(result.items[0]).toMatchObject({
    status: "ok",
    bars: fixture.data.klines
      .slice(-2)
      .map((line) => expect.objectContaining({ date: line.split(",")[0] })),
    returnedCount: 3,
    historyExhausted: false,
  });
  const url = new URL(String(fetcher.mock.calls[0]?.[0]));
  expect(url.searchParams.get("fqt")).toBe("0");
  vi.stubGlobal("fetch", fetcher);
  expect((await onlinePeriodHistory("sh000001", "day", 1)).bars).toHaveLength(
    1,
  );
});
it("批量拒绝串码并保留其他证券状态；不向另一源回退", async () => {
  const fetcher = vi.fn(async () => response());
  const result = await eastmoneyKlines(
    { symbols: ["sh000001", "sz000001", "pt01801081"], period: "day" },
    undefined,
    fetcher,
  );
  expect(result.items.map((item) => item.status)).toEqual([
    "ok",
    "invalid",
    "unsupported",
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("北交所和原生板块使用各自市场映射", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const secid = new URL(String(input)).searchParams.get("secid")!;
    const [market, code] = secid.split(".");
    return new Response(
      JSON.stringify({
        ...fixture,
        data: { ...fixture.data, market: Number(market), code },
      }),
    );
  });
  const result = await eastmoneyKlines(
    { symbols: ["bj920002", "emBK0475"], period: "week" },
    undefined,
    fetcher,
  );
  expect(result.items.map((item) => item.status)).toEqual(["ok", "ok"]);
  expect(
    fetcher.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("secid"),
    ),
  ).toEqual(["0.920002", "90.BK0475"]);
});
it("日期和数量边界先校验，取消终止后续请求", async () => {
  const fetcher = vi.fn(async () => response());
  for (const extra of [
    { limit: 0 },
    { start: "2026-02-30" },
    { start: "2026-09-11", end: "2026-09-10" },
  ])
    await expect(
      eastmoneyKlines(
        { symbols: ["sh000001"], period: "day", ...extra },
        undefined,
        fetcher,
      ),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(
    eastmoneyKlines(
      { symbols: ["sh000001"], period: "day" },
      controller.signal,
      fetcher,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("HTTP 限流不重试，错误和空行情不能当成功", async () => {
  const fetcher = vi.fn(async () => new Response("limited", { status: 429 }));
  expect(
    (
      await eastmoneyKlines(
        { symbols: ["sh000001"], period: "day" },
        undefined,
        fetcher,
      )
    ).items[0],
  ).toMatchObject({
    status: "unavailable",
    message: expect.stringContaining("429"),
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const data of [
    null,
    { ...fixture.data, klines: [] },
    { ...fixture.data, klines: ["2026-02-30,1,1,1,1,1,1"] },
  ]) {
    const result = await eastmoneyKlines(
      { symbols: ["sh000001"], period: "day" },
      undefined,
      async () => new Response(JSON.stringify({ ...fixture, data })),
    );
    expect(result.items[0]?.status).not.toBe("ok");
  }
});

it("请求范围和复权参数可追踪，超大响应及时停止读取", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const result = await eastmoneyKlines(
    {
      symbols: ["sh000001"],
      period: "day",
      start: "2026-09-11",
      end: "2026-09-14",
      adjustment: "qfq",
    },
    undefined,
    fetcher,
  );
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get("beg")).toBe("20260911");
  expect(url.searchParams.get("end")).toBe("20260914");
  expect(url.searchParams.get("fqt")).toBe("1");
  if (result.items[0]?.status === "ok")
    expect(
      result.items[0].bars.every(
        (bar) => bar.date >= "2026-09-11" && bar.date <= "2026-09-14",
      ),
    ).toBe(true);
  const oversized = await eastmoneyKlines(
    { symbols: ["sh000001"], period: "day" },
    undefined,
    async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
  );
  expect(oversized.items[0]).toMatchObject({
    status: "unavailable",
    message: expect.stringContaining("上限"),
  });
});
