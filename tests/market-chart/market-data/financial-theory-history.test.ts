import { describe, expect, it } from "vitest";
import {
  financialRebalanceDates,
  loadFinancialTheoryYear,
} from "~/server/financial/financial-theory-history";
import { localFinancialTheory } from "~/server/financial/financial-theory-adapter";
import { financialScreenInput } from "~/lib/financial/local-financial";
import type { LocalFactorSource } from "trading-strategy-core/factors";

describe("annual financial research boundaries", () => {
  it("freezes the prior completed trading day, not rebalance-day closing data", () => {
    expect(
      financialRebalanceDates(
        ["2024-12-31", "2025-01-02", "2025-12-31", "2026-01-05"],
        2025,
        2026,
      ),
    ).toEqual([
      { year: 2025, asOf: "2024-12-31", executeAt: "2025-01-02" },
      { year: 2026, asOf: "2025-12-31", executeAt: "2026-01-05" },
    ]);
  });
  it("rejects a missing preceding date and duplicated calendar rows", () => {
    expect(() => financialRebalanceDates(["2025-01-02"], 2025, 2025)).toThrow(
      "前一完成",
    );
    expect(() =>
      financialRebalanceDates(
        ["2024-12-31", "2024-12-31", "2025-01-02"],
        2025,
        2025,
      ),
    ).toThrow("递增");
  });
  it("rejects same-day execution before invoking source readers", async () => {
    await expect(
      loadFinancialTheoryYear({
        root: "not-used",
        symbols: [],
        asOf: "2025-01-02",
        executeAt: "2025-01-02",
        calendarHash: "calendar",
        poolHash: "pool",
        researchCodeHash: "code",
      }),
    ).rejects.toThrow("事前");
  });
  it("a theory preset is a real screening condition, with current/historical mode retained", () => {
    expect(
      financialScreenInput.parse({
        asOf: "2026-11-16",
        strict: false,
        conditions: [],
        theoryPreset: "f-score",
      }).theoryPreset,
    ).toBe("f-score");
    expect(
      financialScreenInput.safeParse({ asOf: "2026-11-16", conditions: [] })
        .success,
    ).toBe(false);
  });
  it("missing GP16 and missing reports remain unknown", () => {
    const result = localFinancialTheory([], "2026-11-16", false);
    expect(result.fScore.score).toBeNull();
    expect(result.magic.eligible).toBe(false);
    expect(result.magic.enterpriseValue.inputs[0]?.value).toBeNull();
    expect(result.magic.enterpriseValue.inputs[0]?.reason).toBeTruthy();
    expect(result.magic.enterpriseValue.inputs[0]?.reason).not.toContain(
      "使用原始记录",
    );
  });
  it("labels a known same-day market cap as source evidence, not missing", () => {
    const stock: LocalFactorSource = {
      namespace: "GP",
      filename: "gpsh601898.dat",
      sourceSha256: "fixture-source",
      records: [
        { group: 16, date: 20261116, values: [16493777, 0], offset: 0 },
      ],
    };
    const capital = localFinancialTheory([], "2026-11-16", false, stock).magic
      .enterpriseValue.inputs[0]!;
    expect(capital.value).toBe(164937770000);
    expect(capital.sourceSha256).toBe("fixture-source");
    expect(capital.reason).toContain("按字段单位换算为元");
    expect(capital.reason).not.toContain("缺失");

    const missingIdentity = localFinancialTheory([], "2026-11-16", false, {
      ...stock,
      sourceSha256: "",
    }).magic.enterpriseValue.inputs[0]!;
    expect(missingIdentity.value).toBeNull();
    expect(missingIdentity.reason).toContain("缺失");
  });
});
