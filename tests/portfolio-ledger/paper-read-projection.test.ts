import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { paperRouter } from "~/server/api/routers/paper";
import { executePaperTick } from "~/server/paper/service";
import { registerPaperCandidates } from "~/server/paper/registration";
import { saveSettings } from "~/server/infra/settings";
import { settingsSchema } from "~/lib/domain";
import { StrategyRepository } from "~/server/db/strategy-repository";
import {
  ForwardReferenceRepository,
  forwardSizingPolicyHash,
} from "~/server/db/forward-reference-repository";
import { assessPaperPortfolio } from "~/server/paper/assessment";
import {
  paperAccountRead,
  paperAccountsRead,
  currentPaperAssessment,
} from "~/server/paper/read-projection";
import type {
  FrozenCandidate,
  PaperAccount,
  PaperState,
} from "~/server/paper/model";
import frozen from "~/server/data/paper-candidates.json";

const runtime = vi.hoisted(() => ({ hash: "d".repeat(64), available: true }));
vi.mock("~/server/research/forward-identity", () => ({
  forwardExecutionBuildHash: () => {
    if (!runtime.available) throw new Error("missing manifest");
    return runtime.hash;
  },
}));
const databases: Database.Database[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2025-12-31T00:00:00Z");
  runtime.hash = "d".repeat(64);
  runtime.available = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});

