import { expect, it, vi } from "vitest";
import {
  THSDK_NEWS_FLASH_MAX_PAGE,
  thsdkNewsFlashInputSchema,
  thsdkWencaiQueryInputSchema,
} from "~/lib/market/thsdk-extensions";
import type { ThsdkInvoker } from "~/server/data-sources/thsdk/thsdk-adapter";
import { ThsdkError } from "~/server/data-sources/thsdk/thsdk-contract";
import {
  thsdkNewsFlash,
  thsdkResearchReports,
} from "~/server/data-sources/thsdk/thsdk-news";
import {
  thsdkWencaiHotBlocks,
  thsdkWencaiQuery,
} from "~/server/data-sources/thsdk/thsdk-wencai";

// Market fields from the first saved entries in the Wave 0 response previews.
const security = { code: "000158", market: "USZA" };
const query = "连续3日上涨";
const queryField = {
  query_key: query,
  index_name: "连续上涨天数",
  show_name: "连续上涨天数",
  display_name: "连续上涨天数[20261119]",
  timestamp: "20261119",
  index: 2,
  unit: "天",
  type: "LONG",
};
const cell = {
  name: query,
  type: "LONG",
  key_index: 2,
  timestamp: "20261119",
  value: 3,
};
const wencaiRow = {
  security,
  code: "000158",
  market: "USZA",
  full_code: "USZA000158",
  cells: [{ name: "code", type: "STR", value: "000158" }, cell],
};
const hotBlock = {
  block: { id: 885864, name: "光刻胶" },
  order: 1,
  rate: "137810.0",
  tag: "5家涨停",
  hot_tag: "5天4次上榜",
  etf_name: "半导体设备ETF",
};
const flash = {
  id: "5715763",
  seq: "682019070",
  title: "新开发银行在华发行熊猫债规模突破1000亿元",
  digest:
    "总部位于上海的新开发银行19日晚间宣布，最新在中国银行间债券市场发行规模为80亿元人民币的熊猫债券。至此，新开发银行累计在华发行熊猫债规模突破1000亿元人民币大关，被视为新开发银行和熊猫债市场的重要里程碑。(新华社)",
  url: "https://news.10jqka.com.cn/20261119/c682019070.shtml",
  color: "1",
  tag: "港股,A股",
  tags: [
    { id: "21105", name: "港股" },
    { id: "21103", name: "A股" },
  ],
  ctime: "1795097615",
  rtime: "1795097615",
  import: "0",
};

function invoker() {
  const mock = vi.fn<ThsdkInvoker>();
  const invoke: ThsdkInvoker = async <T>(...args: Parameters<ThsdkInvoker>) =>
    (await mock(...args)) as T;
  return { mock, invoke };
}

it("parses the frozen defaults and bounds with Zod 3", () => {
  expect(thsdkWencaiQueryInputSchema.parse({ query: " 连续3日上涨 " })).toEqual(
    { query, limit: 30 },
  );
  expect(
    thsdkWencaiQueryInputSchema.safeParse({ query, limit: 101 }).success,
  ).toBe(false);
  expect(thsdkNewsFlashInputSchema.parse({ tag: " A股 " })).toEqual({
    page: 1,
    pageSize: 20,
    tag: "A股",
  });
  expect(thsdkNewsFlashInputSchema.safeParse({ pageSize: 51 }).success).toBe(
    false,
  );
  expect(THSDK_NEWS_FLASH_MAX_PAGE).toBe(20);
  expect(
    thsdkNewsFlashInputSchema.parse({ page: THSDK_NEWS_FLASH_MAX_PAGE }).page,
  ).toBe(20);
  expect(thsdkNewsFlashInputSchema.safeParse({ page: 21 }).success).toBe(false);
});

it("preserves Wencai field identity and joins the real numeric cell by index and date", async () => {
  const { mock, invoke } = invoker();
  const signal = new AbortController().signal;
  mock.mockResolvedValueOnce({
    query,
    fields: [queryField],
    securities: [{ security, source_market_id: "33", source_key: "33:000158" }],
    rows: [wencaiRow],
  });
  const result = await thsdkWencaiQuery(
    { query, markets: [], limit: 3 },
    signal,
    invoke,
  );
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "query_wencai",
    { query, limit: 3 },
    { signal },
  );
  expect(result).toMatchObject({
    query,
    source: "thsdk-hq",
    fields: [
      { key: query, label: "连续上涨天数[20261119]", unit: "天", type: "LONG" },
    ],
    rows: [
      { ...security, symbol: "sz000158", name: null, values: { [query]: 3 } },
    ],
  });
});

it.each([
  { label: "omitted", table: {} },
  { label: "empty", table: { fields: [], rows: [] } },
  { label: "null", table: { fields: null, rows: null } },
])("returns Wencai matches when the table is $label", async ({ table }) => {
  const { mock, invoke } = invoker();
  mock.mockResolvedValueOnce({
    ...table,
    securities: [{ security, name: "常山北明" }],
  });
  const result = await thsdkWencaiQuery({ query, limit: 3 }, undefined, invoke);
  expect(result.fields).toEqual([]);
  expect(result.rows).toEqual([
    { ...security, symbol: "sz000158", name: "常山北明", values: {} },
  ]);
});

it("keeps Wencai row values and appends unmatched securities before limiting the result", async () => {
  const { mock, invoke } = invoker();
  const index = { code: security.code, market: "USHI" };
  mock.mockResolvedValueOnce({
    fields: [queryField],
    rows: [wencaiRow],
    securities: [
      { security: index },
      { security, name: "常山北明" },
      { security: { code: "600519", market: "USHA" } },
    ],
  });
  const result = await thsdkWencaiQuery({ query, limit: 2 }, undefined, invoke);
  expect(result.rows).toEqual([
    { ...security, symbol: "sz000158", name: "常山北明", values: { [query]: 3 } },
    { ...index, symbol: "sh000158", name: null, values: { [query]: null } },
  ]);
});

