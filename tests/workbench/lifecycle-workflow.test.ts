import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsSchema } from "~/lib/domain";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";
import { migrate } from "~/server/db/migrations";
import { AlertRepository } from "~/server/db/alert-repository";
import { PaperRepository } from "~/server/db/paper-repository";
import { registerPaperCandidates } from "~/server/paper/registration";
import {
  paperShadowScanning,
  enablePaperShadowScanning,
} from "~/server/paper/shadow-scanning";
import { createAlertPlan, previewAlertPlan } from "~/server/alerts/plans";
import { planExposure } from "~/server/alerts/plan-exposure";
import { equityDailyReadiness } from "~/server/alerts/readiness";
import { publicDataStatus } from "~/server/data-sources/binance/public-data-store";
import { put, dataDirectory } from "~/server/db";

let db: Database.Database, repo: AlertRepository;
const now = Date.parse("2026-11-13T17:00:00+08:00");
const config = settingsSchema.parse({
  alerts: { capital: { "cn-equity": 100000, crypto: 100000 } },
});
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new AlertRepository(db);
});
afterEach(() => db.close());

function candidate() {
  const strategy = {
    id: "l0-workflow-plan",
    version: 1,
    market: "cn-equity" as const,
    period: "day" as const,
    universe: { kind: "symbols" as const, symbols: ["sh600000"] },
    entry: { kind: "constant" as const, value: true },
    exit: { stop: { kind: "fixed", fraction: 0.1 }, takeProfit: 0.3 },
    sizing: { kind: "weight" as const, weight: 1 },
    sleeve: "swing",
  };
  const identity = {
    strategyId: strategy.id,
    version: 1,
    market: strategy.market,
    symbol: "sh600000",
    bar: "2026-11-13",
  };
  const e: AlertEvent = {
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
    reason: "fixture",
    source: "fixture",
    wouldSend: false,
    outcomes: [],
  };
  repo.record(strategy, e);
  return {
    eventKey: e.key,
    stages: [10],
    stop: 9,
    target: 13,
    expiresAt: "2026-11-20T00:00:00Z",
  };
}
function snapshot(at: number, id = "exposure") {
  repo.saveState(id, [
    { market: "cn-equity", sleeve: "__checked__", value: 0, at },
  ]);
}
it("requires one explicit versioned confirmation for paper shadow scanning and leaves live, frozen accounts and subscriptions alone", () => {
  const paper = new PaperRepository(db);
  registerPaperCandidates(paper, now);
  const original = paper.ids().map((id) => paper.account(id));
  const before = paperShadowScanning(repo);
  expect(before.pending).toBe(5);
  expect(repo.watchedStrategies()).toHaveLength(0);
  expect(() =>
    enablePaperShadowScanning(
      { revision: before.revision, confirmed: false as true },
      repo,
      now,
    ),
  ).toThrow();
  const first = before.candidates[0]!;
  repo.saveState(`strategy:${first.id}:${first.version}`, { live: true });
  expect(() =>
    enablePaperShadowScanning(
      { revision: before.revision, confirmed: true },
      repo,
      now,
    ),
  ).toThrow("重新核对");
  expect(repo.watchedStrategies()).toHaveLength(1);
  const current = paperShadowScanning(repo);
  const result = enablePaperShadowScanning(
    { revision: current.revision, confirmed: true },
    repo,
    now,
  );
  expect(result.pending).toBe(0);
  expect(repo.watchedStrategies()).toHaveLength(5);
  expect(repo.liveStrategies()).toHaveLength(1);
  expect(paper.ids().map((id) => paper.account(id))).toEqual(original);
  expect(repo.subscriptions()).toEqual([]);
  expect(repo.records.all("delivery")).toEqual([]);
  expect(repo.records.all("strategy-governance")).toHaveLength(4);
});
it("evening and weekend plans use the completed-close snapshot; midday or future markers are rejected and intraday still expires", () => {
  const input = candidate();
  snapshot(Date.parse("2026-11-13T12:00:00+08:00"));
  expect(() => previewAlertPlan(input, config, now, repo)).toThrow("过期");
  snapshot(now, "exposure-close:cn-equity");
  const saturday = Date.parse("2026-11-14T20:00:00+08:00");
  const plan = previewAlertPlan(input, config, saturday, repo);
  expect(plan.positionSnapshot).toEqual({
    at: now,
    basis: "post-close",
    unassignedValue: 0,
  });
  const morning = Date.parse("2026-11-16T10:00:00+08:00");
  snapshot(morning);
  expect(planExposure("cn-equity", config, morning + 600001, repo).valid).toBe(
    false,
  );
  snapshot(morning + 1);
  expect(planExposure("cn-equity", config, morning, repo).valid).toBe(false);
});
it("a delayed next-morning close scan is a valid post-close snapshot", () => {
  const input = candidate(),
    checkedAt = Date.parse("2026-11-16T08:30:00+08:00");
  snapshot(checkedAt, "exposure-close:cn-equity");
  expect(
    previewAlertPlan(input, config, checkedAt, repo).positionSnapshot.at,
  ).toBe(checkedAt);
});
it("unassigned holdings consume market capital and caps without consuming every sleeve; null valuations still block", () => {
  const input = candidate();
  snapshot(now);
  const p: AccountPosition = {
    id: "imported",
    account: "broker",
    kind: "real",
    market: "cn-equity",
    currency: "CNY",
    symbol: "sh600001",
    sleeve: "未知",
    industry: "银行",
    quantity: 1000,
    cost: 95,
    price: 95,
    value: 95000,
    stop: null,
    at: "2026-11-13",
    strategyId: null,
    strategyVersion: null,
    reasons: [],
  };
  const configured = settingsSchema.parse({
    ...config,
    accountReview: {
      portfolioLimits: { enabled: false },
      caps: [
        {
          market: "cn-equity",
          dimension: "market",
          key: "cn-equity",
          fraction: 1,
        },
        {
          market: "cn-equity",
          dimension: "sleeve",
          key: "swing",
          fraction: 0.5,
        },
      ],
    },
  });
  const plan = createAlertPlan(input, configured, now, repo, {
    positions: [p],
    assertCurrent: () => {},
  });
  expect(plan.quantity).toBe(400);
  expect(
    plan.quantity * plan.entry + (plan.sizingAudit?.estimatedFees ?? 0),
  ).toBeLessThanOrEqual(5000);
  expect(plan.positionSnapshot?.unassignedValue).toBe(95000);
  expect(plan.exposureAudit?.violations).toEqual([]);
  repo.closePlan(plan.id, "cancelled");
  expect(() =>
    previewAlertPlan(input, config, now, repo, [{ ...p, value: null }]),
  ).toThrow("估值未核对");
});
it("readiness requires the expected local daily date and that date's receipt, including weekends", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "tdx-readiness");
  const dir = join(root, "vipdoc/sh/lday");
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(20261113, 0);
  [1000, 1100, 900, 1050].forEach((n, i) => bytes.writeUInt32LE(n, 4 + i * 4));
  bytes.writeFloatLE(10000, 20);
  bytes.writeUInt32LE(1000, 24);
  await writeFile(join(dir, "sh000300.day"), bytes);
  const configured = settingsSchema.parse({
    ...config,
    tdxRoot: root,
    calendar: ["2026-11-12", "2026-11-13", "2026-11-16"],
  });
  put("settings", "settings", configured);
  const weekend = Date.parse("2026-11-14T20:00:00+08:00");
  expect(await equityDailyReadiness(configured, weekend)).toMatchObject({
    localDate: "2026-11-13",
    expectedDate: "2026-11-13",
    receipt: false,
    ready: false,
  });
  await writeFile(
    join(dataDirectory(), "download-2026-11-13-close.json"),
    JSON.stringify({
      date: "2026-11-13",
      phase: "close",
      completedAt: now,
      exitCode: 0,
    }),
  );
  expect(await equityDailyReadiness(configured, weekend)).toMatchObject({
    ready: true,
  });
  expect(
    await equityDailyReadiness(
      configured,
      Date.parse("2026-11-16T17:00:00+08:00"),
    ),
  ).toMatchObject({
    localDate: "2026-11-13",
    expectedDate: "2026-11-16",
    ready: false,
  });
});
it("crypto scan readiness checks only 1d/4h current completed boundaries and surfaces gaps", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "crypto-readiness");
  const at = Date.parse("2026-11-16T10:00:00Z");
  for (const symbol of ["BTCUSDT", "ETHUSDT"])
    for (const interval of ["1d", "4h"]) {
      const dir = join(root, "data/spot/monthly/klines", symbol, interval);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          version: 1,
          symbol,
          interval,
          files: [
            {
              path: `${symbol}-${interval}.zip`,
              sha256: "a".repeat(64),
              rows: interval === "1d" ? 15 : 92,
              start:
                interval === "1d" ? "2026-11-01" : "2026-11-01T04:00:00+00:00",
              end:
                interval === "1d" ? "2026-11-15" : "2026-11-16T08:00:00+00:00",
              verifiedAt: new Date(at).toISOString(),
              bytes: 100,
              quarantined: [],
            },
          ],
          rows: 10,
          start: interval === "1d" ? "2026-11-01" : "2026-11-01T04:00:00+00:00",
          end: interval === "1d" ? "2026-11-15" : "2026-11-16T08:00:00+00:00",
          gaps: [],
          bytes: 0,
          updatedAt: new Date(at).toISOString(),
          status: "ready",
          missing: [],
        }),
      );
    }
  const status = await publicDataStatus(root, at);
  expect(status.needsBackfill).toBe(true);
  expect(status.alertReadiness).toHaveLength(4);
  expect(status.alertReadiness.every((s) => s.ready)).toBe(true);
  const path = join(root, "data/spot/monthly/klines/BTCUSDT/4h/manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    gaps: { from: number; to: number; missingBars: number }[];
  };
  manifest.gaps.push({
    from: at - 28800000,
    to: at - 14400000,
    missingBars: 1,
  });
  await writeFile(path, JSON.stringify(manifest));
  expect(
    (await publicDataStatus(root, at)).alertReadiness.find(
      (s) => s.symbol === "BTCUSDT" && s.interval === "4h",
    )?.ready,
  ).toBe(false);
});
it("a fresh live tail cannot hide an inter-file outage, quarantine or unreported internal hole", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "crypto-coverage-gap"),
    dir = join(root, "data/spot/monthly/klines/BTCUSDT/1d"),
    at = Date.parse("2026-11-16T10:00:00Z");
  await mkdir(dir, { recursive: true });
  const file = (start: string, end: string, rows: number) => ({
    path: `${start}.csv`,
    sha256: "a".repeat(64),
    rows,
    start,
    end,
    verifiedAt: new Date(at).toISOString(),
    bytes: 100,
    quarantined: [] as { line: number; openTime: number; reason: string }[],
  });
  const manifest = {
    version: 1,
    symbol: "BTCUSDT",
    interval: "1d",
    files: [
      file("2026-11-10", "2026-11-10", 1),
      file("2026-11-12", "2026-11-15", 4),
    ],
    rows: 5,
    start: "2026-11-10",
    end: "2026-11-15",
    gaps: [] as { from: number; to: number; missingBars: number }[],
    bytes: 200,
    updatedAt: new Date(at).toISOString(),
    status: "ready",
    missing: [],
  };
  const status = async () => {
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    return (await publicDataStatus(root, at)).alertReadiness.find(
      (s) => s.symbol === "BTCUSDT" && s.interval === "1d",
    )!;
  };
  expect(await status()).toMatchObject({ ready: false, gaps: 1 });
  manifest.files.push(file("2026-11-11", "2026-11-11", 1));
  expect(await status()).toMatchObject({ ready: true, gaps: 0 });
  manifest.files[0]!.quarantined.push({
    line: 2,
    openTime: Date.parse("2026-11-11"),
    reason: "source anomaly",
  });
  manifest.gaps.push({
    from: Date.parse("2026-11-11"),
    to: Date.parse("2026-11-11"),
    missingBars: 1,
  });
  expect(await status()).toMatchObject({
    ready: false,
    gaps: 1,
    quarantinedRows: 1,
  });
  manifest.files[0]!.quarantined = [];
  manifest.gaps = [];
  manifest.files[1]!.rows = 3;
  expect(await status()).toMatchObject({ ready: false, coverageKnown: false });
});
it("readiness lists only unresolved data-gap states in newest-first order", () => {
  repo.saveState("data-gap:crypto:BTCUSDT", { at: now, reason: "missing 4h" });
  repo.saveState("data-gap:crypto:ETHUSDT", {
    at: now + 1,
    reason: "missing daily",
  });
  repo.saveState("data-gap:cn-equity:sh600000", {
    at: now + 2,
    reason: "old error",
    resolved: true,
  });
  repo.saveState("runtime", { at: now + 3, reason: "other state" });
  expect(repo.dataGaps().map((g) => g.id)).toEqual([
    "crypto:ETHUSDT",
    "crypto:BTCUSDT",
  ]);
});
