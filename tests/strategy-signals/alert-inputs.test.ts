import { strategyLabRouter } from "../../src/server/api/routers/strategy-lab";
import { strategyLabDetail } from "../../src/server/db/strategy-lab";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { settingsSchema, type Bar } from "~/lib/domain";
import { put, get } from "~/server/db";
import { alertsRouter } from "~/server/api/routers/alerts";
import { evaluateAlertInputs } from "~/server/alerts/inputs";
import { AlertEngine } from "~/server/alerts/engine";
import type { StrategyObjectInput } from "trading-strategies";
const fixture = vi.hoisted(() => ({
  bars: [] as Bar[],
  positions: [] as { symbol: string; quantity: number; stop: number | null }[],
  tradingStatus: "trading" as "trading" | "unknown" | "suspended",
  onStatus: () => {},
}));
vi.mock("~/server/market/security-trading-status", () => ({
  verifySecurityTradingStatus: vi.fn(async (symbol: string) => {
    fixture.onStatus();
    return {
      version: "security-trading-status-1",
      symbol,
      status: fixture.tradingStatus,
      asOf: "2026-11-13",
      fetchedAt: Date.parse("2026-11-13T02:00:00Z"),
      source: "QA status",
      reason: "fixture",
      evidence: { row: {}, columns: [] },
      evidenceHash: "qa",
    };
  }),
}));
vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars: vi.fn(async () => ({
    bars: fixture.bars,
    source: "fixed",
    adjustment: "none",
    hash: "QA",
    barStore: { formingDates: [] },
  })),
}));
vi.mock("~/server/portfolio/trade-ledger-service", () => ({
  tradePositionState: async () => ({ positions: fixture.positions }),
}));
vi.mock("~/server/strategies/chan/czsc", () => ({ analyzeCzsc: vi.fn() }));
vi.mock("~/server/strategies/strategy-center-native", () => ({
  captureNativeChanObservations: vi.fn(),
}));
let db: Database.Database;
let repo: AlertRepository;
const now = Date.parse("2026-11-13T02:00:00Z");
const strategy: StrategyObjectInput = {
  id: "source-golden",
  version: 1,
  market: "cn-equity",
  period: "5m",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 1 },
  sleeve: "swing",
};
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
  fixture.positions = [];
  fixture.tradingStatus = "trading";
  fixture.onStatus = () => {};
  fixture.bars = [
    {
      date: new Date(now).toISOString(),
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 100,
      amount: 1000,
    },
  ];
  put(
    "settings",
    "settings",
    settingsSchema.parse({
      tdxRoot: "D:\\fixed-fixture",
      calendar: ["2026-11-13"],
    }),
  );
  put("watchlist", "watchlist", ["sh600000"]);
});
afterEach(() => db.close());
it("does not record a fresh but preregistration bar, then records the first bar completed after registration", async () => {
  const crypto = {
    ...strategy,
    id: "shadow-start-boundary",
    market: "crypto" as const,
    universe: { kind: "symbols" as const, symbols: ["BTCUSDT"] },
  };
  repo.strategies.saveStrategy(crypto);
  repo.saveState(`shadow:${crypto.id}:1`, {
    startedAt: now + 1,
    active: true,
    status: "shadow-candidate",
    trialSharpes: [],
    neighbors: [],
    sizing: "equal",
    completeMarketCycles: 0,
    lowZoneCorroborated: false,
  });
  let clock = now + 1000;
  const delivered = vi.fn();
  const engine = new AlertEngine({
    clock: { now: () => clock },
    repository: repo,
    mode: () => "live",
    leader: () => true,
    calendar: async () => [],
    receipt: async () => false,
    evaluate: (phase, at) => evaluateAlertInputs(phase, at, repo),
    deliver: delivered,
    outcomes: async () => {},
    error: (e) => {
      throw e;
    },
  });
  await engine.tick();
  expect(
    repo.history({ page: 0, size: 20, symbol: "", strategyId: crypto.id })
      .total,
  ).toBe(0);
  expect(repo.state(`shadow-progress:${crypto.id}:1`)).toBeUndefined();
  fixture.bars.push({
    ...fixture.bars.at(-1)!,
    date: new Date(now + 300000).toISOString(),
  });
  clock = now + 300001;
  await engine.tick();
  expect(
    repo.history({ page: 0, size: 20, symbol: "", strategyId: crypto.id })
      .total,
  ).toBe(1);
  expect(repo.state(`shadow-summary:${crypto.id}:1`)).toMatchObject({
    signals: 1,
    days: 1,
  });
  expect(delivered).not.toHaveBeenCalled();
});
it("evaluates a shadow-only registration through the real input path and commits current observations with zero delivery even in live mode", async () => {
  const crypto = {
    ...strategy,
    id: "shadow-source",
    market: "crypto" as const,
    universe: { kind: "symbols" as const, symbols: ["BTCUSDT"] },
  };
  repo.strategies.saveStrategy(crypto);
  repo.saveState(`shadow:${crypto.id}:1`, {
    startedAt: now - 1,
    active: true,
    status: "shadow-candidate",
    trialSharpes: [],
    neighbors: [],
    sizing: "equal",
    completeMarketCycles: 0,
    lowZoneCorroborated: false,
  });
  const delivered = vi.fn();
  let clock = now;
  const engine = new AlertEngine({
    clock: { now: () => clock },
    repository: repo,
    mode: () => "live",
    leader: () => true,
    calendar: async () => [],
    receipt: async () => false,
    evaluate: async (phase, at) => {
      const value = await evaluateAlertInputs(phase, at, repo);
      clock = at + 1000;
      return value;
    },
    deliver: delivered,
    outcomes: async () => {},
    error: (e) => {
      throw e;
    },
  });
  await engine.tick();
  await engine.tick();
  const progress = repo.state<{
    samples: { observedAt: number; source: string }[];
    signals: number;
  }>(`shadow-progress:${crypto.id}:1`)!;
  expect(progress.samples).toHaveLength(1);
  expect(progress.samples[0]!.observedAt).toBe(now + 1000);
  expect(progress.samples[0]!.source).toContain("QA");
  expect(progress.signals).toBe(1);
  expect(repo.state(`shadow-summary:${crypto.id}:1`)).toMatchObject({
    signals: 1,
    days: 1,
  });
  expect(delivered).toHaveBeenCalledTimes(0);
  expect(
    repo.history({ page: 0, size: 20, symbol: "", strategyId: crypto.id })
      .items[0],
  ).toMatchObject({ mode: "shadow", status: "shadow" });
});
it("production input path feeds live registered strategy and real saved holding stop into one engine", async () => {
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  fixture.positions = [{ symbol: "sh600000", quantity: 100, stop: 11 }];
  const delivered = vi.fn();
  const engine = new AlertEngine({
    clock: { now: () => now },
    repository: repo,
    mode: () => "shadow",
    leader: () => true,
    calendar: async () => ["2026-11-13"],
    receipt: async () => true,
    evaluate: (phase, at) => evaluateAlertInputs(phase, at, repo),
    deliver: delivered,
    outcomes: async () => {},
    error: (e) => {
      throw e;
    },
  });
  await engine.tick();
  await engine.tick();
  const history = repo.history({
    page: 0,
    size: 20,
    symbol: "",
    strategyId: "",
  });
  expect(history.items.map((e) => e.type).sort()).toEqual(["entry", "stop"]);
  expect(history.items.every((e) => e.mode === "shadow")).toBe(true);
  expect(delivered).toHaveBeenCalledTimes(2);
});
it("production plan source triggers staged entries once then closes only after all stages", async () => {
  repo.strategies.saveStrategy(strategy);
  repo.savePlan(
    {
      id: "source-plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      symbol: "sh600000",
      market: "cn-equity",
      sleeve: "swing",
      triggerKey: "QA",
      entry: 9,
      stages: [
        { entry: 9, quantity: 100 },
        { entry: 11, quantity: 100 },
      ],
      quantity: 200,
      tranches: 2,
      stop: 8,
      target: 13,
      expiresAt: "2026-11-14T00:00:00Z",
      status: "open",
      createdAt: now - 300000,
    },
    now - 300000,
  );
  const run = async (at: number) => {
    const engine = new AlertEngine({
      clock: { now: () => at },
      repository: repo,
      mode: () => "shadow",
      leader: () => true,
      calendar: async () => ["2026-11-13"],
      receipt: async () => true,
      evaluate: (phase, t) => evaluateAlertInputs(phase, t, repo),
      deliver: () => {},
      outcomes: async () => {},
      error: (e) => {
        throw e;
      },
    });
    await engine.tick();
  };
  await run(now);
  expect(repo.strategies.plan("source-plan")?.status).toBe("open");
  fixture.bars = [
    {
      ...fixture.bars[0]!,
      date: new Date(now + 300000).toISOString(),
      close: 12,
      high: 12,
    },
  ];
  await run(now + 300000);
  await run(now + 300000);
  expect(repo.strategies.plan("source-plan")).toMatchObject({
    status: "closed",
    closeReason: "triggered",
  });
  expect(
    repo
      .history({ page: 0, size: 20, symbol: "", strategyId: "" })
      .items.map((e) => e.type),
  ).toEqual(["plan-entry", "plan-entry"]);
});

