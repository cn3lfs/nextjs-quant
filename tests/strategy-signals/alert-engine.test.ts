import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { StrategyObjectInput } from "trading-strategies";
import {
  AlertEngine,
  type AlertEngineDependencies,
  type AlertEvaluation,
} from "~/server/alerts/engine";
import { AlertRepository } from "~/server/db/alert-repository";
import { migrate } from "~/server/db/migrations";
import {
  alertKey,
  alertsSchema,
  type AlertEvent,
} from "~/lib/strategy-facts/alerts";
import { holdingObservation } from "~/server/alerts/observations";
import { createAlertPlan } from "~/server/alerts/plans";
import { settingsSchema } from "~/lib/domain";
import { put, sqlite } from "~/server/db";
import { enqueueAlert, drain, SendError } from "~/server/infra/notifications";
import { ledgerOutcome } from "~/lib/strategy-facts/signal-ledger";
import { watchStrategy } from "~/server/strategies/drivers/watch";
import { scanStrategy } from "~/server/strategies/drivers/scan";
const network = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Real network forbidden");
  }),
);
vi.mock("undici", () => ({ fetch: network, ProxyAgent: class {} }));
const strategy: StrategyObjectInput = {
  id: "r2b-fixture",
  version: 1,
  market: "cn-equity",
  period: "5m",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 1 },
  sleeve: "swing",
};
const at = (time: string) => Date.parse(`2026-11-13T${time}:00+08:00`);
function fixture() {
  const db = new Database(":memory:");
  migrate(db);
  const repository = new AlertRepository(db);
  let now = at("10:00");
  const deps: AlertEngineDependencies = {
    clock: { now: () => now },
    repository,
    mode: () => "shadow",
    leader: () => true,
    calendar: async () => ["2026-11-13"],
    receipt: async () => true,
    evaluate: vi.fn(async () => ({ proposals: [], states: [] })),
    deliver: vi.fn(),
    outcomes: vi.fn(async () => {}),
    error: vi.fn(),
  };
  return {
    db,
    repository,
    deps,
    engine: new AlertEngine(deps),
    time: (value: number) => {
      now = value;
    },
  };
}
const empty: AlertEvaluation = { proposals: [], states: [] };
function proposal(now: number, market: "cn-equity" | "crypto" = "cn-equity") {
  const s = { ...strategy, market };
  return {
    strategy: s,
    completedAt: now,
    windowMs: 300000,
    event: {
      strategyId: s.id,
      version: 1,
      market,
      symbol: "sh600000",
      bar: new Date(now).toISOString(),
      type: "entry" as const,
      price: 10,
      sleeve: "swing",
      stop: 9,
      target: 12,
      reason: "fixture",
      source: "固定合成输入",
    },
  };
}
describe("R2b injectable clock, no historical replay", () => {
  it("exchange calendar rejects intraday holiday/weekend and lunch, while crypto still runs", async () => {
    const f = fixture();
    try {
      for (const time of [
        at("08:00"),
        at("12:00"),
        Date.parse("2026-11-14T10:00:00+08:00"),
        Date.parse("2026-10-01T10:00:00+08:00"),
      ]) {
        f.time(time);
        f.deps.receipt = async () => false;
        await f.engine.tick();
      }
      expect(vi.mocked(f.deps.evaluate).mock.calls.map((c) => c[0])).toEqual([
        "crypto",
        "crypto",
        "crypto",
        "crypto",
      ]);
      f.time(at("10:00"));
      await f.engine.tick();
      expect(vi.mocked(f.deps.evaluate).mock.calls.at(-1)?.[0]).toBe(
        "intraday",
      );
      expect(f.deps.error).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it("waits for late download receipt then runs one post-close scan, including restart in window", async () => {
    const f = fixture();
    let ready = false;
    f.deps.receipt = async () => ready;
    try {
      f.time(at("15:06"));
      await f.engine.tick();
      expect(f.repository.state("close:2026-11-13")).toBeUndefined();
      ready = true;
      f.time(at("15:42"));
      await new AlertEngine(f.deps).tick();
      await new AlertEngine(f.deps).tick();
      expect(
        vi.mocked(f.deps.evaluate).mock.calls.filter((c) => c[0] === "close"),
      ).toHaveLength(1);
      expect(f.repository.state("close:2026-11-13")).toEqual({
        status: "complete",
        at: at("15:42"),
        calendarConfirmed: false,
      });
    } finally {
      f.db.close();
    }
  });
  it("records one missed window without invoking close scan, no bulk catch-up", async () => {
    const f = fixture();
    try {
      f.time(Date.parse("2026-11-16T09:01:00+08:00"));
      await f.engine.tick();
      await new AlertEngine(f.deps).tick();
      expect(vi.mocked(f.deps.evaluate).mock.calls.map((c) => c[0])).toEqual([
        "crypto",
        "crypto",
      ]);
      const events = f.repository.history({
        page: 0,
        size: 20,
        symbol: "",
        strategyId: "",
      });
      expect(events.total).toBe(1);
      expect(events.items[0]).toMatchObject({
        type: "missed",
        status: "missed",
        wouldSend: false,
      });
      expect(f.deps.deliver).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it.each(["2026-11-13T17:05:00+08:00", "2026-11-16T08:30:00+08:00"])(
    "accepts the close receipt at %s once with its original trading date",
    async (time) => {
      const f = fixture();
      f.deps.calendar = async () => ["2026-11-13", "2026-11-16"];
      f.deps.receipt = vi.fn(async () => true);
      try {
        f.time(Date.parse(time));
        await f.engine.tick();
        await new AlertEngine(f.deps).tick();
        expect(f.deps.receipt).toHaveBeenCalledExactlyOnceWith(
          "2026-11-13",
          Date.parse(time),
        );
        expect(
          vi.mocked(f.deps.evaluate).mock.calls.filter((c) => c[0] === "close"),
        ).toEqual([["close", Date.parse(time), "2026-11-13"]]);
      } finally {
        f.db.close();
      }
    },
  );
  it("a scan finishing at the deadline records its proposals missed", async () => {
    const f = fixture();
    f.deps.calendar = async () => ["2026-11-13", "2026-11-16"];
    f.deps.evaluate = vi.fn(async (phase) => {
      if (phase !== "close") return empty;
      f.time(Date.parse("2026-11-16T09:00:00+08:00"));
      return {
        ...empty,
        proposals: [{ ...proposal(at("15:00")), windowMs: 7 * 86400000 }],
      };
    });
    try {
      f.time(Date.parse("2026-11-16T08:59:00+08:00"));
      await f.engine.tick();
      expect(
        f.repository.history({ page: 0, size: 20, symbol: "", strategyId: "" })
          .items[0],
      ).toMatchObject({ status: "missed", wouldSend: false });
    } finally {
      f.db.close();
    }
  });
  it("unfinished close claim after process exit is missed rather than rerun", async () => {
    const f = fixture();
    try {
      f.repository.saveState("close:2026-11-13", { status: "running" });
      f.time(at("15:30"));
      await f.engine.tick();
      expect(f.repository.state("close:2026-11-13")).toMatchObject({
        status: "missed",
      });
      expect(vi.mocked(f.deps.evaluate).mock.calls.map((c) => c[0])).toEqual([
        "crypto",
      ]);
    } finally {
      f.db.close();
    }
  });
  it("strategy × instrument × bar dedupes across process restart; stale bar is recorded missed", async () => {
    const f = fixture();
    f.deps.evaluate = vi.fn(async (phase) =>
      phase === "intraday"
        ? { ...empty, proposals: [proposal(at("10:00"))] }
        : empty,
    );
    try {
      await f.engine.tick();
      await new AlertEngine(f.deps).tick();
      expect(f.deps.deliver).toHaveBeenCalledTimes(1);
      f.time(at("10:20"));
      f.deps.evaluate = async (phase) =>
        phase === "intraday"
          ? { ...empty, proposals: [proposal(at("10:05"))] }
          : empty;
      await f.engine.tick();
      expect(
        f.repository
          .history({ page: 0, size: 20, symbol: "", strategyId: "" })
          .items.map((e) => e.status),
      ).toEqual(["missed", "shadow"]);
    } finally {
      f.db.close();
    }
  });
  it("leader lease prevents a second host from evaluating", async () => {
    const f = fixture();
    try {
      f.deps.leader = () => false;
      await f.engine.tick();
      expect(f.deps.evaluate).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it("completed crypto bar is evaluated on weekend", async () => {
    const f = fixture();
    try {
      const weekend = Date.parse("2026-11-14T10:00:00Z");
      f.time(weekend);
      f.deps.evaluate = async (phase) =>
        phase === "crypto"
          ? { ...empty, proposals: [proposal(weekend, "crypto")] }
          : empty;
      await f.engine.tick();
      expect(f.deps.deliver).toHaveBeenCalledTimes(1);
    } finally {
      f.db.close();
    }
  });
  it("off mode does no evaluation; switching off during source I/O creates no event", async () => {
    const f = fixture();
    try {
      f.deps.mode = () => "off";
      await f.engine.tick();
      expect(f.deps.evaluate).not.toHaveBeenCalled();
      f.deps.mode = () => "shadow";
      f.deps.evaluate = async () => {
        f.deps.mode = () => "off";
        return { ...empty, proposals: [proposal(at("10:00"))] };
      };
      await f.engine.tick();
      expect(f.deps.deliver).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it("plan expires even on a holiday and old expirations are marked missed", async () => {
    const f = fixture();
    try {
      f.repository.strategies.saveStrategy(strategy);
      f.repository.savePlan(
        {
          id: "expiry",
          strategyId: strategy.id,
          strategyVersion: 1,
          symbol: "sh600000",
          sleeve: "swing",
          triggerKey: "test",
          entry: 10,
          stop: 9,
          target: 12,
          quantity: 100,
          tranches: 1,
          expiresAt: new Date(at("10:00")).toISOString(),
          status: "open",
        },
        at("09:00"),
      );
      f.deps.calendar = async () => [];
      await f.engine.tick();
      await new AlertEngine(f.deps).tick();
      expect(f.repository.strategies.plan("expiry")).toMatchObject({
        status: "expired",
        closeReason: "expired",
      });
      expect(f.deps.deliver).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.deps.deliver).mock.calls[0]![0]).toMatchObject({
        type: "plan-expired",
        status: "shadow",
      });
    } finally {
      f.db.close();
    }
  });
});
it("holding stop crossing fires once, re-arms only above stop, new crossing survives restart", () => {
  let state: ReturnType<typeof holdingObservation>["state"] | undefined;
  const triggers = [];
  for (const [i, close] of [11, 9, 8, 11, 9].entries()) {
    const observation = holdingObservation(
      strategy,
      {
        date: new Date(at("10:00") + i * 300000).toISOString(),
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
        amount: close,
      },
      { stop: 10, target: 15, trailing: null },
      state,
    );
    triggers.push(observation.trigger);
    state = JSON.parse(JSON.stringify(observation.state));
  }
  expect(triggers).toEqual([null, "stop", null, null, "stop"]);
  expect(
    holdingObservation(
      strategy,
      {
        date: state!.bar,
        open: 9,
        high: 9,
        low: 9,
        close: 9,
        volume: 1,
        amount: 9,
      },
      { stop: 10, target: 15, trailing: null },
      state,
    ).trigger,
  ).toBeNull();
});
it("trailing protection uses previous completed close high, never current bar's high", () => {
  const previous = { bar: "2026-11-12", high: 100, active: null };
  const bar = {
    date: "2026-11-13",
    open: 100,
    high: 200,
    low: 99,
    close: 100,
    volume: 1,
    amount: 100,
  };
  const observation = holdingObservation(
    strategy,
    bar,
    { stop: 80, target: null, trailing: 0.1 },
    previous,
  );
  expect(observation.trigger).toBeNull();
  expect(observation.state.high).toBe(100);
});
it("shadow event agrees with scan/watch on frozen bars", () => {
  const bars = [
    {
      date: "2026-11-13",
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 1,
      amount: 10,
    },
  ];
  const series = { market: "cn-equity" as const, symbol: "sh600000", bars };
  expect(
    scanStrategy(strategy, [series], bars[0]!.date).map((v) => v.symbol),
  ).toEqual(
    watchStrategy(strategy, series, bars[0]!.date).map((v) => v.symbol),
  );
  expect(alertsSchema.parse({}).mode).toBe("shadow");
});
describe("same real outbox with a stub sender", () => {
  beforeEach(() => {
    network.mockClear();
    sqlite().exec(
      "DELETE FROM records; DELETE FROM watch_events; DELETE FROM trade_plans; DELETE FROM strategies",
    );
  });
  afterEach(() => {
    expect(network).toHaveBeenCalledTimes(0);
  });
  const event = (mode: "shadow" | "live"): AlertEvent => ({
    key: alertKey({
      type: "stop",
      price: 10,
      strategyId: strategy.id,
      version: 1,
      market: "crypto",
      symbol: "BTCUSDT",
      bar: "2026-11-14T10:00:00Z",
    }),
    strategyId: strategy.id,
    version: 1,
    market: "crypto",
    symbol: "BTCUSDT",
    bar: "2026-11-14T10:00:00Z",
    type: "stop",
    price: 10,
    sleeve: "swing",
    stop: 11,
    target: null,
    reason: "QA",
    source: "fixture",
    observedAt: Date.parse("2026-11-14T10:00:00Z"),
    mode,
    status: mode,
    wouldSend: true,
    outcomes: [],
  });
  function setup(mode: "shadow" | "live") {
    const config = settingsSchema.parse({ alerts: { mode } });
    put("settings", "settings", config);
    put("channel", "qa-channel", {
      id: "qa-channel",
      name: "Stub",
      type: "feishu",
      enabled: true,
      configured: true,
    });
    put("alert-subscription", "alert-subscription:qa", {
      id: "qa",
      revision: "r1",
      enabled: true,
      market: "crypto",
      symbols: [],
      strategyIds: [],
      kinds: ["stop"],
      channels: ["qa-channel"],
    });
  }
  it("shadow evaluates and audits would-send, with zero queued or delivered messages", async () => {
    setup("shadow");
    const e = event("shadow");
    enqueueAlert(e);
    const sender = vi.fn(async () => "stub");
    await drain(sender, e.observedAt);
    expect(sender).not.toHaveBeenCalled();
    expect(new AlertRepository().records.all("delivery")).toEqual([]);
    expect(
      new AlertRepository().records.decisions()[0]!.reasons.at(-1),
    ).toContain("影子模式");
  });
  it("live sends through durable outbox and retries failure with the same identity", async () => {
    setup("live");
    const e = event("live");
    enqueueAlert(e);
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new SendError("stub failure"))
      .mockResolvedValueOnce("stub-sent");
    await drain(sender, e.observedAt);
    expect(
      new AlertRepository().records.all<{ status: string; attempts: number }>(
        "delivery",
      )[0],
    ).toMatchObject({ status: "pending", attempts: 1 });
    await drain(sender, e.observedAt + 6000);
    const rows = new AlertRepository().records.all<{
      status: string;
      attempts: number;
    }>("delivery");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", attempts: 2 });
    expect(sender).toHaveBeenCalledTimes(2);
  });
  it("disabling subscription or engine before claim cancels queued live reminders", async () => {
    setup("live");
    const e = event("live");
    enqueueAlert(e);
    put(
      "settings",
      "settings",
      settingsSchema.parse({ alerts: { mode: "shadow" } }),
    );
    const sender = vi.fn(async () => "stub");
    await drain(sender, e.observedAt);
    expect(sender).not.toHaveBeenCalled();
    expect(
      new AlertRepository().records.all<{ status: string }>("delivery")[0]!
        .status,
    ).toBe("cancelled");
  });
  it("changing a subscribed destination revision before claim cancels the pending alert", async () => {
    setup("live");
    const e = event("live");
    enqueueAlert(e);
    const repo = new AlertRepository();
    const subscription = repo.subscriptions()[0]!;
    repo.records.save(
      "alert-subscription",
      `alert-subscription:${subscription.id}`,
      { ...subscription, revision: "changed" },
    );
    const sender = vi.fn(async () => "stub");
    await drain(sender, e.observedAt);
    expect(sender).not.toHaveBeenCalled();
    expect(repo.records.all<{ status: string }>("delivery")[0]!.status).toBe(
      "cancelled",
    );
  });
  it("changing live strategy registration before claim cancels its already queued alert", async () => {
    setup("live");
    const e = event("live");
    const repo = new AlertRepository();
    repo.saveState(`strategy:${e.strategyId}:${e.version}`, {
      live: true,
      revision: "v1",
    });
    enqueueAlert(e);
    repo.saveState(`strategy:${e.strategyId}:${e.version}`, {
      live: false,
      revision: "v2",
    });
    const sender = vi.fn(async () => "stub");
    await drain(sender, e.observedAt);
    expect(sender).not.toHaveBeenCalled();
    expect(repo.records.all<{ status: string }>("delivery")[0]!.status).toBe(
      "cancelled",
    );
  });
  it("post-close immediate tier bypasses only outside-trading silence, preserving custom quiet", async () => {
    setup("live");
    const repo = new AlertRepository();
    const original = repo.subscriptions()[0]!;
    repo.records.save(
      "alert-subscription",
      `alert-subscription:${original.id}`,
      { ...original, market: "cn-equity" },
    );
    const e = {
      ...event("live"),
      market: "cn-equity" as const,
      symbol: "sh600000",
      bar: "2026-11-16",
      observedAt: Date.parse("2026-11-16T15:10:00+08:00"),
      postClose: true,
    };
    e.key = alertKey(e);
    enqueueAlert(e);
    const sender = vi.fn(async () => "stub");
    await drain(sender, e.observedAt);
    expect(sender).toHaveBeenCalledOnce();
    put(
      "settings",
      "settings",
      settingsSchema.parse({
        alerts: { mode: "live" },
        notificationPolicy: {
          quietEnabled: true,
          quietStart: "15:00",
          quietEnd: "16:00",
        },
      }),
    );
    const quietEvent = {
      ...e,
      bar: "2026-11-17",
      observedAt: e.observedAt + 86400000,
    };
    quietEvent.key = alertKey(quietEvent);
    enqueueAlert(quietEvent);
    expect(repo.records.all("delivery")).toHaveLength(1);
    expect(repo.records.decisions().at(-1)?.tier).not.toBe("immediate");
  });
});
it("plan sizing reserves sleeve capital transactionally and rounds by market lot", () => {
  const f = fixture();
  try {
    const planStrategy: StrategyObjectInput = {
      ...strategy,
      exit: { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.3 },
      sizing: { kind: "weight", weight: 0.1, tranches: 2 },
    };
    const p = proposal(at("10:00"));
    const event: AlertEvent = {
      ...p.event,
      key: alertKey(p.event),
      mode: "shadow",
      status: "shadow",
      wouldSend: true,
      observedAt: at("10:00"),
      outcomes: [],
      target: 13,
    };
    f.repository.record(planStrategy, event);
    const config = settingsSchema.parse({
      alerts: { capital: { "cn-equity": 100000, crypto: 0 } },
    });
    f.repository.saveState("exposure", [
      { market: "cn-equity", sleeve: "__checked__", value: 0, at: at("10:01") },
    ]);
    const plan = createAlertPlan(
      {
        eventKey: event.key,
        stages: [10, 11],
        stop: 9,
        target: 13,
        expiresAt: new Date(at("14:00")).toISOString(),
      },
      config,
      at("10:01"),
      f.repository,
      {
        positions: [],
        industryGroups: () => ["QA银行"],
        assertCurrent: () => {},
      },
    );
    // Each stage has a 5,000 capital ceiling. A 5 fee leaves only 400 shares
    // at 10 on the 100-share grid; the first position's risk leaves room for
    // only 200 more at 11, keeping total planned risk below the 1,000 limit.
    expect(plan.stages).toEqual([
      { entry: 10, quantity: 400 },
      { entry: 11, quantity: 200 },
    ]);
    expect(plan.sizingAudit?.overridden).toBe(false);
    expect(plan.exposureAudit?.overridden).toBe(false);
    expect(() =>
      createAlertPlan(
        {
          eventKey: event.key,
          stages: [10],
          stop: 9,
          target: 13,
          expiresAt: new Date(at("14:00")).toISOString(),
        },
        config,
        at("10:01"),
        f.repository,
      ),
    ).toThrow("已有未完成计划");
    expect(f.repository.closePlan(plan.id, "cancelled")).toBe(true);
  } finally {
    f.db.close();
  }
});
it("forward return uses T+1 open and fixed T+5 close; frozen outcome never revises", () => {
  const days = Array.from(
    { length: 6 },
    (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`,
  );
  const bars = days.map((date, i) => ({
    date,
    open: i === 1 ? 10 : 11,
    high: 13,
    low: 9,
    close: i === 5 ? 12 : 11,
    volume: 1,
    amount: 11,
  }));
  const value = ledgerOutcome(
    { observedDate: days[0]! },
    5,
    bars,
    days,
    "fixture",
    { dates: [], coverageEnd: days[5], source: "fixture" },
    days[5]!,
  );
  expect(value.entry).toBe(10);
  expect(value.exit).toBe(12);
  expect(value.returnPct).toBeCloseTo(20);
  const f = fixture();
  try {
    f.repository.outcomes("immutable", [value]);
    f.repository.outcomes("immutable", [{ ...value, returnPct: 999 }]);
    expect(f.repository.state("outcomes:immutable")).toEqual([value]);
  } finally {
    f.db.close();
  }
});

it.each([false, true])(
  "paper-first shared key gains one alert audit and preserves raw evidence (legacy=%s)",
  (legacy) => {
    const f = fixture();
    try {
      const p = proposal(at("10:00"));
      const { reason: _reason, source: _source, ...raw } = p.event;
      const watchRaw = { ...raw, key: alertKey(p.event) };
      f.repository.strategies.record(strategy, watchRaw);
      const key = legacy
        ? JSON.stringify([
            strategy.id,
            strategy.version,
            raw.market,
            raw.symbol,
            raw.bar,
          ])
        : watchRaw.key;
      if (legacy)
        f.db
          .prepare(
            "UPDATE watch_events SET dedupe_key=?,payload=? WHERE dedupe_key=?",
          )
          .run(key, JSON.stringify({ ...watchRaw, key }), watchRaw.key);
      const first = f.db
        .prepare("SELECT payload FROM watch_events WHERE dedupe_key=?")
        .get(key) as { payload: string };
      const event: AlertEvent = {
        ...p.event,
        key: alertKey(p.event),
        mode: "shadow",
        status: "shadow",
        wouldSend: true,
        observedAt: at("10:00"),
        outcomes: [],
      };
      const deliver = vi.fn();
      if (legacy) {
        f.repository.saveState("test-linked-trade", { alertKey: key });
        // A referenced legacy row keeps its key but is still adopted exactly once.
        expect(f.repository.record(strategy, event, deliver)).toBe(true);
        expect(deliver).toHaveBeenCalledOnce();
        expect(f.repository.record(strategy, event, deliver)).toBe(false);
        const legacyStored = f.repository.event(key)!;
        expect(legacyStored.price).toBe(10);
        expect(legacyStored.firstWatchPayload).toBe(first.payload);
        expect(
          f.db
            .prepare("SELECT payload FROM watch_events WHERE dedupe_key=?")
            .get(key),
        ).toBeTruthy();
        expect(
          f.repository.history({
            page: 0,
            size: 20,
            symbol: "",
            strategyId: "",
          }).total,
        ).toBe(1);
        f.repository.saveState("test-linked-trade", {});
        return;
      }
      expect(f.repository.record(strategy, event, deliver)).toBe(true);
      expect(f.repository.record(strategy, event, deliver)).toBe(false);
      expect(deliver).toHaveBeenCalledOnce();
      const stored = f.repository.event(event.key)!;
      expect(stored.price).toBe(10);
      expect(stored.firstWatchPayload).toBe(first.payload);
      expect(stored.confirmation).toEqual({
        price: 10,
        source: "固定合成输入",
      });
      expect(JSON.parse(stored.firstWatchPayload!)).toMatchObject({
        price: 10,
        type: "entry",
      });
      expect(f.repository.strategies.record(strategy, watchRaw)).toBe(false);
      expect(
        f.repository.history({ page: 0, size: 20, symbol: "", strategyId: "" })
          .total,
      ).toBe(1);
    } finally {
      f.db.close();
    }
  },
);
it("same-bar events with different types or prices persist independently", () => {
  const f = fixture();
  try {
    const p = proposal(at("10:00"));
    const { reason: _reason, source: _source, ...raw } = p.event;
    const watchRaw = { ...raw, key: alertKey(p.event) };
    expect(() =>
      f.repository.strategies.record(strategy, { ...watchRaw, type: "exit" }),
    ).toThrow("identity mismatch");
    const before = f.db.prepare("SELECT * FROM watch_events").all();
    const event: AlertEvent = {
      ...p.event,
      key: alertKey(p.event),
      mode: "shadow",
      status: "shadow",
      wouldSend: true,
      observedAt: at("10:00"),
      outcomes: [],
    };
    expect(before).toHaveLength(0);
    const key = JSON.stringify([
      strategy.id,
      strategy.version,
      event.market,
      event.symbol,
      event.bar,
    ]);
    f.repository.record(strategy, event);
    f.db
      .prepare(
        "UPDATE watch_events SET dedupe_key=?, payload=? WHERE dedupe_key=?",
      )
      .run(key, JSON.stringify({ ...event, key }), event.key);
    const effects = vi.fn();
    expect(f.repository.record(strategy, event, effects)).toBe(false);
    expect(effects).not.toHaveBeenCalled();
    const fill = { ...event, paperFillId: "paper:123" };
    fill.key = alertKey(fill);
    expect(f.repository.record(strategy, fill)).toBe(true);
    const fillKey = JSON.stringify([
      ...JSON.parse(key),
      "paper-fill",
      fill.paperFillId,
    ]);
    f.db
      .prepare(
        "UPDATE watch_events SET dedupe_key=?,payload=? WHERE dedupe_key=?",
      )
      .run(fillKey, JSON.stringify({ ...fill, key: fillKey }), fill.key);
    expect(f.repository.record(strategy, fill, effects)).toBe(false);
    expect(effects).not.toHaveBeenCalled();
    for (const fields of [
      { type: "exit", price: 10 },
      { type: "entry", price: 11 },
      { type: "plan-expired", price: null },
    ] as const) {
      const variant = { ...event, ...fields };
      variant.key = alertKey(variant);
      expect(JSON.parse(variant.key)).toEqual([
        strategy.id,
        1,
        event.market,
        event.symbol,
        event.bar,
        fields.type,
        fields.price,
      ]);
      expect(f.repository.record(strategy, variant)).toBe(true);
      expect(f.repository.record(strategy, variant)).toBe(false);
    }
    expect(
      f.repository.history({ page: 0, size: 20, symbol: "", strategyId: "" })
        .total,
    ).toBe(5);
  } finally {
    f.db.close();
  }
});
