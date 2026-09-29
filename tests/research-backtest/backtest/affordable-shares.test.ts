import { describe, expect, it } from "vitest";
import { big, bigFloor } from "~/lib/money";
import { affordableShares } from "~/server/backtest/quant";

const decimal = (cash: number, fee: number, price: number, c: number) =>
  Math.max(
    0,
    bigFloor(
      big(cash)
        .minus(fee)
        .div(big(price).times(big(1).plus(c)))
        .div(100),
    ),
  ) * 100;

describe("affordableShares", () => {
  it("matches the Big.js lot floor on random and boundary inputs", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 5000; i++) {
      const price = Math.round((0.5 + rand() * 3000) * 100) / 100;
      const c = [0, 0.0003, 0.00025, 0.001][i % 4]!;
      const fee = [0, 5, 0.1][i % 3]!;
      const lots = Math.floor(rand() * 5000);
      // Exact lot boundaries, one cent either side, and arbitrary cash.
      const edge = fee + price * (1 + c) * 100 * lots;
      for (const cash of [
        edge,
        edge - 0.01,
        edge + 0.01,
        rand() * 1e7,
        fee - 1,
      ])
        expect(affordableShares(cash, fee, price, c)).toBe(
          decimal(cash, fee, price, c),
        );
    }
  });
});
