import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import fixture from "./fixtures/catalog.json";
import {
  createExtendedQueries,
  type CoreQueries,
  type QuerySender,
} from "../src/queries";
import {
  adjustBars,
  classifyFundFlow,
  computePriceLimits,
  marketStatistics,
} from "../src/analytics";
import type { TdxBar, TdxQuote, TdxTransaction, TdxXdxr } from "../src/wire";

const bar = (date: string, close = 10): TdxBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  amount: 1000,
});
const trade = (time: string, volume = 1, direction = 0): TdxTransaction => ({
  time,
  volume,
  price: 10,
  direction,
  orders: null,
});
const quote = {
  symbol: "sh600000",
  price: 10,
  preClose: 10,
  open: 10,
  high: 10,
  low: 10,
  volume: 2,
  amount: 2000,
  quoteTime: "15:00:00.000",
} as TdxQuote;
const event: TdxXdxr = {
  date: "2026-09-11",
  category: 1,
  name: "除权除息",
  dividend: 1,
  bonusRatio: 0,
  rightsRatio: 0,
  rightsPrice: 0,
};
const core = (overrides: Partial<CoreQueries> = {}): CoreQueries => ({
  barPage: vi.fn(async () => []),
  indexBarPage: vi.fn(async () => []),
  securityQuotes: vi.fn(async () => [quote]),
  transactionPage: vi.fn(async () => []),
  historyTransactionPage: vi.fn(async () => []),
  xdxr: vi.fn(async () => []),
  ...overrides,
});
function api(
  base = core(),
  reply: (
    request: Buffer,
    reusable?: boolean,
  ) => Buffer | Promise<Buffer> = () => Buffer.from([0, 0]),
) {
  const send: QuerySender = async (build, parse, reusable) =>
    parse(await reply(build(), reusable));
  return createExtendedQueries(base, send);
}
const chunk = (data: Buffer) => Buffer.concat([Buffer.alloc(4), data]);

