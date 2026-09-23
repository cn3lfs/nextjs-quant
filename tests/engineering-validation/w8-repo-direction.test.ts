import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import {
  importDeliveryTable,
  type ParsedFill,
} from "../../src/lib/research/evidence/delivery-import";
import { reviewTrades } from "../../src/lib/portfolio/trade-review";
const parsed = importDeliveryTable(
  parseDeliveryTable(
    readFileSync("tests/fixtures/delivery/ths-statement.html"),
  ),
);
const repo = (
  netAmount: number | null,
  kind: "buy" | "sell" = "sell",
  code = "204001",
): ParsedFill => ({
  ...parsed.fills[0]!,
  instrument: "reverseRepo",
  code,
  symbol: null,
  quantity: 1,
  price: 1,
  amount: 1000,
  kind,
  netAmount,
  anomalies: [],
});
it("balances cash directions despite a conflicting operation and preserves ordinary results", () => {
  const fills = [
    repo(-1001),
    repo(-1001),
    repo(-1001),
    repo(1002, "buy"),
    repo(1002, "buy"),
    repo(1002),
  ];
  const r = reviewTrades({ fills });
  // 3 * (-1001 + 1002) = 3.
  expect(r.reverseRepo.interestIncome.value).toBe(3);
  expect(r.reverseRepo.capitalCommitted.value).toBe(3003);
  expect(
    r.reverseRepo.warnings.filter((x) =>
      x.includes("操作列与资金方向不一致，以资金方向为准"),
    ),
  ).toHaveLength(1);
  expect(
    reviewTrades({ fills: fills.slice(0, -1) }).reverseRepo.interestIncome
      .value,
  ).toBeNull();
  const ordinary = reviewTrades(parsed);
  const { reverseRepo: _repo, ...ordinaryFields } = ordinary;
  expect(
    createHash("sha256").update(JSON.stringify(ordinaryFields)).digest("hex"),
  ).toBe("82fa6ba78d706c70195c1a4ae13c68a605cb7cdfd10292703e6d7067115d50ea");
  const mixed = reviewTrades({ ...parsed, fills: [...parsed.fills, ...fills] });
  expect(mixed.movingAverage).toEqual(ordinary.movingAverage);
  expect(mixed.fifo).toEqual(ordinary.fifo);
  expect(mixed.tradePoints).toEqual(ordinary.tradePoints);
});
it.each([null, NaN, Infinity, -Infinity, 0])(
  "does not guess direction for %s",
  (net) => {
    const r = reviewTrades({ fills: [repo(net), repo(1002, "buy")] });
    expect(r.reverseRepo.unknownDirectionCount).toBe(1);
    expect(r.reverseRepo.interestIncome.value).toBeNull();
    expect(r.reverseRepo.interestIncome.reason).toContain("方向不可判");
    expect(r.reverseRepo.warnings.some((x) => x.includes("方向不可判"))).toBe(
      true,
    );
  },
);
it("does not net different securities together and audits buy/outflow conflicts", () => {
  const r = reviewTrades({
    fills: [repo(-1001, "buy"), repo(1002, "buy", "131810")],
  });
  expect(r.reverseRepo.interestIncome.value).toBeNull();
  expect(
    r.reverseRepo.warnings.some((x) => x.includes("操作列与资金方向不一致")),
  ).toBe(true);
});
it.runIf(process.env.W8_REAL_DATA === "1")(
  "accepts the real statement and exact pre-change ordinary output",
  () => {
    const p = importDeliveryTable(
      parseDeliveryTable(
        readFileSync(".test-data/statements-v2/lishi20-26.xls"),
      ),
    );
    const { reverseRepo, ...rest } = reviewTrades(p);
    expect(reverseRepo.interestIncome.value).toBeCloseTo(904.98, 2);
    expect(reverseRepo.capitalCommitted.value).toBeCloseTo(8626091.3, 2);
    expect(reverseRepo.unknownDirectionCount).toBe(0);
    expect(
      reverseRepo.warnings.filter((x) => x.includes("操作列与资金方向不一致")),
    ).toHaveLength(30);
    expect(rest.movingAverage.closedRounds).toHaveLength(785);
    expect(rest.movingAverage.statistics.count).toBe(784);
    expect(rest.movingAverage.statistics.winRate).toBe(399 / 784);
    expect(rest.movingAverage.statistics.payoffRatio).toBeCloseTo(
      0.8912012172774283,
      14,
    );
    expect(
      createHash("sha256").update(JSON.stringify(rest)).digest("hex"),
    ).toBe("2d90dd70e363944ddf226608af4134da367491ec59dd601c9404f44c66eefbae");
    console.log(
      JSON.stringify({
        interest: reverseRepo.interestIncome.value,
        capital: reverseRepo.capitalCommitted.value,
        rounds: rest.movingAverage.closedRounds.length,
        statistics: rest.movingAverage.statistics,
        conflicts: 30,
      }),
    );
  },
);
it("infers repo fees from cash direction on both conflicting labels", () => {
  const r = reviewTrades({ fills: [repo(-1001, "buy"), repo(999, "sell")] });
  expect(
    r.reverseRepo.feeSources.map((x) => ({
      amount: x.amount,
      source: x.source,
    })),
  ).toEqual([
    { amount: 1, source: "netAmount" },
    { amount: 1, source: "netAmount" },
  ]);
});
