import { expect, it, vi } from "vitest";
import type { ThsdkInvoker } from "~/server/data-sources/thsdk/thsdk-adapter";
import {
  thsdkBlockConstituents,
  thsdkSecurityBlocks,
} from "~/server/data-sources/thsdk/thsdk-blocks";
import { ThsdkError } from "~/server/data-sources/thsdk/thsdk-contract";
import {
  thsdkCallAuctionUnusual,
  thsdkLimitUpAnalysis,
  thsdkMarketChangeEvents,
  thsdkRealtimeSignal,
} from "~/server/data-sources/thsdk/thsdk-sentiment";

const { databaseAccess } = vi.hoisted(() => ({
  databaseAccess: vi.fn(() => {
    throw new Error("Unexpected database access");
  }),
}));
vi.mock("~/server/db", () => ({
  get: databaseAccess,
  put: databaseAccess,
  sqlite: databaseAccess,
}));
vi.mock("better-sqlite3", () => ({ default: databaseAccess }));
vi.mock("~/server/market/limit-sentiment", () => {
  throw new Error("THSDK must not load the existing limit sentiment module");
});

// Market fields copied from probe-result.json. Preview arrays are restored
// using the recorded first and last entries, so the suite runs in a clean checkout.
const security = { code: "600519", market: "USHA" };
const attribution = {
  security,
  date: "20261119",
  status_code: "0",
  status_message: "ok",
};
const marketChange = {
  title: "881274:影视院线",
  main_title: "影视院线板块大幅低开",
  type: "非权重",
  unresolved_codes: ["603103:横店影视", "600715:文投控股", "002905:金逸影视"],
  source_security_list: "603103:横店影视,600715:文投控股,002905:金逸影视",
  third_party_id: "681982822",
  published_at: "2026-11-19T09:29:00+08:00",
};
const industry = {
  security,
  industry: { security: { code: "881273", market: "URFI" }, name: "白酒" },
};
const concepts = {
  security,
  isvalid: true,
  tags: [{ concept: { name: "超级品牌" }, kind: "bond", score: 100, order: 1 }],
};
const memberships = [
  {
    block: { id: 129, name: "贵州" },
    index: { security: { code: "882010", market: "URFI" }, name: "贵州" },
    count: 35,
    kind: "2",
  },
  { block: { id: 398114, name: "沪深300" }, count: 300, kind: "0" },
];
const noData = new ThsdkError("no_data", "no data is available");

function invoker() {
  const mock = vi.fn<ThsdkInvoker>();
  const invoke: ThsdkInvoker = async <T>(...args: Parameters<ThsdkInvoker>) =>
    (await mock(...args)) as T;
  return { mock, invoke };
}

it("maps the real status-only limit-up attribution without inventing a reason or counts", async () => {
  const { mock, invoke } = invoker();
  const signal = new AbortController().signal;
  mock.mockResolvedValueOnce(attribution);
  const result = await thsdkLimitUpAnalysis(
    "sh600519",
    "2026-11-19",
    signal,
    invoke,
  );
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "analyze_security_limit_up",
    { security, date: "2026-11-19T00:00:00+08:00" },
    { signal },
  );
  expect(result).toEqual({
    source: "thsdk-hq",
    version: expect.any(String),
    fetchedAt: expect.any(Number),
    symbol: "sh600519",
    date: "2026-11-19",
    statusMessage: "ok",
    available: false,
    reason: null,
    reasons: [],
    concepts: [],
    firstLimitUpTime: null,
    lastLimitUpTime: null,
    openCount: null,
    streakDays: null,
    highDays: null,
    limitUpType: null,
  });
  // The native result exposes text when attribution is available.
  mock.mockResolvedValueOnce({ ...attribution, text: "板块带动" });
  await expect(
    thsdkLimitUpAnalysis("sh600519", undefined, signal, invoke),
  ).resolves.toMatchObject({
    date: "2026-11-19",
    available: true,
    reason: "板块带动",
    reasons: ["板块带动"],
  });
  expect(mock).toHaveBeenLastCalledWith(
    "analyze_security_limit_up",
    { security },
    { signal },
  );
});

it("returns a graceful empty realtime result for the Wave 0 after-hours no_data", async () => {
  const { mock, invoke } = invoker();
  mock.mockRejectedValueOnce(noData);
  const markets = ["USHA", "USZA"] as const;
  await expect(
    thsdkRealtimeSignal("limit_up", [...markets], undefined, invoke),
  ).resolves.toMatchObject({
    signal: "limit_up",
    markets,
    available: false,
    emptyReason: "当前非交易时段或暂无该实时信号样本",
    items: [],
  });
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_securities_by_realtime_signal",
    { markets, signal: "limit_up" },
    { signal: undefined },
  );
});

