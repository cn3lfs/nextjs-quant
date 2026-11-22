import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import type { PortfolioRequest } from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import frozen from "~/server/data/paper-candidates.json";
import { migrate } from "~/server/db/migrations";
import { PaperRepository } from "~/server/db/paper-repository";
import { advancePaper, type PaperInput } from "~/server/paper/advance";
import { paperCompletedAt } from "~/server/paper/advance-clock";
import {
  mirrorOrderFromTrades,
  synchronizePaperMirror,
  type MirrorRunner,
} from "~/server/paper/mirror";
import type { FrozenCandidate, PaperAccount } from "~/server/paper/model";
import { terminal, type Order } from "~/server/crypto-trading/model";
import type { MockTrade } from "~/server/portfolio/mock/mock-trading";

const connections: Database.Database[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});

const order = (quantity = "100"): Order => ({
  clientId: "p1",
  symbol: "BTCUSDT",
  side: "BUY",
  quantity,
  state: "NEW",
  fills: [],
});
const trade = (overrides: Partial<MockTrade> = {}): MockTrade => ({
  zqdm: "600519",
  mmlb: "买入",
  cjg: 10,
  cje: 1000,
  cjsl: 100,
  cjsj: "10:00:00",
  fee: 0.26,
  tradeNo: "T1",
  entrustNo: "E1",
  ...overrides,
});

it("maps a complete attributed fill to a terminal order with quantity, price and fee", () => {
  const remote = mirrorOrderFromTrades(order(), [trade()])!;
  expect(remote).toMatchObject({
    state: "FILLED",
    executedQuantity: "100",
    fills: [
      {
        id: "trade:T1",
        quantity: "100",
        price: "10",
        fee: "0.26",
        feeAsset: "CNY",
      },
    ],
  });
  expect(terminal(remote.state)).toBe(true);
});

it("keeps partial fills non-terminal and refuses rows without a usable quantity", () => {
  expect(
    mirrorOrderFromTrades(order(), [trade({ cjsl: 40, cje: 400 })]),
  ).toMatchObject({
    state: "PARTIALLY_FILLED",
    executedQuantity: "40",
  });
  expect(terminal("PARTIALLY_FILLED")).toBe(false);
  // The documented shape omits cjsl; the amount/price quotient is usable.
  expect(
    mirrorOrderFromTrades(order(), [trade({ cjsl: undefined, cje: 1000 })]),
  ).toMatchObject({ state: "FILLED", executedQuantity: "100" });
  expect(
    mirrorOrderFromTrades(order(), [
      trade({ cjsl: undefined, cjg: 0, cje: 0 }),
    ]),
  ).toBeNull();
  expect(mirrorOrderFromTrades(order(), [])).toBeNull();
});

it("never sums duplicate rows into a fill without trade numbers", () => {
  const half = () =>
    trade({ cjsl: 50, cje: 500, tradeNo: null, entrustNo: "E1" });
  // Two identical 50-share rows without a trade number may be the same
  // execution reported twice; treating them as 100 would fabricate a fill.
  expect(mirrorOrderFromTrades(order(), [half(), half()])).toBeNull();
  // A single row is still usable.
  expect(mirrorOrderFromTrades(order(), [half()])).toMatchObject({
    state: "PARTIALLY_FILLED",
    executedQuantity: "50",
  });
  // The same trade number reported twice is deduplicated, not added.
  expect(
    mirrorOrderFromTrades(order(), [
      trade({ cjsl: 50, cje: 500, tradeNo: "T9" }),
      trade({ cjsl: 50, cje: 500, tradeNo: "T9" }),
    ]),
  ).toMatchObject({
    state: "PARTIALLY_FILLED",
    executedQuantity: "50",
    fills: [{ id: "trade:T9", quantity: "50" }],
  });
  // Distinct trade numbers are genuine separate executions.
  expect(
    mirrorOrderFromTrades(order(), [
      trade({ cjsl: 50, cje: 500, tradeNo: "T9" }),
      trade({ cjsl: 50, cje: 500, tradeNo: "T10" }),
    ]),
  ).toMatchObject({ state: "FILLED", executedQuantity: "100" });
});

