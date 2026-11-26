import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkExposureCaps,
  industryGroupsFor,
  type AccountPosition,
} from "~/lib/portfolio/account-workspace";
import { settingsSchema } from "~/lib/domain";
import { migrate } from "~/server/db/migrations";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { TradeLedgerStore } from "~/server/db/trade-ledger-store";
import { AlertRepository } from "~/server/db/alert-repository";
import {
  loadAccountBook,
  pageAccountBook,
} from "~/server/portfolio/account-workspace-service";
import { accountWeeklyReview } from "~/server/portfolio/account-review-service";
import { createAlertPlan } from "~/server/alerts/plans";
import { alertKey, type AlertEvent } from "~/lib/strategy-facts/alerts";

const blocks = vi.hoisted(() => vi.fn());
const localPrices = vi.hoisted(() => vi.fn());
const readBars = vi.hoisted(() => vi.fn());
vi.mock("~/server/market/industry-blocks", () => ({
  readIndustryBlocks: blocks,
}));
vi.mock("tstdx/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("tstdx/local")>()),
  readSnapshot: localPrices,
}));
vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars,
}));
const connections: Database.Database[] = [];
const now = Date.parse("2026-11-16T17:00:00+08:00");
const sourceHash = "7".repeat(64);
const calendar = ["2026-11-13", "2026-11-16"];
const context = {
  today: "2026-11-16",
  calendar,
  calendarSource: "fixed fixture",
  evidence: () => ({
    events: [],
    coverageEnd: "2026-12-31",
    source: "fixed action coverage",
  }),
};
const config = settingsSchema.parse({
  industryBlocksRoot: "D:/synthetic-read-only/Blocks",
  alerts: { capital: { "cn-equity": 100000, crypto: 100000 } },
});
beforeEach(() =>
  blocks.mockResolvedValue({
    hash: sourceHash,
    files: [
      { name: "食品饮料", members: ["sh600519", "sh600001"] },
      { name: "饮料制造", members: ["sh600519"] },
    ],
  }),
);
afterEach(() => connections.splice(0).forEach((db) => db.close()));

function position(overrides: Partial<AccountPosition> = {}): AccountPosition {
  return {
    id: "held",
    account: "real",
    kind: "real",
    market: "cn-equity",
    currency: "CNY",
    symbol: "sh600519",
    sleeve: "swing",
    industry: "旧显示标签",
    industryGroups: ["食品饮料", "饮料制造"],
    quantity: 1500,
    cost: 10,
    price: 10,
    value: 15000,
    stop: 9,
    at: calendar[1]!,
    strategyId: null,
    strategyVersion: null,
    reasons: [],
    ...overrides,
  };
}
const neutral = {
  market: "cn-equity" as const,
  symbol: "",
  sleeve: "",
  industry: "",
  industryGroups: [],
  value: 0,
  openRisk: 0,
};
const industryCap = {
  market: "cn-equity" as const,
  dimension: "industry" as const,
  key: "*",
  fraction: 0.3,
};
const capital = { "cn-equity": 100000, crypto: 100000 };
function fixture() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const repo = new AccountWorkspaceRepository(db);
  new AlertRepository(db).strategies.saveStrategy({
    id: "fixture",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600001"] },
    entry: { kind: "constant", value: true },
    exit: { stop: { kind: "fixed", fraction: 0.1 } },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  });
  new TradeLedgerStore(db).record(
    {
      id: "11111111-1111-4111-8111-111111111111",
      symbol: "sh600519",
      date: calendar[0],
      side: "buy",
      price: 10,
      quantity: 1500,
      lowerLimit: 9,
      upperLimit: 11,
      limitSource: "fixed fixture",
      stop: 9,
    },
    {
      today: context.today,
      calendar,
      evidence: context.evidence(),
      methods: ["astock-market-rules", "mock-trading"].map((skillId) => ({
        skillId,
        ruleVersion: "fixed",
        outputSchema: "fixed",
        files: [{ file: "fixed fixture", hash: "fixed" }],
        prerequisites: [],
      })),
    },
  );
  const bars = Object.fromEntries(
    ["sh600519", "sh600001"].map((symbol) => [
      symbol,
      calendar.map((date) => ({
        date,
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        volume: 10000,
        amount: 100000,
      })),
    ]),
  );
  const load = () => loadAccountBook(repo, config, now, { context, bars });
  return { db, repo, load, alerts: new AlertRepository(db) };
}

