import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { settingsSchema } from "~/lib/domain";
import { capabilityAllows } from "~/lib/common/capabilities";
import {
  holdingTradeFingerprint,
  protectionPositionKey,
} from "~/lib/portfolio/holding-protection";
import { systemWatch } from "~/server/alerts/inputs/context";
import { intradayAlertStatusSchema } from "~/lib/strategy-facts/intraday-alerts";
import { createIntradayAlertService } from "~/server/alerts/intraday-alert-service";
import * as calendarSource from "~/server/data-sources/gf/gf-calendar";
import { alertsRouter } from "~/server/api/routers/alerts";
import { AlertRepository } from "~/server/db/alert-repository";
import { HoldingProtectionRepository } from "~/server/db/holding-protection-repository";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { loadAccountBook } from "~/server/portfolio/account-workspace/load-book";
import { settings } from "~/server/infra/settings";
import {
  saveIntradayAlertConfig,
  upsertIntradayWatchRule,
} from "~/server/db/intraday-alert-config-repository";
import type { OverviewQuotesResult } from "~/server/market/overview-quotes";
import {
  confirmSimOrder,
  createSimAccount,
} from "~/server/portfolio/sim-accounts/service";

const today = "2026-11-25",
  tomorrow = "2026-11-26",
  symbol = "sh600000";
const ms = (day: string, time = "10:00:00") =>
  Date.parse(`${day}T${time}+08:00`);
const config = {
  enabled: true,
  pollIntervalSec: 15,
  monitorHoldingsStops: false,
  monitorPlannedEntries: false,
  monitorWatchlistRules: true,
  intradayScanEnabled: false,
};
let repo: AlertRepository;
function policy(mode: "off" | "live" | "shadow", calendar = [today, tomorrow]) {
  repo.records.save(
    "settings",
    "settings",
    settingsSchema.parse({
      tdxRoot: join(process.env.QUANT_DATA_DIR!, "empty"),
      industryBlocksRoot: "",
      calendar,
      alerts: { mode },
    }),
  );
}
beforeEach(() => {
  repo = new AlertRepository();
  repo.db.exec("SAVEPOINT quote_fixture");
  policy("shadow");
  saveIntradayAlertConfig(config);
});
afterEach(() => {
  repo.db.exec("ROLLBACK TO quote_fixture");
  repo.db.exec("RELEASE quote_fixture");
  vi.restoreAllMocks();
});

function rule(id: string, direction: "above" | "below", thresholdPrice = 10) {
  return upsertIntradayWatchRule({
    id,
    symbol,
    direction,
    thresholdPrice,
    enabled: true,
    note: id,
  });
}
function seedHoldingPlan(stop: number) {
  repo.strategies.saveStrategy(systemWatch("fixture", "cn-equity", symbol));
  repo.savePlan(
    {
      id: "plan",
      strategyId: "fixture",
      strategyVersion: 1,
      symbol,
      market: "cn-equity",
      sleeve: "swing",
      triggerKey: "candidate",
      entry: 12,
      tranches: 1,
      quantity: 100,
      stop,
      target: 14,
      expiresAt: null,
      status: "closed",
    },
    ms(today) - 1000,
  );
}
function harness() {
  const clock = { at: ms(today), price: 10 };
  const readQuotes = vi.fn(
    async (symbols: readonly string[]): Promise<OverviewQuotesResult> => ({
      source: "腾讯实时",
      fetchedAt: clock.at,
      quotes: symbols.map((symbol) => ({
        symbol,
        price: clock.price,
        preClose: 10,
        amount: 100,
        quoteTime: new Date(clock.at + 8 * 3_600_000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),
      })),
    }),
  );
  const deps = { now: () => clock.at, readQuotes };
  return {
    ...createIntradayAlertService(deps),
    clock,
    readQuotes,
    restart: () => createIntradayAlertService(deps),
  };
}

