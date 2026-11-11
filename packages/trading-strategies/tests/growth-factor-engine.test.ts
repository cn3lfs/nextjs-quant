import { expect, it } from "vitest";
import {
  evaluateGrowthFactorsFromContext,
  rankGrowthFactorRows,
} from "../src/research/growth/growth-factor-engine.js";
import type {
  GrowthFactorContext,
  GrowthEvidenceRow,
} from "../src/research/contracts/growth-factor-context.js";
const request = {
  symbol: "sh600000",
  asOf: "2024-05-01T15:00:00+08:00",
  observationDate: "2024-05-01",
  financialPeriods: ["2024-03-31"],
  annualPeriods: ["2023-12-31"],
  institutionPeriods: ["2024-03-31"],
  universeId: "fixture",
  benchmarkId: "sh000300",
};
function context(
  current = 1.25,
  base = 1,
  error?: string,
): GrowthFactorContext<GrowthEvidenceRow> {
  return {
    request,
    fieldUnit: () => "CNY/share",
    fingerprintPriceHistory: () => "diagnostic-only",
    readValidated: (domain, field, effectiveAt) => ({
      row: {
        domain,
        field,
        effectiveAt,
        entity: request.symbol,
        status: "available",
        value: effectiveAt === "2024-03-31" ? current : base,
      },
      ...(error ? { error } : {}),
    }),
  };
}
it("executes actual EPS tier mathematics on an explicit admitted fact reader", () => {
  const evaluate = (current: number, base: number) =>
    evaluateGrowthFactorsFromContext(context(current, base), ["CA-S-C1"])
      .results[0]!;
  expect(evaluate(1.25, 1)).toMatchObject({
    status: "computed",
    points: 6,
    details: { growthPct: 25 },
  });
  expect(evaluate(1.2499, 1)).toMatchObject({ status: "computed", points: 3 });
  expect(evaluate(1.5, 1)).toMatchObject({ status: "computed", points: 8 });
  expect(evaluate(1.5, 0)).toMatchObject({ status: "missing", points: null });
});
it("preserves admitted evidence and exposes a rejected reader observation as missing", () => {
  const result = evaluateGrowthFactorsFromContext(
    context(1.5, 1, "publication version rejected"),
    ["CA-S-C1"],
  ).results[0]!;
  expect(result.status).toBe("missing");
  expect(result.points).toBeNull();
  expect(result.evidence.length).toBeGreaterThan(0);
  expect(
    result.dataGaps.some(
      (gap) => gap.reason === "publication version rejected",
    ),
  ).toBe(true);
});
it("ranks equal admitted scores together and rejects mismatched comparison contexts", () => {
  const requests = [request, { ...request, symbol: "sh600001" }];
  const rows = requests.map((req) => ({
    symbol: req.symbol,
    ...evaluateGrowthFactorsFromContext({ ...context(), request: req }, [
      "CA-S-C1",
    ]).results[0]!,
  }));
  expect(rankGrowthFactorRows(requests, rows).map((row) => row.rank)).toEqual([
    1, 1,
  ]);
  expect(() =>
    rankGrowthFactorRows(
      [request, { ...requests[1]!, asOf: "2024-05-02T15:00:00+08:00" }],
      rows,
    ),
  ).toThrow("相同时点");
  expect(() => rankGrowthFactorRows(requests, rows.slice(0, 1))).toThrow(
    "一一对应",
  );
});