it("keeps omitted, invalid and nonfinite Wencai numbers null while preserving true zero", async () => {
  const { mock, invoke } = invoker();
  mock.mockResolvedValueOnce({
    fields: [queryField],
    rows: [
      { security, cells: [] },
      ...[undefined, "", "--", Number.NaN, Infinity, 0].map((value) => ({
        security,
        cells: [{ ...cell, value }],
      })),
    ],
  });
  const result = await thsdkWencaiQuery(
    { query, markets: ["USZA"], limit: 10 },
    undefined,
    invoke,
  );
  expect(result.rows.map(({ values }) => values[query])).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
    0,
  ]);
  expect(mock).toHaveBeenLastCalledWith(
    "query_wencai",
    { query, markets: ["USZA"], limit: 10 },
    { signal: undefined },
  );
});

it("maps the real Wencai hot-block sample and leaves missing ranking and malformed rate null", async () => {
  const { mock, invoke } = invoker();
  mock.mockResolvedValueOnce({
    kind: "concept",
    status_code: 0,
    items: [hotBlock, { block: { id: 885865, name: "缺失指标" }, rate: " " }],
  });
  await expect(
    thsdkWencaiHotBlocks("concept", undefined, invoke),
  ).resolves.toMatchObject({
    kind: "concept",
    items: [
      {
        blockId: 885864,
        name: "光刻胶",
        order: 1,
        rate: 137810,
        tag: "5家涨停",
        hotTag: "5天4次上榜",
        etfName: "半导体设备ETF",
      },
      { blockId: 885865, order: null, rate: null },
    ],
  });
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_wencai_hot_blocks",
    { kind: "concept" },
    { signal: undefined },
  );
});

it("maps the real 7×24 flash and sends the requested page, size, and tag", async () => {
  const { mock, invoke } = invoker();
  mock.mockResolvedValueOnce({
    traversal: "page",
    code: "200",
    total: "15030",
    items: [flash],
    filters: [{ id: "21101", name: "全部", bury: "all" }],
  });
  await expect(
    thsdkNewsFlash({ page: 1, pageSize: 3, tag: "A股" }, undefined, invoke),
  ).resolves.toMatchObject({
    source: "thsdk-hq",
    page: 1,
    pageSize: 3,
    total: 15030,
    filters: [{ id: "21101", name: "全部" }],
    items: [
      {
        id: "5715763",
        seq: "682019070",
        title: flash.title,
        digest: flash.digest,
        url: flash.url,
        tags: ["港股", "A股"],
        publishedAt: 1795097615000,
        important: false,
      },
    ],
  });
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_news_flash_items",
    { traversal: "page", page: 1, page_size: 3, tag: "A股" },
    { signal: undefined },
  );
});

it("strips unsafe flash URLs and leaves missing or invalid timestamps and totals null", async () => {
  const { mock, invoke } = invoker();
  mock.mockResolvedValueOnce({
    total: "NaN",
    items: [
      { ...flash, url: "javascript:alert(1)", ctime: undefined },
      {
        ...flash,
        id: "2",
        url: "data:text/html,hello",
        ctime: "",
        import: "1",
      },
      { ...flash, id: "3", url: "not a URL", ctime: null },
    ],
  });
  const result = await thsdkNewsFlash(
    { page: 1, pageSize: 3 },
    undefined,
    invoke,
  );
  expect(result.total).toBeNull();
  expect(
    result.items.map(({ url, publishedAt, important }) => ({
      url,
      publishedAt,
      important,
    })),
  ).toEqual([
    { url: null, publishedAt: null, important: false },
    { url: null, publishedAt: null, important: true },
    { url: null, publishedAt: null, important: false },
  ]);
});

it("requests reports with the exact traversal and filters report URLs to HTTP(S)", async () => {
  const { mock, invoke } = invoker();
  const signal = new AbortController().signal;
  // Wave 0 recorded invalid_request for traversal containing page and page_size.
  // The successful fixture follows SecurityResearchReportsResult in the SDK.
  const report = {
    item_id: "abc",
    time: "2026-11-19",
    title: "贵州茅台研究报告",
    org: "研究所",
    researcher: "研究员",
    abstract: "报告摘要",
    url: "http://example.test/report",
  };
  mock.mockResolvedValueOnce({
    items: [
      report,
      { ...report, item_id: "def", url: "JaVa\tsCrIpT:alert(1)" },
      { ...report, item_id: "ghi", url: "file:///C:/test.html" },
    ],
  });
  const result = await thsdkResearchReports("sh600519", signal, invoke);
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_security_research_reports",
    {
      security: { code: "600519", market: "USHA" },
      traversal: { mode: "page" },
    },
    { signal },
  );
  expect(result.symbol).toBe("sh600519");
  expect(result.items[0]).toEqual({
    id: "abc",
    publishedAt: "2026-11-19",
    title: report.title,
    org: report.org,
    researcher: report.researcher,
    abstract: report.abstract,
    url: report.url,
  });
  expect(result.items.slice(1).map(({ url }) => url)).toEqual([null, null]);
  mock.mockRejectedValueOnce(
    new ThsdkError("invalid_request", "params are invalid"),
  );
  await expect(
    thsdkResearchReports("sh600519", undefined, invoke),
  ).rejects.toMatchObject({ code: "invalid_request" });
});
