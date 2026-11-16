import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import { migrate } from "~/server/db/migrations";
import { DeliveryStore } from "~/server/db/delivery-store";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { AccountReviewRepository } from "~/server/db/account-review-repository";
import { AlertRepository } from "~/server/db/alert-repository";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "~/lib/research/evidence/delivery-import";
import {
  loadAccountBook,
  linkAccountTrade,
  accountAttribution,
} from "~/server/portfolio/account-workspace-service";
import {
  accountLinkSuggestions,
  confirmAccountLinks,
  saveTradeJournal,
  accountExecutionQuality,
  accountWeeklyReview,
} from "~/server/portfolio/account-review-service";
import {
  publishAccountExpectation,
  freezeMatchingAccountExpectation,
} from "~/server/portfolio/account-expectation-service";
import { monthlyAccountReview } from "~/server/portfolio/account-monthly-review";
import { reviewTradeFingerprint } from "~/lib/portfolio/account-review";
import { settingsSchema, type Bar } from "~/lib/domain";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import { forwardDefinitionHash } from "~/server/db/forward-reference-repository";
const connections: Database.Database[] = [];
afterEach(() => connections.splice(0).forEach((d) => d.close()));
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const dates = Array.from({ length: 80 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
const bars: Bar[] = dates.map((date) => ({
  date,
  open: 10,
  high: 11,
  low: 7,
  close: date === "2026-01-06" ? 8 : 10,
  volume: 10000,
  amount: 100000,
}));
const now = Date.parse("2026-02-01T12:00:00Z");
function seed() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new AccountWorkspaceRepository(db),
    alerts = new AlertRepository(db),
    review = new AccountReviewRepository(db);
  const raw = readFileSync("tests/fixtures/delivery/r3b-account.csv"),
    table = parseDeliveryTable(raw),
    parsed = importDeliveryTable(table);
  const imported = new DeliveryStore(db).commitImport({
    account: "real",
    source: "generic",
    fileHash: digest(raw.toString()),
    fileName: "fixed.csv",
    importedAt: 1,
    parsed,
    rawRows: table.rows,
    sourceHeader: table.header,
  });
  const strategy: StrategyObjectInput = {
    id: "review-fixture",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: { stop: { kind: "fixed", fraction: 0.1 } },
    sizing: { kind: "weight", weight: 0.1 },
  };
  alerts.strategies.saveStrategy(strategy);
  const event: AlertEvent = {
    key: "",
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity",
    symbol: "sh600000",
    bar: "2026-01-02",
    type: "entry",
    price: 9.5,
    stop: 9,
    target: null,
    sleeve: "swing",
    observedAt: Date.parse("2026-01-02T00:00:00Z"),
    mode: "shadow",
    status: "shadow",
    reason: "fixed",
    source: "fixture",
    wouldSend: false,
    outcomes: [],
  };
  event.key = alertKey(event);
  alerts.record(strategy, event);
  alerts.savePlan(
    {
      id: "review-plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol: "sh600000",
      sleeve: "swing",
      triggerKey: event.key,
      entry: 10,
      stop: 9,
      target: null,
      quantity: 200,
      tranches: 1,
      expiresAt: "2026-01-06T00:00:00Z",
      status: "closed",
      createdAt: event.observedAt,
      rationale: "固定交易假设",
      tags: ["fixture"],
    },
    event.observedAt,
  );
  const config = settingsSchema.parse({
    alerts: { capital: { "cn-equity": 2000 } },
  });
  const context = {
    today: "2026-02-01",
    calendar: dates,
    calendarSource: "fixed",
    evidence: () => ({
      events: [],
      coverageEnd: "2026-12-31",
      source: "fixed",
    }),
  };
  const load = () =>
    loadAccountBook(repo, config, now, { context, bars: { sh600000: bars } });
  return { db, repo, alerts, review, strategy, event, config, load, imported };
}
it("the fixture month closes alert/plan/fill/stop execution quality, journal, unplanned rounds and manual pause/reduce suggestions", async () => {
  const s = seed();
  let book = await s.load();
  const buy = book.trades.find(
    (t) => t.side === "buy" && t.date === "2026-01-05",
  )!;
  const suggestions = accountLinkSuggestions(book);
  const row = suggestions.items.find((r) => r.trade.id === buy.id)!;
  expect(row.plans.map((p) => p.id)).toEqual(["review-plan"]);
  const sourceBefore = new DeliveryStore(s.db).fills();
  const sell = book.trades.find((t) => t.side === "sell")!;
  const sellRow = suggestions.items.find((r) => r.trade.id === sell.id)!;
  expect(sellRow.plans.map((p) => p.id)).toEqual(["review-plan"]);
  expect(
    confirmAccountLinks(
      {
        confirmed: true,
        factVersion: book.facts.version,
        links: [
          {
            tradeId: buy.id,
            fingerprint: row.fingerprint,
            planId: "review-plan",
          },
          {
            tradeId: sell.id,
            fingerprint: sellRow.fingerprint,
            planId: "review-plan",
          },
        ],
      },
      book,
      s.repo,
    ),
  ).toEqual({ saved: 2 });
  book = await s.load();
  const linkedSell = book.trades.find((t) => t.id === sell.id)!;
  saveTradeJournal(
    {
      tradeId: sell.id,
      fingerprint: reviewTradeFingerprint(linkedSell),
      factVersion: book.facts.version,
      exitReason: "stop",
      note: "按计划核对退出",
      tags: ["止损复核"],
    },
    book,
    s.repo,
  );
  expect(new DeliveryStore(s.db).fills()).toEqual(sourceBefore);
  const task = {
    key: "position",
    symbol: "sh600000",
    market: "cn-equity",
    account: "real",
    kind: "real",
    oldStop: 9,
    newStop: 9.5,
    reason: "fixed",
    dueDate: "2026-01-07",
    dueAt: "2026-01-07T01:00:00Z",
    sourcePlanId: "review-plan",
    strategyId: s.strategy.id,
    version: 1,
    status: "adjust",
    bar: "2026-01-06",
  };
  s.alerts.saveState("protection-snapshot:early", {
    task,
    backupStop: 9,
    bars: 2,
    high: 10.55,
    bindingAt: 1,
    observedAt: Date.parse("2026-01-06T17:00:00+08:00"),
  });
  s.alerts.saveState("protection-snapshot:future", {
    task: { ...task, newStop: 100 },
    backupStop: 9.5,
    bars: 3,
    high: 110,
    bindingAt: 1,
    observedAt: Date.parse("2026-01-08"),
  });
  book = await s.load();
  const quality = accountExecutionQuality(
    book,
    "2026-01-01",
    "2026-02-01",
    s.review,
    now,
  );
  const exit = quality.rows.find((r) => r.tradeId === sell.id)!;
  expect(exit.stop).toBe(9.5);
  expect(exit.stopToExitBps).toBeCloseTo((8 / 9.5 - 1) * 10000);
  expect(exit.exitReason).toBe("stop");
  expect(quality.rows.find((r) => r.tradeId === buy.id)?.planToFillBps).toBe(0);
  s.alerts.saveState("protection-snapshot:needs-review", {
    task: { ...task, status: "needs-review", newStop: null },
    backupStop: 9.5,
    bars: 2,
    high: 10.55,
    bindingAt: 1,
    observedAt: Date.parse("2026-01-06T18:00:00+08:00"),
  });
  const unavailable = accountExecutionQuality(
    book,
    "2026-01-01",
    "2026-02-01",
    s.review,
    now,
  ).rows.find((r) => r.tradeId === sell.id)!;
  expect(unavailable.stop).toBeNull();
  expect(unavailable.stopToExitBps).toBeNull();
  expect(unavailable.initialStop).toBe(9);
  expect(unavailable.stopBasis).toContain("需重核");
  const monthly = monthlyAccountReview(book, "2026-01");
  expect(monthly.items.find((i) => i.kind === "stop")?.count).toBe(1);
  expect(monthly.rounds).toMatchObject({
    planned: 1,
    unplanned: 1,
    unknownOpening: 0,
  });
  expect(monthly.unlinked).toBe(1);
  s.repo.freezeExpectation({
    strategyId: s.strategy.id,
    version: 1,
    strategyHash: digest(s.alerts.strategies.strategy(s.strategy.id, 1)),
    source: "synthetic cohort fixture",
    horizon: 20,
    basis: "raw-entry-20-close",
    samples: Array(40).fill(0.5),
    excluded: 0,
    capturedAt: 1,
    limitations: ["synthetic only"],
  });
  s.alerts.saveState(`strategy:${s.strategy.id}:1`, {
    live: true,
    revision: "fixed",
  });
  book = await s.load();
  book.facts.events = Array.from({ length: 30 }, (_, i) => ({
    ...s.event,
    key: i ? `fixture-${i}` : s.event.key,
    outcomes: [
      {
        horizon: 20,
        settled: true,
        entryDate: dates[0]!,
        exitDate: dates[19]!,
        entry: 10,
        exit: 8,
        returnPct: -20,
        action: "区间无除权" as const,
        reasons: [],
        calendarSource: "fixed",
        actionSource: "fixed",
      },
    ],
  }));
  const weekly = accountWeeklyReview(book, "2026-01-05", s.repo, now);
  expect(weekly.suggestions.some((r) => r.action === "pause-live")).toBe(true);
  expect(weekly.suggestions.some((r) => r.action === "reduce")).toBe(true);
  expect(
    s.alerts.state<{ live: boolean }>(`strategy:${s.strategy.id}:1`)?.live,
  ).toBe(true);
  expect(
    freezeMatchingAccountExpectation(s.strategy.id, 1, s.repo, {
      inputHash: digest("different chosen run"),
    }).status,
  ).toBe("unavailable");
  const mismatchBook = await s.load();
  mismatchBook.facts.events = book.facts.events;
  const mismatch = accountAttribution(mismatchBook, s.strategy.id, 1)[0]!;
  expect(mismatch.expected).toBeNull();
  expect(mismatch.flagged).toBe(false);
  expect(mismatch.expectationReason).toContain("未匹配");
  expect(s.repo.expectation(s.strategy.id, 1)).not.toBeNull();
  expect(
    accountWeeklyReview(
      mismatchBook,
      "2026-01-05",
      s.repo,
      now,
    ).suggestions.some((r) => r.action === "pause-live"),
  ).toBe(false);
});
it("ambiguous matches stay unselected and stale facts/fingerprints roll the entire batch back", async () => {
  const s = seed();
  let book = await s.load();
  const plan = s.alerts.strategies.plan("review-plan")!;
  s.alerts.savePlan({ ...plan, id: "second-plan" }, 1);
  book = await s.load();
  const rows = accountLinkSuggestions(book).items;
  const first = rows.find((r) => r.trade.date === "2026-01-05")!;
  expect(first.ambiguous).toBe(true);
  expect(first.plans).toHaveLength(2);
  expect(() =>
    confirmAccountLinks(
      {
        confirmed: true,
        factVersion: book.facts.version,
        links: [
          { tradeId: first.trade.id, fingerprint: "changed", planId: plan.id },
        ],
      },
      book,
      s.repo,
    ),
  ).toThrow("未保存任何关联");
  expect(s.repo.snapshot().links).toHaveLength(0);
  s.review.records.save("fixture", "changed-fact", {});
  expect(() =>
    confirmAccountLinks(
      {
        confirmed: true,
        factVersion: book.facts.version,
        links: [
          {
            tradeId: first.trade.id,
            fingerprint: first.fingerprint,
            planId: plan.id,
          },
        ],
      },
      book,
      s.repo,
    ),
  ).toThrow("账户事实已更新");
  expect(s.repo.snapshot().links).toHaveLength(0);
});
it("late and expired unexecuted alerts are disclosed without inventing execution prices", async () => {
  const s = seed();
  const other = {
    ...s.event,
    key: "",
    bar: "2026-01-09",
    status: "missed" as const,
    observedAt: Date.parse("2026-01-12"),
  };
  other.key = alertKey(other);
  s.alerts.record(s.strategy, other);
  const book = await s.load();
  const quality = accountExecutionQuality(
    book,
    "2026-01-01",
    "2026-02-01",
    s.review,
    now,
  );
  expect(quality.alerts.some((a) => a.status === "late")).toBe(true);
  expect(quality.alerts.find((a) => a.status === "late")).toMatchObject({
    mode: "shadow",
    wouldSend: false,
    observationOnly: true,
  });
  expect(quality.rows.every((r) => r.planEntry === null)).toBe(true);
  const cancelledBook = await s.load();
  cancelledBook.facts.plans = cancelledBook.facts.plans.map((p) => ({
    ...p,
    closeReason: "cancelled" as const,
  }));
  const skipped = accountExecutionQuality(
    cancelledBook,
    "2026-01-01",
    "2026-02-01",
    s.review,
    now,
  ).alerts.find((a) => a.alertKey === s.event.key);
  expect(skipped?.status).toBe("skipped");
});
it("automatic account cohorts use actual frozen fills/raw closes, bind source hashes and preserve the first version", () => {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new AccountWorkspaceRepository(db),
    alerts = new AlertRepository(db);
  const strategy: StrategyObjectInput = {
    id: "auto-cohort",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "dual-ma", fast: 1, slow: 2, side: "entry" },
    exit: { rule: { kind: "dual-ma", fast: 1, slow: 2, side: "exit" } },
    sizing: { kind: "weight", weight: 0.1 },
  };
  alerts.strategies.saveStrategy(strategy);
  expect(freezeMatchingAccountExpectation(strategy.id, 1, repo).status).toBe(
    "unavailable",
  );
  const raw = dates.map((date, i) => ({
    ...bars[0]!,
    date,
    open: i % 2 ? 11 : 10,
    close: i % 2 ? 11 : 10,
    high: 12,
    low: 9,
  }));
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    strategies: [strategy],
    instruments: [
      {
        symbol: "sh600000",
        market: "cn-equity",
        bars: raw,
        signalBars: raw,
        actions: [],
        execution: {
          evidence: "fixed",
          minimum: 100,
          step: 100,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 10 }],
  };
  const result = runPortfolio(request);
  expect(result.fills.some((f) => f.side === "buy")).toBe(true);
  const input = {
    strategy,
    request,
    fills: result.fills,
    inputHash: digest(request),
    resultHash: digest(result),
    buildHash: digest("synthetic complete execution identity"),
    actionCoverage: {
      sh600000: {
        from: dates[0]!,
        through: dates.at(-1)!,
        source: "fixed synthetic coverage fixture",
        hash: digest("actions-coverage-fixture"),
      },
    },
    source: "fixed raw fixture",
    limitations: ["synthetic source, not a strategy claim"],
  };
  const expectation = publishAccountExpectation(input, repo);
  expect(freezeMatchingAccountExpectation(strategy.id, 1, repo).status).toBe(
    "unavailable",
  );
  alerts.records.save(
    "strategy-qualification",
    `strategy-qualification-${strategy.id}`,
    { inputHash: input.inputHash, status: "research" },
  );
  expect(expectation.samples.length).toBeGreaterThan(0);
  expect(expectation.definitionHash).toBe(forwardDefinitionHash(strategy));
  expect(expectation.inputHash).toBe(input.inputHash);
  expect(freezeMatchingAccountExpectation(strategy.id, 1, repo)).toMatchObject({
    status: "frozen",
    expectation,
  });
  expect(publishAccountExpectation(input, repo).capturedAt).toBe(
    expectation.capturedAt,
  );
  expect(() =>
    publishAccountExpectation(
      { ...input, strategy: { ...strategy, version: 2 } },
      repo,
    ),
  ).toThrow("不一致");
  const noCoverage = { ...strategy, id: "no-action-coverage" };
  alerts.strategies.saveStrategy(noCoverage);
  const uncoveredRequest = { ...request, strategies: [noCoverage] },
    uncoveredFills = result.fills.map((f) => ({
      ...f,
      strategyId: noCoverage.id,
    }));
  const uncoveredInput = {
    ...input,
    strategy: noCoverage,
    request: uncoveredRequest,
    fills: uncoveredFills,
    inputHash: digest(uncoveredRequest),
    resultHash: digest(uncoveredFills),
    actionCoverage: undefined,
  };
  alerts.records.save(
    "strategy-qualification",
    `strategy-qualification-${noCoverage.id}`,
    { inputHash: uncoveredInput.inputHash, status: "research" },
  );
  expect(publishAccountExpectation(uncoveredInput, repo).samples).toEqual([]);
  expect(freezeMatchingAccountExpectation(noCoverage.id, 1, repo).status).toBe(
    "unavailable",
  );
  expect(repo.expectation(noCoverage.id, 1)).toBeNull();
  const multiple = { ...strategy, id: "ambiguous-source" };
  alerts.strategies.saveStrategy(multiple);
  const multiRequest = { ...request, strategies: [multiple] },
    multiFills = result.fills.map((f) => ({ ...f, strategyId: multiple.id }));
  const chosen = {
    ...input,
    strategy: multiple,
    request: multiRequest,
    fills: multiFills,
    inputHash: digest(multiRequest),
    resultHash: digest(multiFills),
  };
  publishAccountExpectation(chosen, repo);
  publishAccountExpectation(
    {
      ...chosen,
      resultHash: digest({ fills: multiFills, fixture: "other result" }),
    },
    repo,
  );
  alerts.records.save(
    "strategy-qualification",
    `strategy-qualification-${multiple.id}`,
    { inputHash: chosen.inputHash, status: "research" },
  );
  expect(
    freezeMatchingAccountExpectation(multiple.id, 1, repo).reason,
  ).toContain("多个");
  expect(
    freezeMatchingAccountExpectation(multiple.id, 1, repo, {
      inputHash: chosen.inputHash,
      resultHash: chosen.resultHash,
      buildHash: chosen.buildHash,
    }).status,
  ).toBe("frozen");
});

