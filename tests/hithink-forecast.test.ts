import { afterEach, expect, it, vi } from "vitest";
import {
  forecastEvidence,
  forecastYear,
  queryForecast,
} from "~/server/hithink-forecast";
const now = Date.parse("2026-09-09T10:00:00+08:00");
function fixture() {
  const row: Record<string, unknown> = {
      股票代码: "600519.SH",
      secret: "private",
    },
    columns: {
      key: string;
      index_name: string;
      type: string;
      unit: string;
      timestamp: string;
    }[] = [];
  for (const year of [2026, 2027, 2028])
    for (const [base, index_name, type, unit, value] of [
      ["预测净利润中值", "预测净利润中值(虚拟表)", "DOUBLE", "元", -100],
      ["每股收益中值", "预测每股收益中值(虚拟表)", "DOUBLE", "元", -1],
      ["预测家数", "预测家数(虚拟表)", "LONG", "家", 10],
    ] as const) {
      const timestamp = `${year}1231`,
        key = `${base}[${timestamp}]`;
      row[key] = value;
      columns.push({ key, index_name, type, unit, timestamp });
    }
  return { status_code: 0, code_count: 1, datas: [row], columns };
}
const parse = (raw: unknown) =>
  forecastEvidence("sh600519", 2026, "q", raw, now);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("preserves negative medians and each target year without inventing aggregation date or currency", () => {
  const e = parse(fixture()),
    p = JSON.parse(e.text);
  expect(p.annual).toHaveLength(3);
  expect(p.annual[0]).toEqual({
    period: "20261231",
    profitMedian: -100,
    epsMedian: -1,
    institutionCount: 10,
  });
  expect(p.aggregationAsOf).toBeNull();
  expect(p.coverageWindow).toBeNull();
  expect(e.envelope).toMatchObject({
    asOf: null,
    publishedAt: null,
    currency: null,
    reportPeriod: null,
  });
  expect(e.text).not.toContain("private");
  expect(forecastEvidence("sh600519", 2026, p.query, p.response, now)).toEqual(
    e,
  );
  expect(forecastYear(Date.parse("2025-12-31T16:00:00Z"))).toBe(2026);
});
it("keeps absent coverage and forecast cells missing, rejecting wholly empty predictions", () => {
  const raw = fixture();
  raw.datas[0]!["预测家数[20261231]"] = "--";
  raw.datas[0]!["每股收益中值[20261231]"] = null;
  expect(JSON.parse(parse(raw).text).annual[0]).toMatchObject({
    epsMedian: null,
    institutionCount: null,
  });
  for (const key of Object.keys(raw.datas[0]!))
    if (key !== "股票代码") raw.datas[0]![key] = "--";
  expect(() => parse(raw)).toThrow(/均无/);
});
it("rejects mean/median substitution, wrong identity or units and contradictory institution counts", () => {
  const mean = fixture();
  mean.columns[0]!.index_name = "预测净利润平均值";
  expect(() => parse(mean)).toThrow(/定义/);
  const wrong = fixture();
  wrong.datas[0]!.股票代码 = "000001.SZ";
  expect(() => parse(wrong)).toThrow(/身份/);
  const unit = fixture();
  unit.columns[0]!.unit = "万元";
  expect(() => parse(unit)).toThrow(/单位/);
  for (const value of [0, 1.5, -1, Infinity, "0x10"]) {
    const count = fixture();
    count.datas[0]!["预测家数[20261231]"] = value;
    expect(() => parse(count)).toThrow();
  }
  const stamp = fixture();
  stamp.columns[0]!.timestamp = "20251231";
  expect(() => parse(stamp)).toThrow();
  expect(() => forecastEvidence("sh600519", 2025, "q", fixture(), now)).toThrow(
    /年度/,
  );
});
it("routes the three-year query to institutional research and shares concurrent requests", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect((init.headers as Record<string, string>)["X-Claw-Skill-Id"]).toBe(
      "hithink-insresearch-query",
    );
    expect(JSON.parse(init.body as string).query).toContain(
      "2026年 2027年 2028年 预测净利润中值 预测每股收益中值 预测家数",
    );
    return Response.json(fixture());
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryForecast("sh600519", 2026),
    queryForecast("sh600519", 2026),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const c = new AbortController();
  c.abort();
  expect(() => queryForecast("sh600519", 2026, c.signal)).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