it.each(["suspended"] as const)(
  "new engine rejects %s status and retries the same fresh bar without losing it",
  async (status) => {
    repo.strategies.saveStrategy(strategy);
    repo.saveState(`strategy:${strategy.id}:1`, { live: true });
    fixture.tradingStatus = status;
    const deps = {
      clock: { now: () => now },
      repository: repo,
      mode: () => "shadow" as const,
      leader: () => true,
      calendar: async () => ["2026-11-13"],
      receipt: async () => true,
      evaluate: (phase: "close" | "intraday" | "crypto", at: number) =>
        evaluateAlertInputs(phase, at, repo),
      deliver: vi.fn(),
      outcomes: async () => {},
      error: (e: unknown) => {
        throw e;
      },
    };
    await new AlertEngine(deps).tick();
    expect(
      repo.history({ page: 0, size: 20, symbol: "", strategyId: "" }).total,
    ).toBe(0);
    fixture.tradingStatus = "trading";
    await new AlertEngine(deps).tick();
    expect(
      repo.history({ page: 0, size: 20, symbol: "", strategyId: "" }).total,
    ).toBe(1);
  },
);
it("strategy disabled and re-enabled during awaited status cannot commit the old registration", async () => {
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true, revision: "old" });
  fixture.onStatus = () => {
    repo.saveState(`strategy:${strategy.id}:1`, {
      live: false,
      revision: "off",
    });
    repo.saveState(`strategy:${strategy.id}:1`, {
      live: true,
      revision: "new",
    });
  };
  const delivery = vi.fn();
  await new AlertEngine({
    clock: { now: () => now },
    repository: repo,
    mode: () => "shadow",
    leader: () => true,
    calendar: async () => ["2026-11-13"],
    receipt: async () => true,
    evaluate: (p, t) => evaluateAlertInputs(p, t, repo),
    deliver: delivery,
    outcomes: async () => {},
    error: (e) => {
      throw e;
    },
  }).tick();
  expect(delivery).not.toHaveBeenCalled();
  expect(
    repo.history({ page: 0, size: 20, symbol: "", strategyId: "" }).total,
  ).toBe(0);
  expect(repo.state(`strategy:${strategy.id}:1`)).toEqual({
    live: true,
    revision: "new",
  });
});
it("freshness is rechecked after asynchronous source verification", async () => {
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  let clock = now;
  fixture.onStatus = () => {
    clock = now + 60000;
  };
  const delivery = vi.fn();
  await new AlertEngine({
    clock: { now: () => clock },
    repository: repo,
    mode: () => "shadow",
    leader: () => true,
    calendar: async () => ["2026-11-13"],
    receipt: async () => true,
    evaluate: (p, t) => evaluateAlertInputs(p, t, repo),
    deliver: delivery,
    outcomes: async () => {},
    error: (e) => {
      throw e;
    },
  }).tick();
  expect(delivery).not.toHaveBeenCalled();
  expect(
    repo.history({ page: 0, size: 20, symbol: "", strategyId: "" }).total,
  ).toBe(0);
});

