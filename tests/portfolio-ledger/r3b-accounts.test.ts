import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { settingsSchema, type Bar } from "~/lib/domain";
import { defaultBacktestCosts } from "~/lib/backtest/backtest-costs";
import { migrate } from "~/server/db/migrations";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { AlertRepository } from "~/server/db/alert-repository";
import { DeliveryStore } from "~/server/db/delivery-store";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "~/lib/research/evidence/delivery-import";
import {
  decayFlag,
  accountReviewSettingsSchema,
  checkExposureCaps,
  type AccountPosition,
} from "~/lib/portfolio/account-workspace";
import {
  accountAttribution,
  entryCohortReturn,
  loadAccountBook,
  pageAccountBook,
  linkAccountTrade,
  accountTradePage,
  accountPositionDetail,
} from "~/server/portfolio/account-workspace-service";
import { monthlyAccountReview } from "~/server/portfolio/account-monthly-review";
import { replayTradeReview } from "~/server/portfolio/trade-review-service";
import { createAlertPlan } from "~/server/alerts/plans";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";
import type { StrategyObjectInput } from "trading-strategies";
import type { PortfolioRequest } from "quant-backtest";
import {
  publishAccountExpectation,
  freezeMatchingAccountExpectation,
} from "~/server/portfolio/account-expectation-service";

const policy = accountReviewSettingsSchema.parse({});
const dates = Array.from({ length: 65 }, (_, i) =>
  new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
const bars: Bar[] = dates.map((date) => ({
  date,
  open: date === "2026-01-07" ? 7 : 10,
  close: date === "2026-01-06" ? 8 : 10,
  high: 11,
  low: 7,
  volume: 10000,
  amount: 100000,
}));
const strategy: StrategyObjectInput = {
  id: "QA-r3b",
  version: 1,
  market: "cn-equity",
  period: "day",
  sleeve: "swing",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "weight", weight: 1 },
};
function seed() {
  const db = new Database(":memory:");
  migrate(db);
  const repo = new AccountWorkspaceRepository(db),
    alerts = new AlertRepository(db);
  const raw = readFileSync("tests/fixtures/delivery/r3b-account.csv"),
    table = parseDeliveryTable(raw),
    parsed = importDeliveryTable(table);
  new DeliveryStore(db).commitImport({
    account: "QA-real",
    source: "generic",
    fileHash: createHash("sha256").update(raw).digest("hex"),
    fileName: "r3b-account.csv",
    importedAt: 1,
    parsed,
    rawRows: table.rows,
    sourceHeader: table.header,
  });
  const event: AlertEvent = {
    key: alertKey({
      strategyId: strategy.id,
      version: 1,
      market: "cn-equity",
      symbol: "sh600000",
      bar: "2026-01-02",
    }),
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity",
    symbol: "sh600000",
    bar: "2026-01-02",
    type: "entry",
    price: 9.5,
    stop: 9,
    target: 12,
    sleeve: "swing",
    observedAt: Date.parse("2026-01-02T00:00:00Z"),
    mode: "shadow",
    status: "shadow",
    reason: "QA",
    source: "fixed",
    wouldSend: false,
    outcomes: [],
  };
  alerts.record(strategy, event);
  alerts.savePlan(
    {
      id: "QA-plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol: "sh600000",
      sleeve: "swing",
      triggerKey: event.key,
      entry: 9.5,
      stop: 9,
      target: 12,
      quantity: 100,
      tranches: 1,
      status: "closed",
      expiresAt: null,
      createdAt: event.observedAt,
    },
    event.observedAt,
  );
  const config = settingsSchema.parse({
    alerts: { capital: { "cn-equity": 10000 } },
  });
  const context = {
    today: "2026-03-15",
    calendar: dates,
    calendarSource: "QA",
    evidence: () => ({ events: [], coverageEnd: "2027-01-01", source: "QA" }),
  };
  const load = () =>
    loadAccountBook(repo, config, Date.parse("2026-03-15"), {
      context,
      bars: { sh600000: bars },
    });
  return { db, repo, alerts, event, config, load };
}

