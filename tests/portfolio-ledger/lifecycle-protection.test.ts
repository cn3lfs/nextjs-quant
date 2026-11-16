import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { migrate } from "~/server/db/migrations";
import { DeliveryStore } from "~/server/db/delivery-store";
import { AlertRepository } from "~/server/db/alert-repository";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { HoldingProtectionRepository } from "~/server/db/holding-protection-repository";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "~/lib/research/evidence/delivery-import";
import {
  loadAccountBook,
  linkAccountTrade,
} from "~/server/portfolio/account-workspace-service";
import { evaluateAlertInputs } from "~/server/alerts/inputs";
import { stopTasks } from "~/server/portfolio/holding-protection-service";
import {
  activeHoldingRound,
  holdingProtectionCurrent,
  observeHoldingProtection,
} from "~/lib/portfolio/holding-protection";
import { settingsSchema, type Bar } from "~/lib/domain";
import { saveSettings } from "~/server/infra/settings";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";

const fixture = vi.hoisted(() => ({ bars: [] as Bar[] }));
const calendar = ["2026-01-08", "2026-01-09", "2026-01-12"];
vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars: async () => ({
    bars: fixture.bars,
    rawBars: fixture.bars,
    source: "fixed",
    hash: "fixed",
    adjustment: "none",
    barStore: { formingDates: [] },
  }),
}));
vi.mock("~/server/portfolio/trade-ledger-service", () => ({
  tradePositionState: async () => ({ positions: [] }),
  tradeContext: async () => ({
    today: "2026-01-08",
    calendar: ["2026-01-05", "2026-01-07", ...calendar],
    calendarSource: "fixture",
    evidence: () => ({
      events: [],
      coverageEnd: "2026-12-31",
      source: "fixed",
    }),
  }),
}));
const connections: Database.Database[] = [];
beforeEach(() => {
  fixture.bars = [
    {
      date: "2026-01-08",
      open: 10,
      high: 12,
      low: 9.5,
      close: 10,
      volume: 10000,
      amount: 80000,
    },
  ];
});

it("plan expiry blocks a new entry, but partial and complete exits can still be associated with its original round", async () => {
  const s = seed(),
    now = Date.parse("2026-01-14T17:05:00+08:00");
  const plan = s.alerts.strategies.plan("linked-plan")!;
  s.db
    .prepare("UPDATE trade_plans SET payload=? WHERE id=?")
    .run(
      JSON.stringify({ ...plan, expiresAt: "2026-01-08T12:00:00+08:00" }),
      plan.id,
    );
  const first = await loadAccountBook(s.repo, s.config, now);
  const buy = first.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  const link = (
    tradeId: string,
    book: Awaited<ReturnType<typeof loadAccountBook>>,
  ) =>
    linkAccountTrade(
      {
        tradeId,
        planId: plan.id,
        alertKey: null,
        strategyId: s.strategy.id,
        strategyVersion: 1,
        sleeve: "swing",
      },
      book,
      s.repo,
    );
  link(buy.id, first);
  const importRow = (row: string) => {
    const raw = Buffer.from(
      readFileSync("tests/fixtures/delivery/r3b-account.csv", "utf8").split(
        /\r?\n/,
      )[0] +
        "\n" +
        row +
        "\n",
    );
    const table = parseDeliveryTable(raw),
      parsed = importDeliveryTable(table);
    new DeliveryStore(s.db).commitImport({
      account: "account-a",
      source: "generic",
      fileHash: createHash("sha256").update(raw).digest("hex"),
      fileName: "exit.csv",
      importedAt: now,
      parsed,
      rawRows: table.rows,
      sourceHeader: table.header,
    });
  };
  importRow("20260109,100000,证券卖出,600000,40,9,360,360,8960,60,0,partial");
  let book = await loadAccountBook(s.repo, s.config, now);
  link(
    book.trades.find(
      (t) => t.account === "account-a" && t.date === "2026-01-09",
    )!.id,
    book,
  );
  book = await loadAccountBook(s.repo, s.config, now);
  expect(holdingProtectionCurrent(s.protections.all()[0]!, book.trades)).toBe(
    true,
  );
  importRow("20260112,100000,证券卖出,600000,60,10,600,600,9560,0,0,complete");
  book = await loadAccountBook(s.repo, s.config, now);
  link(
    book.trades.find(
      (t) => t.account === "account-a" && t.date === "2026-01-12",
    )!.id,
    book,
  );
  expect(
    (await stopTasks(s.repo, s.config, now)).filter(
      (t) => t.account === "account-a",
    ),
  ).toEqual([]);
  importRow(
    "20260113,100000,证券买入,600000,100,10,1000,-1000,8560,100,0,late-buy",
  );
  book = await loadAccountBook(s.repo, s.config, now);
  expect(() =>
    link(
      book.trades.find(
        (t) => t.account === "account-a" && t.date === "2026-01-13",
      )!.id,
      book,
    ),
  ).toThrow("超出计划有效期");
});

