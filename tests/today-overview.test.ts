import { expect, it } from "vitest";
import {
  health,
  phaseOf,
  scheduleSummary,
  timeline,
  todos,
  type OverviewInput,
} from "../src/components/overview/overview-model";

const base = (
  minutes: number,
  patch: Partial<OverviewInput> = {},
): OverviewInput => ({
  now: Date.parse("2026-09-16T00:00:00Z") + minutes * 60000 - 8 * 3600000,
  date: "2026-09-16",
  minutes,
  intraday: {
    config: { enabled: true, noon: "11:20", late: "14:40" },
    lastCheck: {
      checkedAt: 0,
      schedule: {
        date: "2026-09-16",
        trading: "open",
        previousTradingDay: "2026-09-15",
        slots: [],
        closeDue: false,
      },
    },
    worker: { running: false, error: null },
    runs: [],
    unconfirmed: 0,
  },
  coverage: { counts: { "sh/day": 3, "sz/day": 2, "sh/5m": 1 }, scannedAt: 0 },
  rps: { latestDate: "2026-09-15", running: false },
  channels: [{ enabled: true }],
  failedDeliveries: 0,
  ...patch,
});

it("derives the phase and the next window from the clock and the saved cutoffs", () => {
  expect(phaseOf(base(9 * 60))).toBe("盘前");
  expect(phaseOf(base(11 * 60 + 14))).toBe("午盘前");
  const noon = timeline(base(11 * 60 + 14)).find((s) => s.key === "noon")!;
  expect(noon).toMatchObject({
    time: "11:20",
    status: "6 分钟后",
    tone: "accent",
  });
  const first = todos(base(11 * 60 + 14))[0]!;
  expect(first.title).toBe("午盘预选 11:20 即将运行");
});

it("reports real batch results and missed windows, never invented candidates", () => {
  const input = base(14 * 60 + 50, {
    intraday: {
      ...base(0).intraday!,
      runs: [
        {
          date: "2026-09-16",
          slot: "noon",
          status: "complete",
          results: [{ observationId: "a" }, { observationId: null }],
        },
      ],
    },
  });
  const slots = timeline(input);
  expect(slots.find((s) => s.key === "noon")!.status).toBe("已完成 · 1 个候选");
  expect(slots.find((s) => s.key === "late")!).toMatchObject({
    status: "未运行",
    tone: "warn",
  });
  expect(scheduleSummary(input)).toBe("今日 1/2 个预选批次已运行");
});

it("puts failures first and flags stale RPS against the previous trading day", () => {
  const input = base(15 * 60 + 30, {
    failedDeliveries: 2,
    rps: { latestDate: "2026-09-12", running: false },
  });
  const list = todos(input);
  expect(list[0]).toMatchObject({ tone: "bad", href: "/signals" });
  expect(list.some((t) => t.key === "rps" && t.tone === "warn")).toBe(true);
  const cards = health(input);
  expect(cards.find((c) => c.key === "day")!.value).toBe("5 个");
  expect(cards.find((c) => c.key === "channels")!.tone).toBe("bad");
});

it("shows disabled scheduling as idle rather than as a failure", () => {
  const input = base(10 * 60, {
    intraday: {
      ...base(0).intraday!,
      config: { enabled: false, noon: "11:20", late: "14:40" },
    },
    coverage: null,
  });
  expect(timeline(input).find((s) => s.key === "noon")!.tone).toBe("idle");
  expect(todos(input).map((t) => t.key)).toEqual(["scan", "intraday-off"]);
});
