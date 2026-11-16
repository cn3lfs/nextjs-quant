import { describe, expect, it } from "vitest";
import {
  defaultExecutionCosts,
  equityStampDutyBps,
  executionCostsForDate,
} from "../src/costs.js";
import { equityResearchRules } from "../src/market-rules.js";

describe("declared historical costs and same-date ST evidence", () => {
  it("uses the frozen 2023 stamp-duty boundary, including stress scaling", () => {
    expect(equityStampDutyBps("2023-08-27")).toBe(10);
    expect(equityStampDutyBps("2023-08-28")).toBe(5);
    expect(
      executionCostsForDate(
        {
          ...defaultExecutionCosts,
          sellTaxSchedule: { kind: "cn-equity-historical", multiplier: 2 },
        },
        "2023-08-27",
      ).sellTaxBps,
    ).toBe(20);
    expect(executionCostsForDate(defaultExecutionCosts, "2020-01-01")).toBe(
      defaultExecutionCosts,
    );
    expect(() => equityStampDutyBps("bad-date")).toThrow("date");
  });
  it("requires same-date ST evidence and preserves separate board rules", () => {
    const date = "2020-09-01",
      status = { st: true, source: "frozen historical fixture", date };
    expect(equityResearchRules("sh600000", date, status).limit).toBe(0.05);
    expect(equityResearchRules("sh600000", date).limit).toBe(0.1);
    expect(equityResearchRules("sh688001", date, status).limit).toBe(0.2);
    expect(equityResearchRules("sz300001", date, status).limit).toBe(0.2);
    expect(() =>
      equityResearchRules("sh600000", date, { ...status, date: "2020-08-31" }),
    ).toThrow("same-date");
  });
});
