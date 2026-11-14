import { expect, it } from "vitest";
import {
  timeline,
  scheduleSummary,
  health,
  todos,
  type OverviewInput,
} from "~/components/overview/overview-model";

it.each([true, false])(
  "saved subscription enabled=%s cannot advertise an active paused schedule",
  (enabled) => {
    const input: OverviewInput = {
      now: Date.parse("2026-11-13T07:10:00Z"),
      date: "2026-11-13",
      minutes: 15 * 60 + 10,
      coverage: null,
      channels: [],
      failedDeliveries: 0,
      intraday: {
        config: { enabled, noon: "11:20", late: "14:40" },
        lastCheck: null,
        worker: { running: false, error: null },
        runs: [],
        unconfirmed: 2,
      },
    };
    for (const slot of timeline(input).filter((slot) =>
      ["noon", "late", "close"].includes(slot.key),
    ))
      expect(slot.status).toBe("已暂停");
    expect(scheduleSummary(input)).toContain("暂停");
    expect(health(input).find((item) => item.key === "schedule")?.value).toBe(
      "已暂停",
    );
    expect(
      todos(input).find((todo) => todo.key === "intraday-paused")?.detail,
    ).toContain("不会恢复调度");
    expect(
      todos(input).filter((todo) =>
        ["intraday-off", "noon", "late", "confirm"].includes(todo.key),
      ),
    ).toEqual([]);
  },
);
