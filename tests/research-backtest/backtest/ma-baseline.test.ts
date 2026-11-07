import { expect, it } from "vitest";
import { returnCurve, drawdownCurve } from "~/lib/backtest/equity-drawdown";
it("baseline charts include initial capital instead of hiding first-day fees", () => {
  const points = [{ date: "2026-10-12", value: 995 }];
  expect(returnCurve(points, 1000)[0]!.value).toBeCloseTo(-0.5);
  expect(drawdownCurve(points, 1000)[0]!.value).toBeCloseTo(-0.5);
});
