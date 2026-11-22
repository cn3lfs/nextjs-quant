import { describe, expect, it } from "vitest";
import { AtomsPortfolioAccount as PortfolioAccount } from "../src/portfolio/atoms-account.js";

describe("intraday settlement uses trading dates", () => {
  it("keeps same-day equity lots locked across bars and lunch", () => {
    const account = new PortfolioAccount(10000);
    account.fill("stock", "2026-11-16 09:35", "buy", 100, 10, 0, 1);
    expect(account.sellable("stock", "2026-11-16 14:55", 1)).toBe(0);
    expect(() =>
      account.fill("stock", "2026-11-16 14:55", "sell", 100, 10, 0, 1),
    ).toThrow("T+1");
    expect(account.sellable("stock", "2026-11-17 09:35", 1)).toBe(100);
  });

  it("sells only yesterday's lots and keeps today's additions", () => {
    const account = new PortfolioAccount(10000);
    account.fill("stock", "2026-11-16 14:55", "buy", 100, 10, 0, 1);
    account.fill("stock", "2026-11-17 09:35", "buy", 100, 10, 0, 1);
    account.fill("stock", "2026-11-17 14:55", "sell", 100, 10, 0, 1);
    expect(account.positions.get("stock")?.lots).toEqual([
      { quantity: 100, bought: "2026-11-17 09:35" },
    ]);
    expect(account.sellable("stock", "2026-11-17 15:00", 1)).toBe(0);
  });

  it("retains crypto T+0 and explicit corporate-action availability", () => {
    const account = new PortfolioAccount(10000);
    account.fill("coin", "2026-11-16T00:05:00Z", "buy", 1, 100, 0, 0);
    expect(account.sellable("coin", "2026-11-16T00:10:00Z", 0)).toBe(1);
    account.corporateAction(
      "coin",
      {
        date: "2026-11-16",
        availableAt: "2026-11-16",
        cashAvailableAt: "2026-11-16",
        timingAssumption: "ex-date-research-scenario",
        sharesSellableAt: "2026-11-18",
        dividend: 0,
        bonus: 1,
        evidence: "fixture",
      },
      false,
      0,
    );
    expect(account.sellable("coin", "2026-11-17T00:10:00Z", 0)).toBe(1);
    expect(account.sellable("coin", "2026-11-18T00:10:00Z", 0)).toBe(2);
  });
});
