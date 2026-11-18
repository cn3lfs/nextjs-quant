import { describe, expect, it } from "vitest";
import type { FinancialReportSnapshot } from "trading-strategy-core/financial";
import {
  evaluateFinancialTheory,
  rankFinancialTheory,
} from "../src/research/financial-theory.js";

function report(
  year: number,
  values: Record<number, number>,
): FinancialReportSnapshot {
  return {
    symbol: "sh600000",
    financialCompany: false,
    reportDate: `${year}-12-31`,
    announcementDate: `${year + 1}-03-01`,
    availableFrom: `${year + 1}-03-02`,
    sourceFilename: `gpcw${year}1231.dat`,
    sourceSha256: `sha-${year}`,
    contentSha256: `content-${year}`,
    recordOffset: 0,
    mappingVersion: "test",
    warnings: [],
    fields: Object.entries(values).map(([id, value]) => ({
      code: `FN${id}`,
      slot: +id - 1,
      label: id,
      section: "test",
      raw: value,
      value,
      unit: "元",
      rawUnit: "元",
      scale: 1,
      timing: "cumulative",
      status: "value",
      reason: null,
    })),
  };
}
const history = () => [
  report(2025, {
    8: 10,
    21: 60,
    27: 40,
    31: 0,
    32: 0,
    40: 120,
    41: 3,
    52: 2,
    54: 20,
    55: 6,
    56: 2,
    74: 150,
    75: 60,
    95: 20,
    107: 30,
    207: 25,
  }),
  report(2024, {
    8: 9,
    21: 40,
    27: 30,
    31: 0,
    32: 0,
    40: 100,
    41: 3,
    52: 2,
    54: 20,
    55: 10,
    56: 3,
    74: 100,
    75: 50,
    95: 10,
    107: 15,
    207: 18,
  }),
  report(2023, { 40: 80 }),
];
const context = {
  asOf: "2026-04-01",
  strict: true,
  ordinarySharesIssued: {
    value: 0,
    unit: "股",
    source: "issuance-ledger",
    asOf: "2025-12-31",
    availableFrom: "2026-03-02",
  },
  marketCapitalization: {
    value: 200,
    unit: "元",
    source: "same-day-GP16",
    asOf: "2026-04-01",
  },
  interestBearingDebt: {
    value: 13,
    unit: "元",
    source: "debt",
    asOf: "2025-12-31",
  },
};
describe("financial theory annual evidence", () => {
  it("computes nine independently evidenced signals and retains fixed denominators", () => {
    const r = evaluateFinancialTheory(history(), context);
    expect(r.fScore.score).toBe(9);
    expect(
      r.fScore.checks.find((c) => c.id === "roa-improvement")?.value,
    ).toBeCloseTo(0.2 - 0.125);
    expect(r.fScore.checks.find((c) => c.id === "leverage")?.value).toBeCloseTo(
      13 / 90 - 8 / 110,
    );
    expect(r.magic.earningsYield).toBeCloseTo(25 / 203);
    expect(r.magic.returnOnCapital).toBeCloseTo(25 / 75);
  });
  it("does not infer no issuance from unchanged capital or cash-flow balances", () => {
    const r = evaluateFinancialTheory(history(), {
      ...context,
      ordinarySharesIssued: undefined,
    });
    expect(r.fScore.score).toBeNull();
    expect(r.fScore.known).toBe(8);
    expect(r.fScore.checks[6]?.matched).toBeNull();
  });
  it("does not admit a future-certified issuance fact to a historical score", () => {
    const result = evaluateFinancialTheory(history(), {
      ...context,
      ordinarySharesIssued: {
        ...context.ordinarySharesIssued,
        availableFrom: "2026-05-01",
      },
    });
    expect(result.fScore.score).toBeNull();
    expect(result.fScore.checks[6]?.inputs[0]?.sourceSha256).toBe(
      "issuance-ledger",
    );
    expect(result.fScore.checks[6]?.inputs[0]?.reason).toContain("可见资格");
  });
  it("does not use a not-yet-available annual report", () => {
    const r = evaluateFinancialTheory(history(), {
      ...context,
      asOf: "2026-03-01",
    });
    expect(r.reportDate).toBe("2024-12-31");
    expect(r.fScore.score).toBeNull();
    expect(r.magic.eligible).toBe(false);
  });
  it("current selection works without historical availability evidence", () => {
    const rows = history();
    rows[0]!.announcementDate = null;
    rows[0]!.availableFrom = null;
    expect(
      evaluateFinancialTheory(rows, { ...context, strict: false }).reportDate,
    ).toBe("2025-12-31");
    expect(evaluateFinancialTheory(rows, context).reportDate).toBe(
      "2024-12-31",
    );
  });
  it("source zero and absent years remain unknown rather than zero scores", () => {
    const rows = history();
    const cash = rows[0]!.fields.find((f) => f.code === "FN107")!;
    cash.status = "source-zero";
    cash.raw = 0;
    cash.value = null;
    expect(evaluateFinancialTheory(rows, context).fScore.score).toBeNull();
    expect(
      evaluateFinancialTheory(rows.slice(0, 2), context).fScore.checks.find(
        (c) => c.id === "turnover",
      )?.matched,
    ).toBeNull();
  });
  it("duplicate report periods and financial-industry identity cannot become eligible", () => {
    expect(
      evaluateFinancialTheory([...history(), history()[0]!], context).fScore
        .score,
    ).toBeNull();
    const rows = history();
    rows[0]!.financialCompany = true;
    expect(evaluateFinancialTheory(rows, context).magic.eligible).toBe(false);
    expect(evaluateFinancialTheory(rows, context).fScore.known).toBe(0);
  });
  it("nonpositive capital and stale market value are not rankable", () => {
    const rows = history();
    rows[0]!.fields.find((f) => f.code === "FN54")!.value = 1000;
    expect(
      evaluateFinancialTheory(rows, context).magic.returnOnCapital,
    ).toBeNull();
    expect(evaluateFinancialTheory(rows, context).magic.matched).toBe(false);
    expect(
      evaluateFinancialTheory(history(), {
        ...context,
        marketCapitalization: {
          ...context.marketCapitalization,
          asOf: "2026-03-31",
        },
      }).magic.eligible,
    ).toBe(false);
  });
  it("does not rank oil/gas operating assets as if FN27 represented all production capital", () => {
    const rows = history();
    const special = rows[0]!.fields.find((field) => field.code === "FN32")!;
    special.value = 500;
    special.raw = 500;
    const result = evaluateFinancialTheory(rows, context);
    expect(result.magic.eligible).toBe(false);
    expect(result.magic.matched).toBeNull();
    expect(result.magic.reason).toContain("特殊资产");
  });
  it("unknown special production assets stay unknown and cannot reject on basic capital", () => {
    const rows = history();
    const special = rows[0]!.fields.find((field) => field.code === "FN32")!;
    special.value = null;
    special.status = "source-zero";
    special.raw = 0;
    // Basic FN27 capital is nonpositive, but an unknown FN32 may cover the gap.
    rows[0]!.fields.find((field) => field.code === "FN54")!.value = 1000;
    const result = evaluateFinancialTheory(rows, context);
    expect(result.magic.eligible).toBe(false);
    expect(result.magic.matched).toBeNull();
    expect(result.magic.reason).toContain("特殊生产资产");
  });
  it("ties rank by symbol only at the end and unfilled slots stay in cash", () => {
    const result = evaluateFinancialTheory(history(), context);
    const book = rankFinancialTheory(
      [
        { symbol: "sz000002", result },
        { symbol: "sh600000", result },
      ],
      "magic-formula",
    );
    expect(book.positions.map((r) => r.symbol)).toEqual([
      "sh600000",
      "sz000002",
    ]);
    expect(book.positions.map((r) => r.score)).toEqual([2, 2]);
    expect(book.positions[0]?.weight).toBe(0.05);
    expect(book.cashWeight).toBe(0.9);
  });
});
