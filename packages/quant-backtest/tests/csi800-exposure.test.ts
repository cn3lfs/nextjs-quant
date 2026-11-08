import { it, expect } from "vitest";
import { matchCsi800Exposure } from "../src/csi800-exposure.js";
const bar = (date: string, open: number, close: number) => ({
  date,
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  amount: 1e8,
  volume: 1e7,
});
it("matches overnight and opening exposures separately, preserving whole-lot cash", () => {
  const points = matchCsi800Exposure({
    initial: 1000,
    benchmark: [
      bar("2024-01-01", 100, 100),
      bar("2024-01-02", 110, 121),
      bar("2024-01-03", 133.1, 146.41),
    ],
    stocks: [
      {
        symbol: "sh600000",
        bars: [bar("2024-01-02", 5, 5.5), bar("2024-01-03", 6, 6.6)],
      },
    ],
    curve: [
      { date: "2024-01-02", equity: 1050, cash: 500, exposure: 550 / 1050 },
      { date: "2024-01-03", equity: 1160, cash: 500, exposure: 660 / 1160 },
    ],
    snapshots: [
      {
        date: "2024-01-02",
        symbol: "sh600000",
        quantity: 100,
        weight: 550 / 1050,
      },
      {
        date: "2024-01-03",
        symbol: "sh600000",
        quantity: 100,
        weight: 660 / 1160,
      },
    ],
  });
  expect(points[0]!.openExposure).toBe(0.5);
  expect(points[0]!.value).toBeCloseTo(1000 * (1 + 0.5 * 0.1));
  expect(points[1]!.value).toBeCloseTo(
    1050 * (1 + (550 / 1050) * 0.1) * (1 + (600 / 1100) * 0.1),
  );
});
it("rejects invalid account facts instead of fabricating a matched curve", () => {
  expect(() =>
    matchCsi800Exposure({
      initial: 1000,
      curve: [{ date: "2024-01-02", equity: 1000, cash: -1, exposure: 0.5 }],
      snapshots: [],
      benchmark: [bar("2024-01-01", 1, 1), bar("2024-01-02", 1, 1)],
      stocks: [],
    }),
  ).toThrow("现金非法");
});