it("refuses conflicting executions that reuse one trade number", () => {
  // The same trade number with different quantity, price, fee or entrust
  // number is ambiguous; order of arrival must not decide the result.
  expect(
    mirrorOrderFromTrades(order(), [
      trade({ cjsl: 100, cje: 1000, tradeNo: "T1" }),
      trade({ cjsl: 40, cje: 400, tradeNo: "T1" }),
    ]),
  ).toBeNull();
  expect(
    mirrorOrderFromTrades(order(), [
      trade({ cjsl: 40, cje: 400, tradeNo: "T1" }),
      trade({ cjsl: 100, cje: 1000, tradeNo: "T1" }),
    ]),
  ).toBeNull();
  expect(
    mirrorOrderFromTrades(order(), [
      trade({ tradeNo: "T1", entrustNo: "E1" }),
      trade({ tradeNo: "T1", entrustNo: "E2" }),
    ]),
  ).toBeNull();
});

function bar(date: string, price = 10): Bar {
  return {
    date,
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
    volume: 1000,
    amount: 10000,
  };
}

function fixture() {
  const db = new Database(":memory:");
  connections.push(db);
  db.pragma("foreign_keys=ON");
  migrate(db);
  const repo = new PaperRepository(db);
  const dates = [
    "2026-10-09",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
  ];
  const strategy: StrategyObjectInput = {
    id: "mock-reconcile-fixture",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "formula", source: "选股:C=10;" },
    exit: { rule: { kind: "formula", source: "退出:C<10;" } },
    sizing: { kind: "weight", weight: 1, tranches: 1 },
    sleeve: "swing",
  };
  const candidate = {
    ...(frozen.candidates[0] as unknown as FrozenCandidate),
    strategy,
  };
  const account: PaperAccount = {
    id: "paper:mock-reconcile",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    startedAt: Date.parse("2026-10-09T00:00:00Z"),
    initial: 10000,
    candidates: [candidate],
    mirror: { venue: "off" },
    mirrorRevision: "first",
    revision: 0,
    lastBar: null,
    lastRun: null,
    error: null,
    summary: null,
  };
  repo.create(account);
  const bars = dates.map((date, index) => bar(date, index >= 2 ? 9 : 10));
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 10000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [
      {
        symbol: "sh600000",
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixed QA market rule evidence",
          minimum: 100,
          step: 100,
          limitDown: null,
          limitUp: null,
          tradable: true,
        },
      },
    ],
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      ...defaultExecutionCosts,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  };
  const input: PaperInput = {
    request,
    benchmark: dates.map((date) => bar(date)),
    readyDates: dates,
    source: "fixed QA fixture, never live evidence",
  };
  return { repo, account, request, input, dates };
}

