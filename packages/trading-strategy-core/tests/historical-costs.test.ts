import { describe, expect, it } from "vitest";
import {
  defaultExecutionCosts,
  equityStampDutyBps,
  equityTransferBps,
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
  it("switches the A-share transfer fee with the same historical boundary", () => {
    expect(equityTransferBps("2022-04-28")).toBe(0.2);
    expect(equityTransferBps("2022-04-29")).toBe(0.1);
    expect(
      executionCostsForDate(
        {
          ...defaultExecutionCosts,
          transferSchedule: { kind: "cn-equity-transfer", multiplier: 2 },
        },
        "2022-04-28",
      ).transferBps,
    ).toBe(0.4);
  });
  it("requires same-date ST evidence and preserves separate board rules", () => {
    const date = "2020-09-01",
      status = { st: true, source: "frozen historical fixture", date };
    expect(equityResearchRules("sh600000", date, status).limit).toBe(0.05);
    expect(equityResearchRules("sh600000", date).limit).toBe(0.1);
    expect(equityResearchRules("sh688001", date, status).limit).toBe(0.2);
    expect(equityResearchRules("sz300001", date, status).limit).toBe(0.2);
    expect(equityResearchRules("bj430047", date)).toMatchObject({
      minimum: 100,
      step: 1,
      limit: 0.3,
    });
    expect(() =>
      equityResearchRules("sh600000", date, { ...status, date: "2020-08-31" }),
    ).toThrow("same-date");
    // Main-board ST widened to 10% on 2026-07-06; the 5% rule ends the day
    // before, and ChiNext/STAR keep their 20% limits throughout.
    expect(
      equityResearchRules("sh600000", "2026-07-05", {
        ...status,
        date: "2026-07-05",
      }).limit,
    ).toBe(0.05);
    expect(
      equityResearchRules("sh600000", "2026-07-06", {
        ...status,
        date: "2026-07-06",
      }).limit,
    ).toBe(0.1);
    expect(
      equityResearchRules("sz300001", "2026-07-06", {
        ...status,
        date: "2026-07-06",
      }).limit,
    ).toBe(0.2);
  });
});
