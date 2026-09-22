import { afterEach, expect, it, vi } from "vitest";
import {
  annualFinanceMetrics,
  financeEvidence,
  queryFinance,
} from "../src/server/data-sources/hithink/hithink-finance";
const fixture = {
  status_code: 0,
  token: "gateway-private",
  datas: [{ 股票代码: "600519.SH", 营业收入: 100, "资产负债率[20260630]": 15 }],
  columns: [
    { key: "营业收入", unit: "元", type: "DOUBLE" },
    { key: "资产负债率[20260630]", unit: "%", timestamp: "20260630" },
  ],
};
it.each(
  Object.keys(annualFinanceMetrics) as (keyof typeof annualFinanceMetrics)[],
)(
  "keeps %s single-metric retries on explicit completed years",
  async (profile) => {
    vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ status_code: 0, datas: [] })),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(queryFinance("sh600519", undefined, profile)).rejects.toThrow(
      "三次",
    );
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const lastYear = new Date(Date.now() + 8 * 3600000).getUTCFullYear() - 1;
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[0]![1].body as string).query).toBe(
      `600519.SH ${lastYear - 4}年至${lastYear}年 每年年报${annualFinanceMetrics[profile]}`,
    );
    for (const call of calls) {
      const query = JSON.parse(call[1].body as string).query;
      expect(query).toContain(annualFinanceMetrics[profile]);
      expect(query).toContain(`${lastYear}年`);
      expect(query).not.toContain("最新");
    }
  },
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("rejects invalid numbers and contradictory or impossible field dates", () => {
  for (const value of [
    true,
    [],
    {},
    "",
    " ",
    "NaN",
    "Infinity",
    "0x10",
    "12亿元",
  ]) {
    expect(() =>
      financeEvidence(
        "sh600519",
        { ...fixture, datas: [{ ...fixture.datas[0], 营业收入: value }] },
        "q",
        1000,
      ),
    ).toThrow();
  }
  for (const value of [0, -12, "0", "1.5e3", null, "--"]) {
    expect(() =>
      financeEvidence(
        "sh600519",
        { ...fixture, datas: [{ ...fixture.datas[0], 营业收入: value }] },
        "q",
        1000,
      ),
    ).not.toThrow();
  }
  for (const timestamp of ["20260229", "20261301", "20260331"]) {
    expect(() =>
      financeEvidence(
        "sh600519",
        { ...fixture, columns: [{ ...fixture.columns[1], timestamp }] },
        "q",
        1000,
      ),
    ).toThrow();
  }
  expect(() =>
    financeEvidence(
      "sh600519",
      { ...fixture, columns: [fixture.columns[0], fixture.columns[0]] },
      "q",
      1000,
    ),
  ).toThrow();
});
it("rewrites only empty successful queries at most twice and records the final query", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status_code: 0, datas: [] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ status_code: 0, datas: [] })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(fixture)));
  vi.stubGlobal("fetch", fetcher);
  const entry = await queryFinance("sh600519");
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(entry.text).query).toBe("600519.SH 营业收入 净利润");
  expect(
    fetcher.mock.calls.map((call) => call[1].headers["X-Claw-Call-Type"]),
  ).toEqual(["normal", "retry", "retry"]);
  fetcher
    .mockReset()
    .mockImplementation(
      async () => new Response(JSON.stringify({ status_code: 0, datas: [] })),
    );
  await expect(queryFinance("sh600519")).rejects.toThrow("三次");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("does not retry auth errors, wrong identities, or cancellation", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
  const fetcher = vi.fn(async () => new Response("", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(queryFinance("sh600519")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher
    .mockReset()
    .mockImplementation(async () => new Response(JSON.stringify(fixture)));
  await expect(queryFinance("sz600519")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockClear();
  await expect(queryFinance("sh600519", AbortSignal.abort())).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("retains field units and report periods without fabricating common dates or retaining gateway metadata", () => {
  const entry = financeEvidence("sh600519", fixture, "query", 1000);
  expect(entry.envelope).toMatchObject({
    asOf: null,
    reportPeriod: null,
    publishedAt: null,
    unit: { 营业收入: "元", "资产负债率[20260630]": "%" },
  });
  expect(entry.text).toContain("20260630");
  expect(JSON.stringify(entry)).not.toContain("gateway-private");
  expect(() => financeEvidence("sz600519", fixture, "query", 1000)).toThrow();
  expect(() =>
    financeEvidence("sh600519", { ...fixture, datas: [] }, "query", 1000),
  ).toThrow();
  expect(() =>
    financeEvidence("sh600519", { ...fixture, status_code: 1 }, "query", 1000),
  ).toThrow();
});
it("uses the documented authenticated read-only request and independent trace IDs", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fixture)));
  vi.stubGlobal("fetch", fetcher);
  await queryFinance("sh600519");
  await queryFinance("sh600519");
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  const headers = calls.map((c) => c[1].headers as Record<string, string>);
  expect(headers[0]?.Authorization).toBe("Bearer fixture-key");
  expect(headers[0]?.["X-Claw-Skill-Id"]).toBe("hithink-finance-query");
  expect(headers[0]?.["X-Claw-Trace-Id"]).toMatch(/^[a-f0-9]{64}$/);
  expect(headers[0]?.["X-Claw-Trace-Id"]).not.toBe(
    headers[1]?.["X-Claw-Trace-Id"],
  );
  expect(JSON.parse(calls[0]![1].body as string).query).toContain("600519.SH");
});
it("keeps growth retries in single-quarter terms rather than falling back to overview", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ status_code: 0, datas: [] })),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(queryFinance("sh600519", undefined, "growth")).rejects.toThrow(
    "三次",
  );
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  expect(calls).toHaveLength(3);
  for (const call of calls)
    expect(JSON.parse(call[1].body as string).query).toContain(
      "单季度归母净利润同比增长率",
    );
});
it.each(["quarter-eps", "annual-eps"] as const)(
  "keeps %s retries in explicit per-share periods",
  async (profile) => {
    vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ status_code: 0, datas: [] })),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(queryFinance("sh600519", undefined, profile)).rejects.toThrow(
      "三次",
    );
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const query = JSON.parse(call[1].body as string).query as string;
      expect(query).toContain(
        profile === "quarter-eps" ? "单季度基本每股收益" : "年报基本每股收益",
      );
      expect(query).not.toContain("净利润");
      if (profile === "annual-eps")
        expect(query).toContain("年报每股经营现金流量");
    }
  },
);

it.each(["annual-cash-flow", "annual-capex"] as const)(
  "keeps %s empty-result retries on annual cash statements",
  async (profile) => {
    vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ status_code: 0, datas: [] })),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(queryFinance("sh600519", undefined, profile)).rejects.toThrow(
      "三次",
    );
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(3);
    const lastAnnualYear =
      new Date(Date.now() + 8 * 3600000).getUTCFullYear() - 1;
    expect(JSON.parse(calls[0]![1].body as string).query).toContain(
      `${lastAnnualYear - 4}年至${lastAnnualYear}年`,
    );
    for (const [index, call] of calls.entries()) {
      const query = JSON.parse(call[1].body as string).query;
      expect(query).toContain("年报");
      if (profile === "annual-cash-flow" && index === 0) {
        expect(query).toContain("经营活动产生的现金流量净额");
        expect(query).not.toContain("财务报表币种");
      } else expect(query).toContain("购建固定资产");
      expect(query).toContain("600519.SH");
      expect(query).not.toContain("最新报告期");
    }
  },
);