it("an unproven same-time buy/sell ordering cannot invent a new holding round", async () => {
  const s = seed(),
    book = await loadAccountBook(
      s.repo,
      s.config,
      Date.parse("2026-01-08T17:05:00+08:00"),
    );
  const original = book.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  const time = original.time + 86400000;
  const sell = {
    ...original,
    id: "a-sell",
    side: "sell" as const,
    time,
    quantity: 100,
    sourceOrder: undefined,
  };
  const buy = {
    ...original,
    id: "z-buy",
    time,
    quantity: 100,
    sourceOrder: undefined,
  };
  expect(activeHoldingRound([original, buy, sell], original).ambiguous).toBe(
    true,
  );
  expect(activeHoldingRound([original, sell, buy], original).ambiguous).toBe(
    true,
  );
  const proven = activeHoldingRound(
    [
      original,
      { ...buy, sourceOrder: { source: "statement", index: 2 } },
      { ...sell, sourceOrder: { source: "statement", index: 1 } },
    ],
    original,
  );
  expect(proven.ambiguous).toBe(false);
  expect(proven.trades.map((t) => t.id)).toEqual([buy.id]);
});

it("4h protection starts at the real entry instant and is due at the next native period, not tomorrow", async () => {
  const s = seed(),
    book = await loadAccountBook(
      s.repo,
      s.config,
      Date.parse("2026-01-08T17:05:00+08:00"),
    );
  const trade = book.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: "linked-plan",
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    book,
    s.repo,
  );
  const binding = s.protections.all()[0]!;
  const crypto = {
    ...binding,
    market: "crypto" as const,
    symbol: "BTCUSDT",
    entryDate: "2026-01-08T09:00:00Z",
    entryTime: Date.parse("2026-01-08T09:00:00Z"),
    entryPrice: 100,
    protection: {
      version: "plan-protection-1" as const,
      exitSpec: {
        stop: { kind: "fixed" as const, fraction: 0.1 },
        trailing: 0.1,
        maxBars: 2,
      },
      initialStop: 90,
      target: null,
      entryReference: 100,
      asOf: "2026-01-08",
    },
  };
  const b = (hour: number, high: number) => ({
    date: `2026-01-08T${String(hour).padStart(2, "0")}:00:00+00:00`,
    open: 100,
    high,
    low: 95,
    close: 100,
    volume: 100,
    amount: 10000,
  });
  const bars = [
    b(4, 500),
    b(8, 400),
    b(12, 110),
    { ...b(16, 120), open: 110, low: 105, close: 115 },
  ];
  const first = observeHoldingProtection(
    crypto,
    bars,
    [],
    Date.parse("2026-01-08T12:01:00Z"),
    undefined,
    { period: "4h" },
  );
  expect(first.bars).toBe(1);
  expect(first.high).toBe(110);
  expect(first.task).toMatchObject({
    newStop: 99,
    status: "set",
    dueDate: "2026-01-08",
    dueAt: "2026-01-08T12:00:00.000Z",
  });
  const second = observeHoldingProtection(
    crypto,
    bars,
    [],
    Date.parse("2026-01-08T16:01:00Z"),
    first,
    { period: "4h" },
  );
  expect(second.bars).toBe(2);
  expect(second.task.status).toBe("time-exit");
  expect(second.task.dueAt).toBe("2026-01-08T16:00:00.000Z");
  expect(
    observeHoldingProtection(
      { ...crypto, entryTime: null },
      bars,
      [],
      Date.parse("2026-01-08T16:01:00Z"),
      undefined,
      { period: "4h" },
    ).task.status,
  ).toBe("needs-review");
  const lunch = { ...fixture.bars[0]!, date: "2026-01-08T11:30:00+08:00" };
  const cn = observeHoldingProtection(
    binding,
    [lunch],
    calendar,
    Date.parse("2026-01-08T11:31:00+08:00"),
    undefined,
    { period: "5m" },
  );
  expect(cn.task.dueAt).toBe("2026-01-08T05:00:00.000Z");
});
afterEach(() => connections.splice(0).forEach((db) => db.close()));
function seed() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const raw = readFileSync("tests/fixtures/delivery/r3b-account.csv"),
    table = parseDeliveryTable(raw),
    parsed = importDeliveryTable(table);
  for (const account of ["account-a", "account-b"])
    new DeliveryStore(db).commitImport({
      account,
      source: "generic",
      fileHash: createHash("sha256").update(raw).digest("hex"),
      fileName: "fixed.csv",
      importedAt: 1,
      parsed,
      rawRows: table.rows,
      sourceHeader: table.header,
    });
  const alerts = new AlertRepository(db),
    repo = new AccountWorkspaceRepository(db);
  const strategy: StrategyObjectInput = {
    id: "linked-protection",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols: ["sh600000"] },
    entry: { kind: "constant", value: true },
    exit: { stop: { kind: "fixed", fraction: 0.1 }, trailing: 0.1, maxBars: 2 },
    sizing: { kind: "weight", weight: 0.1 },
  };
  alerts.strategies.saveStrategy(strategy);
  alerts.savePlan(
    {
      id: "linked-plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol: "sh600000",
      sleeve: "swing",
      triggerKey: "fixed",
      entry: 10,
      quantity: 100,
      tranches: 1,
      stop: 9,
      target: null,
      expiresAt: null,
      status: "open",
      createdAt: Date.parse("2026-01-02"),
      protection: {
        version: "plan-protection-1",
        exitSpec: strategyObjectSchema.parse(strategy).exit,
        initialStop: 9,
        target: null,
        entryReference: 10,
        asOf: "2026-01-02",
      },
    },
    1,
  );
  const config = settingsSchema.parse({
    tdxRoot: process.env.QUANT_DATA_DIR!,
    calendar,
    alerts: { capital: { "cn-equity": 100000 } },
  });
  saveSettings(config);
  return {
    db,
    alerts,
    repo,
    strategy,
    config,
    protections: new HoldingProtectionRepository(db),
  };
}
it("a linked imported holding inherits the full plan, keeps account identity and proposes the next close's trailing/time exit", async () => {
  const s = seed(),
    now = Date.parse("2026-01-08T17:05:00+08:00");
  const book = await loadAccountBook(s.repo, s.config, now);
  const trade = book.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: "linked-plan",
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    book,
    s.repo,
  );
  const binding = s.protections.all()[0]!;
  expect(binding).toMatchObject({
    account: "account-a",
    status: "active",
    protection: { exitSpec: s.strategy.exit },
  });
  const input = await evaluateAlertInputs("close", now, s.alerts, "2026-01-08");
  const protective = input.proposals.filter((p) => p.event.type === "stop");
  expect(protective).toHaveLength(0);
  for (const state of input.states) s.alerts.saveState(state.id, state.value);
  let tasks = await stopTasks(s.repo, s.config, now);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    account: "account-a",
    oldStop: 9,
    newStop: 10.8,
    dueDate: "2026-01-09",
    status: "set",
  });
  expect(tasks[0]!.reason).toContain("未认证已挂单");
  fixture.bars.push({
    date: "2026-01-09",
    open: 12,
    high: 13,
    low: 11.5,
    close: 12,
    volume: 10000,
    amount: 120000,
  });
  const nextNow = Date.parse("2026-01-09T17:05:00+08:00");
  const next = await evaluateAlertInputs(
    "close",
    nextNow,
    s.alerts,
    "2026-01-09",
  );
  for (const state of next.states) s.alerts.saveState(state.id, state.value);
  tasks = await stopTasks(s.repo, s.config, nextNow);
  expect(tasks[0]).toMatchObject({
    account: "account-a",
    oldStop: 10.8,
    newStop: 11.700000000000001,
    dueDate: "2026-01-12",
    status: "time-exit",
  });
});
it("changing a source fill or clearing a source link disconnects protection without mutating the trade", async () => {
  const s = seed(),
    now = Date.parse("2026-01-08T17:05:00+08:00");
  const book = await loadAccountBook(s.repo, s.config, now),
    trade = book.trades.find(
      (t) => t.account === "account-a" && t.date === "2026-01-08",
    )!;
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: "linked-plan",
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    book,
    s.repo,
  );
  const linked = await loadAccountBook(s.repo, s.config, now),
    binding = s.protections.all()[0]!;
  expect(holdingProtectionCurrent(binding, linked.trades)).toBe(true);
  expect(
    holdingProtectionCurrent(
      binding,
      linked.trades.map((t) =>
        t.id === trade.id ? { ...t, price: t.price + 1 } : t,
      ),
    ),
  ).toBe(false);
  expect(
    holdingProtectionCurrent(
      binding,
      linked.trades.map((t) =>
        t.id === trade.id ? { ...t, time: t.time - 1 } : t,
      ),
    ),
  ).toBe(false);
  expect(
    holdingProtectionCurrent(
      binding,
      linked.trades.map((t) =>
        t.id === trade.id ? { ...t, planId: null } : t,
      ),
    ),
  ).toBe(false);
  const before = new DeliveryStore(s.db).fills();
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: null,
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    linked,
    s.repo,
  );
  const tasks = await stopTasks(s.repo, s.config, now);
  expect(tasks[0]?.status).toBe("needs-review");
  expect(new DeliveryStore(s.db).fills()).toEqual(before);
});
it("rechecking the same completed bar cannot apply its new trailing stop retrospectively", async () => {
  const s = seed(),
    now = Date.parse("2026-01-08T17:05:00+08:00"),
    book = await loadAccountBook(s.repo, s.config, now);
  const trade = book.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: "linked-plan",
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    book,
    s.repo,
  );
  const binding = s.protections.all()[0]!,
    first = observeHoldingProtection(binding, fixture.bars, calendar, now);
  expect(first.backupStop).toBe(9);
  expect(
    observeHoldingProtection(
      binding,
      fixture.bars,
      calendar,
      now + 60000,
      first,
    ),
  ).toBe(first);
});

