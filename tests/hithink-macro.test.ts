import { beforeEach, afterEach, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("~/server/db", () => database);
import {
  macroDefinitions,
  macroEvidence,
  queryMacro,
  type MacroProfile,
} from "~/server/hithink-macro";
const now = Date.parse("2026-09-09T10:00:00+08:00");
function raw(profile: MacroProfile = "bond-10y") {
  const d = macroDefinitions[profile];
  return {
    status_code: 0,
    code_count: 1,
    secret: "private",
    datas: [
      {
        国家: "中国",
        时间:
          d.frequency === "年"
            ? "20251231"
            : d.frequency === "月"
              ? "20260831"
              : "20260908",
        指标: d.indicator,
        指标值: profile === "manufacturing-pmi" ? 49.8 : 1.6798,
        周期: d.frequency,
        macro_id: d.id,
        macro_name: String(d.name),
        单位: "%",
        地区级别: ["国家"],
        secret: "private",
      },
    ],
    columns: [
      { key: "时间", type: "DATE", index_name: "宏观@交易日期" },
      { key: "指标值", type: "DOUBLE", index_name: "宏观@经济核算值" },
      { key: "单位", type: "STR", index_name: "宏观@单位" },
    ],
  };
}
const parse = (value: unknown, profile: MacroProfile = "bond-10y") =>
  macroEvidence(profile, "q", value, now);
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("keeps nationwide evidence independent of securities and converts percent only for the bond rate", () => {
  const evidence = parse(raw()),
    payload = JSON.parse(evidence.text);
  expect(evidence.envelope).toMatchObject({
    symbol: null,
    asOf: "2026-09-08",
    publishedAt: null,
    reportPeriod: null,
    unit: { 指标值: "%" },
  });
  expect(payload.facts.rateFraction).toBeCloseTo(0.016798);
  expect(evidence.text).not.toContain("private");
  expect(
    macroEvidence("bond-10y", payload.query, payload.response, now),
  ).toEqual(evidence);
  const pmi = JSON.parse(
    parse(raw("manufacturing-pmi"), "manufacturing-pmi").text,
  );
  expect(pmi.facts.rateFraction).toBeNull();
  expect(pmi.facts.value).toBe(49.8);
  expect(pmi.facts.interpretation).toContain("不是同比");
});
it("preserves cumulative PPI and rejects confusing it with monthly CPI or other series", () => {
  expect(
    JSON.parse(parse(raw("ppi-cumulative"), "ppi-cumulative").text).facts.label,
  ).toContain("累计同比");
  expect(() => parse(raw("ppi-cumulative"), "cpi-monthly")).toThrow(/定义/);
  const alternate = raw();
  alternate.datas[0]!.macro_name = "国债到期收益率:10年";
  expect(() => parse(alternate)).toThrow(/定义/);
  const unit = raw();
  unit.datas[0]!.单位 = "基点";
  expect(() => parse(unit)).toThrow();
  const country = raw();
  country.datas[0]!.国家 = "美国";
  expect(() => parse(country)).toThrow();
});
it("validates observation dates, period ends, finite values and PMI bounds", () => {
  for (const stamp of ["20260230", "20260910", "20261301"]) {
    const bad = raw();
    bad.datas[0]!.时间 = stamp;
    expect(() => parse(bad)).toThrow();
  }
  const monthly = raw("cpi-monthly");
  monthly.datas[0]!.时间 = "20260830";
  expect(() => parse(monthly, "cpi-monthly")).toThrow(/月末/);
  const annual = raw("gdp-annual");
  annual.datas[0]!.时间 = "20250630";
  expect(() => parse(annual, "gdp-annual")).toThrow(/年末/);
  const invalid = raw();
  invalid.datas[0]!.指标值 = Infinity;
  expect(() => parse(invalid)).toThrow();
  const pmi = raw("manufacturing-pmi");
  pmi.datas[0]!.指标值 = 101;
  expect(() => parse(pmi, "manufacturing-pmi")).toThrow(/PMI/);
  const negative = raw("cpi-monthly");
  negative.datas[0]!.指标值 = -1;
  expect(JSON.parse(parse(negative, "cpi-monthly").text).facts.value).toBe(-1);
});
it("shares acquisitions and reuses one global cache without a symbol key", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect((init.headers as Record<string, string>)["X-Claw-Skill-Id"]).toBe(
      "hithink-macro-query",
    );
    return Response.json(raw());
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryMacro("bond-10y"),
    queryMacro("bond-10y"),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(database.put).toHaveBeenCalledWith(
    "evidence",
    "macro-context-v1-bond-10y",
    expect.objectContaining({ evidence: a }),
  );
  database.get.mockReturnValue({ createdAt: Date.now(), evidence: a });
  expect(await queryMacro("bond-10y")).toEqual(a);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not cache a late reply after cancellation", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const c = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      c.abort();
      return Response.json(raw());
    }),
  );
  await expect(queryMacro("bond-10y", c.signal)).rejects.toThrow();
  expect(database.put).not.toHaveBeenCalled();
});