it("列表要求完整、证券页不可复用连接", async () => {
  const reusable: (boolean | undefined)[] = [];
  const a = api(core(), (req, reuse) => {
    reusable.push(reuse);
    return req.readUInt16LE(10) === 0x044e
      ? Buffer.from([1, 0])
      : Buffer.from(fixture.bodies.security, "hex");
  });
  expect((await a.stocks("sh"))[0]?.symbol).toBe("sh600000");
  expect(reusable).toEqual([undefined, false]);
});
it("证券列表提前结束或重复都拒绝", async () => {
  const make = (empty: boolean) =>
    api(core(), (req) =>
      req.readUInt16LE(10) === 0x044e
        ? Buffer.from([2, 0])
        : empty
          ? Buffer.from([0, 0])
          : Buffer.from(fixture.bodies.security, "hex"),
    );
  await expect(make(true).stocks("sh")).rejects.toThrow("提前结束");
  await expect(make(false).stocks("sh")).rejects.toThrow("重复");
});
it("报告文件按字节偏移拼接，正常末片终止", async () => {
  const offsets: number[] = [];
  const a = api(core(), (req) => {
    const offset = req.readUInt32LE(12);
    offsets.push(offset);
    return chunk(offset === 0 ? Buffer.alloc(30000, 1) : Buffer.from([2, 3]));
  });
  const file = await a.reportFile("tdxhy.cfg");
  expect(file.length).toBe(30002);
  expect(offsets).toEqual([0, 30000]);
  expect(file.subarray(-2)).toEqual(Buffer.from([2, 3]));
});
it("拒绝重复分片、超限文件和损坏 MD5", async () => {
  await expect(
    api(core(), () => chunk(Buffer.alloc(30000, 1))).reportFile("x"),
  ).rejects.toThrow("重复");
  await expect(
    api(core(), () => chunk(Buffer.alloc(30000, 1))).reportFile("x", 100),
  ).rejects.toThrow("maxBytes");
  const a = api(core(), (req) =>
    req.readUInt16LE(10) === 0x02c5
      ? Buffer.from(fixture.bodies.meta, "hex")
      : chunk(Buffer.from(fixture.bodies.block, "hex")),
  );
  await expect(a.blockInfo()).rejects.toThrow("MD5");
});
it("板块完整下载及 MD5 校验后返回分组/扁平成分", async () => {
  const bytes = Buffer.from(fixture.bodies.block, "hex"),
    meta = Buffer.from(fixture.bodies.meta, "hex");
  meta.write(createHash("md5").update(bytes).digest("hex"), 5, "ascii");
  const a = api(core(), (req) =>
    req.readUInt16LE(10) === 0x02c5 ? meta : chunk(bytes),
  );
  expect((await a.blockInfo())[0]?.codes).toEqual(["600000", "000750"]);
  expect(await a.blockMembers()).toHaveLength(2);
});
it("F10 内容短回包不会当作完整栏目", async () => {
  await expect(
    api(core(), () =>
      Buffer.from(fixture.bodies.content, "hex"),
    ).companyInfoContent("sh600000", "资料.txt", 5, 10),
  ).rejects.toThrow("不完整");
});
it("区间翻页合并重复边界并按闭区间输出", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce([bar("2026-09-11"), bar("2026-09-14")])
    .mockResolvedValueOnce([bar("2026-09-10"), bar("2026-09-11")]);
  const rows = await api(core({ barPage: read })).barsRange(
    "sh600000",
    "day",
    20260910,
    20260914,
    { pageSize: 2 },
  );
  expect(rows.map((x) => x.date)).toEqual([
    "2026-09-10",
    "2026-09-11",
    "2026-09-14",
  ]);
  expect(read.mock.calls.map((x) => x[2])).toEqual([0, 2]);
});
it("区间重复页、冲突、分页预算耗尽均拒绝", async () => {
  const a = api(
    core({
      barPage: vi.fn(async () => [bar("2026-09-11"), bar("2026-09-14")]),
    }),
  );
  await expect(
    a.barsRange("sh600000", "day", 20260910, 20260914, { pageSize: 2 }),
  ).rejects.toThrow("重复");
  await expect(
    a.barsRange("sh600000", "day", 20260910, 20260914, {
      pageSize: 2,
      maxPages: 1,
    }),
  ).rejects.toThrow("上限");
  const b = api(
    core({
      barPage: vi
        .fn()
        .mockResolvedValueOnce([bar("2026-09-11"), bar("2026-09-14")])
        .mockResolvedValueOnce([bar("2026-09-10"), bar("2026-09-11", 11)]),
    }),
  );
  await expect(
    b.barsRange("sh600000", "day", 20260910, 20260914, { pageSize: 2 }),
  ).rejects.toThrow("冲突");
});
it("指数自动路由，批量保留顺序和逐项错误", async () => {
  const stock = vi.fn(async (symbol: string) => {
    if (symbol === "sz000001") throw Error("unavailable");
    return [bar("2026-09-14")];
  });
  const index = vi.fn(async () => [bar("2026-09-14", 3000)]);
  const a = api(core({ barPage: stock, indexBarPage: index }));
  const rows = await a.kBatch(
    ["sh600000", "sz000001", "sh000001"],
    20260910,
    20260914,
  );
  expect(rows.map((r) => r.status)).toEqual(["data", "error", "data"]);
  expect(index).toHaveBeenCalledTimes(1);
  expect(rows.map((r) => r.symbol)).toEqual([
    "sh600000",
    "sz000001",
    "sh000001",
  ]);
});
it("复权按每股分红计算，前后锚点正确且不改原始量额", () => {
  const bars = [bar("2026-09-10"), bar("2026-09-11", 9)];
  const qfq = adjustBars(bars, [event], "qfq"),
    hfq = adjustBars(bars, [event], "hfq");
  expect(qfq.map((b) => b.close)).toEqual([9, 9]);
  expect(hfq.map((b) => b.close)).toEqual([10, 10]);
  expect(qfq[0]?.amount).toBe(bars[0]?.amount);
  expect(bars[0]?.close).toBe(10);
  expect(() => adjustBars(bars, [{ ...event, dividend: 20 }], "qfq")).toThrow();
});
it("复权封装先取前置历史而非从请求开始日累积", async () => {
  const read = vi.fn(async () => [bar("2026-09-10"), bar("2026-09-11", 9)]);
  const rows = await api(
    core({ barPage: read, xdxr: vi.fn(async () => [event]) }),
  ).kAdjusted("sh600000", "hfq", 20260911, 20260914);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.close).toBe(10);
});
it("复权不使用查询末日之后的除权事件", () => {
  const bars = [bar("2026-09-10"), bar("2026-09-11", 9), bar("2026-09-14", 9)];
  const future = { ...event, date: "2026-09-15", dividend: 20 };
  const qfq = adjustBars(bars, [event, future], "qfq"),
    hfq = adjustBars(bars, [event, future], "hfq");
  expect(qfq.map((row) => row.close)).toEqual([9, 9, 9]);
  expect(hfq.map((row) => row.close)).toEqual([10, 10, 10]);
  expect(qfq.map((row) => [row.volume, row.amount])).toEqual(
    bars.map((row) => [row.volume, row.amount]),
  );
});
it("资金流阈值边界、未知方向可追溯，主力与总净额正确", () => {
  const result = classifyFundFlow([
    trade("10:00", 1001),
    trade("10:01", 201, 1),
    trade("10:02", 41),
    trade("10:03", 40, 1),
    trade("10:04", 2, 2),
    trade("10:05", 3, 5),
  ]);
  expect(result.superIn).toBe(1001000);
  expect(result.largeOut).toBe(201000);
  expect(result.mediumIn).toBe(41000);
  expect(result.smallOut).toBe(40000);
  expect(result.mainNetInflow).toBe(800000);
  expect(result.totalNetInflow).toBe(801000);
  expect(result.neutralAmount).toBe(2000);
  expect(result.unknownAmount).toBe(3000);
});
it("资金流在取得完整分页后核对快照量，缺量不能成功", async () => {
  const page = vi
    .fn()
    .mockResolvedValueOnce([trade("10:00"), trade("10:01")])
    .mockResolvedValueOnce([]);
  const flow = await api(core({ transactionPage: page })).fundFlow("sh600000");
  expect(flow.volume).toBe(2);
  expect(page.mock.calls[1]?.[1]).toBe(2);
  await expect(api(core()).fundFlow("sh600000")).rejects.toThrow("覆盖不完整");
});
it("历史资金流直接失败时使用真实历史成交，并保留原因", async () => {
  const a = api(
    core({
      barPage: vi.fn(async () => [bar("2026-09-14")]),
      historyTransactionPage: vi
        .fn()
        .mockResolvedValueOnce([trade("10:00")])
        .mockResolvedValueOnce([]),
    }),
  );
  const [row] = await a.historyFundFlow("sh600000");
  expect(row?.source).toBe("transactions");
  expect(row?.smallIn).toBe(1000);
  expect(row?.fallbackReason).toContain("截断");
  await expect(
    api(
      core({ barPage: vi.fn(async () => [bar("2026-09-14")]) }),
    ).historyFundFlow("sh600000"),
  ).rejects.toThrow("为空");
});
it("成交重复页或无法分辨的边界重叠不静默去重", async () => {
  await expect(
    api(
      core({ transactionPage: vi.fn(async () => [trade("10:00")]) }),
    ).transactionsAll("sh600000"),
  ).rejects.toThrow("重复");
  const page = vi
    .fn()
    .mockResolvedValueOnce([trade("10:01"), trade("10:02")])
    .mockResolvedValueOnce([trade("10:00"), trade("10:01")]);
  await expect(
    api(core({ transactionPage: page })).transactionsAll("sh600000"),
  ).rejects.toThrow("重叠");
});
it("涨跌停显式上市窗口/品种，市场统计守恒", () => {
  expect(
    computePriceLimits("sh600000", 9.26, { listedDays: 10 }),
  ).toMatchObject({ up: 10.19, down: 8.33 });
  expect(computePriceLimits("sz300750", 100, { listedDays: 1 }).up).toBeNull();
  expect(computePriceLimits("bj920002", 10, { listedDays: 10 }).percent).toBe(
    30,
  );
  expect(computePriceLimits("sh000001", 100).up).toBeNull();
  expect(
    marketStatistics({
      ...quote,
      symbol: "sh880005",
      price: 2,
      preClose: 3,
      low: 1,
      high: 7,
    }),
  ).toMatchObject({ up: 2, down: 3, neutral: 1, unclassified: 1 });
  expect(() =>
    marketStatistics({ ...quote, symbol: "sh880005", high: 1 }),
  ).toThrow("守恒");
});

it("停牌跨多个除权日时依次调整参考价", () => {
  const result = adjustBars(
    [bar("2026-09-10"), bar("2026-09-14", 8)],
    [event, { ...event, date: "2026-09-12" }],
    "qfq",
  );
  result.forEach((b) => expect(b.close).toBeCloseTo(8, 10));
});
it("批量使用独立 worker，并在部分失败时关闭全部 worker", async () => {
  const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
  let at = 0;
  const factory = vi.fn(() => ({
    barsRange: async (symbol: string) => {
      if (symbol === "sz000001") throw Error("broken");
      return [bar("2026-09-14")];
    },
    close: closes[at++]!,
  }));
  const query = createExtendedQueries(
    core(),
    async () => {
      throw Error("unexpected");
    },
    factory,
  );
  const result = await query.kBatch(
    ["sh600000", "sz000001", "sz300750"],
    20260910,
    20260914,
    2,
  );
  expect(result.map((r) => r.status)).toEqual(["data", "error", "data"]);
  expect(factory).toHaveBeenCalledTimes(2);
  closes.forEach((close) => expect(close).toHaveBeenCalledOnce());
});