it("a selected new import can be confirmed after more than 200 older unlinked trades", async () => {
  const s = seed(),
    book = await s.load();
  const target = book.trades.find(
    (t) => t.side === "buy" && t.date === "2026-01-05",
  )!;
  const batch = book.facts.fills.find(
    (f) => `delivery:${f.id}` === target.id,
  )!.batchId;
  const older = Array.from({ length: 201 }, (_, i) => ({
    ...target,
    id: `old-${i}`,
    account: `old-account-${i}`,
    symbol: "sh600999",
    time: target.time - 86400000,
  }));
  const expanded = { ...book, trades: [...older, ...book.trades] };
  const matching = accountLinkSuggestions(expanded, batch).items.find(
    (r) => r.trade.id === target.id,
  )!;
  expect(matching.plans).toHaveLength(1);
  expect(
    confirmAccountLinks(
      {
        confirmed: true,
        factVersion: expanded.facts.version,
        links: [
          {
            tradeId: target.id,
            fingerprint: matching.fingerprint,
            planId: "review-plan",
          },
        ],
      },
      expanded,
      s.repo,
    ),
  ).toEqual({ saved: 1 });
});

it("unknown opening is a separate round, never counted as a planned or compliant trade", async () => {
  const s = seed();
  const raw = Buffer.from(
    readFileSync("tests/fixtures/delivery/r3b-account.csv", "utf8").split(
      /\r?\n/,
    )[0] +
      "\n20260115,100000,证券卖出,600001,50,9,450,450,450,0,0,unknown-exit\n",
  );
  const table = parseDeliveryTable(raw),
    parsed = importDeliveryTable(table);
  new DeliveryStore(s.db).commitImport({
    account: "unknown-real",
    source: "generic",
    fileHash: digest(raw.toString()),
    fileName: "unknown.csv",
    importedAt: 1,
    parsed,
    rawRows: table.rows,
    sourceHeader: table.header,
  });
  const monthly = monthlyAccountReview(await s.load(), "2026-01");
  expect(monthly.rounds.unknownOpening).toBe(1);
  expect(monthly.rounds.unplanned).toBe(2);
  expect(
    monthly.rounds.items.find((r) => r.account === "unknown-real")?.status,
  ).toBe("unknown-opening");
});