it("A-share protection configuration shares the existing saved stop owner", async () => {
  const caller = alertsRouter.createCaller({ headers: new Headers() });
  await caller.saveHoldingAlert({
    market: "cn-equity",
    symbol: "sh600000",
    account: "",
    sleeve: "swing",
    stop: 9,
    target: 12,
    trailing: 0.1,
  });
  expect(get("trade-stop-sh600000")).toEqual({ stop: 9 });
  await caller.saveHoldingAlert({
    market: "cn-equity",
    symbol: "sh600000",
    account: "",
    sleeve: "swing",
    stop: null,
    target: 12,
    trailing: null,
  });
  expect(get("trade-stop-sh600000")).toEqual({ stop: null });
});
it("only an explicit manual live setting ends shadow evaluation and preserves its evidence", async () => {
  const liveRepo = new AlertRepository();
  const candidate = { ...strategy, id: "manual-shadow-switch" };
  const evidence = {
    startedAt: now,
    status: "shadow-candidate",
    active: true,
    trialSharpes: [],
    neighbors: [],
    sizing: "legacy",
    completeMarketCycles: 0,
    lowZoneCorroborated: false,
  };
  liveRepo.strategies.saveStrategy(candidate);
  liveRepo.saveState(`shadow:${candidate.id}:1`, evidence);
  liveRepo.saveState(`shadow-progress:${candidate.id}:1`, {
    signals: 12,
    days: ["2026-11-13"],
  });
  const caller = strategyLabRouter.createCaller({ headers: new Headers() });
  liveRepo.saveState(`shadow-summary:${candidate.id}:1`, {
    signals: 30,
    days: 60,
    paused: false,
    assessment: {
      at: now,
      eligible: true,
      reasons: [],
      recommendation: "QA fixture passed",
    },
  });
  await expect(
    caller.strategyLabAction({
      id: candidate.id,
      version: 1,
      action: "promote",
      confirmed: true,
      revision: strategyLabDetail(candidate.id, 1).revision,
    }),
  ).rejects.toThrow("晋级门槛未通过");
  expect(liveRepo.state(`shadow:${candidate.id}:1`)).toEqual(evidence);
  await caller.strategyLabAction({
    id: candidate.id,
    version: 1,
    action: "live",
    confirmed: true,
    riskAccepted: true,
    revision: strategyLabDetail(candidate.id, 1).revision,
  });
  expect(liveRepo.state(`strategy:${candidate.id}:1`)).toMatchObject({
    live: true,
  });
  expect(liveRepo.state(`shadow:${candidate.id}:1`)).toEqual({
    ...evidence,
    active: false,
  });
  expect(liveRepo.state(`shadow-progress:${candidate.id}:1`)).toEqual({
    signals: 12,
    days: ["2026-11-13"],
  });
});
it("later edits from the original position stop form override no stale alert copy", async () => {
  fixture.positions = [{ symbol: "sh600000", quantity: 100, stop: 9 }];
  repo.saveState("protection:cn-equity:sh600000", {
    stop: 11,
    target: null,
    trailing: null,
    sleeve: "swing",
  });
  const result = await evaluateAlertInputs("intraday", now, repo);
  expect(result.proposals.filter((p) => p.event.type === "stop")).toEqual([]);
  fixture.positions = [{ symbol: "sh600000", quantity: 100, stop: 11 }];
  const changed = await evaluateAlertInputs("intraday", now, repo);
  expect(changed.proposals.filter((p) => p.event.type === "stop")).toHaveLength(
    1,
  );
  expect(changed.proposals[0]!.event.stop).toBe(11);
});