it("imported holdings receive the same close-crossing backup alert after linking", async () => {
  const s = seed(),
    now = Date.parse("2026-01-08T17:05:00+08:00"),
    book = await loadAccountBook(s.repo, s.config, now);
  const trade = book.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: "linked-plan",
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    book,
    s.repo,
  );
  fixture.bars = [{ ...fixture.bars[0]!, low: 7, close: 8 }];
  const input = await evaluateAlertInputs("close", now, s.alerts, "2026-01-08");
  const stop = input.proposals.find((p) => p.event.type === "stop")!;
  expect(stop.event.stop).toBe(9);
  expect(
    input.states.find((p) => p.id.startsWith("holding-protection:"))?.value,
  ).toMatchObject({ task: { status: "stop-exit" } });
});
it("missing bars, unverified ATR and unknown exit rules cannot silently raise a stop", async () => {
  const s = seed(),
    now = Date.parse("2026-01-08T17:05:00+08:00"),
    book = await loadAccountBook(s.repo, s.config, now);
  const trade = book.trades.find(
    (t) => t.account === "account-a" && t.date === "2026-01-08",
  )!;
  linkAccountTrade(
    {
      tradeId: trade.id,
      planId: "linked-plan",
      alertKey: null,
      strategyId: s.strategy.id,
      strategyVersion: 1,
      sleeve: "swing",
    },
    book,
    s.repo,
  );
  const binding = s.protections.all()[0]!;
  if (binding.protection.version !== "plan-protection-1")
    throw new Error("fixture");
  const atr = {
    ...binding,
    protection: {
      ...binding.protection,
      exitSpec: {
        ...binding.protection.exitSpec,
        stop: { kind: "atr" as const, period: 14, multiple: 3 },
      },
    },
  };
  expect(
    observeHoldingProtection(atr, fixture.bars, calendar, now).task,
  ).toMatchObject({ status: "needs-review", newStop: null });
  const rule = {
    ...binding,
    protection: {
      ...binding.protection,
      exitSpec: {
        ...binding.protection.exitSpec,
        rule: { kind: "constant" as const, value: true },
      },
    },
  };
  expect(
    observeHoldingProtection(rule, fixture.bars, calendar, now).task.status,
  ).toBe("needs-review");
  expect(
    observeHoldingProtection(rule, fixture.bars, calendar, now, undefined, {
      ruleExit: true,
    }).task.status,
  ).toBe("rule-exit");
  expect(
    observeHoldingProtection(
      binding,
      [...fixture.bars, { ...fixture.bars[0]!, date: "2026-01-12", high: 20 }],
      calendar,
      Date.parse("2026-01-12T17:05:00+08:00"),
    ).task,
  ).toMatchObject({ status: "needs-review", newStop: null });
  expect(
    observeHoldingProtection(binding, fixture.bars, calendar, now, undefined, {
      evidenceIssue: "公司行动需人工核验",
    }).task,
  ).toMatchObject({ status: "needs-review", newStop: null });
});