it("maps native realtime field cells and retains a genuine zero change", async () => {
  const { mock, invoke } = invoker();
  // Constructed using the SDK's RealtimeSignalSecurity and RealtimeStatsCell layout.
  mock.mockResolvedValueOnce([
    {
      security,
      fields: [
        { name: "最新价", value: "NaN" },
        { name: "涨幅", value: 0 },
        { name: "首次涨停时间", value: "09:30:00" },
      ],
    },
  ]);
  await expect(
    thsdkRealtimeSignal("limit_up", ["USHA"], undefined, invoke),
  ).resolves.toMatchObject({
    available: true,
    emptyReason: null,
    items: [
      {
        ...security,
        symbol: "sh600519",
        name: null,
        price: null,
        changePct: 0,
        signalTime: "09:30:00",
        reason: null,
      },
    ],
  });
});

it("parses and deduplicates unresolved and source-list securities without guessing unknown markets", async () => {
  const { mock, invoke } = invoker();
  mock.mockResolvedValueOnce([
    marketChange,
    {
      main_title: "板块异动",
      source_security_list:
        "920001:北交所,400001:非上市股,830799:北交所 B,301178:深圳,700001:未知",
      securities: [{ code: "301178", market: "USHA" }],
    },
  ]);
  const result = await thsdkMarketChangeEvents(undefined, invoke);
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_market_change_events",
    null,
    { signal: undefined },
  );
  expect(result.items[0]).toEqual({
    id: "681982822",
    title: "881274:影视院线",
    mainTitle: "影视院线板块大幅低开",
    eventType: "非权重",
    publishedAt: "2026-11-19T09:29:00+08:00",
    relatedSecurities: [
      { symbol: "sh603103", code: "603103", name: "横店影视" },
      { symbol: "sh600715", code: "600715", name: "文投控股" },
      { symbol: "sz002905", code: "002905", name: "金逸影视" },
    ],
  });
  expect(result.items[1]?.relatedSecurities).toEqual([
    { symbol: "bj920001", code: "920001", name: "北交所" },
    { symbol: null, code: "400001", name: "非上市股" },
    { symbol: "bj830799", code: "830799", name: "北交所 B" },
    { symbol: null, code: "301178", name: "深圳" },
    { symbol: null, code: "700001", name: "未知" },
  ]);
});

it("sends an auction trade date in native format, preserves the Wave 0 timeout and degrades no_data", async () => {
  const { mock, invoke } = invoker();
  mock.mockRejectedValueOnce(new ThsdkError("timeout", "request timed out"));
  await expect(
    thsdkCallAuctionUnusual("USHA", "2026-11-19", undefined, invoke),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_market_call_auction_unusual_events",
    { market: "USHA", trade_date: "20261119" },
    { signal: undefined },
  );
  mock.mockRejectedValueOnce(noData);
  await expect(
    thsdkCallAuctionUnusual("USZA", undefined, undefined, invoke),
  ).resolves.toMatchObject({
    market: "USZA",
    tradeDate: null,
    available: false,
    emptyReason: expect.any(String),
    items: [],
  });
  // Constructed using the SDK's ShortTermEvent layout.
  mock.mockResolvedValueOnce([
    {
      security,
      name: "贵州茅台",
      event_type: 1,
      event_name: "高开",
      description: "集合竞价高开",
      time: "2026-11-19T09:25:00+08:00",
      gains: 2.5,
    },
  ]);
  await expect(
    thsdkCallAuctionUnusual("USHA", undefined, undefined, invoke),
  ).resolves.toMatchObject({
    available: true,
    items: [
      {
        symbol: "sh600519",
        code: "600519",
        name: "贵州茅台",
        eventType: "1",
        title: "高开",
        detail: "集合竞价高开",
        eventTime: "2026-11-19T09:25:00+08:00",
        changePct: 2.5,
      },
    ],
  });
});

it("combines all three real block profile samples with their distinct identities", async () => {
  const { mock, invoke } = invoker();
  mock
    .mockResolvedValueOnce(industry)
    .mockResolvedValueOnce(concepts)
    .mockResolvedValueOnce(memberships);
  const result = await thsdkSecurityBlocks("sh600519", undefined, invoke);
  expect(mock.mock.calls).toEqual([
    ["get_security_industry", { security }, { signal: undefined }],
    ["get_security_concept_tags", { security }, { signal: undefined }],
    ["list_security_block_memberships", { security }, { signal: undefined }],
  ]);
  expect(result).toMatchObject({
    symbol: "sh600519",
    industry: { code: "881273", name: "白酒" },
    conceptTags: [{ name: "超级品牌", kind: "bond", score: 100, order: 1 }],
    memberships: [
      {
        blockId: 129,
        blockName: "贵州",
        indexCode: "882010",
        count: 35,
        kind: "2",
      },
      {
        blockId: 398114,
        blockName: "沪深300",
        indexCode: null,
        count: 300,
        kind: "0",
      },
    ],
  });
});

it("keeps block memberships when the industry or concepts return no_data", async () => {
  const { mock, invoke } = invoker();
  mock
    .mockRejectedValueOnce(noData)
    .mockRejectedValueOnce(noData)
    .mockResolvedValueOnce(memberships);
  await expect(
    thsdkSecurityBlocks("sh600519", undefined, invoke),
  ).resolves.toMatchObject({
    industry: null,
    conceptTags: [],
    memberships: [expect.any(Object), expect.any(Object)],
  });
});

