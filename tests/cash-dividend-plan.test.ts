import { expect, it } from "vitest";
import { reconciledCashPlan } from "../src/server/backtest/cash-dividend-plan";
import { reconcileDividends } from "../src/server/backtest/dividend-reconciliation";
import { actionReview } from "../src/server/backtest/backtest-actions";
import { dividendSchedule } from "../src/server/data-sources/hithink/hithink-dividends";
import fixture from "./fixtures/hithink-dividends.json";
const remote = dividendSchedule("sh600519", fixture.raw, fixture.fetchedAt);
const source = {
  symbol: "sh600519",
  source: "tdx-local",
  bars: [{ date: "2025-01-01" }, { date: "2026-09-08" }],
};
const local = actionReview(
  source,
  remote.events.map((e) => ({
    date: `${String(e.ex).slice(0, 4)}-${String(e.ex).slice(4, 6)}-${String(e.ex).slice(6)}`,
    category: 1,
    name: "除权除息",
    dividend: Math.fround(Number(e.dividend) * 10) / 10,
    rightsPrice: 0,
    bonusRatio: 0,
    rightsRatio: 0,
  })),
  { file: "fixture", modified: 1, fetchedAt: 2 },
);
it("includes cash events needed by warmup and refuses uncovered or unmatched warmup", () => {
  const review = reconcileDividends(local, remote);
  expect(
    reconciledCashPlan(review, 0, "2026-07-01", "2026-09-08", "2026-06-01")
      .events,
  ).toHaveLength(1);
  expect(
    reconciledCashPlan(review, 0, "2026-07-01", "2026-09-08").events,
  ).toHaveLength(0);
  expect(() =>
    reconciledCashPlan(review, 0, "2026-07-01", "2026-09-08", "2024-01-01"),
  ).toThrow("覆盖");
  const extra = reconcileDividends(
    actionReview(
      source,
      [...local.events, { ...local.events[0]!, date: "2026-06-01" }],
      { file: "fixture", modified: 1, fetchedAt: 2 },
    ),
    remote,
  );
  expect(() =>
    reconciledCashPlan(extra, 0, "2026-07-01", "2026-09-08", "2026-06-01"),
  ).toThrow("缺项");
});
it("discloses other capital events in warmup but rejects them in the simulated holding window", () => {
  const review = reconcileDividends(
    actionReview(
      source,
      [...local.events, { date: "2026-05-28", category: 5, name: "股本变化" }],
      { file: "fixture", modified: 1, fetchedAt: 2 },
    ),
    remote,
  );
  expect(
    reconciledCashPlan(
      review,
      0,
      "2026-06-01",
      "2026-09-08",
      "2026-05-01",
    ).warmupWarnings?.join(),
  ).toContain("2026-05-28");
  expect(() =>
    reconciledCashPlan(review, 0, "2026-05-01", "2026-09-08"),
  ).toThrow("非现金");
});
it("creates an explicit tax scenario only within reconciled coverage", () => {
  const review = reconcileDividends(local, remote);
  const plan = reconciledCashPlan(review, 2000, "2026-01-01", "2026-09-08");
  expect(plan.events).toHaveLength(1);
  expect(plan.events[0]).toMatchObject({
    record: "2026-06-25",
    pay: "2026-06-26",
    perShare: 28.02423,
  });
  expect(plan.taxBps).toBe(2000);
  expect(plan.reconciliationHash).toBe(review.hash);
  expect(() =>
    reconciledCashPlan(review, 2000, "2024-01-01", "2026-09-08"),
  ).toThrow("覆盖");
  expect(() =>
    reconciledCashPlan(review, -1, "2026-01-01", "2026-09-08"),
  ).toThrow();
});
it("refuses incomplete events rather than silently dropping them, and refuses changed hashes", () => {
  const review = reconcileDividends(
    actionReview(
      source,
      [...local.events, { ...local.events[0]!, date: "2026-05-01" }],
      { file: "fixture", modified: 1, fetchedAt: 2 },
    ),
    remote,
  );
  expect(() =>
    reconciledCashPlan(review, 0, "2026-01-01", "2026-09-08"),
  ).toThrow("缺项");
  const changed = structuredClone(review);
  changed.rows = changed.rows.filter((r) => r.status === "matched-cash");
  expect(() =>
    reconciledCashPlan(changed, 0, "2026-01-01", "2026-09-08"),
  ).toThrow("校验");
});
