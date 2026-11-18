import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { CandidateTable } from "~/components/overview/candidate-table";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: ReactNode }) =>
      createElement("a", { href }, children),
  };
});

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
  exit: { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.3 },
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
  repo.saveState(`candidate-scan:cn-equity:${strategy.id}:1`, {
    bar: "2026-11-13",
    observedAt: now,
  });
});
afterEach(() => db.close());
const secondStrategy: StrategyObjectInput = { ...strategy, id: "daily-qb" };
function strategyEvent(
  target: StrategyObjectInput,
  bar: string,
  observedAt = now,
) {
  const identity = {
    strategyId: target.id,
    version: target.version,
    market: "cn-equity" as const,
    symbol: "sh600000",
    bar,
  };
  return { ...event(), ...identity, key: alertKey(identity), observedAt };
}
function scanState(
  target: StrategyObjectInput,
  bar: string,
  observedAt: number,
) {
  return {
    market: "cn-equity",
    strategyId: target.id,
    version: target.version,
    period: "day",
    bar,
    observedAt,
  };
}
it("quantity preview and create share admission; post-close exposure remains usable and unknown crypto lot stays unavailable", () => {
  const e = event();
  repo.record(strategy, e);
  const before = repo.plans().length;
  expect(workspaceCandidate(e, repo, now)).toMatchObject({
    quantity: 900,
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
    { positions: [], industry: () => "银行", assertCurrent: () => {} },
  );
  expect(plan.quantity).toBe(900);
  expect(workspaceCandidate(e, repo, now).quantityReason).toContain(
    "未完成计划",
  );
  repo.closePlan(plan.id, "cancelled");
  expect(workspaceCandidate(e, repo, now + 600001)).toMatchObject({
    quantity: 900,
    quantityReason: null,
    positionSnapshot: { at: now, basis: "post-close" },
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
  // Backtest qualification alone cannot replace the missing frozen forward
  // reference and the manual, same-version promotion decision.
  expect(workspaceCandidate(e, repo, now).qualification).toBe("shadow");
  repo.saveState(`promotion:${strategy.id}:1`, {
    at: now,
    inputHash: null,
    reasons: [],
  });
  expect(workspaceCandidate(e, repo, now).qualification).toBe("shadow");
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
it("today exposes both modes, post-close allocation, low-zone evidence, unknown holdings and archive gaps", async () => {
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
    true,
  );
  expect(
    result.sleeves.find((s) => s.market === "cn-equity")?.snapshotBasis,
  ).toBe("post-close");
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
it("merged A-share rows show both scan times and keep only the current source plannable", () => {
  const currentBar = "2026-11-18";
  const priorBar = "2026-11-17";
  const currentAt = Date.parse("2026-11-18T16:00:00+08:00");
  const priorAt = Date.parse("2026-11-17T16:00:00+08:00");
  const current = strategyEvent(strategy, currentBar, currentAt);
  const prior = strategyEvent(secondStrategy, priorBar, priorAt);
  repo.record(strategy, current);
  repo.record(secondStrategy, prior);
  repo.saveState(
    `candidate-scan:cn-equity:${strategy.id}:1`,
    scanState(strategy, currentBar, currentAt),
  );
  repo.saveState(
    `candidate-scan:cn-equity:${secondStrategy.id}:1`,
    scanState(secondStrategy, priorBar, priorAt),
  );
  const result = workspaceCandidates({ page: 0 }, repo, now, undefined, {
    closeDate: currentBar,
    calendar: [priorBar, currentBar],
  });
  expect(result.total).toBe(1);
  const row = result.items[0]!;
  expect(row.scan).toEqual({
    current: false,
    hasHistorical: true,
    hasUnverified: false,
  });
  const byStrategy = Object.fromEntries(
    row.sources.map((source) => [source.strategyId, source]),
  );
  expect(byStrategy[strategy.id]).toMatchObject({
    bar: currentBar,
    scanFreshness: "current",
    scanAt: currentAt,
  });
  expect(byStrategy[secondStrategy.id]).toMatchObject({
    bar: priorBar,
    scanFreshness: "stale",
    scanAt: priorAt,
  });
  // The historical source is viewable but is not the default plan source.
  expect(
    row.sources
      .filter((source) => source.scanFreshness !== "stale")
      .map((source) => source.strategyId),
  ).toEqual([strategy.id]);
  const html = renderToStaticMarkup(
    createElement(CandidateTable, {
      data: [row],
      total: 1,
      onPlan: () => {},
      canPlan: (r) => r.sources.some((s) => s.scanFreshness !== "stale"),
    }),
  );
  expect(html).toContain("含历史来源");
  expect(html).toContain("加入计划");
  const staleOnly = renderToStaticMarkup(
    createElement(CandidateTable, {
      data: [
        {
          ...row,
          sources: row.sources.filter((s) => s.scanFreshness === "stale"),
        },
      ],
      total: 1,
      onPlan: () => {},
      canPlan: (r) => r.sources.some((s) => s.scanFreshness !== "stale"),
    }),
  );
  expect(staleOnly).toContain("历史来源 · 仅查看");
  expect(staleOnly).not.toContain("加入计划");
  // An unknown reference date is unverified, not historical and not blocked.
  const unknown = workspaceCandidates({ page: 0 }, repo, now, undefined, {
    closeDate: null,
    calendar: [priorBar, currentBar],
  });
  expect(unknown.items[0]!.scan).toMatchObject({
    hasHistorical: false,
    hasUnverified: true,
  });
  expect(
    unknown.items[0]!.sources.every(
      (source) => source.scanFreshness === "unknown",
    ),
  ).toBe(true);
});
it("crypto candidates keep their original presentation and plan availability", () => {
  const crypto: StrategyObjectInput = {
    ...strategy,
    id: "crypto-freshness",
    market: "crypto",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
  };
  const identity = {
    strategyId: crypto.id,
    version: crypto.version,
    market: "crypto" as const,
    symbol: "BTCUSDT",
    bar: "2026-11-18",
  };
  repo.record(crypto, { ...event(), ...identity, key: alertKey(identity) });
  repo.saveState(`candidate-scan:crypto:${crypto.id}:1`, {
    market: "crypto",
    strategyId: crypto.id,
    version: crypto.version,
    period: "day",
    bar: identity.bar,
    observedAt: now,
  });
  const result = workspaceCandidates(
    { page: 0, market: "crypto" },
    repo,
    now,
    undefined,
    {
      closeDate: "2026-11-18",
      calendar: ["2026-11-17", "2026-11-18"],
    },
  );
  const row = result.items[0]!;
  expect(row.scan).toBeNull();
  expect(row.scanFreshness).toBeNull();
  expect(row.sources.map((source) => source.scanFreshness)).toEqual([null]);
  expect(
    row.sources.filter((source) => source.scanFreshness !== "stale"),
  ).toHaveLength(1);
});
it("today close scan separates historical, completed-zero and never-scanned reads", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "tdx-close-scan");
  const dir = join(root, "vipdoc/sh/lday");
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(20261118, 0);
  [1000, 1100, 900, 1050].forEach((n, i) => bytes.writeUInt32LE(n, 4 + i * 4));
  bytes.writeFloatLE(10000, 20);
  bytes.writeUInt32LE(1000, 24);
  await writeFile(join(dir, "sh000300.day"), bytes);
  const configured = settingsSchema.parse({
    ...config,
    tdxRoot: root,
    calendar: ["2026-11-17", "2026-11-18"],
  });
  put("settings", "settings", configured);
  repo.saveState(`strategy:${strategy.id}:1`, { live: true });
  const closeAt = Date.parse("2026-11-18T16:00:00+08:00");
  const priorAt = Date.parse("2026-11-17T16:00:00+08:00");
  const prior = strategyEvent(strategy, "2026-11-17", priorAt);
  repo.record(strategy, prior);
  repo.saveState(
    `candidate-scan:cn-equity:${strategy.id}:1`,
    scanState(strategy, "2026-11-17", priorAt),
  );
  let result = await todayWorkspace(closeAt, repo);
  expect(result.closeScan).toMatchObject({
    date: "2026-11-18",
    phase: "unconfirmed",
    strategies: 1,
  });
  expect(result.candidates.total).toBe(1);
  expect(result.candidates.items[0]!.scan).toMatchObject({
    hasHistorical: true,
  });

  // The watermark advanced with zero events: finished, but not "no signal".
  db.prepare("DELETE FROM watch_events").run();
  repo.saveState(
    `candidate-scan:cn-equity:${strategy.id}:1`,
    scanState(strategy, "2026-11-18", closeAt),
  );
  repo.saveState("close:2026-11-18", { status: "complete", at: closeAt });
  result = await todayWorkspace(closeAt, repo);
  expect(result.closeScan).toMatchObject({
    date: "2026-11-18",
    phase: "complete",
    strategies: 1,
  });
  expect(result.candidates.total).toBe(0);

  // No watermark and no close record: never confirmed for this reference date.
  db.prepare("DELETE FROM records WHERE id=?").run(
    `alerts:candidate-scan:cn-equity:${strategy.id}:1`,
  );
  db.prepare("DELETE FROM records WHERE id=?").run("alerts:close:2026-11-18");
  result = await todayWorkspace(closeAt, repo);
  expect(result.closeScan).toMatchObject({
    date: "2026-11-18",
    phase: "unconfirmed",
    strategies: 1,
  });
  expect(result.candidates.total).toBe(0);
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