it("reads legacy single labels only when arrays are absent, and never mutates or splits source facts", () => {
  expect(industryGroupsFor({ industry: "银行" })).toEqual(["银行"]);
  expect(industryGroupsFor({ industry: "银行", industryGroups: [] })).toEqual(
    [],
  );
  const facts = {
    industry: "legacy",
    industryGroups: ["饮料制造", "食品饮料", "食品饮料", "未知", ""],
  };
  const before = JSON.stringify(facts);
  expect(industryGroupsFor(facts)).toEqual(["食品饮料", "饮料制造"]);
  expect(JSON.stringify(facts)).toBe(before);
  expect(industryGroupsFor({ industry: "行业甲/行业乙" })).toEqual([
    "行业甲/行业乙",
  ]);
});

it("checks each overlapping group independently while counting position and market capital once", () => {
  const violations = checkExposureCaps({
    positions: [
      position(),
      position({
        id: "food-only",
        symbol: "sh600001",
        industryGroups: ["食品饮料"],
        value: 20000,
      }),
    ],
    reserved: [],
    proposed: neutral,
    capital,
    caps: [
      industryCap,
      {
        market: "cn-equity",
        dimension: "market",
        key: "cn-equity",
        fraction: 0.3,
      },
    ],
  });
  expect(violations.map((v) => [v.dimension, v.key, v.used, v.limit])).toEqual([
    ["industry", "食品饮料", 35000, 30000],
    ["market", "cn-equity", 35000, 30000],
  ]);
});

it("includes all reserved groups, deduplicates within a group and honors explicit cap keys", () => {
  const input = {
    positions: [position({ value: 10000 })],
    reserved: [
      {
        ...neutral,
        symbol: "sh600002",
        industryGroups: ["食品饮料", "饮料制造", "食品饮料"],
        value: 5000,
      },
    ],
    proposed: {
      ...neutral,
      symbol: "sh600003",
      industryGroups: ["食品饮料"],
      value: 15000,
    },
    capital,
    caps: [industryCap],
  };
  expect(checkExposureCaps(input)).toEqual([]);
  expect(
    checkExposureCaps({
      ...input,
      proposed: { ...input.proposed, value: 15100 },
    }),
  ).toMatchObject([{ key: "食品饮料", used: 30100 }]);
  expect(
    checkExposureCaps({
      ...input,
      caps: [{ ...industryCap, key: "饮料制造", fraction: 0.1 }],
    }),
  ).toMatchObject([{ key: "饮料制造", used: 15000, limit: 10000 }]);
});

it("does not invent unknown classification from a zero sentinel but blocks real missing groups or values", () => {
  const input = {
    positions: [position()],
    reserved: [],
    proposed: neutral,
    capital,
    caps: [industryCap],
  };
  expect(checkExposureCaps(input)).toEqual([]);
  expect(
    checkExposureCaps({
      ...input,
      positions: [position({ industry: "食品饮料", industryGroups: [] })],
    }),
  ).toMatchObject([{ key: "未知", used: null }]);
  expect(
    checkExposureCaps({
      ...input,
      positions: [position({ value: null })],
    }).every((v) => v.used === null),
  ).toBe(true);
  expect(
    checkExposureCaps({
      ...input,
      positions: [
        position({ industry: "食品饮料", industryGroups: undefined }),
      ],
    }),
  ).toEqual([]);
});

it("loads multiple current memberships with source hash and projects nonexclusive exposure without rewriting ledger bytes", async () => {
  const f = fixture();
  const before = f.db.prepare("SELECT payload FROM trade_ledger").get();
  const book = await f.load();
  expect(book.positions[0]).toMatchObject({
    industryGroups: ["食品饮料", "饮料制造"],
    industry: "食品饮料、饮料制造",
    value: 15000,
  });
  expect(book.industrySource).toEqual({
    hash: sourceHash,
    basis: "current-labelled",
    grouping: "all-known-groups",
  });
  expect(book.positions[0]!.reasons.join(" ")).not.toContain("多层归属");
  const page = pageAccountBook(book, {});
  expect(page.totals.find((row) => row.currency === "CNY")!.value).toBe(15000);
  expect(page.exposure.filter((row) => row.dimension === "industry")).toEqual([
    {
      dimension: "industry",
      overlapping: true,
      key: "CNY:食品饮料",
      value: 15000,
    },
    {
      dimension: "industry",
      overlapping: true,
      key: "CNY:饮料制造",
      value: 15000,
    },
  ]);
  expect(f.db.prepare("SELECT payload FROM trade_ledger").get()).toEqual(
    before,
  );
});