it("persists entrust numbers and only settles a fully attributed mirror fill", async () => {
  const f = fixture();
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 2) } },
    Date.parse("2026-10-16T00:00:00Z"),
  );
  const fill = f.repo.state(f.account.id)!.result.fills[0]!;
  expect(fill.quantity).toBe(1000);
  const current = f.repo.account(f.account.id)!;
  const completedAt = paperCompletedAt(current, fill.date);
  const account = f.repo.save(
    {
      ...current,
      mirror: { venue: "ths", network: "simulation" },
      mirrorSince: completedAt - 1,
    },
    current.revision,
  );
  const key = `${account.mirrorRevision}:0`;
  const record = () =>
    f.repo.factValue<{
      phase: string;
      remoteRef?: string[];
      remote?: { state: string; executedQuantity?: string };
    }>(f.account.id, "mirror", key)!;
  let placed = 0;
  let mode: "none" | "throw" | "partial" | "full" = "none";
  const runner: MirrorRunner = async (_account, work) =>
    work({
      revision: "ths-simulation",
      snapshot: async () => ({ balances: [], openOrders: [] }),
      prepare: async (o) => o,
      place: async () => {
        placed += 1;
        return { message: "已受理", entrustNos: ["E1"] };
      },
      reconcile: async (o, remoteRef, tradeDate) => {
        expect(remoteRef).toEqual(["E1"]);
        expect(tradeDate).toBe(fill.date.slice(0, 10));
        if (mode === "throw") throw new Error("场所查询失败");
        if (mode === "none") return null;
        return mirrorOrderFromTrades(o, [
          trade({
            cjsl: mode === "partial" ? 400 : 1000,
            cje: mode === "partial" ? 4000 : 10000,
          }),
        ]);
      },
      evidence: async () => ({ attributable: false }),
    });
  const now = completedAt + 60_000;

  await synchronizePaperMirror(f.repo, f.account.id, now, runner);
  expect(placed).toBe(1);
  expect(record()).toMatchObject({ phase: "unknown", remoteRef: ["E1"] });

  // No attribution: remain unknown and never resend.
  await synchronizePaperMirror(f.repo, f.account.id, now, runner);
  expect(placed).toBe(1);
  expect(record().phase).toBe("unknown");

  // A failed lookup is not treated as "no fill".
  mode = "throw";
  await expect(
    synchronizePaperMirror(f.repo, f.account.id, now, runner),
  ).rejects.toThrow("场所查询失败");
  expect(placed).toBe(1);
  expect(record()).toMatchObject({ phase: "unknown", remoteRef: ["E1"] });

  // A partial fill keeps the mirror unresolved for the next reconciliation.
  mode = "partial";
  await synchronizePaperMirror(f.repo, f.account.id, now, runner);
  expect(placed).toBe(1);
  expect(record()).toMatchObject({
    phase: "unknown",
    remote: { state: "PARTIALLY_FILLED", executedQuantity: "400" },
  });

  // Only the complete, terminal fill settles the mirror.
  mode = "full";
  await synchronizePaperMirror(f.repo, f.account.id, now, runner);
  expect(placed).toBe(1);
  expect(record()).toMatchObject({
    phase: "settled",
    remoteRef: ["E1"],
    remote: { state: "FILLED", executedQuantity: "1000" },
  });
});

it("does not query or attribute an unresolved mirror after the credential changed", async () => {
  const f = fixture();
  advancePaper(
    f.repo,
    f.account.id,
    { ...f.input, request: { ...f.request, calendar: f.dates.slice(0, 2) } },
    Date.parse("2026-10-16T00:00:00Z"),
  );
  const fill = f.repo.state(f.account.id)!.result.fills[0]!;
  const current = f.repo.account(f.account.id)!;
  const completedAt = paperCompletedAt(current, fill.date);
  const account = f.repo.save(
    {
      ...current,
      mirror: { venue: "ths", network: "simulation" },
      mirrorSince: completedAt - 1,
    },
    current.revision,
  );
  const key = `${account.mirrorRevision}:0`;
  let queries = 0;
  const runner =
    (revision: string): MirrorRunner =>
    async (_account, work) =>
      work({
        revision,
        snapshot: async () => ({ balances: [], openOrders: [] }),
        prepare: async (o) => o,
        place: async () => ({ message: "已受理", entrustNos: ["E1"] }),
        reconcile: async () => {
          queries += 1;
          return null;
        },
      });
  const now = completedAt + 60_000;
  await synchronizePaperMirror(f.repo, f.account.id, now, runner("ths:before"));
  expect(f.repo.factValue(f.account.id, "mirror", key)).toMatchObject({
    phase: "unknown",
    credentialRevision: "ths:before",
    remoteRef: ["E1"],
    remote: null,
  });
  // Replacing the credential must not look up the new account's trades and
  // must not attribute anything to the old intent.
  await expect(
    synchronizePaperMirror(f.repo, f.account.id, now, runner("ths:after")),
  ).rejects.toThrow("镜像凭证已变化");
  expect(queries).toBe(0);
  expect(f.repo.factValue(f.account.id, "mirror", key)).toMatchObject({
    phase: "unknown",
    credentialRevision: "ths:before",
    remote: null,
  });
});
