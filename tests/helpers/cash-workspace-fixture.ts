import {
  reconcileCashDays,
  type CashDaySource,
} from "../../src/lib/portfolio/cash-reconciliation";
/** Deterministic synthetic cash history; no application database or local market files. */
export function cashWorkspaceFixture(count: number, largeRows = 0) {
  const date = (i: number) =>
    new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10);
  const source = (i: number, value: number, id = "a"): CashDaySource => ({
    batchId: `cash-fixture-${id}-${i}`,
    fileHash: `synthetic-${id}-${i}`,
    rowIndexes: [i + 1],
    rows: Array.from(
      { length: i === 0 && largeRows ? largeRows : 2 },
      (_, j) => ({
        rowIndex: j + 1,
        time: "15:00:00",
        balanceCash: value,
        netAmount: 1,
      }),
    ),
    order: "single-row",
    openingCash: value - 1,
    statementCash: value,
    reason: null,
  });
  return reconcileCashDays({
    openingCash: 0,
    projectedDays: Array.from({ length: count }, (_, i) => ({
      date: date(i),
      cash: 100 + i,
    })),
    evidence: {
      days: Array.from({ length: count }, (_, i) => ({
        date: date(i),
        sources:
          i % 4 === 2
            ? []
            : i % 4 === 3
              ? [source(i, 100 + i), source(i, 102 + i, "b")]
              : [source(i, 100 + i + (i % 4 === 1 ? 0.01 : 0))],
      })),
      openings: [],
      diagnostics: [],
    },
  });
}