it("registers only an explicit production account, advances it on local bars, and reads the latest order through the API", async () => {
  vi.stubEnv("VITEST", undefined);
  const api = paperRouter.createCaller({ headers: new Headers() });
  const repo = new PaperRepository();
  expect(
    await executePaperTick({ type: "paper-tick", now: Date.now() }),
  ).toEqual([]);
  expect(() => registerPaperCandidates(repo, Date.now())).toThrow("已停用");
  expect("registerPaperCandidates" in paperRouter._def.procedures).toBe(false);
  const candidate = {
    id: "explicit-cn",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  } as const;
  const input = {
    name: "生产纸面 QA",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    initial: 20000,
    candidates: [strategyObjectSchema.parse(candidate)],
  } as const;
  const raw = { ...input, candidates: [...input.candidates] };
  await expect(
    api.registerPaperAccount({ ...raw, candidates: [] }),
  ).rejects.toThrow();
  await expect(
    api.registerPaperAccount({
      ...raw,
      candidates: [{ ...raw.candidates[0]!, version: 0 }],
    }),
  ).rejects.toThrow();
  await expect(
    api.registerPaperAccount({
      ...raw,
      candidates: [raw.candidates[0]!, raw.candidates[0]!],
    }),
  ).rejects.toThrow("id 重复");
  await expect(
    api.registerPaperAccount({ ...raw, market: "crypto", currency: "USDT" }),
  ).rejects.toThrow("市场或 sleeve");
  await expect(
    api.registerPaperAccount({ ...raw, sleeve: "other" }),
  ).rejects.toThrow("市场或 sleeve");
  await expect(
    api.registerPaperAccount({ ...raw, currency: "USDT" }),
  ).rejects.toThrow("币种与市场不符");
  expect(await api.paperAccounts()).toEqual([]);
  const account = await api.registerPaperAccount(raw);
  expect(account).toMatchObject({
    ...raw,
    candidates: [{ strategy: raw.candidates[0] }],
    startedAt: Date.now(),
    lastBar: null,
    mirror: { venue: "off" },
  });
  expect(
    new StrategyRepository(repo.db).strategy(candidate.id, candidate.version),
  ).toEqual(raw.candidates[0]);
  expect(
    repo.db
      .prepare(
        "SELECT kind FROM records WHERE kind IN ('paper-forward-reference','account-expectation-status') ORDER BY kind",
      )
      .all(),
  ).toEqual([
    { kind: "account-expectation-status" },
    { kind: "paper-forward-reference" },
  ]);
  await expect(api.registerPaperAccount(raw)).rejects.toThrow("账户名称已存在");
  await expect(
    api.registerPaperAccount({ ...raw, name: "另一账户" }),
  ).rejects.toThrow("候选策略已登记");
  await api.savePaperSettings({
    grouping: "sleeve",
    equityInitial: 12345,
    cryptoInitial: 100000,
  });
  expect((await api.paperAccount(account.id)).initial).toBe(20000);

  const dates = ["2026-01-05", "2026-01-06"];
  const root = join(process.env.QUANT_DATA_DIR!, "paper-tdx");
  mkdirSync(join(root, "vipdoc/sh/lday"), { recursive: true });
  mkdirSync(join(root, "T0002/hq_cache"), { recursive: true });
  const daily = Buffer.concat(
    dates.map((date) => {
      const row = Buffer.alloc(32);
      row.writeUInt32LE(Number(date.replaceAll("-", "")), 0);
      row.writeUInt32LE(1000, 4);
      row.writeUInt32LE(1010, 8);
      row.writeUInt32LE(990, 12);
      row.writeUInt32LE(1000, 16);
      row.writeFloatLE(1000000, 20);
      row.writeUInt32LE(100000, 24);
      return row;
    }),
  );
  for (const symbol of ["sh000906", "sh600000"])
    writeFileSync(join(root, "vipdoc/sh/lday", `${symbol}.day`), daily);
  writeFileSync(join(root, "T0002/hq_cache/gbbq"), Buffer.alloc(4));
  saveSettings(settingsSchema.parse({ tdxRoot: root, calendar: dates }));
  for (const [time, status] of [
    ["2026-01-06T00:00:00Z", "pending"],
    ["2026-01-07T00:00:00Z", "filled"],
  ] as const) {
    vi.setSystemTime(time);
    expect(
      await executePaperTick({ type: "paper-tick", now: Date.now() }),
    ).toMatchObject([{ id: account.id, error: null }]);
    expect(
      await api.paperFacts({ id: account.id, kind: "order" }),
    ).toMatchObject({
      total: 1,
      items: [{ id: "1", date: dates[0], value: { status } }],
    });
  }
  expect(await api.paperAccount(account.id)).toMatchObject({
    name: raw.name,
    lastBar: dates[1],
  });
  expect(
    await api.paperFacts({ id: account.id, kind: "order-event" }),
  ).toMatchObject({
    total: 1,
    items: [
      { value: { orderId: 1, sequence: 2, order: { status: "filled" } } },
    ],
  });
});
function fixture(backtestPassed = true) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db);
  const repo = new PaperRepository(db);
  const strategy = strategyObjectSchema.parse({
    id: "read-account",
    version: 2,
    market: "crypto",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["BTCUSDT"] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  });
  new StrategyRepository(db).saveStrategy(strategy);
  const bars = Array.from({ length: 120 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 1000,
    amount: 10000,
  }));
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 100000,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map((bar) => bar.date),
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "tiny read fixture",
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const references = new ForwardReferenceRepository(db);
  const reference = references.freeze({
    strategy,
    inputHash: "a".repeat(64),
    resultHash: "b".repeat(64),
    buildHash: runtime.hash,
    initial: request.initial,
    sizingPolicyHash: forwardSizingPolicyHash(request),
    backtestPassed,
    method: "lifecycle-2",
    purpose: "preregistered",
    slippageBasis: "paper-model",
    source: "tiny read fixture",
    distribution: {
      days: Array.from({ length: 240 }, (_, i) => ({
        date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
        return: 0,
        signals: 0,
      })),
      tradeReturns: [],
      slippageBps: [],
    },
  });
  const account: PaperAccount = {
    id: "paper:read-account",
    market: "crypto",
    currency: "USDT",
    sleeve: "swing",
    startedAt: Date.parse("2026-01-01T00:00:00Z"),
    initial: request.initial,
    candidates: [
      { ...frozen.candidates[0], strategy } as unknown as FrozenCandidate,
    ],
    mirror: { venue: "off" },
    mirrorRevision: "fixture",
    revision: 0,
    lastBar: request.end,
    lastRun: null,
    error: null,
    summary: null,
  };
  references.bindPaper(account.id, strategy, account.startedAt);
  const state: PaperState = {
    request,
    result: runPortfolio(request),
    benchmark: bars,
    decisions: bars.map((bar) => ({
      strategyId: strategy.id,
      symbol: "BTCUSDT",
      date: bar.date,
      entry: false,
      exit: false,
      stop: null,
      observedAt: Date.parse(bar.date) + 86400000 + 60000,
      source: "fixed clock",
    })),
  };
  vi.setSystemTime("2026-05-01T12:00:00Z");
  account.summary = {
    return: 0,
    drawdown: 0,
    trades: 0,
    winRate: null,
    benchmarkReturn: 0,
    signals: 0,
    days: 120,
    assessment: assessPaperPortfolio(account, state, Date.now(), {
      reference,
      buildHash: runtime.hash,
      calendar: [],
    }),
  };
  repo.create(account);
  return { repo, account, state };
}

