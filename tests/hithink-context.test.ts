import { expect, it, vi } from "vitest";
import { contextEvidence, request } from "../src/server/hithink-context";
import { validateHithinkColumns } from "../src/server/hithink-columns";
const response = {
  status_code: 0,
  token: "private",
  columns: [
    { key: "市盈率(pe,ttm)[20260907]", unit: "倍", timestamp: "20260907" },
  ],
  datas: [
    {
      指数代码: "801120.SL",
      指数简称: "食品饮料",
      指数类型: "申万一级行业指数",
      "市盈率(pe,ttm)[20260907]": 22.1,
    },
  ],
};
it("marks explicitly reformulated retries and gives each request a new trace", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  try {
    await request("hithink-basicinfo-query", "first");
    await request(
      "hithink-basicinfo-query",
      "reformulated",
      undefined,
      1,
      10,
      "retry",
    );
    const first = fetch.mock.calls[0]![1].headers;
    const second = fetch.mock.calls[1]![1].headers;
    expect(first["X-Claw-Call-Type"]).toBe("normal");
    expect(second["X-Claw-Call-Type"]).toBe("retry");
    expect(second["X-Claw-Trace-Id"]).toMatch(/^[a-f0-9]{64}$/);
    expect(second["X-Claw-Trace-Id"]).not.toBe(first["X-Claw-Trace-Id"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("retains exact industry identity and field metadata without filling absent requested values", () => {
  const e = contextEvidence(
    "sh600519",
    "hithink-industry-query",
    "近1月涨跌幅 市盈率",
    response,
    "食品饮料",
  );
  expect(e.envelope).toMatchObject({
    asOf: null,
    unit: { "市盈率(pe,ttm)[20260907]": "倍" },
    quality: "partial",
  });
  expect(JSON.stringify(e)).not.toContain("private");
  expect(JSON.parse(e.text).row["涨跌幅"]).toBeUndefined();
});
it("validates finite numeric fields, real date ranges and classification arrays", () => {
  const columns = [
    {
      key: "涨跌幅[20260807-20260908]",
      timestamp: "20260807-20260908",
      type: "DOUBLE",
    },
  ];
  expect(() =>
    validateHithinkColumns({ "涨跌幅[20260807-20260908]": -2.5 }, columns),
  ).not.toThrow();
  for (const bad of [true, [], "", "NaN", "0x10", Infinity])
    expect(() =>
      validateHithinkColumns({ "涨跌幅[20260807-20260908]": bad }, columns),
    ).toThrow();
  for (const stamp of ["20260230", "20260908-20260807", "20260807-20260909"])
    expect(() =>
      validateHithinkColumns({}, [{ ...columns[0]!, timestamp: stamp }]),
    ).toThrow();
  expect(() =>
    validateHithinkColumns({ 上市日期: "20260229" }, [
      { key: "上市日期", type: "DATE" },
    ]),
  ).toThrow();
  expect(() =>
    validateHithinkColumns({ 分类: ["食品饮料", 5] }, [
      { key: "分类", type: "ARRAY" },
    ]),
  ).toThrow();
  expect(() =>
    validateHithinkColumns({}, [columns[0]!, columns[0]!]),
  ).toThrow();
});
it("rejects constituent pages, mismatched names and classification systems", () => {
  expect(() =>
    contextEvidence(
      "sh600519",
      "hithink-industry-query",
      "q",
      {
        ...response,
        datas: [{ 股票代码: "600519.SH", 所属申万一级行业: "食品饮料" }],
      },
      "食品饮料",
    ),
  ).toThrow();
  expect(() =>
    contextEvidence(
      "sh600519",
      "hithink-industry-query",
      "q",
      response,
      "银行",
    ),
  ).toThrow();
  expect(() =>
    contextEvidence(
      "sh600519",
      "hithink-industry-query",
      "q",
      {
        ...response,
        datas: [{ ...response.datas[0], 指数类型: "同花顺行业指数" }],
      },
      "食品饮料",
    ),
  ).toThrow();
});
it("verifies the full exchange-qualified stock code for basic information", () => {
  const source = {
    status_code: 0,
    columns: [],
    datas: [
      {
        股票代码: "600519.SH",
        所属申万一级行业: "食品饮料",
        所属同花顺行业: ["食品饮料", "白酒"],
      },
    ],
  };
  expect(() =>
    contextEvidence("sh600519", "hithink-basicinfo-query", "q", source),
  ).not.toThrow();
  expect(() =>
    contextEvidence("sz600519", "hithink-basicinfo-query", "q", source),
  ).toThrow();
});
