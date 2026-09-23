import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  gf: vi.fn(),
  local: vi.fn(),
  history: vi.fn(),
  increments: vi.fn(),
}));
vi.mock("../../../src/server/data-sources/tdx/tdx-daily-cache", () => ({
  readDailyIncrementRange: mocks.increments,
}));
vi.mock("../../../src/server/data-sources/gf/gf-calendar", () => ({
  gfCalendarReference: mocks.gf,
}));
vi.mock("../../../src/server/market/data-health", async (original) => ({
  ...(await original<typeof import("../../../src/server/market/data-health")>()),
  localCalendarReference: mocks.local,
}));
vi.mock("../../../src/server/market/preferred-online-chart", () => ({
  preferredOnlineChart: mocks.history,
}));
import { monitorCalendar } from "../../../src/server/monitoring/monitor-calendar";
import { freshCompleted, transition } from "../../../src/server/runtime";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.increments.mockReturnValue([]);
  mocks.local.mockResolvedValue({ days: [], source: "local", hash: null });
  mocks.gf.mockResolvedValue({
    days: ["2026-09-30", "2026-10-08"],
    closedDays: ["2026-10-01"],
    source: "gf",
    hash: "fixture",
  });
});
it("prefers user overrides, then the declared calendar, without requesting index history", async () => {
  await monitorCalendar("root", ["2026-10-08"], true, true, 0);
  expect(mocks.gf).not.toHaveBeenCalled();
  expect(mocks.increments).not.toHaveBeenCalled();
  const calendar = await monitorCalendar("root", [], true, true, 0);
  expect(calendar.source).toBe("gf");
  expect(mocks.history).not.toHaveBeenCalled();
  const now = Date.parse("2026-10-01T16:00:00+08:00");
  expect(freshCompleted("2026-09-30", "day", now, calendar.days)).toBe(false);
  expect(freshCompleted("2026-10-01", "day", now, calendar.days)).toBe(false);
  const fresh = freshCompleted(
    "2026-10-08",
    "day",
    Date.parse("2026-10-08T16:00:00+08:00"),
    calendar.days,
  );
  expect(fresh).toBe(true);
  const before = { date: "2026-09-30", matched: false },
    after = { date: "2026-10-08", matched: true };
  expect(transition(before, after, fresh, true)).toBe(false);
  expect(transition(before, after, fresh, false)).toBe(true);
});

// g4day 暂停（见 docs/decisions.md WF3）：日历不再并入增量日期，解冻时去掉 .skip。
it.skip("extends local fallback with observed index increments and preserves version evidence", async () => {
  const now = Date.parse("2026-09-11T16:00:00+08:00");
  mocks.gf.mockRejectedValue(new Error("unavailable"));
  mocks.local.mockResolvedValue({
    days: ["2026-09-10"],
    source: "local",
    hash: "base",
  });
  mocks.increments.mockReturnValue([
    {
      snapshot: { id: "published", observedAt: now - 1 },
      record: { bar: { date: "2026-09-11", volume: 1 } },
    },
    {
      snapshot: { id: "future", observedAt: now + 1 },
      record: { bar: { date: "2026-09-12", volume: 1 } },
    },
    {
      snapshot: { id: "empty", observedAt: now - 1 },
      record: { bar: { date: "2026-09-13", volume: 0 } },
    },
  ]);
  const result = await monitorCalendar("root", [], false, true, now);
  expect(result.days).toEqual(["2026-09-10", "2026-09-11"]);
  expect(result.source).toContain("非完整交易日历");
  expect(result.hash).not.toBe("base");
  expect(mocks.increments).toHaveBeenCalledWith(
    "sh000001",
    "2026-09-10",
    "2026-09-11",
  );
});
it("keeps fallback provenance and does not apply the Shanghai/Shenzhen calendar to other markets", async () => {
  mocks.gf.mockRejectedValue(new Error("unavailable"));
  mocks.history.mockResolvedValue({
    bars: [
      { date: "2026-10-08", volume: 1 },
      { date: "2026-10-09", volume: 0 },
    ],
  });
  const remote = await monitorCalendar("root", [], true, true, 0);
  expect(remote.days).toEqual(["2026-10-08"]);
  expect(remote.source).toContain("非完整");
  mocks.gf.mockClear();
  expect((await monitorCalendar("root", [], false, false, 0)).source).toContain(
    "未使用沪深",
  );
  expect(mocks.gf).not.toHaveBeenCalled();
  expect((await monitorCalendar("root", [], false, true, 0)).source).toContain(
    "广发日历不可用",
  );
});
