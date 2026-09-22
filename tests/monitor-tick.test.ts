import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  settingsSchema,
  strategySchema,
  type Monitor,
  type Signal,
  type Snapshot,
} from "../src/lib/domain";
const mocked = vi.hoisted(() => ({
  worker: vi.fn(),
  enqueue: vi.fn(),
  calendar: vi.fn(),
  tradingStatus: vi.fn(),
  beforeAtomic: vi.fn(),
  background: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock("../src/server/db", async (original) => {
  const actual = await original<typeof import("../src/server/db")>();
  return {
    ...actual,
    atomic: <T>(fn: () => T) => {
      mocked.beforeAtomic();
      return actual.atomic(fn);
    },
  };
});
vi.mock("../src/server/jobs/jobs", async (original) => ({
  ...(await original<typeof import("../src/server/jobs/jobs")>()),
  runWorker: mocked.worker,
  background: mocked.background,
}));
vi.mock("../src/server/research/research", async (original) => ({
  ...(await original<typeof import("../src/server/research/research")>()),
  analyze: mocked.analyze,
}));
vi.mock("../src/server/research/gather-evidence", async (original) => ({
  ...(await original<
    typeof import("../src/server/research/gather-evidence")
  >()),
  gatherEvidence: async () => [],
}));
vi.mock("../src/server/infra/notifications", () => ({
  enqueue: mocked.enqueue,
  recoverDeliveries: vi.fn(),
  drain: vi.fn(),
}));
vi.mock("../src/server/monitoring/monitor-calendar", () => ({
  monitorCalendar: mocked.calendar,
}));
vi.mock("../src/server/market/security-trading-status", () => ({
  verifySecurityTradingStatus: mocked.tradingStatus,
}));
vi.mock("../src/server/market/securities", () => ({
  securityDirectory: async () => ({ entries: {} }),
}));
import { tick } from "../src/server/runtime";
import { sqlite, put, get, list } from "../src/server/db";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-tick-"));
const day = "2026-10-08";
function at(time: string) {
  return Date.parse(`${day}T${time}:00+08:00`);
}
function source(time = "10:00", rising = false): Snapshot {
  const times = ["09:35", "09:40", "09:45", "09:50", "09:55", "10:00"];
  if (time !== "10:00") times.push(time);
  return {
    id: `test-${time}-${rising}`,
    symbol: "sh600519",
    period: "5m",
    source: "fixture",
    adjustment: "none",
    createdAt: at(time),
    hash: "fixture",
    bars: times.map((t, i) => ({
      date: `${day}T${t}:00+08:00`,
      open: 10,
      high: 11,
      low: 9,
      close: rising && i === times.length - 1 ? 10.5 : 10,
      volume: 100,
      amount: 1000,
    })),
  };
}
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("10:04"));
  const state = (
    globalThis as typeof globalThis & {
      quantRuntime: { lastTick: number; recovered: boolean };
    }
  ).quantRuntime;
  state.lastTick = 0;
  state.recovered = false;
  mocked.calendar.mockResolvedValue({
    days: [day],
    source: "calendar-fixture",
    hash: "calendar-hash",
  });
  mocked.worker.mockResolvedValue(source());
  mocked.tradingStatus.mockImplementation(async () => ({
    version: "security-trading-status-1",
    symbol: "sh600519",
    status: "trading",
    asOf: day,
    fetchedAt: Date.now(),
    source: "status-fixture",
    reason: "交易",
    evidence: { row: {}, columns: [] },
    evidenceHash: "status-hash",
  }));
  put("settings", "settings", settingsSchema.parse({}));
  put<Monitor>("monitor", "monitor-fixture", {
    id: "monitor-fixture",
    name: "fixture",
    symbols: ["sh600519"],
    strategy: strategySchema.parse({ fast: 2, slow: 5 }),
    period: "5m",
    source: "local",
    channels: ["mock-only"],
    ai: false,
    enabled: true,
    states: {},
    createdAt: 1,
  });
});
afterEach(() => vi.useRealTimers());
it("persists one fresh transition with calendar provenance and deduplicates the same completed bar", async () => {
  await tick();
  expect(list("signal")).toHaveLength(0);
  vi.setSystemTime(at("10:05"));
  mocked.worker.mockResolvedValue(source("10:05", true));
  await tick();
  const signals = list<Signal>("signal");
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    monitorRun: { createdAt: 1, revision: null },
    tradingStatusEvidence: {
      status: "trading",
      asOf: day,
      evidenceHash: "status-hash",
    },
    date: `${day}T10:05:00+08:00`,
    calendarEvidence: {
      source: "calendar-fixture",
      hash: "calendar-hash",
      assessedAt: at("10:05"),
    },
  });
  expect(get<Monitor>("monitor-fixture")?.calendarEvidence).toEqual(
    signals[0]!.calendarEvidence,
  );
  expect(mocked.enqueue).toHaveBeenCalledOnce();
  expect(mocked.tradingStatus).toHaveBeenCalledOnce();
  const monitor = get<Monitor>("monitor-fixture")!;
  put("monitor", monitor.id, {
    ...monitor,
    states: { sh600519: { date: `${day}T10:00:00+08:00`, matched: false } },
  });
  vi.setSystemTime(at("10:06"));
  await tick();
  expect(list("signal")).toHaveLength(1);
  expect(mocked.enqueue).toHaveBeenCalledOnce();
});
it.each(["holiday", "resuming", "disabled"])(
  "does not enqueue a new signal when %s",
  async (reason) => {
    await tick();
    vi.setSystemTime(at(reason === "resuming" ? "10:10" : "10:05"));
    mocked.worker.mockResolvedValue(
      source(reason === "resuming" ? "10:10" : "10:05", true),
    );
    if (reason === "holiday")
      mocked.calendar.mockResolvedValue({
        days: [],
        closedDays: [day],
        source: "fixture",
        hash: "fixture",
      });
    if (reason === "disabled")
      put("monitor", "monitor-fixture", {
        ...get<Monitor>("monitor-fixture"),
        enabled: false,
      });
    await tick();
    expect(list("signal")).toHaveLength(0);
    expect(mocked.enqueue).not.toHaveBeenCalled();
    if (reason !== "disabled")
      expect(get<Monitor>("monitor-fixture")?.states.sh600519?.matched).toBe(
        true,
      );
  },
);

