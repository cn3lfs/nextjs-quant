import { expect, it } from "vitest";
import { researchKellyTraining } from "trading-strategies/research/risk/research-kelly-training";
import { researchKellyLimit } from "trading-strategies/research/risk/research-kelly";

const sample = (i: number, profit = 1) => ({
  event: {
    symbol: "sh600000",
    key: String(i),
    observedDate: "2024-01-01",
    partition: "development",
  },
  entryDate: "2024-01-02",
  exitDate: "2024-01-03" as string | null,
  profit: profit as number | null,
  remainingQuantity: 0,
});
it("requires thirty unique fully closed net outcomes and keeps zero outcomes explicit", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    sample(i, i < 15 ? 1 : i < 25 ? -1 : 0),
  );
  expect(
    researchKellyTraining(rows.slice(1), "2024-01-01", "2024-02-01").winRate,
  ).toBeNull();
  const result = researchKellyTraining(rows, "2024-01-01", "2024-02-01");
  expect(result).toMatchObject({
    wins: 15,
    losses: 10,
    zeros: 5,
    winRate: 0.5,
    reason: null,
  });
  expect(
    researchKellyTraining([...rows, rows[0]!], "2024-01-01", "2024-02-01")
      .winRate,
  ).toBeNull();
  const invalid = [
    { ...sample(31), exitDate: null },
    { ...sample(32), exitDate: "2024-02-01" },
    { ...sample(33), remainingQuantity: 100 },
    { ...sample(34), profit: NaN },
    { ...sample(35), event: { ...sample(35).event, partition: "validation" } },
  ];
  expect(
    researchKellyTraining([...rows, ...invalid], "2024-01-01", "2024-02-01"),
  ).toMatchObject({ wins: 15, excluded: 5, winRate: 0.5 });
  const config = {
    provenance: "development-closed" as const,
    payoff: 2,
    fraction: 0.5,
  };
  expect(researchKellyLimit(config).weight).toBeNull();
  expect(researchKellyLimit(config, 0).weight).toBe(0);
  expect(researchKellyLimit(config, 1).weight).toBe(0.5);
});
