import { describe, expect, it } from "vitest";
import { indexCoverageCases } from "../../scripts/lib/research/method-pool-coverage";

const cell = {
  market: "cn-equity",
  strategyId: "portfolio-a",
  window: "development",
  scenario: "base",
};

describe("method-pool coverage indexing", () => {
  it("keeps the same scenario key under different input identities as separate evidence", () => {
    const rows = [
      {
        ...cell,
        identity: "a".repeat(64),
        version: "theory-study-ten-2",
        evidenceSize: 500,
      },
      {
        ...cell,
        identity: "b".repeat(64),
        version: "theory-study-ten-3",
        evidenceSize: 1,
      },
    ];
    const cases = indexCoverageCases(rows);

    expect(cases.get("portfolio-a")).toHaveLength(2);
    expect(cases.get("portfolio-a")!.map((row) => row.identity)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(indexCoverageCases([...rows].reverse()).get("portfolio-a")).toEqual(
      cases.get("portfolio-a"),
    );
  });

  it("deduplicates only the identical identity and scenario key", () => {
    const row = {
      ...cell,
      identity: "a".repeat(64),
      version: "theory-study-ten-3",
      evidenceSize: 1,
    };
    const cases = indexCoverageCases([row, { ...row }]);

    expect(cases.get("portfolio-a")).toHaveLength(1);
  });
});
