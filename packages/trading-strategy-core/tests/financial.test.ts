import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  financialCatalog,
  financialDate,
  financialAvailableFrom,
  financialMappingVersion,
  financialMetrics,
  financialMetricSeries,
  projectFinancialFields,
  seriesValueDefinition,
  combineFinancialConditions,
  evaluateFinancialConditions,
  type FinancialReportSnapshot,
} from "../src/financial/index.js";
function report(
  date: string,
  fields: Record<number, number>,
  announcement: string,
): FinancialReportSnapshot {
  const raw = new Array<number>(658).fill(0);
  for (const [id, value] of Object.entries(fields)) raw[+id - 1] = value;
  return {
    symbol: "sh600519",
    financialCompany: false,
    reportDate: date,
    announcementDate: announcement,
    sourceFilename: `gpcw${date.replaceAll("-", "")}.dat`,
    sourceSha256: "a".repeat(64),
    contentSha256: "b".repeat(64),
    recordOffset: 31,
    mappingVersion: financialMappingVersion,
    fields: projectFinancialFields(raw, false),
    warnings: [],
  };
}
describe("财务字段语义", () => {
  it("官方元数据已冻结，语义已知与物理映射未核验分开", () => {
    expect(financialCatalog.filter((f) => f.namespace === "FN")).toHaveLength(
      478,
    );
    expect(financialCatalog.find((f) => f.code === "FN63")).toMatchObject({
      slot: 62,
      label: "负债合计",
      unit: "元",
    });
    expect(financialCatalog.find((f) => f.code === "FN308")).toMatchObject({
      slot: 307,
      scale: 10000,
      unit: "元",
    });
    expect(financialCatalog.find((f) => f.code === "FN5651")).toMatchObject({
      slot: null,
      mappingStatus: "unverified",
    });
    const raw = new Array<number>(658).fill(0);
    raw[650] = 4.86;
    raw[307] = 123;
    const cells = projectFinancialFields(raw, false);
    expect(cells[650]).toMatchObject({
      code: "RAW651",
      raw: 4.86,
      value: null,
      status: "unverified",
    });
    expect(cells[307]).toMatchObject({
      code: "FN308",
      raw: 123,
      value: 1230000,
    });
    expect(cells[62]).toMatchObject({ raw: 0, status: "source-zero" });
    expect(seriesValueDefinition("GP", 3, 0)).toMatchObject({
      label: "融资余额(万元)",
      scale: 10000,
      unit: "元",
    });
    expect(seriesValueDefinition("SC", 3, 0)?.label).toBe("涨停家数");
    expect(seriesValueDefinition("BK", 5, 1)?.label).toBe("PE TTM算术平均");
  });
  it("YYMMDD前导零与世纪按报告时代解释，非法日期拒绝", () => {
    expect(financialDate(261031, 2026)).toBe("2026-10-31");
    expect(financialDate(40115, 2003)).toBe("2004-01-15");
    expect(financialDate(991231, 1999)).toBe("1999-12-31");
    expect(financialDate(260230, 2026)).toBeNull();
    expect(financialDate(261031)).toBeNull();
  });
});
describe("财务计算与时点", () => {
  const rows = [
    report(
      "2026-09-30",
      {
        74: 90,
        75: 54,
        95: 18,
        96: 16,
        206: 15,
        107: 20,
        40: 200,
        63: 80,
        271: 100,
        308: 0.0036,
      },
      "2026-10-31",
    ),
    report("2026-06-30", { 74: 50, 96: 8 }, "2026-08-15"),
    report("2025-12-31", { 74: 100, 96: 30 }, "2026-03-20"),
    report("2025-09-30", { 74: 60, 96: 10 }, "2025-10-30"),
  ];
  it("累计、单季、TTM和同比分开，负债直接读取总额", () => {
    const metrics = financialMetrics(rows);
    const v = (id: string) => metrics.find((m) => m.id === id)?.value;
    expect(v("74-quarter")).toBe(40);
    expect(v("74-ttm")).toBe(130);
    expect(v("74-yoy")).toBe(50);
    expect(v("96-ttm")).toBe(36);
    expect(v("source-308")).toBeCloseTo(36, 8);
    expect(v("debt-ratio")).toBe(0.4);
    expect(v("net-margin")).toBe(0.2);
    expect(v("gross-margin")).toBe(0.4);
    expect(
      financialMetrics(rows.slice(0, 2)).find((m) => m.id === "74-ttm")?.value,
    ).toBeNull();
    expect(
      financialMetrics([{ ...rows[0]!, financialCompany: true }]).find(
        (m) => m.id === "gross-margin",
      )?.value,
    ).toBeNull();
  });
  it("公告当天不可取数；周末后交易日期只用已公告且组成项可见的数据", () => {
    expect(
      financialAvailableFrom("2026-10-30", ["2026-10-30", "2026-11-02"]),
    ).toBe("2026-11-02");
    expect(financialAvailableFrom("2026-10-30", [])).toBeNull();
    expect(
      financialAvailableFrom("2026-11-02", ["2026-10-30", "2026-11-02"]),
    ).toBeNull();
    expect(
      financialMetricSeries(rows, "74-yoy", [
        "2026-10-30",
        "2026-10-31",
        "2026-11-02",
      ]),
    ).toEqual([null, null, 50]);
    expect(
      evaluateFinancialConditions(
        rows,
        [{ field: "debt-ratio", operator: "lt", threshold: 0.5 }],
        "all",
      ).matched,
    ).toBe(true);
    expect(
      evaluateFinancialConditions(
        rows,
        [{ field: "FN35", operator: "lt", threshold: 1 }],
        "all",
      ).matched,
    ).toBeNull();
    expect(combineFinancialConditions([false, null], "all")).toBe(false);
    expect(combineFinancialConditions([true, null], "any")).toBe(true);
  });
  it("源字典不会把公司诊断放进第5651个物理槽", () => {
    const body = readFileSync(
      new URL(
        "../../../docs/data-sources/tdx-financial/fn-fields.json",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      JSON.parse(body).find((f: { code: string }) => f.code === "FN5651").label,
    ).toBe("盈利能力");
    expect(financialCatalog.find((f) => f.code === "FN5651")?.slot).toBeNull();
  });
});
