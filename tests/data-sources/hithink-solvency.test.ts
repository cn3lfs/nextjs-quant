import { afterEach, expect, it, vi } from "vitest";
import {
  solvencyEvidence,
  querySolvency,
  type SolvencyProfile,
} from "~/server/data-sources/hithink/hithink-solvency";
const now = Date.parse("2026-09-09T10:00:00+08:00");
function raw(profile: SolvencyProfile = "balance") {
  const row: Record<string, unknown> = {
      股票代码: "600519.SH",
      secret: "hidden",
    },
    columns: {
      key: string;
      index_name: string;
      type: string;
      unit: string;
      timestamp: string;
    }[] = [];
  const fields =
    profile === "balance"
      ? [
          ["总资产", "资产总计", 100],
          ["负债", "负债合计", 40],
          ["所有者权益", "所有者权益合计", 60],
        ]
      : [
          ["息税前利润", "息税前利润ebit", 20],
          ["利息支出", "利息支出", 2],
          ["带息债务", "带息债务", 30],
        ];
  for (const [base, index, value] of fields) {
    const key = `${base}[20251231]`;
    row[key] = value;
    columns.push({
      key,
      index_name: String(index),
      type: "DOUBLE",
      unit: "元",
      timestamp: "20251231",
    });
  }
  return { status_code: 0, code_count: 1, datas: [row], columns };
}
const parse = (value: unknown, profile: SolvencyProfile = "balance") =>
  solvencyEvidence("sh600519", 2025, profile, "q", value, now);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("computes debt/assets only after the balance equation and keeps reported debt separate", () => {
  const e = parse(raw()),
    p = JSON.parse(e.text);
  expect(p.facts.balanceVerified).toBe(true);
  expect(p.facts.debtToAssets).toBe(0.4);
  expect(p.facts.interestCoverage).toBeNull();
  expect(e.text).not.toContain("hidden");
  expect(
    solvencyEvidence("sh600519", 2025, "balance", p.query, p.response, now),
  ).toEqual(e);
  const c = JSON.parse(parse(raw("coverage"), "coverage").text);
  expect(c.facts.interestCoverage).toBe(10);
  expect(c.facts.amounts.reportedInterestBearingDebt).toBe(30);
  expect(c.facts.debtToAssets).toBeNull();
});
it("rejects an unbalanced sheet but preserves negative equity and negative EBIT", () => {
  const bad = raw();
  bad.datas[0]!["负债[20251231]"] = 41;
  expect(() => parse(bad)).toThrow(/不等于/);
  bad.datas[0]!["负债[20251231]"] = 120;
  bad.datas[0]!["所有者权益[20251231]"] = -20;
  expect(JSON.parse(parse(bad).text).facts.debtToAssets).toBe(1.2);
  const loss = raw("coverage");
  loss.datas[0]!["息税前利润[20251231]"] = -4;
  expect(JSON.parse(parse(loss, "coverage").text).facts.interestCoverage).toBe(
    -2,
  );
});
it("keeps missing fields and zero interest as missing ratios, never infinite safety", () => {
  const missing = raw();
  missing.datas[0]!["所有者权益[20251231]"] = "--";
  const p = JSON.parse(parse(missing).text);
  expect(p.facts.debtToAssets).toBeNull();
  expect(p.facts.balanceVerified).toBeNull();
  expect(p.facts.missing).toContain("所有者权益合计缺失");
  const zero = raw("coverage");
  zero.datas[0]!["利息支出[20251231]"] = 0;
  expect(
    JSON.parse(parse(zero, "coverage").text).facts.interestCoverage,
  ).toBeNull();
  const negative = raw("coverage");
  negative.datas[0]!["利息支出[20251231]"] = -1;
  expect(() => parse(negative, "coverage")).toThrow(/数值/);
});
it("rejects wrong identity, nonfinite values, units, years and substituted interest definitions", () => {
  const wrong = raw();
  wrong.datas[0]!.股票代码 = "000001.SZ";
  expect(() => parse(wrong)).toThrow(/身份/);
  const infinite = raw();
  infinite.datas[0]!["总资产[20251231]"] = Infinity;
  expect(() => parse(infinite)).toThrow();
  const unit = raw();
  unit.columns[0]!.unit = "万元";
  expect(() => parse(unit)).toThrow(/单位/);
  const interest = raw("coverage");
  interest.columns[1]!.index_name = "净利息费用";
  expect(() => parse(interest, "coverage")).toThrow(/定义/);
  expect(() =>
    solvencyEvidence("sh600519", 2026, "balance", "q", raw(), now),
  ).toThrow(/尚未结束/);
});
it("shares the two-profile finance request and rejects cancelled calls before network work", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect((init.headers as Record<string, string>)["X-Claw-Skill-Id"]).toBe(
      "hithink-finance-query",
    );
    expect(JSON.parse(init.body as string).query).toContain(
      "2025年 负债合计 资产总计 所有者权益合计",
    );
    return Response.json(raw());
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    querySolvency("sh600519", 2025, "balance"),
    querySolvency("sh600519", 2025, "balance"),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const c = new AbortController();
  c.abort();
  expect(() => querySolvency("sh600519", 2025, "coverage", c.signal)).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