it("freezes the actual industry source and proposed groups in a new plan audit", async () => {
  const f = fixture();
  const strategy = f.alerts.strategies.strategy("fixture", 1)!;
  const event: AlertEvent = {
    key: "",
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity",
    symbol: "sh600001",
    bar: calendar[1]!,
    type: "entry",
    price: 10,
    stop: 9,
    target: null,
    sleeve: "swing",
    observedAt: now,
    mode: "shadow",
    status: "shadow",
    reason: "fixed fixture",
    source: "fixed fixture",
    wouldSend: false,
    outcomes: [],
  };
  event.key = alertKey(event);
  f.alerts.record(strategy, event);
  f.alerts.saveState("exposure", [
    { market: "cn-equity", sleeve: "__checked__", value: 0, at: now },
  ]);
  const book = await f.load();
  const plan = createAlertPlan(
    {
      eventKey: event.key,
      stages: [10],
      stop: 9,
      target: null,
      expiresAt: new Date(now + 86400000).toISOString(),
    },
    config,
    now,
    f.alerts,
    {
      positions: book.positions,
      industryGroups: (symbol) => book.industryBySymbol.get(symbol) ?? [],
      industrySource: book.industrySource,
      assertCurrent: () => f.repo.assertVersion(book.facts.version),
    },
  );
  expect(plan.exposureAudit?.industryGroups).toMatchObject({
    source: book.industrySource,
    proposed: { market: "cn-equity", symbol: "sh600001", groups: ["食品饮料"] },
    reserved: [],
  });
  expect(
    f.alerts.strategies.plan(plan.id)!.exposureAudit?.industryGroups,
  ).toEqual(plan.exposureAudit!.industryGroups);
});

it("local-only account previews request completed local prices without an automatic online source", async () => {
  const f = fixture();
  localPrices.mockResolvedValue({
    bars: calendar.map((date, i) => ({
      date,
      open: 10,
      high: 10 + i,
      low: 10,
      close: 10 + i,
      volume: 10000,
      amount: 100000,
    })),
  });
  const beforeCloseReady = Date.parse("2026-11-16T15:04:00+08:00");
  const book = await loadAccountBook(f.repo, config, beforeCloseReady, {
    context,
    localOnly: true,
  });
  expect(localPrices).toHaveBeenCalledWith(config.tdxRoot, "sh600519", "day", {
    chartFunds: true,
  });
  expect(readBars).not.toHaveBeenCalled();
  expect(book.bars.sh600519?.map((bar) => bar.date)).toEqual([calendar[0]]);
  expect(book.positions[0]!.value).toBe(15000);
});

it("weekly review uses every pending plan group, ignores its neutral proposed item and retains missing-group gaps", async () => {
  const f = fixture();
  f.alerts.savePlan(
    {
      id: "reserved-food",
      strategyId: "fixture",
      strategyVersion: 1,
      symbol: "sh600001",
      market: "cn-equity",
      sleeve: "swing",
      triggerKey: "fixed",
      entry: 10,
      quantity: 1600,
      tranches: 1,
      stop: 9,
      target: null,
      expiresAt: null,
      status: "open",
      createdAt: now,
    },
    now,
  );
  const book = await f.load();
  const result = accountWeeklyReview(book, calendar[0]!, f.repo, now);
  const reduce = result.suggestions.find((row) => row.action === "reduce");
  expect(reduce?.reason).toContain("industry/食品饮料 31000 > 30000");
  expect(result.riskUnknown.filter((row) => row.includes("行业组"))).toEqual(
    [],
  );
  const unknown = { ...book, positions: [position({ industryGroups: [] })] };
  expect(
    accountWeeklyReview(unknown, calendar[0]!, f.repo, now).riskUnknown.some(
      (row) => row.includes("行业组"),
    ),
  ).toBe(true);
});
