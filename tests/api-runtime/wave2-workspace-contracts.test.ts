import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AlertRepository } from "~/server/db/alert-repository";
import { migrate } from "~/server/db/migrations";
import { appRouter } from "~/server/api/root";
import { sqlite, put } from "~/server/db";
import { settings } from "~/server/infra/settings";
import {
  strategyLabCompareRuns,
  strategyLabDetail,
} from "~/server/db/strategy-lab";
import { readAlertPipeline } from "~/server/infra/alert-pipeline-diagnostics";
import { evaluateCandidatePlanEligibility } from "~/server/alerts/plans";
import { matchQuickSecurities } from "~/server/api/routers/market";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type { Job } from "~/lib/domain";
import { strategyObjectSchema } from "trading-strategies";

const strategy = strategyObjectSchema.parse({
  id: "qa-wave2",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 0.2 },
  sleeve: "swing",
});
const bar = "2026-11-17",
  now = Date.parse(bar + "T08:00:00Z");
const identity = {
  strategyId: strategy.id,
  version: 1,
  market: strategy.market,
  symbol: "sh600000",
  bar,
};
const event: AlertEvent = {
  ...identity,
  key: alertKey(identity),
  type: "entry",
  price: 12,
  stop: 10,
  target: null,
  observedAt: now,
  mode: "live",
  status: "live",
  reason: "fixture",
  source: "fixture",
  wouldSend: true,
  outcomes: [],
  sleeve: "swing",
};
const ready = {
  ready: true,
  expectedDate: bar,
  closeStatus: "complete",
  scanAt: now,
};
let repo: AlertRepository;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
});
afterEach(() => repo.db.close());

it("keeps frozen signal and execution prices distinct and treats missing freshness as unverified", () => {
  const e = { ...event, signalPrice: 10, signalPriceBasis: "forward" as const };
  const reference = { closeDate: bar, calendar: ["2026-11-16", bar] };
  const scan = { bar, observedAt: now };
  expect(evaluateCandidatePlanEligibility(e)).toEqual({
    freshness: "unverified",
    executionRawPrice: 12,
    signalPrice: 10,
    signalPriceBasis: "forward",
  });
  expect(
    evaluateCandidatePlanEligibility(
      { ...e, executionRawPrice: null },
      scan,
      "day",
      reference,
    ),
  ).toMatchObject({ freshness: "fresh-close", executionRawPrice: null });
  expect(
    evaluateCandidatePlanEligibility(e, scan, "5m", reference).freshness,
  ).toBe("intraday");
  expect(
    evaluateCandidatePlanEligibility(
      { ...e, bar: "2026-11-16" },
      { ...scan, bar: "2026-11-16" },
      "day",
      reference,
    ).freshness,
  ).toBe("stale");
});

it("finds code prefixes, Chinese substrings and pinyin initials across only supported local markets", () => {
  const entries = [{ name: "浦发银行", symbol: "sh600000" }];
  expect(matchQuickSecurities([], "BTC", 12)).toEqual({
    ready: false,
    items: [],
  });
  for (const [query, matchType] of [
    ["6000", "code"],
    ["发银", "name"],
    ["PFYH", "pinyin"],
  ]) {
    expect(matchQuickSecurities(entries, query!, 1).items).toEqual([
      { ...entries[0], market: "cn-equity", matchType, ready: true },
    ]);
  }
  expect(matchQuickSecurities(entries, "BTCUSDT", 12).items[0]?.symbol).toBe(
    "cxBTCUSDT",
  );
  expect(matchQuickSecurities(entries, "ETHUSDT", 12).items[0]?.symbol).toBe(
    "cxETHUSDT",
  );
  expect(matchQuickSecurities(entries, "BNBUSDT", 12).items).toEqual([]);
  expect(matchQuickSecurities(entries, "沪金", 12).items[0]?.market).toBe(
    "futures",
  );
});

