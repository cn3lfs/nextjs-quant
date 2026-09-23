import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cashReconciliationPage,
  extractStatementCashEvidence,
  reconcileCashDays,
  type CashEvidenceBatch,
} from "~/lib/portfolio/cash-reconciliation";
import { mapDeliveryColumns } from "~/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";

const fixture = parseDeliveryTable(
  readFileSync("tests/fixtures/delivery/cash-reconciliation.csv"),
);
const batch = (rows = fixture.rows, id = "fixture"): CashEvidenceBatch => ({
  id,
  fileHash: "fixture-sha256",
  payload: {
    mapping: mapDeliveryColumns(fixture.header),
    rawRows: rows,
    statementOpeningCash: 0,
  },
});
const result = (batches = [batch()]) =>
  reconcileCashDays({
    evidence: extractStatementCashEvidence(batches),
    openingCash: 0,
    projectedDays: [
      { date: "2026-01-02", cash: 750 },
      { date: "2026-01-03", cash: 799.99 },
    ],
  });

describe("cash statement daily evidence", () => {
  it("proves tied-time endpoints from a fixed balance chain without relying on export order", () => {
    for (const rows of [
      fixture.rows,
      [...fixture.rows].reverse(),
      [fixture.rows[1]!, fixture.rows[0]!, fixture.rows[3]!, fixture.rows[2]!],
    ]) {
      const evidence = extractStatementCashEvidence([batch(rows)]);
      expect(
        evidence.days.map((day) => [day.date, day.sources[0]!.statementCash]),
      ).toEqual([
        ["2026-01-02", 750],
        ["2026-01-03", 800],
      ]);
      expect(evidence.days.map((day) => day.sources[0]!.order)).toEqual([
        "balance-chain",
        "balance-chain",
      ]);
    }
  });
  it("compares cents, reports the first difference and keeps source row references", () => {
    const reviewed = result();
    expect(reviewed.summary).toMatchObject({
      comparableDays: 2,
      matchedDays: 1,
      differenceDays: 1,
      firstDifferenceDate: "2026-01-03",
      maximumAbsoluteDifference: 0.01,
    });
    expect(reviewed.days[1]).toMatchObject({
      difference: 0.01,
      evidence: [
        { batchId: "fixture", fileHash: "fixture-sha256", rowIndexes: [3, 4] },
      ],
    });
    expect(reviewed.opening.evidence[0]).toMatchObject({ difference: 0 });
  });
  it("does not choose an endpoint for a tied-time cycle, but accepts a distinct consistent time chain", () => {
    const rows = [
      ["20260102", "100000", "100", "200", "CNY"],
      ["20260102", "100000", "-100", "100", "CNY"],
    ];
    expect(result([batch(rows)]).days[0]).toMatchObject({
      status: "unavailable",
      statementCash: null,
    });
    rows[0]![1] = "090000";
    expect(
      extractStatementCashEvidence([batch(rows)]).days[0]!.sources[0],
    ).toMatchObject({
      order: "timestamp-chain",
      openingCash: 100,
      statementCash: 100,
    });
  });
  it.each([
    [
      "disconnected",
      [
        ["20260102", "090000", "100", "200", "CNY"],
        ["20260102", "100000", "50", "500", "CNY"],
      ],
    ],
    [
      "branched",
      [
        ["20260102", "090000", "100", "200", "CNY"],
        ["20260102", "100000", "200", "300", "CNY"],
      ],
    ],
    [
      "missing amount",
      [
        ["20260102", "090000", "", "200", "CNY"],
        ["20260102", "100000", "100", "300", "CNY"],
      ],
    ],
    ["missing balance", [["20260102", "090000", "100", "", "CNY"]]],
    ["invalid balance", [["20260102", "090000", "100", "Infinity", "CNY"]]],
    ["foreign currency", [["20260102", "090000", "100", "200", "HKD"]]],
  ])("rejects %s evidence without guessing", (_label, rows) => {
    const day = result([batch(rows)]).days[0]!;
    expect(day.status).toBe("unavailable");
    expect(day.difference).toBeNull();
    expect(day.evidence[0]!.reason).toBeTruthy();
  });
  it("invalid-date rows cannot be silently dropped to manufacture complete daily evidence", () => {
    const reviewed = result([
      batch([...fixture.rows, ["20260230", "090000", "100", "200", "CNY"]]),
    ]);
    expect(reviewed.diagnostics).toMatchObject([{ rowIndex: 5 }]);
    expect(reviewed.days.every((day) => day.status === "unavailable")).toBe(
      true,
    );
  });
  it.each(["", "NaN"])(
    "a last row with invalid amount %s remains in the day's evidence and prevents a false matched result",
    (amount) => {
      const rows = [
        ...fixture.rows,
        ["20260103", "110000", amount, "800", "CNY"],
      ];
      const day = result([batch(rows)]).days[1]!;
      expect(day).toMatchObject({
        status: "unavailable",
        statementCash: null,
        difference: null,
      });
      expect(day.evidence[0]!.rowIndexes).toEqual([3, 4, 5]);
    },
  );
  it("a last row with no balance cannot be replaced by the preceding valid balance", () => {
    const reviewed = result([
      batch([...fixture.rows, ["20260103", "110000", "0", "", "CNY"]]),
    ]);
    expect(reviewed.days[1]).toMatchObject({
      status: "unavailable",
      statementCash: null,
      difference: null,
    });
  });
  it("duplicate copies of a source neither double cash movements nor conceal conflicting sources", () => {
    const once = result();
    const twice = result([batch(), batch(fixture.rows, "duplicate")]);
    expect(twice.summary).toEqual(once.summary);
    expect(twice.days.map((day) => day.difference)).toEqual(
      once.days.map((day) => day.difference),
    );
    expect(twice.days[0]!.evidence).toHaveLength(2);
  });
  it("an unknown batch and review start cannot create a comparable opening difference", () => {
    const reviewed = reconcileCashDays({
      evidence: {
        days: [],
        diagnostics: [],
        openings: [
          { batchId: "missing-date", fileHash: "hash", date: null, value: 100 },
        ],
      },
      openingCash: 0,
      projectedDays: [],
    });
    expect(reviewed.opening.evidence[0]).toMatchObject({
      difference: null,
      reason: "批次或复盘起点未知，未比较期初现金",
    });
  });
  it("does not select the newest of conflicting sources or discard an ambiguous source", () => {
    const extra = batch([["20260102", "090000", "800", "800", "CNY"]], "other");
    expect(result([batch(), extra]).days[0]).toMatchObject({
      status: "conflict",
      statementCash: null,
      difference: null,
    });
    extra.payload.rawRows[0]![3] = "750";
    expect(result([batch(), extra]).days[0]!.status).toBe("matched");
    extra.payload.rawRows[0]![3] = "";
    expect(result([batch(), extra]).days[0]).toMatchObject({
      status: "unavailable",
      statementCash: 750,
      difference: null,
    });
  });
  it("keeps missing coverage and unknown projection null and never carries statement cash forward", () => {
    const reviewed = reconcileCashDays({
      evidence: extractStatementCashEvidence([batch()]),
      openingCash: null,
      projectedDays: [
        { date: "2026-01-02", cash: null },
        { date: "2026-01-04", cash: 800 },
      ],
    });
    expect(
      reviewed.days.map((day) => [day.date, day.status, day.difference]),
    ).toEqual([
      ["2026-01-02", "unavailable", null],
      ["2026-01-03", "unavailable", null],
      ["2026-01-04", "unavailable", null],
    ]);
    expect(reviewed.days[2]!.statementCash).toBeNull();
    expect(reviewed.opening.evidence[0]!.difference).toBeNull();
  });
  it("opening conflicts are displayed, not used to reset the caller's cash", () => {
    const reviewed = reconcileCashDays({
      evidence: extractStatementCashEvidence([batch()]),
      openingCash: 50,
      projectedDays: [{ date: "2026-01-02", cash: 800 }],
    });
    expect(reviewed.opening).toMatchObject({
      cash: 50,
      evidence: [{ difference: -50 }],
    });
    expect(reviewed.days[0]!.difference).toBe(-50);
  });
  it("does not compare a batch opening at a later start to the account opening", () => {
    const reviewed = reconcileCashDays({
      evidence: extractStatementCashEvidence([batch()]),
      openingCash: 0,
      projectedDays: [{ date: "2026-01-01", cash: 0 }],
    });
    expect(reviewed.opening.evidence[0]).toMatchObject({
      difference: null,
      reason: "批次起点与复盘起点不同，未比较期初现金",
    });
  });
  it("filters before server pagination and leaves input and export evidence unchanged", () => {
    const sources = [batch()];
    const before = JSON.stringify(sources);
    const reviewed = result(sources);
    const exported = JSON.stringify(reviewed);
    expect(
      cashReconciliationPage(reviewed, {
        status: "difference",
        pageSize: 1,
      }).rows.map((row) => row.date),
    ).toEqual(["2026-01-03"]);
    expect(
      cashReconciliationPage(reviewed, { pageIndex: 1, pageSize: 1 }),
    ).toMatchObject({ total: 2, rows: [{ date: "2026-01-03" }] });
    expect(cashReconciliationPage(reviewed, { pageIndex: 10 }).rows).toEqual(
      [],
    );
    expect(() => cashReconciliationPage(reviewed, { pageSize: 0 })).toThrow();
    expect(JSON.stringify(sources)).toBe(before);
    expect(JSON.stringify(reviewed)).toBe(exported);
  });
  it("an import without a balance column remains explicitly uncovered", () => {
    const source = batch();
    delete source.payload.mapping.columns.balanceCash;
    expect(result([source]).summary).toMatchObject({
      comparableDays: 0,
      unavailableDays: 2,
    });
  });
});
