import { expect, it } from "vitest";
import { researchKellySwitch } from "trading-strategies/research/risk/research-kelly-switch";
import { researchKellySchema } from "trading-strategies/research/risk/research-kelly";

const evidence = JSON.stringify({
  checks: {
    trend: "是",
    level: "是",
    volume: "是",
    indicators: "是",
    candle: "否",
  },
});
const row = (i: number) => ({
  event: {
    symbol: "sh600000",
    key: String(i),
    observedDate: "2024-01-01",
    partition: "development",
  },
  entryDate: "2024-01-02",
  exitDate: "2024-01-03",
  profit: i < 15 ? 100 : -50,
  remainingQuantity: 0,
});
it("switches only at thirty prior complete outcomes and uses quarter versus half", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i));
  const before = researchKellySwitch(
    rows.slice(0, 29),
    "2024-01-01",
    "2024-02-01",
    "development",
    evidence,
    2,
  );
  expect(before).toMatchObject({
    source: "quality-proxy",
    sampleCount: 29,
    winRate: 0.5,
    fraction: 0.25,
    weight: 0.0625,
  });
  const after = researchKellySwitch(
    rows,
    "2024-01-01",
    "2024-02-01",
    "development",
    evidence,
    2,
  );
  expect(after).toMatchObject({
    source: "closed-trades",
    sampleCount: 30,
    winRate: 0.5,
    fraction: 0.5,
    weight: 0.125,
  });
  expect(
    researchKellySwitch(
      rows,
      "2024-01-01",
      "2024-01-03",
      "development",
      evidence,
      2,
    ).sampleCount,
  ).toBe(0);
  expect(
    researchKellySwitch(
      rows,
      "2024-01-01",
      "2024-02-01",
      "validation",
      evidence,
      2,
    ).sampleCount,
  ).toBe(0);
  expect(
    researchKellySwitch(
      [...rows, rows[0]!],
      "2024-01-01",
      "2024-02-01",
      "development",
      evidence,
      2,
    ).weight,
  ).toBeNull();
  expect(
    researchKellySwitch([], "2024-01-01", "2024-02-01", "development", "{}", 2)
      .weight,
  ).toBeNull();
  expect(
    researchKellySchema.safeParse({
      provenance: "rolling-switch30",
      payoff: 2,
      fraction: 0.25,
    }).success,
  ).toBe(false);
});
it("counts zero as non-win and excludes unfinished or future records", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    ...row(i),
    profit: i < 15 ? 100 : 0,
  }));
  const extra = [
    { ...row(40), remainingQuantity: 100 },
    { ...row(41), exitDate: "2024-03-01" },
  ];
  expect(
    researchKellySwitch(
      [...rows, ...extra],
      "2024-01-01",
      "2024-02-01",
      "development",
      "{}",
      2,
    ),
  ).toMatchObject({ sampleCount: 30, winRate: 0.5, zeros: 15, weight: 0.125 });
});