it("attributes a missing push to the actual prerequisite and correlates only this event's receipts", () => {
  const inspect = (mode: "live" | "shadow" = "live") =>
    readAlertPipeline(repo, mode, ready, now);
  expect(inspect().primaryBlocker?.stage).toBe(1);
  repo.record(strategy, event);
  expect(inspect().primaryBlocker?.stage).toBe(3);
  repo.records.save("alert-subscription", "alert-subscription:sub", {
    id: "sub",
    revision: "one",
    enabled: true,
    market: "cn-equity",
    kinds: ["entry"],
    symbols: [],
    strategyIds: [],
    channels: ["chan"],
  });
  expect(inspect("shadow").primaryBlocker).toMatchObject({
    stage: 4,
    fixHref: "/lab",
  });
  repo.saveState("strategy:" + strategy.id + ":1", { live: true });
  expect(inspect().primaryBlocker?.stage).toBe(5);
  repo.records.save("channel", "chan", {
    id: "chan",
    configured: true,
    enabled: true,
  });
  const signalId =
    "alert-" +
    createHash("sha256")
      .update(event.key + "sub")
      .digest("hex");
  const id =
    "delivery-alert-" +
    createHash("sha256")
      .update(signalId + "chan")
      .digest("hex");
  repo.records.save("notification-decision", "notification-decision:" + id, {
    signalId,
    tier: "ledger",
    reasons: ["同方向已推送"],
  });
  expect(inspect().primaryBlocker).toMatchObject({
    stage: 2,
    reason: "同方向已推送",
  });
  repo.records.save("delivery", "unrelated", {
    id: "unrelated",
    alertKey: "other",
    status: "sent",
  });
  repo.records.save("delivery", id, {
    id,
    createdAt: now,
    alertKey: event.key,
    channelId: "chan",
    status: "pending",
    attempts: 1,
    nextAt: now + 1000,
  });
  expect(inspect().primaryBlocker).toMatchObject({
    stage: 5,
    reason: expect.stringContaining("重试"),
  });
  const delivery = {
    id,
    createdAt: now,
    alertKey: event.key,
    channelId: "chan",
    attempts: 2,
    nextAt: now,
  };
  repo.records.save("delivery", id, { ...delivery, status: "failed" });
  expect(inspect().primaryBlocker?.stage).toBe(6);
  repo.records.save("delivery", id, { ...delivery, status: "sent" });
  repo.db.pragma("query_only=ON");
  const final = inspect();
  expect(final.stages.map((s) => s.label)).toEqual([
    "触发",
    "入队",
    "订阅",
    "资格",
    "投递",
    "回执",
  ]);
  expect(final.primaryBlocker).toBeNull();
  expect(final.evidence.lastSuccess?.id).toBe(id);
  expect(final.evidence.deliveries).toHaveLength(1);
});

it("routes persisted preferences, a cold and loaded directory, and read-only diagnostics through the local API", async () => {
  const caller = appRouter.createCaller({ headers: new Headers() });
  expect(await caller.workspacePreferences()).toMatchObject({
    density: "comfort",
  });
  await caller.saveWorkspacePreferences({ density: "compact" });
  expect(
    await caller.saveWorkspacePreferences({ closeToTray: true }),
  ).toMatchObject({ density: "compact", closeToTray: true });
  expect(await caller.quickSearchSecurities({ query: "BTC" })).toEqual({
    ready: false,
    items: [],
  });
  put("security-directory", "security-directory", {
    root: settings().tdxRoot,
    entries: { sh600000: { symbol: "sh600000", name: "浦发银行" } },
  });
  expect(await caller.quickSearchSecurities({ query: "pfyh" })).toMatchObject({
    ready: true,
    items: [{ symbol: "sh600000", matchType: "pinyin" }],
  });
  await expect(
    caller.quickSearchSecurities({ query: "p", limit: 26 }),
  ).rejects.toThrow();
  const changes = () => sqlite().prepare("SELECT total_changes() n").get();
  const before = changes();
  expect((await caller.alertPipelineDiagnostics()).primaryBlocker?.stage).toBe(
    1,
  );
  expect(changes()).toEqual(before);
});
const window = { start: "2026-11-01", end: bar, initial: 100 };
const request = {
  ...window,
  market: "cn-equity",
  strategies: [strategy],
  instruments: [{ symbol: "sh600000", actions: [], execution: { step: 100 } }],
  calendar: [bar],
  costs: { commission: 1 },
  sleeves: [{ id: "swing", share: 1 }],
};
const frozen = {
  request,
  marketPolicy: { execution: "raw" },
  costScenario: "base",
  strategyBuildHash: "build",
  executionBuildHash: "execution",
  sources: [{ symbol: "sh600000", hash: "a" }],
};
function job(id: string, kind: string, freeze: unknown): Job {
  return {
    id,
    type: "backtest",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { type: kind },
    result: {
      frozen: freeze,
      inputHash: createHash("sha256")
        .update(JSON.stringify(freeze))
        .digest("hex"),
      result: { curve: [{ date: bar, equity: 110 }], fills: [] },
      inputDiagnostics: [],
    },
  };
}