it.each([
  [today, "09:24:59", "closed"],
  [today, "11:30:01", "lunch-break"],
  [today, "12:00:00", "lunch-break"],
  [today, "15:00:01", "closed"],
  [today, "15:30:00", "closed"],
  ["2026-11-28", "10:00:00", "closed"],
])(
  "makes zero quote calls at %s %s, including manual checks",
  async (day, time, session) => {
    rule("test", "above");
    const h = harness();
    h.clock.at = ms(day!, time);
    expect(await h.tick()).toBe(session);
    expect(await h.tick(true)).toBe(session);
    expect((await h.snapshot()).session).toBe(session);
    expect(h.readQuotes).not.toHaveBeenCalled();
  },
);
it("honors disabled, global off, and calendar-confirmed holiday before reading any quotes", async () => {
  rule("test", "above");
  const h = harness();
  saveIntradayAlertConfig({ ...config, enabled: false });
  expect(await h.tick()).toBe("disabled");
  saveIntradayAlertConfig(config);
  policy("off");
  expect(await h.tick()).toBe("off");
  policy("live", ["2026-11-24", tomorrow]);
  expect(await h.tick()).toBe("closed");
  expect(h.readQuotes).not.toHaveBeenCalled();
});
it("skips quotes throughout a calendar outage, allows a read-only manual preview, then resumes on confirmed evidence", async () => {
  rule("unconfirmed", "above");
  policy("live", ["2026-11-24"]);
  const calendar = vi
    .spyOn(calendarSource, "gfCalendarReference")
    .mockRejectedValue(new Error("fixture offline"));
  const h = harness();
  expect(await h.tick()).toBe("closed");
  h.clock.at += 31_000;
  expect(await h.tick()).toBe("closed");
  expect(calendar).toHaveBeenCalledTimes(1);
  expect(h.readQuotes).not.toHaveBeenCalled();
  expect(await h.runNow()).toMatchObject({
    warning: expect.stringContaining("交易日历未知"),
    snapshot: {
      session: "closed",
      lastResult: { freshCount: 1, triggeredCount: 0 },
    },
  });
  expect(h.readQuotes).toHaveBeenCalledTimes(1);
  expect(await h.snapshot()).toMatchObject({
    lastCheckedAt: null,
    lastResult: null,
    recentEvents: [],
    rules: [{ lastTriggeredDate: null }],
  });
  expect(repo.records.all("delivery")).toHaveLength(0);
  h.clock.at += 300_000;
  expect(await h.tick()).toBe("closed");
  expect(calendar).toHaveBeenCalledTimes(2);
  expect(h.readQuotes).toHaveBeenCalledTimes(1);
  policy("shadow", [today]);
  expect(await h.tick()).toBe("checked");
  expect((await h.snapshot()).recentEvents).toHaveLength(1);
});
it.each(["11:20", "14:40"])(
  "only adds an automatic check at %s when the slot switch is enabled",
  async (cutoff) => {
    rule("slot", "above", 20);
    const h = harness();
    saveIntradayAlertConfig({ ...config, pollIntervalSec: 300 });
    h.clock.at = ms(today, cutoff + ":00") - 1_000;
    expect(await h.tick()).toBe("checked");
    h.clock.at += 1_000;
    expect(await h.tick()).toBe("throttled");
    expect(h.readQuotes).toHaveBeenCalledTimes(1);
    saveIntradayAlertConfig({
      ...config,
      pollIntervalSec: 300,
      intradayScanEnabled: true,
    });
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("throttled");
    expect(await h.restart().tick()).toBe("throttled");
    expect(h.readQuotes).toHaveBeenCalledTimes(2);
  },
);
it.each(["09:25:00", "11:30:00", "13:00:00", "15:00:00"])(
  "includes the session boundary %s",
  async (time) => {
    rule("boundary", "above", 20);
    const h = harness();
    h.clock.at = ms(today, time);
    expect(await h.tick()).toBe("checked");
    expect(h.readQuotes).toHaveBeenCalledTimes(1);
  },
);
it("coalesces overlapping ticks and waits the full configured interval between requests", async () => {
  saveIntradayAlertConfig({ ...config, pollIntervalSec: 47 });
  rule("not-hit", "above", 20);
  const h = harness();
  await Promise.all([h.tick(), h.tick(), h.tick(true)]);
  h.clock.at += 46_999;
  expect(await h.tick()).toBe("throttled");
  expect(h.readQuotes).toHaveBeenCalledTimes(1);
  h.clock.at++;
  await h.tick();
  expect(h.readQuotes).toHaveBeenCalledTimes(2);
});
it("claims identical conditions once, marks every matching rule, and rearms both directions the next day", async () => {
  rule("a", "above");
  rule("b", "below");
  rule("duplicate", "above");
  const h = harness();
  await h.tick();
  expect(h.readQuotes).toHaveBeenCalledWith([symbol]);
  const first = await h.snapshot();
  expect(first.rules.map((r) => r.lastTriggeredDate)).toEqual([
    today,
    today,
    today,
  ]);
  expect(first.recentEvents.map((e) => e.triggerKind).sort()).toEqual([
    "watch_above",
    "watch_below",
  ]);
  h.clock.at = ms(tomorrow);
  await h.tick();
  const next = await h.snapshot();
  expect(next.rules.map((r) => r.lastTriggeredDate)).toEqual([
    tomorrow,
    tomorrow,
    tomorrow,
  ]);
  expect(new Set(next.recentEvents.map((e) => e.alertKey)).size).toBe(4);
});
it("uses the unified local-sim holding and its linked plan, preserves quote price and deduplicates after restart", async () => {
  saveIntradayAlertConfig({ ...config, monitorHoldingsStops: true });
  const h = harness();
  const { id } = createSimAccount(
    { name: "fixture", market: "cn-equity", initialCapital: "100000" },
    repo.db,
  );
  seedHoldingPlan(11);
  confirmSimOrder(
    {
      accountId: id,
      symbol,
      side: "buy",
      quantity: "100",
      price: "12",
      tradeDate: today,
      clientRequestId: "fixture",
      planId: "plan",
      executionMode: "plan-manual",
    },
    repo.db,
    h.clock.at,
  );
  expect((await h.snapshot()).holdings[0]).toMatchObject({
    price: null,
    kind: "local-sim",
    stopPrice: 11,
    targetPrice: 14,
  });
  expect(h.readQuotes).not.toHaveBeenCalled();
  await h.tick();
  h.clock.at += 20_000;
  h.clock.price = 9;
  await h.restart().tick();
  const view = await h.snapshot();
  expect(view.holdings[0]).toMatchObject({
    account: id,
    price: 9,
    distanceToStop: -2,
    distanceToTarget: 5,
    quoteStatus: "fresh",
  });
  expect(view.recentEvents).toHaveLength(1);
  const event = view.recentEvents[0]!;
  expect(repo.event(event.eventKey)).toMatchObject({
    alertKey: `intraday:${today}:${symbol}:stop_loss:11`,
    priceBasis: "intraday_quote",
    triggerKind: "stop_loss",
    type: "stop",
    price: 10,
    stop: 11,
    mode: "shadow",
  });
  h.clock.at += 20_000;
  h.clock.price = 14;
  await h.tick();
  expect((await h.snapshot()).recentEvents[0]).toMatchObject({
    triggerKind: "take_profit",
    price: 14,
  });
});
it("ignores expired and completed stages and observes an open plan without mutating its lifecycle", async () => {
  saveIntradayAlertConfig({ ...config, monitorPlannedEntries: true });
  const h = harness();
  const plan = {
    id: "p1",
    strategyId: "fixture",
    strategyVersion: 1,
    market: "cn-equity" as const,
    symbol,
    sleeve: "swing",
    triggerKey: "candidate",
    entry: 9,
    tranches: 2,
    quantity: 200,
    stop: 8,
    target: 13,
    expiresAt: null,
    status: "open" as const,
    stages: [
      { entry: 9, quantity: 100 },
      { entry: 10, quantity: 100 },
    ],
  };
  repo.strategies.saveStrategy(systemWatch("fixture", "cn-equity", symbol));
  repo.savePlan(plan, h.clock.at - 1000);
  repo.savePlan(
    {
      ...plan,
      id: "p2",
      entry: 7,
      stages: undefined,
      expiresAt: new Date(h.clock.at).toISOString(),
    },
    h.clock.at - 1000,
  );
  repo.saveState("plan-stages:p1", [0]);
  h.clock.price = 9.99;
  await h.tick();
  expect((await h.snapshot()).recentEvents).toEqual([]);
  h.clock.price = 10;
  h.clock.at += 15_000;
  await h.tick();
  expect((await h.snapshot()).recentEvents).toMatchObject([
    { triggerKind: "planned_entry", thresholdPrice: 10 },
  ]);
  expect(repo.strategies.plan("p1")?.status).toBe("open");
  expect(repo.state("plan-stages:p1")).toEqual([0]);
});
it("uses a current real-account protection projection and discards it after its bound fill changes", async () => {
  const h = harness();
  saveIntradayAlertConfig({ ...config, monitorHoldingsStops: true });
  seedHoldingPlan(8);
  const fill = {
    id: "fixture",
    symbol,
    date: today,
    side: "buy",
    price: 10,
    quantity: 100,
    fees: { total: 0 },
    createdAt: h.clock.at,
  };
  repo.db
    .prepare("INSERT INTO trade_ledger VALUES (?,?,?,?)")
    .run(fill.id, symbol, today, JSON.stringify(fill));
  const book = await loadAccountBook(
    new AccountWorkspaceRepository(repo.db),
    settings(),
    h.clock.at,
    { bars: {} },
  );
  const trade = book.trades[0]!;
  const id = protectionPositionKey(
    trade.kind,
    trade.account,
    trade.market,
    symbol,
  );
  new HoldingProtectionRepository(repo.db).save({
    id,
    kind: trade.kind,
    account: trade.account,
    market: trade.market,
    symbol,
    strategyId: "fixture",
    version: 1,
    planId: "plan",
    sleeve: "swing",
    trades: [{ id: trade.id, fingerprint: holdingTradeFingerprint(trade) }],
    entryDate: today,
    entryTime: null,
    entryPrice: 10,
    boundAt: h.clock.at,
    protection: {
      version: "plan-protection-1",
      exitSpec: {},
      initialStop: 8,
      target: 14,
      entryReference: 10,
      asOf: today,
    },
    status: "active",
    reason: null,
  });
  repo.saveState(`holding-protection:${id}`, {
    bindingAt: h.clock.at,
    task: { newStop: 10 },
    backupStop: 8,
  });
  await h.tick();
  expect((await h.snapshot()).recentEvents).toMatchObject([
    { triggerKind: "stop_loss", thresholdPrice: 10 },
  ]);
  repo.db
    .prepare("UPDATE trade_ledger SET payload=? WHERE id=?")
    .run(JSON.stringify({ ...fill, price: 11 }), fill.id);
  expect((await h.snapshot()).holdings).toEqual([]);
});
it("rolls the daily claim and rule date back on a write failure and retries only after the interval", async () => {
  rule("retry", "above");
  const h = harness();
  vi.spyOn(AlertRepository.prototype, "record").mockImplementationOnce(() => {
    throw new Error("fixture write failure");
  });
  await expect(h.tick()).rejects.toThrow("fixture write failure");
  expect(await h.snapshot()).toMatchObject({
    recentEvents: [],
    rules: [{ lastTriggeredDate: null }],
    lastResult: { status: "error" },
  });
  expect(await h.tick()).toBe("throttled");
  h.clock.at += 15_000;
  await h.tick();
  expect(await h.snapshot()).toMatchObject({
    recentEvents: [{ triggerKind: "watch_above" }],
    rules: [{ lastTriggeredDate: today }],
  });
});
it.each(["shadow", "live-disabled", "live-enabled"] as const)(
  "uses the existing subscription policy and transactional outbox in %s",
  async (scenario) => {
    policy(scenario === "shadow" ? "shadow" : "live");
    repo.records.save("channel", "ch", {
      id: "ch",
      type: "feishu",
      name: "stub",
      enabled: true,
      configured: true,
    });
    repo.records.save("alert-subscription", "alert-subscription:sub", {
      id: "sub",
      revision: "r1",
      enabled: scenario !== "live-disabled",
      market: "cn-equity",
      kinds: ["regime"],
      channels: ["ch"],
      symbols: [symbol],
      strategyIds: [],
    });
    rule("price", "below");
    const h = harness();
    await h.tick();
    expect((await h.snapshot()).recentEvents).toHaveLength(1);
    expect(repo.records.all("delivery")).toHaveLength(
      scenario === "live-enabled" ? 1 : 0,
    );
    if (scenario === "shadow")
      expect(repo.records.decisions()[0]?.tier).toBe("ledger");
    if (scenario === "live-enabled")
      expect(repo.records.all("delivery")[0]).toMatchObject({
        status: "pending",
        channelId: "ch",
      });
  },
);
it("rejects stale, undated and absent quotes without advancing rule dates", async () => {
  rule("old", "above");
  const h = harness();
  for (const quoteTime of [
    "2026-11-24 10:00:00",
    "10:00:00.000",
    null,
    "2026-11-25 10:30:00",
    "2026-11-25 09:50:00",
  ]) {
    h.readQuotes.mockResolvedValueOnce({
      source: "通达信实时",
      fetchedAt: h.clock.at,
      quotes: [{ symbol, price: 12, amount: 0, preClose: 10, quoteTime }],
    });
    await h.tick(true);
    expect((await h.snapshot()).lastResult?.staleCount).toBe(1);
  }
  h.readQuotes.mockResolvedValueOnce({
    source: "腾讯实时",
    fetchedAt: h.clock.at,
    quotes: [],
  });
  await h.tick(true);
  expect(await h.snapshot()).toMatchObject({
    recentEvents: [],
    rules: [{ lastTriggeredDate: null }],
    lastResult: { missingCount: 1 },
  });
});
it("rechecks the live switches and rule edits made while quotes were in flight", async () => {
  rule("edited", "above");
  const h = harness();
  const response = {
    source: "腾讯实时" as const,
    fetchedAt: h.clock.at,
    quotes: [
      {
        symbol,
        price: 12,
        amount: 1,
        preClose: 10,
        quoteTime: "2026-11-25 10:00:00",
      },
    ],
  };
  h.readQuotes.mockImplementationOnce(async () => {
    rule("edited", "above", 20);
    return response;
  });
  await h.tick();
  expect((await h.snapshot()).recentEvents).toEqual([]);
  h.readQuotes.mockImplementationOnce(async () => {
    saveIntradayAlertConfig({ ...config, enabled: false });
    return response;
  });
  expect(await h.tick(true)).toBe("disabled");
});
it("exposes the five flat bindings and validates CRUD inputs and snapshots through a caller", async () => {
  for (const [name, operation, type] of [
    ["intradayAlertOverview", "read", "query"],
    ["intradayAlertConfigSave", "configure", "mutation"],
    ["intradayWatchRuleSave", "configure", "mutation"],
    ["intradayWatchRuleDelete", "configure", "mutation"],
    ["intradayAlertRunNow", "configure", "mutation"],
  ] as const) {
    expect(alertsRouter._def.procedures[name]._def).toMatchObject({
      type,
      meta: { capability: "alerts", operation },
    });
    expect(capabilityAllows("alerts", operation)).toBe(true);
  }
  const api = alertsRouter.createCaller({ headers: new Headers() });
  await expect(
    api.intradayAlertConfigSave({ ...config, pollIntervalSec: 14 }),
  ).rejects.toThrow();
  await expect(
    api.intradayAlertConfigSave({ ...config, pollIntervalSec: 301 }),
  ).rejects.toThrow();
  await api.intradayAlertConfigSave({ ...config, enabled: false });
  const input = {
    symbol,
    thresholdPrice: 9,
    direction: "below" as const,
    enabled: true,
    note: "test",
  };
  await expect(
    api.intradayWatchRuleSave({ ...input, thresholdPrice: 0 }),
  ).rejects.toThrow();
  const saved = await api.intradayWatchRuleSave(input);
  const view = intradayAlertStatusSchema.parse(
    await api.intradayAlertOverview(),
  );
  expect(view.rules).toEqual([saved]);
  expect(view.monitoredSymbolCount).toBe(1);
  expect(await api.intradayAlertRunNow()).toMatchObject({
    result: "disabled",
    snapshot: { rules: [saved] },
  });
  expect(await api.intradayWatchRuleDelete({ id: saved.id })).toBe(true);
  expect(await api.intradayWatchRuleDelete({ id: saved.id })).toBe(false);
});