it.each(["unknown", "suspended", "stale", "wrong-day", "failed"])(
  "pauses a fresh rule signal on %s status and retries without losing its baseline",
  async (reason) => {
    await tick();
    vi.setSystemTime(at("10:05"));
    mocked.worker.mockResolvedValue(source("10:05", true));
    if (reason === "failed")
      mocked.tradingStatus.mockRejectedValueOnce(new Error("unavailable"));
    else
      mocked.tradingStatus.mockResolvedValueOnce({
        symbol: "sh600519",
        status:
          reason === "unknown" || reason === "suspended" ? reason : "trading",
        asOf: reason === "wrong-day" ? "2026-10-07" : day,
        fetchedAt: reason === "stale" ? at("10:04") : at("10:05"),
        reason,
        source: "fixture",
        evidence: { row: {}, columns: [] },
        evidenceHash: "fixture",
      });
    await tick();
    expect(list("signal")).toHaveLength(0);
    expect(mocked.enqueue).not.toHaveBeenCalled();
    expect(get<Monitor>("monitor-fixture")?.states.sh600519).toEqual({
      date: `${day}T10:00:00+08:00`,
      matched: false,
    });
    expect(get<Monitor>("monitor-fixture")?.error).toContain("交易状态");
    vi.setSystemTime(at("10:06"));
    await tick();
    expect(list("signal")).toHaveLength(1);
    expect(mocked.enqueue).toHaveBeenCalledOnce();
  },
);

it.each(["disabled", "strategy", "expired"])(
  "rechecks authorization and freshness after awaiting status: %s",
  async (reason) => {
    await tick();
    vi.setSystemTime(at("10:05"));
    mocked.worker.mockResolvedValue(source("10:05", true));
    mocked.tradingStatus.mockImplementationOnce(async () => {
      const current = get<Monitor>("monitor-fixture")!;
      if (reason === "disabled")
        put("monitor", current.id, { ...current, enabled: false });
      if (reason === "strategy")
        put("monitor", current.id, {
          ...current,
          strategy: { ...current.strategy, slow: 6 },
        });
      if (reason === "expired") vi.setSystemTime(at("10:16"));
      return {
        symbol: "sh600519",
        status: "trading",
        asOf: day,
        fetchedAt: Date.now(),
        reason: "trading",
      };
    });
    await tick();
    expect(list("signal")).toHaveLength(0);
    expect(mocked.enqueue).not.toHaveBeenCalled();
  },
);

