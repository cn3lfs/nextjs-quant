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
import {
  CandidateTable,
  type WorkspaceCandidate,
} from "~/components/overview/candidate-table";
import {
  candidateView,
  dailyMainAction,
  emptyCandidateMessage,
  isTodayBatch,
  selectMarket,
} from "~/components/overview/today-candidates";

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
  // The same filter applies before paging when one market has more than a page
  // of candidates, so page 1 of crypto is not a slice of the mixed list.
  const paged: StrategyObjectInput = {
    ...strategy,
    id: "crypto-page",
    market: "crypto",
    universe: { kind: "symbols", symbols: ["cx0USDT"] },
  };
  for (let i = 0; i < 21; i++) {
    const identity = {
      strategyId: paged.id,
      version: paged.version,
      market: "crypto" as const,
      symbol: `cx${i}USDT`,
      bar: "2026-11-13",
    };
    repo.record(paged, { ...event(), ...identity, key: alertKey(identity) });
  }
  repo.saveState(`candidate-scan:crypto:${paged.id}:1`, {
    market: "crypto",
    strategyId: paged.id,
    version: paged.version,
    period: "day",
    bar: "2026-11-13",
    observedAt: now,
  });
  const cryptoSecond = workspaceCandidates(
    { page: 1, market: "crypto" },
    repo,
    now,
  );
  expect(cryptoSecond.total).toBe(21);
  expect(cryptoSecond.items).toHaveLength(1);
  expect(cryptoSecond.items[0]!.market).toBe("crypto");
  expect(
    workspaceCandidates({ page: 0, market: "cn-equity" }, repo, now).total,
  ).toBe(25);
  // The unfiltered list mixes both markets, so reusing it for a market page
  // would report the wrong total and rows.
  expect(workspaceCandidates({ page: 0 }, repo, now).total).toBe(46);
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
it("today ranks valid deadlines first, keeps unverified and expired plans visible, and never closes them", async () => {
  const day = 86400000;
  const iso = (at: number) => new Date(at).toISOString();
  repo.strategies.saveStrategy(strategy);
  const addPlan = (id: string, expiresAt: string | null, at: number) =>
    repo.savePlan(
      {
        id,
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        symbol: "sh600000",
        sleeve: "swing",
        triggerKey: `qa:${id}`,
        entry: 10,
        tranches: 1,
        quantity: 100,
        stop: 9,
        target: 13,
        expiresAt,
        status: "open" as const,
        createdAt: at,
      },
      at,
    );
  addPlan("due-1h", iso(now + 3600000), now + 1);
  addPlan("due-12h", iso(now + 12 * 3600000), now + 2);
  // 截止正好等于 now+24h 属于 24 小时内到期。
  addPlan("due-24h", iso(now + day), now + 3);
  // 同一截止先按 createdAt 倒序，再按 ID 升序。
  addPlan("tie-old", iso(now + 5 * day), now + 4);
  addPlan("tie-new", iso(now + 5 * day), now + 5);
  addPlan("tie-same-a", iso(now + 5 * day), now + 5);
  addPlan("tie-same-b", iso(now + 5 * day), now + 5);
  for (let i = 0; i < 13; i++)
    addPlan(`far-${i}`, iso(now + (6 + i) * day), now + 10 + i);
  // 截止正好等于 now 已到期；这些计划仍保持 open，只展示状态。
  addPlan("exp-2d", iso(now - 2 * day), now + 20);
  addPlan("exp-1d", iso(now - day), now + 21);
  addPlan("exp-1h", iso(now - 3600000), now + 22);
  addPlan("exp-now", iso(now), now + 23);
  for (let i = 0; i < 4; i++) addPlan(`unv-${i}`, null, now + 30 + i);

  const result = await todayWorkspace(now, repo);
  expect(result.openPlans).toMatchObject({
    total: 28,
    valid: 20,
    dueSoon: 3,
    unverified: 4,
    expired: 4,
  });
  expect(result.openPlans.items).toHaveLength(20);
  const ids = result.openPlans.items.map((p) => p.id);
  expect(ids.slice(0, 7)).toEqual([
    "due-1h",
    "due-12h",
    "due-24h",
    "tie-new",
    "tie-same-a",
    "tie-same-b",
    "tie-old",
  ]);
  expect(ids.slice(7, 14)).toEqual(
    Array.from({ length: 7 }, (_, i) => `far-${i}`),
  );
  // 非有效各保留最近 3 条，其余名额先给最早截止的有效计划。
  expect(ids.slice(14, 17)).toEqual(["unv-3", "unv-2", "unv-1"]);
  expect(ids.slice(17)).toEqual(["exp-now", "exp-1h", "exp-1d"]);
  expect(result.openPlans.items[2]).toMatchObject({
    id: "due-24h",
    expiryState: "due-soon",
  });
  expect(result.openPlans.items[17]).toMatchObject({
    id: "exp-now",
    expiryState: "expired",
  });
  // 只读投影：数据库里的 28 条计划全部仍是 open。
  expect(
    db
      .prepare("SELECT status,COUNT(*) AS n FROM trade_plans GROUP BY status")
      .all(),
  ).toEqual([{ status: "open", n: 28 }]);
  expect(repo.plans()).toHaveLength(28);
  expect(repo.plans().every((p) => p.status === "open")).toBe(true);
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
  const result = workspaceCandidates(
    { page: 0, market: "cn-equity" },
    repo,
    now,
    undefined,
    {
      closeDate: currentBar,
      calendar: [priorBar, currentBar],
    },
  );
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
it("the first market page uses server-filtered rows, never the mixed today batch", () => {
  repo.record(strategy, event());
  const crypto: StrategyObjectInput = {
    ...strategy,
    id: "crypto-first-page",
    market: "crypto",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
  };
  const identity = {
    strategyId: crypto.id,
    version: crypto.version,
    market: "crypto" as const,
    symbol: "BTCUSDT",
    bar: "2026-11-13",
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
  const all = workspaceCandidates({ page: 0 }, repo, now);
  const filtered = workspaceCandidates(
    { page: 0, market: "crypto" },
    repo,
    now,
  );
  expect(all.total).toBe(2);
  expect(filtered.total).toBe(1);
  const close = { phase: "complete", strategies: 1 } as const;
  const view = candidateView({
    market: "crypto",
    page: 0,
    all,
    filtered,
    close,
  });
  expect(isTodayBatch("all", 0)).toBe(true);
  expect(isTodayBatch("crypto", 0)).toBe(false);
  expect(view.source).toBe("filtered");
  expect(view.total).toBe(1);
  expect(view.rows?.map((row) => row.market)).toEqual(["crypto"]);
  // A missing key is pending, not the previous page's or another market's rows.
  const pending = candidateView({ market: "crypto", page: 0, all, close });
  expect(pending.source).toBe("pending");
  expect(pending.rows).toBeUndefined();
  expect(pending.loading).toBe(true);
  expect(pending.emptyMessage).toContain("正在读取候选");
  expect(pending.emptyMessage).not.toMatch(/无入选候选|本页无候选/);
  expect(selectMarket({ market: "all", page: 3 }, "crypto")).toEqual({
    market: "crypto",
    page: 0,
  });
});
it("candidate refresh keeps the same key's rows and never turns an old read into a confirmed empty", () => {
  const close = { phase: "complete", strategies: 1 } as const;
  const rows = [{ key: "qa-row" }] as unknown as WorkspaceCandidate[];
  const all = { items: rows, total: 1 };
  const filtered = { items: rows, total: 1 };
  // A same-key refetch keeps the table instead of flashing a loading state.
  const refreshing = candidateView({
    market: "cn-equity",
    page: 0,
    all,
    filtered,
    fetching: true,
    close,
  });
  expect(refreshing).toMatchObject({
    source: "filtered",
    loading: false,
    stale: false,
    warning: null,
  });
  expect(refreshing.rows).toBe(rows);
  // A failed refresh keeps the last successful rows but pauses planning.
  const failed = candidateView({
    market: "cn-equity",
    page: 0,
    all,
    filtered,
    failure: "connection refused",
    close,
  });
  expect(failed).toMatchObject({
    source: "filtered",
    loading: false,
    warning: "connection refused",
    stale: true,
  });
  expect(failed.rows).toBe(rows);
  // A same-key old zero followed by a failure is not a completed zero scan.
  const staleZero = candidateView({
    market: "cn-equity",
    page: 0,
    all,
    filtered: { items: [], total: 0 },
    failure: "connection refused",
    close,
  });
  expect(staleZero.stale).toBe(true);
  expect(staleZero.emptyMessage).toContain("刷新失败");
  expect(staleZero.emptyMessage).not.toContain("最近收盘扫描已完成");
  // A first read keeps its original error instead of a zero-candidate table.
  const firstFailure = candidateView({
    market: "cn-equity",
    page: 0,
    all,
    failure: "connection refused",
    close,
  });
  expect(firstFailure).toMatchObject({
    source: "error",
    rows: undefined,
    total: undefined,
    loading: false,
    error: "connection refused",
    emptyMessage: null,
  });
  // Switching to another key never exposes the previous key's rows.
  const switched = candidateView({ market: "crypto", page: 0, all, close });
  expect(switched).toMatchObject({
    source: "pending",
    rows: undefined,
    total: undefined,
    loading: true,
  });
  // A stale today summary cannot claim its old zero is a completed scan.
  const staleToday = candidateView({
    market: "all",
    page: 0,
    all: { items: [], total: 0 },
    allStale: true,
    close,
  });
  expect(staleToday.stale).toBe(true);
  expect(staleToday.emptyMessage).not.toContain("最近收盘扫描已完成");
});
it("main action keeps risk first; one missing market still leads to candidates", () => {
  expect(
    dailyMainAction({
      risks: 2,
      equityReady: false,
      cryptoReady: false,
      candidates: 0,
    }),
  ).toEqual({ href: "#holding-risk", text: "处理 2 个跌破止损" });
  const singleGap = dailyMainAction({
    risks: 0,
    equityReady: true,
    cryptoReady: false,
    candidates: 3,
  });
  expect(singleGap.href).toBe("#tomorrow");
  expect(singleGap.text).toContain("候选");
  expect(singleGap.text).not.toContain("计划");
  expect(
    dailyMainAction({
      risks: 0,
      equityReady: false,
      cryptoReady: false,
      candidates: 0,
    }).href,
  ).toBe("/system");
  expect(
    dailyMainAction({
      risks: 0,
      equityReady: true,
      cryptoReady: true,
      candidates: 0,
    }).text,
  ).not.toMatch(/\d/);
  const cryptoEmpty = emptyCandidateMessage({
    market: "crypto",
    total: 0,
    close: { phase: "complete", strategies: 0 },
  });
  expect(cryptoEmpty).toContain("数字货币");
  expect(cryptoEmpty).not.toContain("A 股策略");
  expect(cryptoEmpty).not.toMatch(/收盘扫描|回执/);
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
it("seven workspace entrances and the display formatter preserve unknown and zero", () => {
  expect(navGroups.map((g) => g.label)).toEqual([
    "今日交易",
    "行情看盘",
    "选股筛选",
    "策略回测",
    "持仓复盘",
    "资讯研报",
    "系统设置",
  ]);
  expect(formatNumber(null)).toBe("—");
  expect(formatNumber(NaN)).toBe("—");
  expect(formatNumber(0)).toBe("0.00");
});
