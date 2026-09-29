import { expect, it } from "vitest";
import {
  dailyFreshness,
  health,
  todos,
  type OverviewInput,
} from "~/components/overview/overview-model";
import { expectedDailyAsOf } from "~/lib/market/daily-freshness";

/** Beijing wall-clock time as epoch ms. */
const at = (iso: string) => Date.parse(`${iso}+08:00`);
const calendar = { days: ["2026-09-25", "2026-09-28", "2026-09-29"] };

it("expects the previous trading day before 15:05 and today after it", () => {
  expect(expectedDailyAsOf(calendar, at("2026-09-29T10:00:00"))).toBe(
    "2026-09-28",
  );
  expect(expectedDailyAsOf(calendar, at("2026-09-29T15:04:00"))).toBe(
    "2026-09-28",
  );
  expect(expectedDailyAsOf(calendar, at("2026-09-29T15:05:00"))).toBe(
    "2026-09-29",
  );
  // Weekend / unknown day: the last trading day before it.
  expect(expectedDailyAsOf(calendar, at("2026-09-27T20:00:00"))).toBe(
    "2026-09-25",
  );
  expect(expectedDailyAsOf({ days: [] }, at("2026-09-29T20:00:00"))).toBeNull();
});

const input = (daily: OverviewInput["daily"]): OverviewInput => ({
  now: 0,
  date: "2026-09-29",
  minutes: 600,
  coverage: { counts: { day: 5000 }, scannedAt: 0 },
  channels: [],
  failedDeliveries: 0,
  daily,
});

it("surfaces lagging data on the card and as a next step", () => {
  const stale = input({ asOf: "2026-09-25", expected: "2026-09-28" });
  expect(dailyFreshness(stale)).toEqual({
    asOf: "2026-09-25",
    expected: "2026-09-28",
    lagging: true,
  });
  const card = health(stale).find((c) => c.key === "day")!;
  expect(card.value).toBe("截至 09-25");
  expect(card.tone).toBe("warn");
  expect(card.note).toContain("2026-09-28");
  expect(todos(stale).some((t) => t.key === "daily-stale")).toBe(true);
  const current = input({ asOf: "2026-09-28", expected: "2026-09-28" });
  expect(health(current).find((c) => c.key === "day")!.tone).toBe("neutral");
  expect(todos(current).some((t) => t.key === "daily-stale")).toBe(false);
});

it("says nothing when either side is unknown", () => {
  expect(dailyFreshness(input(null))).toBeNull();
  expect(
    dailyFreshness(input({ asOf: "2026-09-28", expected: null })),
  ).toBeNull();
  expect(
    dailyFreshness(input({ asOf: null, expected: "2026-09-28" })),
  ).toBeNull();
});