it.each([
  "auth_required",
  "auth_failed",
  "disabled",
  "not_configured",
  "session_expired",
  "dll_invalid",
] as const)(
  "propagates %s from the first block read before starting the other reads",
  async (code) => {
    const { mock, invoke } = invoker();
    mock.mockRejectedValueOnce(new ThsdkError(code, code));
    await expect(
      thsdkSecurityBlocks("sh600519", undefined, invoke),
    ).rejects.toMatchObject({ code });
    expect(mock).toHaveBeenCalledTimes(1);
  },
);

it("fails immediately on a subsequent auth error while a sibling read is pending", async () => {
  const { mock, invoke } = invoker();
  mock
    .mockResolvedValueOnce(industry)
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockRejectedValueOnce(
      new ThsdkError("session_expired", "session expired"),
    );
  await expect(
    thsdkSecurityBlocks("sh600519", undefined, invoke),
  ).rejects.toMatchObject({ code: "session_expired" });
  expect(mock).toHaveBeenCalledTimes(3);
});

it("requests block constituents by block ID and keeps price and percentage unknown", async () => {
  const { mock, invoke } = invoker();
  // Constructed using the SDK's BlockConstituent layout.
  mock.mockResolvedValueOnce([
    { security, full_code: "USHA600519", name: "贵州茅台" },
  ]);
  await expect(
    thsdkBlockConstituents({ blockId: 129, limit: 5 }, undefined, invoke),
  ).resolves.toMatchObject({
    blockId: 129,
    blockName: null,
    items: [
      {
        ...security,
        symbol: "sh600519",
        name: "贵州茅台",
        price: null,
        changePct: null,
      },
    ],
  });
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    "list_block_constituents",
    { block: { id: 129 }, sort_begin: 0, sort_count: 5 },
    { signal: undefined },
  );
});

it.each([{ id: 300123 }, { block: { id: 300123 } }])(
  "uses the resolved block ID for a named hot block (%j)",
  async (resolved) => {
    const { mock, invoke } = invoker();
    const signal = new AbortController().signal;
    mock.mockResolvedValueOnce(resolved).mockResolvedValueOnce([]);
    await thsdkBlockConstituents(
      { blockId: 885864, blockName: " 光刻胶 ", limit: 5 },
      signal,
      invoke,
    );
    expect(mock.mock.calls).toEqual([
      ["resolve_block", { name: "光刻胶" }, { signal }],
      [
        "list_block_constituents",
        { block: { id: 300123 }, sort_begin: 0, sort_count: 5 },
        { signal },
      ],
    ]);
  },
);

it.each(["no_data", "invalid_request", "invalid_response"] as const)(
  "falls back to the supplied block ID when name resolution returns %s",
  async (code) => {
    const { mock, invoke } = invoker();
    mock
      .mockRejectedValueOnce(new ThsdkError(code, code))
      .mockResolvedValueOnce([]);
    await thsdkBlockConstituents(
      { blockId: 885864, blockName: "光刻胶", limit: 5 },
      undefined,
      invoke,
    );
    expect(mock.mock.calls).toEqual([
      ["resolve_block", { name: "光刻胶" }, { signal: undefined }],
      [
        "list_block_constituents",
        { block: { id: 885864 }, sort_begin: 0, sort_count: 5 },
        { signal: undefined },
      ],
    ]);
  },
);

it.each([
  "auth_required",
  "auth_failed",
  "disabled",
  "cancelled",
  "session_expired",
] as const)(
  "propagates %s from name resolution without requesting constituents",
  async (code) => {
    const { mock, invoke } = invoker();
    mock.mockRejectedValueOnce(new ThsdkError(code, code));
    await expect(
      thsdkBlockConstituents(
        { blockId: 885864, blockName: "光刻胶", limit: 5 },
        undefined,
        invoke,
      ),
    ).rejects.toMatchObject({ code });
    expect(mock).toHaveBeenCalledExactlyOnceWith(
      "resolve_block",
      { name: "光刻胶" },
      { signal: undefined },
    );
  },
);

it("runs sentiment mapping without importing the canonical limit sentiment module or touching SQLite", async () => {
  const { mock, invoke } = invoker();
  mock
    .mockResolvedValueOnce(attribution)
    .mockRejectedValueOnce(noData)
    .mockResolvedValueOnce([marketChange])
    .mockResolvedValueOnce([]);
  await Promise.all([
    thsdkLimitUpAnalysis("sh600519", undefined, undefined, invoke),
    thsdkRealtimeSignal("limit_up", ["USHA"], undefined, invoke),
    thsdkMarketChangeEvents(undefined, invoke),
    thsdkCallAuctionUnusual("USHA", undefined, undefined, invoke),
  ]);
  expect(databaseAccess).not.toHaveBeenCalled();
});
