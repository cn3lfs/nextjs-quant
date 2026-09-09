import { afterEach, expect, it, vi } from "vitest";
import { ownershipEvidence, queryOwnership } from "~/server/hithink-ownership";
const now = Date.parse("2026-09-09T10:00:00+08:00");
function capital() {
  return {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        股票代码: "600519.SH",
        "总股本[20251231]": 1000,
        "持股比例[20251231]": 65,
        secret: "hidden",
      },
    ],
    columns: [
      {
        key: "总股本[20251231]",
        index_name: "总股本",
        type: "DOUBLE",
        unit: "股",
        timestamp: "20251231",
      },
      {
        key: "持股比例[20251231]",
        index_name: "前十大股东持股比例合计(报告期)",
        type: "DOUBLE",
        unit: "%",
        timestamp: "20251231",
      },
    ],
  };
}
function control() {
  return {
    status_code: 0,
    code_count: 1,
    datas: [
      {
        股票代码: "600519.SH",
        类型: ["控股股东"],
        截止日期: "20260630",
        股东名称: "控股企业",
        实际控制人: "来源实控人",
        企业性质: "来源性质",
        "持股占流通股比例[20260630]": 55,
      },
    ],
    columns: [
      { key: "类型", index_name: "机构持股类型(虚拟表)", type: "ARRAY" },
      { key: "截止日期", index_name: "交易日期", type: "DATE" },
      { key: "股东名称", index_name: "持股机构名称明细", type: "STR" },
      { key: "实际控制人", index_name: "实际控制人(虚拟表)", type: "STR" },
      { key: "企业性质", index_name: "企业性质", type: "STR" },
      {
        key: "持股占流通股比例[20260630]",
        index_name: "机构本期持股占流通股比例明细",
        type: "DOUBLE",
        unit: "%",
        timestamp: "20260630",
      },
    ],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("keeps controller identity undated and floating share percentage separate from annual capital", () => {
  const a = ownershipEvidence("sh600519", 2025, "control", "q", control(), now);
  const b = ownershipEvidence(
    "sh600519",
    2025,
    "annual-capital",
    "q",
    capital(),
    now,
  );
  expect(a.envelope).toMatchObject({
    reportPeriod: null,
    asOf: null,
    publishedAt: null,
  });
  expect(JSON.parse(a.text).facts).toMatchObject({
    controlIdentityAsOf: null,
    holdingDate: "20260630",
    floatingSharePercent: 55,
  });
  expect(b.envelope?.reportPeriod).toBe("20251231");
  expect(JSON.parse(b.text).facts).toEqual({
    period: "20251231",
    totalShares: 1000,
    topTenSharePercent: 65,
  });
  expect(b.text).not.toContain("hidden");
  const p = JSON.parse(a.text);
  expect(
    ownershipEvidence("sh600519", 2025, "control", p.query, p.response, now),
  ).toEqual(a);
});
it("does not infer control from a large holder or mislabel floating shares as total shares", () => {
  const raw = control();
  raw.datas[0]!.类型 = ["第一大股东"];
  expect(() =>
    ownershipEvidence("sh600519", 2025, "control", "q", raw, now),
  ).toThrow(/控股股东/);
  raw.datas[0]!.类型 = ["控股股东"];
  raw.columns[5]!.index_name = "机构本期持股占总股本比例明细";
  expect(() =>
    ownershipEvidence("sh600519", 2025, "control", "q", raw, now),
  ).toThrow(/口径/);
});
it("rejects wrong identity, annual scope, duplicate rows, noninteger shares and invalid concentration", () => {
  const parse = (raw: unknown) =>
    ownershipEvidence("sh600519", 2025, "annual-capital", "q", raw, now);
  const wrong = capital();
  wrong.datas[0]!.股票代码 = "000001.SZ";
  expect(() => parse(wrong)).toThrow(/身份/);
  const rows = capital();
  rows.datas.push({ ...rows.datas[0]! });
  expect(() => parse(rows)).toThrow();
  const date = capital();
  date.columns[0]!.timestamp = "20241231";
  expect(() => parse(date)).toThrow();
  for (const value of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = capital();
    raw.datas[0]!["总股本[20251231]"] = value;
    expect(() => parse(raw)).toThrow();
  }
  const ratio = capital();
  ratio.datas[0]!["持股比例[20251231]"] = 101;
  expect(() => parse(ratio)).toThrow();
  expect(() =>
    ownershipEvidence("sh600519", 2026, "annual-capital", "q", capital(), now),
  ).toThrow(/尚未结束/);
});
it("rejects absent controller text and future or impossible holding dates", () => {
  const raw = control();
  raw.datas[0]!.实际控制人 = "--";
  expect(() =>
    ownershipEvidence("sh600519", 2025, "control", "q", raw, now),
  ).toThrow(/缺失/);
  raw.datas[0]!.实际控制人 = "来源实控人";
  raw.datas[0]!.截止日期 = "20260230";
  expect(() =>
    ownershipEvidence("sh600519", 2025, "control", "q", raw, now),
  ).toThrow(/日期/);
  raw.datas[0]!.截止日期 = "20261231";
  expect(() =>
    ownershipEvidence("sh600519", 2025, "control", "q", raw, now),
  ).toThrow(/时点/);
});
it("uses the management provider, explicit annual query and shared requests", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect((init.headers as Record<string, string>)["X-Claw-Skill-Id"]).toBe(
      "hithink-management-query",
    );
    expect(JSON.parse(init.body as string).query).toContain(
      "2025年 前十大股东持股比例 总股本",
    );
    return Response.json(capital());
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryOwnership("sh600519", 2025, "annual-capital"),
    queryOwnership("sh600519", 2025, "annual-capital"),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    queryOwnership("sh600519", 2025, "annual-capital", controller.signal),
  ).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