it("isolates six version-specific lifecycle gates, including a peer with different strategy and identical execution inputs", () => {
  repo.strategies.saveStrategy(strategy);
  const inspect = () => strategyLabDetail(strategy.id, 1, repo);
  expect(inspect().primaryBlocker?.key).toBe("definition");
  repo.records.save("job", "a", job("a", "lab-backtest", frozen));
  repo.records.save(
    "job",
    "wrong",
    job("wrong", "lab-backtest", { ...frozen, costScenario: "double-cost" }),
  );
  expect(inspect().primaryBlocker?.key).toBe("comparison");
  repo.records.save(
    "job",
    "b",
    job("b", "lab-backtest", {
      ...frozen,
      request: { ...request, strategies: [{ ...strategy, id: "peer" }] },
    }),
  );
  repo.saveState("strategy:" + strategy.id + ":1", { live: true });
  const d = inspect();
  expect(d.lifecycleGates.map((g) => g.label)).toEqual([
    "定义冻结",
    "回测证据",
    "同口径对比",
    "纸面前推",
    "影子前推",
    "晋级观察",
  ]);
  expect(d.lifecycleGates.map((g) => g.status)).toEqual([
    "passed",
    "passed",
    "passed",
    "blocked",
    "pending",
    "pending",
  ]);
  expect(d.primaryBlocker?.stage).toBe(4);
  expect(d.liveSwitch.enabled).toBe(true);
  expect(strategyLabDetail(strategy.id, 2, repo).primaryBlocker?.key).toBe(
    "definition",
  );
});

it("compares both verified frozen formats with common metrics and reports the dates, pool and costs that differ", () => {
  const a = job("a", "lab-backtest", frozen);
  const b = job("b", "strategy-center", {
    version: "strategy-center-input-1",
    input: {
      ...window,
      initial: 50,
      start: "2026-10-01",
      strategyId: "other",
      symbol: "sz000001",
    },
    strategyBuildHash: "build",
    sourceHash: "other",
    engineVersion: "old",
  });
  const load = (id: string) => (id === "a" ? a : b);
  const [left, right] = strategyLabCompareRuns(["a", "b"], load);
  expect(left).toMatchObject({
    id: "a",
    strategyVersion: 1,
    symbolCount: 1,
    initial: 100,
    costScenario: "base",
  });
  expect(right).toMatchObject({
    id: "b",
    strategyVersion: null,
    symbolCount: 1,
    initial: 50,
    costScenario: null,
  });
  expect(left?.metrics.totalReturn.value).toBeCloseTo(0.1);
  expect(right?.metrics.totalReturn.value).toBeCloseTo(1.2);
  expect(right?.basisWarnings).toEqual(
    expect.arrayContaining([
      "策略版本号未冻结",
      "证券池不同",
      "起止日期不同",
      "费用情景不同",
      "初始资金不同",
    ]),
  );
  expect(() =>
    strategyLabCompareRuns(["a"], () => ({ ...a, status: "running" })),
  ).toThrow("已完成");
  expect(() =>
    strategyLabCompareRuns(["a"], () => ({
      ...a,
      result: { ...(a.result as object), inputHash: "changed" },
    })),
  ).toThrow("哈希不匹配");
});
