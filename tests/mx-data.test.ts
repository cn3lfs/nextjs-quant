import { expect, it, vi } from "vitest";
import {
  mxKinds,
  mxQueryPlan,
  mxQuerySchema,
  mxScopeWarnings,
} from "../src/lib/mx-data";
import {
  mxConnection,
  parseMxResponse,
  queryMxData,
} from "../src/server/data-sources/mx/mx-data";

const input = {
  kind: "ashare" as const,
  subjects: ["宁德时代（300750.SZ）"],
  timeRange: "2026-09-10至2026-09-14",
  request: "不复权收盘价与成交量，注明单位",
};
const envelope = (data: unknown[], message?: string) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        data,
        ...(message === undefined ? {} : { message }),
      }),
    },
  ],
});
const table = {
  sheetName: "宁德时代(300750.SZ)",
  columns: ["宁德时代(300750.SZ)", "2026-09-14(日)"],
  items: [
    ["收盘价", "337.11元"],
    ["成交量", "2618万股"],
  ],
};
it("新闻公告混类和越界日期显式提示，原始结果不被删改", async () => {
  const data = [
    {
      sheetName: "原始结果",
      columns: ["标题", "发布时间", "信息类型"],
      items: [
        ["半年度报告", "2026-07-25 00:19:27", "NOTICE"],
        ["相关新闻", "2026-09-11 09:00:00", "INV_NEWS"],
      ],
    },
  ];
  const requested = {
    ...input,
    kind: "notice" as const,
    timeRange: "2026-08-01至2026-09-14",
  };
  const result = await queryMxData(
    requested,
    undefined,
    vi.fn().mockResolvedValue(envelope(data)),
  );
  expect(result.status).toBe("with-message");
  expect(result.scopeWarnings).toHaveLength(2);
  expect(result.data).toEqual(data);
  expect(
    mxScopeWarnings({ ...requested, kind: "news" }, data).join(),
  ).toContain("信息类型");
  expect(
    mxScopeWarnings({ ...requested, timeRange: "最近一个月" }, [
      { ...data[0], items: [data[0]!.items[0]] },
    ]),
  ).toEqual([]);
});
it.each(Object.entries(mxKinds))(
  "routes %s only to its specific read-only tool",
  (kind, item) => {
    const plan = mxQueryPlan({ ...input, kind: kind as keyof typeof mxKinds });
    expect(plan.tool).toBe(item.tool);
    expect(plan.query).toContain(input.subjects[0]);
    expect(plan.query).toContain(input.timeRange);
  },
);
it("requires target, period, single category and a bounded unique target list", () => {
  for (const invalid of [
    { ...input, kind: "unknown" },
    { ...input, subjects: [] },
    { ...input, subjects: [" "] },
    { ...input, subjects: ["a", "a"] },
    { ...input, subjects: Array.from({ length: 501 }, (_, i) => String(i)) },
    { ...input, timeRange: " " },
    { ...input, request: " " },
    { ...input, extra: true },
  ])
    expect(mxQuerySchema.safeParse(invalid).success).toBe(false);
});
it("preserves rounded values, missing successful message and table metadata without making candles", async () => {
  const execute = vi.fn().mockResolvedValue(envelope([table]));
  const result = await queryMxData(input, undefined, execute);
  expect(result.data).toEqual([table]);
  expect(result.status).toBe("ok");
  expect(result.source).toBe("eastmoney/mx-ds-mcp");
  expect(result).not.toHaveProperty("bars");
  expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    "mx_ashare_finance_data",
    mxQueryPlan(input).query,
    undefined,
  );
});
it.each([
  { data: [], message: "", status: "empty" },
  { data: [], message: "请求失败：服务异常", status: "error" },
  { data: [table], message: "只返回部分数据", status: "with-message" },
])(
  "keeps $status separate and retains the provider message",
  ({ data, message, status }) => {
    expect(parseMxResponse(envelope(data, message))).toEqual({
      data,
      message,
      status,
    });
  },
);
it("rejects protocol errors, invalid JSON, missing data and unknown block layouts", () => {
  for (const raw of [
    { ...envelope([]), isError: true },
    { content: [] },
    { content: [{ type: "text", text: "oops" }] },
    { content: [{ type: "text", text: '{"message":"failure"}' }] },
    { content: [{ type: "image" }] },
  ])
    expect(() => parseMxResponse(raw)).toThrow();
});
it("does not retry failures or canceled queries", async () => {
  const fail = vi.fn().mockRejectedValue(new Error("401"));
  await expect(queryMxData(input, undefined, fail)).rejects.toThrow("401");
  expect(fail).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  const execute = vi.fn();
  await expect(
    queryMxData(input, controller.signal, execute),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it("changes provenance when the requested time range changes", async () => {
  const execute = vi.fn().mockResolvedValue(envelope([table]));
  const a = await queryMxData(input, undefined, execute);
  const b = await queryMxData(
    { ...input, timeRange: "2026-09-14" },
    undefined,
    execute,
  );
  expect(a.hash).not.toBe(b.hash);
});
it("reads only allowlisted endpoint and credentials without running configured commands", () => {
  const config = {
    mcp_servers: {
      "mx-ds-mcp": {
        command: "DO-NOT-RUN",
        args: [
          "--url",
          "https://mxapi.eastmoney.com/mxds/mcp",
          "--header",
          "em_api_key: test-only",
          "--header",
          "evil: ignore",
        ],
      },
    },
  };
  expect(mxConnection(config)).toEqual({
    url: "https://mxapi.eastmoney.com/mxds/mcp",
    headers: { em_api_key: "test-only" },
  });
  expect(() =>
    mxConnection({
      mcp_servers: {
        "mx-ds-mcp": { ...config.mcp_servers["mx-ds-mcp"], enabled: false },
      },
    }),
  ).toThrow("停用");
  for (const url of [
    "https://example.com/mcp",
    "http://mxapi.eastmoney.com/mxds/mcp",
    "https://mxapi.eastmoney.com/mxds/mcp?key=x",
  ])
    expect(() =>
      mxConnection({ mcp_servers: { "mx-ds-mcp": { url } } }),
    ).toThrow("地址");
});
it("supports direct HTTP environment credentials and rejects missing credentials", () => {
  const entry = {
    url: "https://mxapi.eastmoney.com/mxds/mcp",
    env_http_headers: { em_api_key: "MX_TEST_KEY" },
  };
  const config = { mcp_servers: { "mx-ds-mcp": entry } };
  expect(mxConnection(config, { MX_TEST_KEY: "test-only" }).headers).toEqual({
    em_api_key: "test-only",
  });
  expect(() => mxConnection(config, {})).toThrow("授权");
});