describe("R3b comparable decay", () => {
  it("flags a fixed diverging strategy, keeps its healthy control and insufficient/version-mismatch records unflagged", () => {
    const expected = Array.from({ length: 40 }, (_, i) => 0.01 + i / 1000);
    expect(decayFlag(expected, Array(30).fill(-0.2), policy)).toMatchObject({
      flagged: true,
      enough: true,
      expectedSamples: 40,
      observedSamples: 30,
      median: -0.2,
    });
    expect(
      decayFlag(expected, Array(30).fill(-0.2), policy).threshold,
    ).toBeCloseTo(0.0139, 14);
    expect(decayFlag(expected, Array(30).fill(0.03), policy).flagged).toBe(
      false,
    );
    expect(decayFlag(expected, Array(29).fill(-0.2), policy)).toMatchObject({
      flagged: false,
      enough: false,
    });
    expect(decayFlag([], Array(30).fill(-0.2), policy).flagged).toBe(false);
  });
  it("uses the twentieth market day including entry, rejects missing/duplicate prices and corporate-action uncertainty", () => {
    expect(
      entryCohortReturn(
        "sh600000",
        dates[0]!,
        5,
        { sh600000: bars },
        dates,
        [],
        "2027-01-01",
        "cn-equity",
      ),
    ).toBe(1);
    expect(
      entryCohortReturn(
        "sh600000",
        dates[0]!,
        5,
        { sh600000: bars },
        dates,
        [],
        null,
        "cn-equity",
      ),
    ).toBeNull();
    expect(
      entryCohortReturn(
        "sh600000",
        dates[0]!,
        5,
        { sh600000: [...bars, bars[19]!] },
        dates,
        [],
        "2027-01-01",
        "cn-equity",
      ),
    ).toBeNull();
    expect(
      entryCohortReturn(
        "sh600000",
        dates[0]!,
        5,
        { sh600000: bars },
        dates,
        [{ date: dates[5]!, category: 1 }],
        "2027-01-01",
        "cn-equity",
      ),
    ).toBeNull();
  });
});
it("keeps real/simulation/currency totals separate, pages deterministically and refuses unknown exposure", async () => {
  const s = seed();
  try {
    const book = await s.load(),
      p = book.positions[0]!;
    expect(p).toMatchObject({
      account: "QA-real",
      quantity: 100,
      value: 1000,
      cost: 10,
      kind: "real",
    });
    book.positions.push(
      { ...p, id: "paper", account: "paper", kind: "paper", value: 90000 },
      {
        ...p,
        id: "demo",
        account: "demo",
        kind: "exchange-simulation",
        market: "crypto",
        currency: "USDT",
        value: 500,
      },
    );
    expect(pageAccountBook(book, {}).totals).toEqual([
      { currency: "CNY", count: 1, value: 1000, missing: 0 },
      { currency: "USDT", count: 0, value: 0, missing: 0 },
    ]);
    expect(
      pageAccountBook(book, { kind: "all" }).totals.map((t) => t.value),
    ).toEqual([91000, 500]);
    expect(pageAccountBook(book, { page: 1 }).items).toEqual([]);
    book.trades.push({
      ...book.trades[0]!,
      id: "local:display-name-collision",
    });
    expect(accountPositionDetail(book, p.id).tradeCount).toBe(3);
    const input = {
      positions: book.positions,
      reserved: [
        {
          market: "cn-equity" as const,
          symbol: p.symbol,
          sleeve: "swing",
          industry: "未知",
          value: 500,
        },
      ],
      proposed: {
        market: "cn-equity" as const,
        symbol: p.symbol,
        sleeve: "swing",
        industry: "未知",
        value: 600,
      },
      capital: s.config.alerts.capital,
      caps: [
        {
          market: "cn-equity" as const,
          dimension: "symbol" as const,
          key: p.symbol,
          fraction: 0.2,
        },
      ],
    };
    expect(checkExposureCaps(input)).toEqual([
      {
        dimension: "symbol",
        key: p.symbol,
        used: 2100,
        limit: 2000,
        reason: "计划及未完成预留加入后超过敞口上限",
      },
    ]);
    expect(
      checkExposureCaps({ ...input, positions: [{ ...p, value: null }] }),
    ).toMatchObject([
      { used: null, reason: "持仓估值、分组或资本依据不足，无法证明未超限" },
    ]);
    s.db
      .prepare(
        "UPDATE trade_fills SET payload=json_set(payload,'$.instrument','convertible')",
      )
      .run();
    const unknownUnits = await s.load();
    expect(unknownUnits.positions[0]).toMatchObject({
      value: null,
      price: null,
      cost: null,
    });
    expect(unknownUnits.positions[0]?.reasons).toContain(
      "可转债数量/价格单位须在原交割单复盘核对，统一风险估值留空",
    );
    expect(
      accountPositionDetail(unknownUnits, unknownUnits.positions[0]!.id)
        .concentration.summary.maxSingleWeight,
    ).toBeNull();
    expect(
      monthlyAccountReview(unknownUnits, "2026-01").unavailable,
    ).toHaveLength(2);
  } finally {
    s.db.close();
  }
});
it("validates links against actual trade identity, preserves every revision and prevents stale-book writes", async () => {
  const s = seed();
  try {
    let book = await s.load();
    const trade = book.trades[0]!;
    const input = {
      tradeId: trade.id,
      planId: "QA-plan",
      alertKey: s.event.key,
      strategyId: strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    };
    expect(linkAccountTrade(input, book, s.repo)).toMatchObject(input);
    expect(() => linkAccountTrade(input, book, s.repo)).toThrow(
      "账户事实已更新",
    );
    book = await s.load();
    expect(() =>
      linkAccountTrade({ ...input, strategyVersion: 2 }, book, s.repo),
    ).toThrow("策略市场、版本或分仓不符");
    s.db
      .prepare(
        "UPDATE trade_fills SET payload=json_set(payload,'$.price',11) WHERE id=?",
      )
      .run(trade.id.slice("delivery:".length));
    book = await s.load();
    expect(book.trades.find((t) => t.id === trade.id)?.strategyId).toBeNull();
    s.db
      .prepare(
        "UPDATE trade_fills SET payload=json_set(payload,'$.price',10) WHERE id=?",
      )
      .run(trade.id.slice("delivery:".length));
    s.db
      .prepare(
        "UPDATE trade_plans SET payload=json_set(payload,'$.createdAt',?) WHERE id='QA-plan'",
      )
      .run(Date.parse("2026-03-01"));
    book = await s.load();
    expect(() => linkAccountTrade(input, book, s.repo)).toThrow(
      "计划标的、版本或创建时间不符",
    );
    expect(
      s.db.prepare("SELECT count(*) n FROM account_link_audit").get(),
    ).toEqual({ n: 1 });
  } finally {
    s.db.close();
  }
});
it("reconciles imported fixture cash every day and preserves a deliberate discrepancy without balancing flows", async () => {
  const s = seed();
  try {
    const f = new DeliveryStore(s.db),
      fills = f.fills("QA-real"),
      cashFlows = f.cashFlows("QA-real");
    const run = (rows = fills) =>
      replayTradeReview({
        version: 1,
        account: "QA-real",
        trades: { fills: rows, cashFlows, bars: { sh600000: bars } },
        nav: { openingCash: 0, tradingDays: dates },
        dimensions: {},
        batches: f.batches(),
        sources: [],
        warnings: [],
        rpsPeriod: 20,
      });
    const result = run();
    expect(
      result.projectedCashDays.slice(0, 4).map((d) => d.cash.value),
    ).toEqual([8000, 8000, 9600, 8600]);
    expect(result.cashReconciliation.summary).toMatchObject({
      matchedDays: 3,
      differenceDays: 0,
    });
    const changed = fills.map((v, i) =>
        i === 0 ? { ...v, netAmount: -2001 } : v,
      ),
      negative = run(changed);
    expect(negative.cashReconciliation.summary.differenceDays).toBe(3);
    expect(negative.cashResiduals.map((r) => r.value)).toEqual([0, 1, 1, 1]);
    expect(cashFlows).toHaveLength(1);
  } finally {
    s.db.close();
  }
});
it("reports all three monthly discipline classes with signed monetary counterfactuals and no invented unlinked trades", async () => {
  const s = seed();
  try {
    let book = await s.load();
    for (const trade of book.trades) {
      linkAccountTrade(
        {
          tradeId: trade.id,
          planId: "QA-plan",
          alertKey: s.event.key,
          strategyId: strategy.id,
          strategyVersion: 1,
          sleeve: "swing",
        },
        book,
        s.repo,
      );
      book = await s.load();
    }
    const monthly = monthlyAccountReview(book, "2026-01");
    expect(monthly.items.map((r) => [r.kind, r.count])).toEqual([
      ["stop", 1],
      ["oversize", 1],
      ["chase", 2],
    ]);
    expect(monthly.items.find((r) => r.kind === "oversize")).toMatchObject({
      actual: -400,
      counterfactual: -200,
      impact: 200,
    });
    expect(monthly.items.find((r) => r.kind === "chase")?.impact).toBeNull(); // one affected round is still open
    expect(monthly.unlinked).toBe(0);
  } finally {
    s.db.close();
  }
});
it("stores exposure override evidence with the plan and never admits an unacknowledged breach", () => {
  const s = seed();
  try {
    s.config.accountReview.portfolioLimits.enabled = false;
    s.config.alerts.sleeves.find(
      (row) => row.market === "cn-equity" && row.id === "swing",
    )!.risk = 0.02;
    s.config.accountReview.caps = [
      {
        market: "cn-equity",
        dimension: "market",
        key: "cn-equity",
        fraction: 0.01,
      },
    ];
    s.alerts.saveState("exposure-close:cn-equity", [
      {
        market: "cn-equity",
        sleeve: "__checked__",
        value: 0,
        at: Date.parse("2026-01-02T17:00:00+08:00"),
      },
    ]);
    const input = {
        eventKey: s.event.key,
        stages: [10],
        stop: 9,
        target: 12,
        expiresAt: "2026-01-20T00:00:00Z",
        overrideSizing: {
          confirmed: true as const,
          reason: "固定fixture人工保护目标",
        },
      },
      admission = {
        positions: [] as AccountPosition[],
        assertCurrent: () => {},
      };
    expect(() =>
      createAlertPlan(
        input,
        s.config,
        Date.parse("2026-01-03"),
        s.alerts,
        admission,
      ),
    ).toThrow("敞口超限");
    const plan = createAlertPlan(
      { ...input, overrideCaps: true },
      s.config,
      Date.parse("2026-01-03"),
      s.alerts,
      admission,
    );
    expect(s.alerts.strategies.plan(plan.id)?.exposureAudit).toMatchObject({
      overridden: true,
      caps: s.config.accountReview.caps,
      violations: [{ dimension: "market", limit: 100, used: 1000 }],
    });
  } finally {
    s.db.close();
  }
});
it("automatically freezes a run-anchored raw cohort and exercises divergent/healthy/version-isolated attribution", async () => {
  const s = seed();
  try {
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
          bars,
          signalBars: bars,
          actions: [],
          execution: {
            evidence: "QA fixed raw fixture",
            minimum: 100,
            step: 100,
            tradable: true,
            limitUp: null,
            limitDown: null,
          },
        },
      ],
      sleeves: [
        { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 10 },
      ],
    };
    const fills = Array.from({ length: 40 }, () => ({
      strategyId: strategy.id,
      symbol: "sh600000",
      date: dates[0]!,
      side: "buy" as const,
      price: 5,
    }));
    const buildHash = digest("QA synthetic runtime identity"),
      frozen = { request, executionBuildHash: buildHash },
      inputHash = digest(frozen),
      resultHash = digest({ fills });
    const source = {
      strategy,
      request,
      fills,
      inputHash,
      resultHash,
      buildHash,
      source: "QA synthetic raw cohort fixture",
      limitations: ["QA synthetic only"],
      actionCoverage: {
        sh600000: {
          from: dates[0]!,
          through: dates.at(-1)!,
          source: "QA explicit synthetic no-action coverage fixture",
          hash: digest("QA synthetic action coverage"),
        },
      },
    };
    expect(publishAccountExpectation(source, s.repo)).toMatchObject({
      samples: Array(40).fill(1),
      excluded: 0,
    });
    expect(s.repo.expectation(strategy.id, 1)).toBeNull();
    expect(
      freezeMatchingAccountExpectation(strategy.id, 1, s.repo, {
        inputHash,
        resultHash,
        buildHash,
      }),
    ).toMatchObject({
      status: "frozen",
      expectation: { samples: Array(40).fill(1) },
    });
    expect(
      freezeMatchingAccountExpectation(strategy.id, 1, s.repo, {
        inputHash,
        resultHash,
        buildHash,
      }).status,
    ).toBe("frozen");
    let book = await s.load();
    const outcome = {
      horizon: 20 as const,
      settled: true,
      entryDate: dates[0]!,
      exitDate: dates[19]!,
      entry: 10,
      exit: 8,
      returnPct: -20,
      action: "区间无除权" as const,
      reasons: [],
      calendarSource: "QA",
      actionSource: "QA",
    };
    book.facts.events = Array.from({ length: 30 }, (_, i) => ({
      ...s.event,
      key: `QA-${i}`,
      outcomes: [outcome],
    }));
    expect(accountAttribution(book)[0]).toMatchObject({
      flagged: true,
      alerts: { flagged: true, observedSamples: 30 },
      actual: { flagged: false, observedSamples: 0 },
    });
    book.facts.events = book.facts.events.map((e) => ({
      ...e,
      outcomes: [{ ...outcome, returnPct: 110 }],
    }));
    expect(accountAttribution(book)[0]?.flagged).toBe(false);
    book.facts.expectations[0]!.version = 2;
    expect(accountAttribution(book)[0]).toMatchObject({
      expected: null,
      flagged: false,
    });
    book.facts.expectations[0]!.version = 1;
    book.facts.expectations[0]!.strategyHash = "different-parameters";
    expect(accountAttribution(book)[0]).toMatchObject({
      expected: null,
      flagged: false,
    });
    const invalidStrategy = { ...strategy, id: "QA-invalid-source" };
    s.alerts.strategies.saveStrategy(invalidStrategy);
    const invalidFrozen = {
      ...frozen,
      request: { ...request, strategies: [invalidStrategy] },
    };
    const wrongInputHash = digest("wrong input hash");
    s.db
      .prepare("INSERT INTO records VALUES('QA-invalid-archive','job',?,1)")
      .run(
        JSON.stringify({
          status: "completed",
          result: {
            inputHash: wrongInputHash,
            frozen: invalidFrozen,
            result: {
              fills: fills.map((f) => ({
                ...f,
                strategyId: invalidStrategy.id,
              })),
            },
          },
        }),
      );
    expect(() =>
      freezeMatchingAccountExpectation(invalidStrategy.id, 1, s.repo, {
        inputHash: wrongInputHash,
      }),
    ).toThrow("输入哈希不符");
  } finally {
    s.db.close();
  }
});
it("includes closed trades in source linking and reviews the manual ledger without inventing its opening cash", async () => {
  const s = seed();
  try {
    const book = await s.load();
    const fills = book.facts.fills.filter((f) => f.tradeDate < "2026-01-08");
    book.facts.local = fills.map((f, index) => ({
      id: `manual-${index}`,
      symbol: f.symbol!,
      date: f.tradeDate,
      side: f.kind,
      price: f.price,
      quantity: f.quantity,
      lowerLimit: 1,
      upperLimit: 20,
      limitSource: "QA",
      signalId: null,
      stop: 9,
      note: "",
      createdAt: 1,
      methods: [],
      costs: defaultBacktestCosts,
      fees: { commission: 0, tax: 0, slippage: 0, total: 0 },
    }));
    for (const [index, f] of fills.entries())
      book.trades.push({
        id: `local:manual-${index}`,
        account: "手工账本",
        kind: "real",
        market: "cn-equity",
        symbol: f.symbol!,
        side: f.kind,
        date: f.tradeDate,
        time: Date.parse(f.tradeDate),
        price: f.price,
        quantity: f.quantity,
        strategyId: strategy.id,
        strategyVersion: 1,
        sleeve: "swing",
        planId: "QA-plan",
        alertKey: s.event.key,
      });
    expect(
      accountTradePage(book, {
        page: 0,
        kind: "real",
        symbol: "sh600000",
      }).trades.filter((t) => t.side === "sell"),
    ).toHaveLength(2);
    const monthly = monthlyAccountReview(book, "2026-01");
    expect(
      monthly.items.find(
        (r) => r.account === "手工账本" && r.kind === "oversize",
      ),
    ).toMatchObject({
      count: 1,
      actual: -400,
      counterfactual: -200,
      impact: 200,
    });
    expect(
      monthly.items.find((r) => r.account === "手工账本" && r.kind === "stop"),
    ).toMatchObject({
      count: 1,
      counterfactual: null,
      reason: "手工账本缺期初现金与完整出入金，止损资金重放不可用；不补造本金",
    });
  } finally {
    s.db.close();
  }
});
it("filters real positions by delivery/local id prefix and ignores source for other kinds", async () => {
  const s = seed();
  try {
    const book = await s.load(),
      delivery = book.positions[0]!;
    book.positions.push(
      // Same display account and symbol as the delivery row: only the id
      // prefix separates the manual ledger, and its valuation is unknown.
      {
        ...delivery,
        id: "local:sh600000",
        account: delivery.account,
        value: null,
        price: null,
        cost: null,
        industryGroups: [],
      },
      {
        ...delivery,
        id: "demo:usdt",
        account: "demo",
        kind: "exchange-simulation",
        market: "crypto",
        currency: "USDT",
        industry: "数字货币",
        industryGroups: [],
        value: 500,
      },
    );
    const ids = (input: Parameters<typeof pageAccountBook>[1]) =>
      pageAccountBook(book, input)
        .items.map((i) => i.id)
        .sort();
    expect(ids({})).toEqual(ids({ source: "all" }));
    expect(ids({ source: "delivery" })).toEqual([delivery.id]);
    expect(ids({ source: "local" })).toEqual(["local:sh600000"]);
    expect(ids({ source: "local" })).not.toEqual(ids({ source: "delivery" }));

    const deliveryPage = pageAccountBook(book, { source: "delivery" });
    expect(deliveryPage.total).toBe(1);
    expect(deliveryPage.totals[0]).toEqual({
      currency: "CNY",
      count: 1,
      value: 1000,
      missing: 0,
    });
    expect(deliveryPage.exposure.every((e) => e.value === 1000)).toBe(true);
    expect(
      pageAccountBook(book, { source: "delivery", page: 1 }).items,
    ).toEqual([]);

    const localPage = pageAccountBook(book, { source: "local" });
    expect(localPage.total).toBe(1);
    expect(localPage.totals[0]).toEqual({
      currency: "CNY",
      count: 1,
      value: null,
      missing: 1,
    });
    expect(localPage.exposure).toHaveLength(deliveryPage.exposure.length);
    expect(localPage.exposure.every((e) => e.value === null)).toBe(true);

    // Non-real kinds have no source: an explicit source must behave as all.
    expect(ids({ kind: "all" })).toEqual(ids({ kind: "all", source: "local" }));
    expect(pageAccountBook(book, { kind: "all", source: "local" }).totals).toEqual(
      [
        { currency: "CNY", count: 2, value: null, missing: 1 },
        { currency: "USDT", count: 1, value: 500, missing: 0 },
      ],
    );
    expect(
      pageAccountBook(book, { kind: "exchange-simulation", source: "delivery" }),
    ).toEqual(
      pageAccountBook(book, { kind: "exchange-simulation", source: "all" }),
    );
    expect(
      ids({ kind: "exchange-simulation", source: "delivery" }),
    ).toEqual(["demo:usdt"]);
  } finally {
    s.db.close();
  }
});
it("classifies read price/stop before filtering and paging, and reports the same touched set", async () => {
  const s = seed();
  try {
    const book = await s.load(),
      base = book.positions[0]!;
    const make = (
      id: string,
      price: number | null,
      stop: number | null,
      extra: Partial<AccountPosition> = {},
    ): AccountPosition => ({ ...base, id, price, stop, value: 1000, ...extra });
    // Equal counts as touched; missing, non-finite or non-positive inputs are
    // unknown and never inferred from distance, cost or value.
    book.positions = [
      make("delivery:equal", 10, 10),
      make("delivery:below", 9, 10),
      make("delivery:above", 11, 10),
      make("delivery:missing-stop", 10, null),
      make("delivery:missing-price", null, 10),
      make("delivery:invalid-price", 0, 10),
      make("delivery:invalid-stop", 10, Number.NaN),
      make("local:equal", 10, 10, { account: "手工账本" }),
      ...Array.from({ length: 22 }, (_, i) =>
        make(`delivery:touched-${i}`, 9, 10),
      ),
    ];
    const isTouched = (p: AccountPosition) =>
      p.price !== null && p.stop !== null && p.price <= p.stop;
    const touched = pageAccountBook(book, { stopStatus: "touched" }),
      next = pageAccountBook(book, { stopStatus: "touched", page: 1 });
    expect(touched.total).toBe(25);
    expect(touched.items).toHaveLength(20);
    expect(touched.items.every(isTouched)).toBe(true);
    expect(next.items).toHaveLength(5);
    expect([...touched.items, ...next.items].every(isTouched)).toBe(true);
    expect(touched.totals[0]).toEqual({
      currency: "CNY",
      count: 25,
      value: 25000,
      missing: 0,
    });
    expect(touched.exposure.every((e) => e.value === 25000)).toBe(true);

    expect(
      pageAccountBook(book, { stopStatus: "touched", source: "local" }).items
        .map((p) => p.id),
    ).toEqual(["local:equal"]);
    expect(
      pageAccountBook(book, { stopStatus: "unknown" })
        .items.map((p) => p.id)
        .sort(),
    ).toEqual([
      "delivery:invalid-price",
      "delivery:invalid-stop",
      "delivery:missing-price",
      "delivery:missing-stop",
    ]);
    // Above-stop rows remain in the unfiltered view.
    expect(pageAccountBook(book, {}).total).toBe(30);
  } finally {
    s.db.close();
  }
});
it("does not call turnover oversizing or assign a later month's oversize to an earlier month", async () => {
  const s = seed();
  try {
    const book = await s.load(),
      template = book.facts.fills[0]!;
    const rows = [
      {
        id: "b1",
        kind: "buy" as const,
        tradeDate: "2026-01-05",
        quantity: 100,
        price: 10,
      },
      {
        id: "s1",
        kind: "sell" as const,
        tradeDate: "2026-01-07",
        quantity: 50,
        price: 8,
      },
      {
        id: "b2",
        kind: "buy" as const,
        tradeDate: "2026-01-08",
        quantity: 50,
        price: 10,
      },
      {
        id: "s2",
        kind: "sell" as const,
        tradeDate: "2026-01-09",
        quantity: 100,
        price: 8,
      },
    ];
    const apply = () => {
      book.facts.fills = rows.map((r, i) => ({
        ...template,
        ...r,
        rowIndex: i,
        amount: r.quantity * r.price,
        netAmount: (r.kind === "buy" ? -1 : 1) * r.quantity * r.price,
        balanceCash: null,
        balanceShares: null,
      }));
      book.trades = book.facts.fills.map((f) => ({
        id: `delivery:${f.id}`,
        account: "QA-real",
        kind: "real",
        market: "cn-equity",
        symbol: f.symbol!,
        side: f.kind,
        date: f.tradeDate,
        time: Date.parse(f.tradeDate),
        price: f.price,
        quantity: f.quantity,
        strategyId: strategy.id,
        strategyVersion: 1,
        sleeve: "swing",
        planId: "QA-plan",
        alertKey: s.event.key,
      }));
    };
    apply();
    expect(
      monthlyAccountReview(book, "2026-01").items.find(
        (r) => r.kind === "oversize",
      )?.count,
    ).toBe(0); // 150 bought, peak only100
    rows[2]!.tradeDate = "2026-02-02";
    rows[2]!.quantity = 100;
    rows[3]!.tradeDate = "2026-02-03";
    rows[3]!.quantity = 150;
    apply();
    expect(
      monthlyAccountReview(book, "2026-01").items.find(
        (r) => r.kind === "oversize",
      )?.count,
    ).toBe(0);
    expect(
      monthlyAccountReview(book, "2026-02").items.find(
        (r) => r.kind === "oversize",
      )?.count,
    ).toBe(1);
  } finally {
    s.db.close();
  }
});
