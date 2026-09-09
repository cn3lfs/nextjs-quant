import { afterEach, expect, it, vi } from "vitest";
import {
  incomeScopeEvidence,
  queryIncomeScope,
} from "~/server/hithink-income-scope";
import { revenueReconciliation } from "~/server/revenue-reconciliation";
import { businessEvidence } from "~/server/hithink-business";
const now = Date.parse("2026-09-09T10:00:00+08:00");
function raw() {
  const row: Record<string, unknown> = {
    股票代码: "600519.SH",
    secret: "unrequested",
  };
  const columns = ["营业总收入", "营业收入", "利息收入"].map((label, i) => {
    const key = `${label}[20251231]`;
    row[key] = [110, 100, 10][i];
    return {
      key,
      index_name: label,
      type: "DOUBLE",
      unit: "元",
      timestamp: "20251231",
    };
  });
  return { status_code: 0, code_count: 1, datas: [row], columns };
}
const parse = (r = raw()) => incomeScopeEvidence("sh600519", 2025, "q", r, now);
function segments() {
  const rows = [
    { 分类标准: "行业", 项目名称: "甲", 业务收入: 110, 收入占比: 100 },
    { 分类标准: "产品", 项目名称: "乙", 业务收入: 70, 收入占比: 63.64 },
    { 分类标准: "产品", 项目名称: "丙", 业务收入: 40, 收入占比: 36.36 },
    { 分类标准: "地区", 项目名称: "丁", 业务收入: 100, 收入占比: 90.91 },
  ].map((r) => ({ ...r, 股票代码: "600519.SH", 报告期截止日: "20251231" }));
  return businessEvidence(
    "sh600519",
    2025,
    "segments",
    "q",
    [
      {
        status_code: 0,
        code_count: 1,
        datas: rows,
        columns: Object.keys(rows[0]!).map((key) => ({
          key,
          type: ["业务收入", "收入占比"].includes(key) ? "DOUBLE" : "STRING",
          unit: key === "业务收入" ? "元" : key === "收入占比" ? "%" : "",
        })),
      },
    ],
    now,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("retains distinct definitions, strips unrelated data and replays exactly", () => {
  const e = parse(),
    p = JSON.parse(e.text);
  expect(p.facts.amounts).toEqual({
    totalRevenue: 110,
    revenue: 100,
    interestIncome: 10,
  });
  expect(e.text).not.toContain("unrequested");
  expect(e.envelope?.currency).toBeNull();
  expect(incomeScopeEvidence("sh600519", 2025, "q", p.response, now)).toEqual(
    e,
  );
});
it("rejects substituted definitions, identity, year, unit and invalid numeric input", () => {
  for (const change of [
    (r: ReturnType<typeof raw>) => {
      r.columns[0]!.index_name = "营业收入";
    },
    (r: ReturnType<typeof raw>) => {
      r.columns[0]!.unit = "万元";
    },
    (r: ReturnType<typeof raw>) => {
      r.columns[0]!.timestamp = "20241231";
    },
    (r: ReturnType<typeof raw>) => {
      r.datas[0]!.股票代码 = "000001.SZ";
    },
    (r: ReturnType<typeof raw>) => {
      r.datas[0]!["营业收入[20251231]"] = true;
    },
    (r: ReturnType<typeof raw>) => {
      r.datas[0]!["营业收入[20251231]"] = Infinity;
    },
  ]) {
    const r = raw();
    change(r);
    expect(() => parse(r)).toThrow();
  }
  expect(() => incomeScopeEvidence("sh600519", 2026, "q", raw(), now)).toThrow(
    /尚未结束/,
  );
});
it("compares each classification independently and does not assert segment coverage", () => {
  const result = revenueReconciliation("finance", "20251231", 100, [
    parse(),
    segments(),
  ]);
  expect(result.archiveRevenueMatches).toBe(true);
  expect(result.totalMinusRevenue).toBe(10);
  expect(result.differenceMatchesInterest).toBe(true);
  expect(
    result.groups.map((g) => [
      g.classification,
      g.revenue,
      g.matchesTotalRevenue,
      g.matchesRevenue,
    ]),
  ).toEqual([
    ["行业", 110, true, false],
    ["产品", 110, true, false],
    ["地区", 100, false, true],
  ]);
  expect(result.citations).toHaveLength(3);
});
it("retains other-income residuals, missing interest and conflicts without replacing archived revenue", () => {
  const r = raw();
  r.datas[0]!["利息收入[20251231]"] = 4;
  let result = revenueReconciliation("finance", "20251231", 99, [parse(r)]);
  expect(result.residualAfterInterest).toBe(6);
  expect(result.differenceMatchesInterest).toBe(false);
  expect(result.archiveRevenueMatches).toBe(false);
  expect(result.archivedRevenue).toBe(99);
  expect(result.missing.join()).toContain("不一致");
  r.datas[0]!["利息收入[20251231]"] = "--";
  result = revenueReconciliation("finance", "20251231", 100, [parse(r)]);
  expect(result.residualAfterInterest).toBeNull();
  expect(result.differenceMatchesInterest).toBeNull();
  expect(result.missing).toContain("利息收入缺失");
  expect(() =>
    revenueReconciliation("finance", "20251231", 100, [parse(), parse(r)]),
  ).toThrow(/重复/);
  expect(
    revenueReconciliation("finance", "20251231", 100, []).archiveRevenueMatches,
  ).toBeNull();
});
it("preserves signed values and reports overflow rather than an invalid equality", () => {
  const r = raw();
  r.datas[0]!["营业总收入[20251231]"] = Number.MAX_VALUE;
  r.datas[0]!["营业收入[20251231]"] = -Number.MAX_VALUE;
  const result = revenueReconciliation("finance", "20251231", 100, [parse(r)]);
  expect(result.totalMinusRevenue).toBeNull();
  expect(result.differenceMatchesInterest).toBeNull();
  expect(result.missing.join()).toContain("溢出");
});
it("deduplicates annual queries and rejects cancellation before network work", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(JSON.parse(init.body as string).query).toContain(
      "2025年 营业总收入 营业收入 利息收入",
    );
    return Response.json(raw());
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryIncomeScope("sh600519", 2025),
    queryIncomeScope("sh600519", 2025),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const c = new AbortController();
  c.abort();
  expect(() => queryIncomeScope("sh600519", 2025, c.signal)).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
