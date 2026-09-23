import { expect, it } from "vitest";
import { canslimFloat } from "../../../../src/lib/strategy-facts/canslim-float";
const raw = (yi: number) => ({
  status_code: 0,
  datas: [{ 股票代码: "600519.SH", "流通市值[20260908]": yi * 1e8 }],
  columns: [{ key: "流通市值[20260908]", unit: "元", timestamp: "20260908" }],
});
const events = {
  symbol: "sh600519",
  asOf: "2026-09-08",
  unlockWithinThreeMonths: false,
  activeBuybackPlan: false,
  evidenceIds: ["events"],
};
it("uses exact floating-cap units and resolves overlapping tier endpoints", () => {
  for (const [cap, points] of [
    [29.99, 0],
    [30, 2],
    [50, 4],
    [100, 5],
    [300, 5],
    [500, 4],
    [1000, 2],
    [1000.01, 0],
  ])
    expect(
      canslimFloat("sh600519", raw(cap!), events.asOf, events),
    ).toMatchObject({ status: "computed", points, floatMarketCapYi: cap });
});
it("applies event adjustments together and never invents missing event evidence", () => {
  expect(canslimFloat("sh600519", raw(100), events.asOf)).toMatchObject({
    status: "missing",
    points: 0,
    basePoints: 5,
  });
  expect(
    canslimFloat("sh600519", raw(100), events.asOf, {
      ...events,
      unlockWithinThreeMonths: true,
      activeBuybackPlan: true,
    }).points,
  ).toBe(5);
  expect(
    canslimFloat("sh600519", raw(20), events.asOf, {
      ...events,
      unlockWithinThreeMonths: true,
    }).points,
  ).toBe(0);
  expect(canslimFloat("sh600519", raw(100), "2026-09-07", events).status).toBe(
    "missing",
  );
  const wrong = raw(100);
  wrong.columns[0]!.unit = "亿元";
  expect(canslimFloat("sh600519", wrong, events.asOf, events).status).toBe(
    "missing",
  );
});