it("does not overwrite a replacement subscription with late baseline state", async () => {
  let replacement: Monitor;
  mocked.worker.mockImplementationOnce(async () => {
    replacement = {
      ...get<Monitor>("monitor-fixture")!,
      createdAt: 2,
      states: { sh600519: { date: `${day}T09:55:00+08:00`, matched: true } },
    };
    put("monitor", replacement.id, replacement);
    return source();
  });
  await tick();
  expect(get("monitor-fixture")).toEqual(replacement!);
  expect(mocked.enqueue).not.toHaveBeenCalled();
});

it("does not carry a pending signal across disable and re-enable of the same subscription", async () => {
  await tick();
  vi.setSystemTime(at("10:05"));
  mocked.worker.mockResolvedValue(source("10:05", true));
  let replacement: unknown;
  mocked.tradingStatus.mockImplementationOnce(async () => {
    const previous = get<Monitor>("monitor-fixture")!;
    put("monitor", previous.id, {
      ...previous,
      enabled: false,
      revision: "disabled",
      states: {},
    });
    replacement = {
      ...previous,
      enabled: true,
      revision: "re-enabled",
      states: {},
    };
    put("monitor", previous.id, replacement);
    return {
      symbol: "sh600519",
      status: "trading",
      asOf: day,
      fetchedAt: Date.now(),
      reason: "trading",
    };
  });
  await tick();
  expect(list("signal")).toHaveLength(0);
  expect(mocked.enqueue).not.toHaveBeenCalled();
  expect(get("monitor-fixture")).toEqual(replacement);
});

it.each(["revision", "baseline"])(
  "checks %s again inside the commit transaction",
  async (changed) => {
    await tick();
    vi.setSystemTime(at("10:05"));
    mocked.worker.mockResolvedValue(source("10:05", true));
    let replacement: Monitor;
    mocked.beforeAtomic.mockImplementationOnce(() => {
      const previous = get<Monitor>("monitor-fixture")!;
      replacement =
        changed === "revision"
          ? { ...previous, revision: "new-run", states: {} }
          : {
              ...previous,
              states: {
                sh600519: { date: `${day}T10:04:00+08:00`, matched: true },
              },
            };
      put("monitor", previous.id, replacement);
    });
    await tick();
    expect(list("signal")).toHaveLength(0);
    expect(mocked.enqueue).not.toHaveBeenCalled();
    expect(get("monitor-fixture")).toEqual(replacement!);
  },
);

it.each([false, true, "at-commit"])(
  "only delivers deferred AI analysis to its original monitor run, restarted=%s",
  async (restarted) => {
    const original = get<Monitor>("monitor-fixture")!;
    put("monitor", original.id, { ...original, ai: true });
    await tick();
    vi.setSystemTime(at("10:05"));
    mocked.worker.mockResolvedValue(source("10:05", true));
    await tick();
    expect(mocked.enqueue).toHaveBeenCalledOnce();
    expect(mocked.background).toHaveBeenCalledOnce();
    mocked.analyze.mockImplementationOnce(async () => {
      if (restarted === true) {
        const current = get<Monitor>(original.id)!;
        put("monitor", current.id, {
          ...current,
          revision: "restarted",
          states: {},
        });
      }
      if (restarted === "at-commit")
        mocked.beforeAtomic.mockImplementationOnce(() => {
          const current = get<Monitor>(original.id)!;
          put("monitor", current.id, {
            ...current,
            revision: "restarted-at-commit",
            states: {},
          });
        });
      return { id: "report-fixture" };
    });
    const work = mocked.background.mock.calls[0]![2];
    await work({}, new AbortController().signal);
    expect(mocked.enqueue).toHaveBeenCalledTimes(restarted ? 1 : 2);
    if (!restarted) expect(mocked.enqueue.mock.calls[1]![2]).toBe("analysis");
  },
);