it("projects a real same-account conformance without reading state or modifying financial history", () => {
  const f = fixture();
  const bytes = f.repo.db.prepare("SELECT payload FROM paper_accounts").get();
  const prepare = vi.spyOn(f.repo.db, "prepare");
  const list = paperAccountsRead(f.repo);
  const detail = paperAccountRead(f.account.id, f.repo);
  expect(detail.currentAssessment).toMatchObject({
    verdict: "conforming",
    eligible: true,
    days: 120,
  });
  expect(list[0]!.currentAssessment).toEqual(detail.currentAssessment);
  expect(list[0]).not.toHaveProperty("candidates");
  expect(detail.summary).toMatchObject({ return: 0, trades: 0, days: 120 });
  expect(detail.summary).not.toHaveProperty("assessment");
  expect(
    prepare.mock.calls.every(([sql]) => !sql.includes("paper_state")),
  ).toBe(true);
  expect(f.repo.db.prepare("SELECT payload FROM paper_accounts").get()).toEqual(
    bytes,
  );
});

it("hides legacy positive recommendations while retaining the original record", () => {
  const f = fixture();
  f.account.summary!.assessment = {
    recommendation: "OLD POSITIVE LIVE RECOMMENDATION",
    eligible: true,
    reasons: [],
  };
  f.repo.save(f.account, 0);
  const detail = paperAccountRead(f.account.id, f.repo);
  expect(detail.currentAssessment).toMatchObject({
    verdict: "insufficient",
    eligible: false,
  });
  expect(JSON.stringify(detail)).not.toContain("OLD POSITIVE");
  expect(
    f.repo.account(f.account.id)!.summary!.assessment!.recommendation,
  ).toContain("OLD POSITIVE");
});

it.each([
  "build",
  "reference",
  "definition",
  "version",
  "runtime",
  "missing-conformance",
])("rejects %s evidence mismatch", (mode) => {
  const f = fixture();
  if (mode === "build") runtime.hash = "e".repeat(64);
  if (mode === "reference")
    f.account.summary!.assessment!.referenceHash = "f".repeat(64);
  if (mode === "definition")
    f.account.candidates[0]!.strategy.entry = { kind: "constant", value: true };
  if (mode === "version") f.account.candidates[0]!.strategy.version = 3;
  if (mode === "runtime") runtime.available = false;
  if (mode === "missing-conformance")
    delete f.account.summary!.assessment!.conformance;
  f.repo.save(f.account, 0);
  expect(paperAccountsRead(f.repo)[0]!.currentAssessment).toMatchObject({
    verdict: "insufficient",
    eligible: false,
  });
});

it("does not borrow conformance from another account with the same strategy version", () => {
  const f = fixture();
  f.repo.create({ ...f.account, id: "paper:unbound-same-version" });
  const rows = paperAccountsRead(f.repo);
  expect(
    rows.find((a) => a.id === f.account.id)!.currentAssessment.eligible,
  ).toBe(true);
  expect(
    rows.find((a) => a.id !== f.account.id)!.currentAssessment,
  ).toMatchObject({
    verdict: "insufficient",
    eligible: false,
    reasons: expect.arrayContaining(["missing-same-account-forward-reference"]),
  });
});

it("requires backtest AND conforming and treats contradictory persisted eligibility as insufficient", () => {
  const f = fixture(false);
  expect(currentPaperAssessment(f.account, f.repo)).toMatchObject({
    verdict: "conforming",
    eligible: false,
  });
  f.account.summary!.assessment!.eligible = true;
  expect(currentPaperAssessment(f.account, f.repo)).toMatchObject({
    verdict: "insufficient",
    eligible: false,
    reasons: expect.arrayContaining(["inconsistent-current-paper-conformance"]),
  });
});
