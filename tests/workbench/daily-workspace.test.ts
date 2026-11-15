import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { put } from "~/server/db";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import {
  todayWorkspace,
  workspaceCandidate,
  workspaceCandidates,
} from "~/server/alerts/workspace";
import { createAlertPlan } from "~/server/alerts/plans";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type { StrategyObjectInput } from "trading-strategies";
import { formatNumber } from "trading-strategy-core/format-number";
import { navGroups } from "~/components/workbench/navigation";

const now = Date.parse("2026-11-13T08:00:00Z");
const config = settingsSchema.parse({
  alerts: { capital: { "cn-equity": 100000, crypto: 100000 } },
});
const strategy: StrategyObjectInput = {
  id: "daily-qa",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 1 },
  sleeve: "swing",
};
let db: Database.Database, repo: AlertRepository;
function event(overrides: Partial<AlertEvent> = {}) {
  const identity = {
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity" as const,
    symbol: "sh600000",
    bar: "2026-11-13",
  };
  return {
    ...identity,
    key: alertKey(identity),
    type: "entry",
    price: 10,
    stop: 9,
    target: 13,
    sleeve: "swing",
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    reason: "QA",
    source: "fixed synthetic input",
    wouldSend: false,
    outcomes: [],
    ...overrides,
  } satisfies AlertEvent;
}
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
  put("settings", "settings", config);
  repo.saveState("exposure", [
    { market: "cn-equity", sleeve: "__checked__", value: 0, at: now },
  ]);
});
afterEach(() => db.close());
it("quantity preview and create share admission; stale exposure and unknown crypto lot remain unavailable", () => {
  const e = event();
  repo.record(strategy, e);
  const before = repo.plans().length;
  expect(workspaceCandidate(e, repo, now)).toMatchObject({
    quantity: 1000,
    qualification: "research",
    quantityReason: null,
  });
  expect(repo.plans()).toHaveLength(before);
  const plan = createAlertPlan(
    {
      eventKey: e.key,
      stages: [10],
      stop: 9,
      target: 13,
      expiresAt: new Date(now + 86400000).toISOString(),
    },
    config,
    now,
    repo,
  );
  expect(plan.quantity).toBe(1000);
  expect(workspaceCandidate(e, repo, now).quantityReason).toContain(
    "未完成计划",
  );
  repo.closePlan(plan.id, "cancelled");
  expect(workspaceCandidate(e, repo, now + 600001)).toMatchObject({
    quantity: null,
    quantityReason: expect.stringContaining("过期"),
  });
  const cryptoStrategy = {
    ...strategy,
    id: "crypto-qa",
    market: "crypto" as const,
  };
  const crypto = event({
    strategyId: cryptoStrategy.id,
    market: "crypto",
    symbol: "BTCUSDT",
    key: alertKey({
      strategyId: cryptoStrategy.id,
      version: 1,
      market: "crypto",
      symbol: "BTCUSDT",
      bar: e.bar,
    }),
  });
  repo.record(cryptoStrategy, crypto);
  repo.saveState("exposure", [
    { market: "crypto", sleeve: "__checked__", value: 0, at: now },
  ]);
  expect(workspaceCandidate(crypto, repo, now)).toMatchObject({
    quantity: null,
    quantityReason: expect.stringContaining("数量步长"),
  });
});
it("research promotion never follows live mode; shadow registration and version are explicit", () => {
  const e = event();
  repo.record(strategy, e);
  repo.records.save(
    "strategy-qualification",
    `strategy-qualification-${strategy.id}`,
    { status: "research" },
  );
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  expect(workspaceCandidate(e, repo, now).qualification).toBe("research");
  repo.saveState(`shadow:${strategy.id}:1`, { active: true });
  expect(workspaceCandidate(e, repo, now).qualification).toBe("shadow");
  repo.records.save(
    "strategy-qualification",
    `strategy-qualification-${strategy.id}`,
    { status: "live-candidate" },
  );
  expect(workspaceCandidate(e, repo, now).qualification).toBe("promoted");
  expect(
    workspaceCandidate({ ...e, version: 2 }, repo, now).qualification,
  ).toBe("research");
});
it("candidate filters run before stable server pagination; missed entries never count as plans", () => {
  for (let i = 0; i < 25; i++) {
    const e = event({ symbol: `sh${600000 + i}` });
    e.key = alertKey(e);
    repo.record(strategy, e);
  }
  const missed = event({ bar: "2026-11-14", status: "missed" });
  missed.key = alertKey(missed);
  repo.record(strategy, missed);
  const first = workspaceCandidates({ page: 0 }, repo, now),
    second = workspaceCandidates({ page: 1 }, repo, now);
  expect(first.total).toBe(25);
  expect(first.items).toHaveLength(20);
  expect(second.items).toHaveLength(5);
  expect(
    new Set([...first.items, ...second.items].map((e) => e.key)).size,
  ).toBe(25);
  expect(
    workspaceCandidates({ page: 0, minimumRps: 80 }, repo, now),
  ).toMatchObject({ total: 0, items: [] });
  expect(
    workspaceCandidates({ page: 0, strategy: "missing" }, repo, now).total,
  ).toBe(0);
});
it("today exposes both modes, stale allocation, low-zone evidence, unknown holdings and archive gaps", async () => {
  repo.record(strategy, event());
  const live = event({
    bar: "2026-11-13T00:00:00Z",
    mode: "live",
    status: "live",
  });
  live.key = alertKey(live);
  repo.record(strategy, live);
  repo.saveState("regime:crypto:ETHUSDT", {
    trend: "down",
    temperature: 10,
    zone: "cold",
    basis: "QA",
    bar: "2026-11-13",
  });
  const result = await todayWorkspace(now + 600001, repo);
  expect(result.sleeves.find((s) => s.market === "cn-equity")?.fresh).toBe(
    false,
  );
  expect(result.regimes.find((r) => r.symbol === "ETHUSDT")?.value?.trend).toBe(
    "down",
  );
  expect(result.triggered.items.map((e) => e.mode).sort()).toEqual([
    "live",
    "shadow",
  ]);
  expect(result.holdings).toBeNull();
  expect(result.receipt).toBe(false);
  expect(result.archive.needsBackfill).toBe(true);
  expect(repo.subscriptions()).toEqual([]);
  expect(repo.plans()).toEqual([]);
});
it("six workspace entrances and the display formatter preserve unknown and zero", () => {
  expect(navGroups.map((g) => g.label)).toEqual([
    "今日",
    "扫描与图表",
    "策略实验室",
    "账户与复盘",
    "情报",
    "系统",
  ]);
  expect(formatNumber(null)).toBe("—");
  expect(formatNumber(NaN)).toBe("—");
  expect(formatNumber(0)).toBe("0.00");
});