it("keeps unknown trading status as a labelled shadow candidate without external delivery", async () => {
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  fixture.tradingStatus = "unknown";
  const value = await evaluateAlertInputs("intraday", now, repo);
  const proposal = value.proposals.find(
    (p) => p.event.strategyId === strategy.id,
  )!;
  expect(proposal.event.tradingStatusEvidence?.status).toBe("unknown");
  expect(proposal.event.reason).toContain("交易状态未知");
  expect(proposal.shadowOnly).toBe(true);
  expect(proposal.authorize?.(now)).toBe(true);
});

it("retains a candidate as unknown when the status provider fails", async () => {
  repo.strategies.saveStrategy(strategy);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  fixture.onStatus = () => {
    throw new Error("unavailable");
  };
  const value = await evaluateAlertInputs("intraday", now, repo);
  const proposal = value.proposals.find(
    (p) => p.event.strategyId === strategy.id,
  )!;
  expect(proposal.event.tradingStatusEvidence).toMatchObject({
    status: "unknown",
    asOf: null,
  });
  expect(proposal.shadowOnly).toBe(true);
});

it("reads the requested close date during the next morning rather than that morning's date", async () => {
  const { readBars } = await import("~/server/market/bar-store/read-bars");
  fixture.bars = [{ ...fixture.bars[0]!, date: "2026-11-13" }];
  repo.strategies.saveStrategy({ ...strategy, period: "day" });
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  const morning = Date.parse("2026-11-16T08:30:00+08:00");
  const result = await evaluateAlertInputs(
    "close",
    morning,
    repo,
    "2026-11-13",
  );
  expect(vi.mocked(readBars).mock.calls.at(-1)?.[0].to).toBe("2026-11-13");
  const p = result.proposals.find((p) => p.event.strategyId === strategy.id)!;
  expect(morning - p.completedAt).toBeLessThan(p.windowMs);
  expect(
    Date.parse("2026-11-16T09:00:00+08:00") - p.completedAt,
  ).toBeGreaterThan(p.windowMs);
  expect(
    result.states.find((s) => s.id === "exposure-close:cn-equity"),
  ).toBeDefined();
});

it("fixed crypto universes do not collect a second shadow security from a cx watchlist alias", async () => {
  const crypto = {
    ...strategy,
    id: "fixed-alias",
    market: "crypto" as const,
    universe: { kind: "symbols" as const, symbols: ["BTCUSDT"] },
  };
  repo.strategies.saveStrategy(crypto);
  put("watchlist", "watchlist", ["cxBTCUSDT", "cxETHUSDT"]);
  repo.saveState(`shadow:${crypto.id}:1`, {
    startedAt: now - 1,
    active: true,
    status: "shadow-candidate",
    trialSharpes: [],
    neighbors: [],
    sizing: "equal",
    completeMarketCycles: 0,
    lowZoneCorroborated: false,
  });
  const result = await evaluateAlertInputs("crypto", now, repo);
  const progress = result.states.find(
    (s) => s.id === `shadow-progress:${crypto.id}:1`,
  )?.value as { samples: { symbol: string }[] };
  expect(progress.samples.map((s) => s.symbol)).toEqual(["BTCUSDT"]);
  expect(
    result.proposals
      .filter((p) => p.event.strategyId === crypto.id)
      .map((p) => p.event.symbol),
  ).toEqual(["BTCUSDT"]);
});
