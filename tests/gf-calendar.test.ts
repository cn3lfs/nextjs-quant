import { expect, it } from "vitest";
import raw from "./fixtures/gf-calendar-202610.json";
import { parseGfCalendar } from "../src/server/data-sources/gf/gf-calendar";
import { screenDataHealth } from "../src/server/market/data-health";
it("uses trading flags independently from the absent future leaderboard and covers holiday boundaries", () => {
  const calendar = parseGfCalendar(raw, "2026-10");
  expect(calendar.days).toContain("2026-10-08");
  expect(calendar.days).toContain("2026-09-30");
  expect(calendar.closedDays).toContain("2026-10-01");
  for (const [today, bar] of [
    ["2026-10-01", "2026-09-30"],
    ["2026-10-08", "2026-10-08"],
  ]) {
    expect(
      screenDataHealth(
        bar!,
        "day",
        Date.parse(`${today}T16:00:00+08:00`),
        calendar,
      ).status,
    ).toBe("aligned");
  }
  expect(
    screenDataHealth(
      "2026-09-30",
      "day",
      Date.parse("2026-10-08T16:00:00+08:00"),
      calendar,
    ).status,
  ).toBe("lagging");
  expect(
    screenDataHealth(
      "2026-10-30",
      "day",
      Date.parse("2026-11-01T16:00:00+08:00"),
      calendar,
    ).status,
  ).toBe("unknown");
});
it("rejects incomplete, duplicate, invalid dates and broken predecessor chains", () => {
  expect(() =>
    parseGfCalendar({ ...raw, data: raw.data.slice(1) }, "2026-10"),
  ).toThrow();
  for (const patch of [
    { normDay: 20261000 },
    { normDay: 20261002 },
    { isTrdDay: 2 },
    { nxtTrdDay: 20261001 },
    { latesTrdDay: 20261001 },
  ]) {
    expect(() =>
      parseGfCalendar(
        { ...raw, data: [{ ...raw.data[0], ...patch }, ...raw.data.slice(1)] },
        "2026-10",
      ),
    ).toThrow();
  }
  const changed = structuredClone(raw);
  changed.data[8]!.preTrdDay = 20260930;
  expect(() => parseGfCalendar(changed, "2026-10")).toThrow();
});