it("monthly round counts include crypto while monetary replay stays explicitly CNY only", async () => {
  const s = seed(),
    book = await s.load(),
    base = book.trades[0]!;
  const crypto = [
    {
      ...base,
      id: "cx-buy",
      account: "crypto-account",
      kind: "exchange-simulation" as const,
      market: "crypto" as const,
      symbol: "BTCUSDT",
      side: "buy" as const,
      date: "2026-01-10",
      time: Date.parse("2026-01-10T01:00:00Z"),
      quantity: 0.1,
      planId: null,
    },
    {
      ...base,
      id: "cx-sell",
      account: "crypto-account",
      kind: "exchange-simulation" as const,
      market: "crypto" as const,
      symbol: "BTCUSDT",
      side: "sell" as const,
      date: "2026-01-11",
      time: Date.parse("2026-01-11T01:00:00Z"),
      quantity: 0.1,
      planId: null,
    },
  ];
  const monthly = monthlyAccountReview(
    { ...book, trades: [...book.trades, ...crypto] },
    "2026-01",
  );
  expect(monthly.rounds.unplanned).toBe(3);
  expect(
    monthly.rounds.items.filter((r) => r.market === "crypto"),
  ).toHaveLength(1);
  expect(monthly.items.some((r) => r.account === "crypto-account")).toBe(false);
  expect(monthly.coverage).toMatchObject({
    monetaryMarket: "cn-equity",
    monetaryCurrency: "CNY",
    cryptoCountOnly: true,
  });
  const tied = crypto.map((t) => ({
    ...t,
    time: crypto[0]!.time,
    sourceOrder: undefined,
  }));
  expect(
    monthlyAccountReview(
      { ...book, trades: [...book.trades, ...tied] },
      "2026-01",
    ).coverage.excludedCryptoGroups,
  ).toHaveLength(1);
});
