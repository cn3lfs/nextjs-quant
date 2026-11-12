import { describe, it, expect } from "vitest";
import {
  configSchema,
  floorStep,
  orderQuantity,
} from "../../src/server/crypto-trading/model";
describe("spot admission", () => {
  const rules = { step: "0.00001", min: "0.00001", max: "10", minValue: "5" };
  it("floors exactly without spending above budget", () => {
    expect(floorStep("0.123459999999999999", "0.00001")).toBe("0.12345");
    expect(orderQuantity("0.001239999999", "50000", rules)).toBe("0.00123");
  });
  it("refuses dust and oversized orders", () => {
    expect(() => orderQuantity("0.000001", "50000", rules)).toThrow();
    expect(() => orderQuantity("11", "50000", rules)).toThrow();
    expect(() => orderQuantity("0.00001", "50000", rules)).toThrow();
  });
  it("refuses live and unsupported networks and excess budgets", () => {
    expect(
      configSchema.safeParse({ venue: "okx", network: "testnet" }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ venue: "binance", network: "live" }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ venue: "bybit", allocation: 0.5 }).success,
    ).toBe(false);
    expect(configSchema.parse({ venue: "bybit" })).toMatchObject({
      network: "demo",
      minutes: 60,
      fast: 5,
      slow: 20,
      allocation: 0.4,
    });
  });
});
