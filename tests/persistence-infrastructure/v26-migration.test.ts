import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, migrations } from "~/server/db/migrations";
import { createDeployment } from "~/server/db/deployment-repository";
import {
  getOrCreatePipelineRun,
  insertOrderIntents,
} from "~/server/db/pipeline-repository";
import {
  getAccountRiskState,
  listAccountRiskStates,
  upsertAccountRiskState,
} from "~/server/db/account-risk-state-repository";
import {
  deleteZeroSleeveHolding,
  listAccountSleeveHoldings,
  listOwnerSleeveHoldings,
  syncSleeveHoldingDelta,
  upsertSleeveHolding,
} from "~/server/db/sleeve-holding-repository";
import {
  listFillLinksByAccount,
  listFillLinksByIntentIds,
  listFillLinksByPlanId,
  recordExecutionFillLink,
} from "~/server/db/execution-fill-link-repository";
import {
  deleteIntradayWatchRule,
  getIntradayAlertConfig,
  listIntradayWatchRules,
  markIntradayWatchRuleTriggered,
  saveIntradayAlertConfig,
  upsertIntradayWatchRule,
} from "~/server/db/intraday-alert-config-repository";

const tables = [
  "account_risk_states",
  "account_sleeve_holdings",
  "execution_fill_links",
  "intraday_alert_config",
  "intraday_watch_rules",
];
const indexes = [
  "account_sleeve_holdings_account_symbol",
  "execution_fill_links_account",
  "execution_fill_links_intent",
  "execution_fill_links_plan",
  "intraday_watch_rules_enabled_symbol",
];
const account = { accountScope: "local_sim", accountId: "shared" } as const;
const owner = {
  ...account,
  ownerKind: "deployment",
  ownerId: "first",
} as const;
const key = { ...owner, symbol: "sh510300" };
const day = "2026-11-23";
const nextDay = "2026-11-24";

function seedBusiness(db: Database.Database) {
  createDeployment(
    {
      id: "first",
      name: "部署一",
      market: "cn-equity",
      strategySpec: { kind: "double-breakout" },
      universeSpec: { kind: "fixed-symbols", symbols: [key.symbol] },
      regimeGate: { kind: "none" },
      riskPolicy: { maxConsecutiveFailures: 2 },
      venueBinding: { kind: "local_sim", simAccountId: account.accountId },
      schedule: { kind: "manual_only" },
      provenance: { sourceKind: "manual" },
    },
    db,
  );
  const { run } = getOrCreatePipelineRun(
    {
      deploymentId: "first",
      decisionDate: day,
      executeDate: nextDay,
      triggerKind: "manual",
    },
    db,
  );
  const [intent] = insertOrderIntents(
    run.id,
    [
      {
        runId: run.id,
        deploymentId: "first",
        venueKind: "local_sim",
        symbol: key.symbol,
        side: "BUY",
        phase: 2,
        quantity: 100,
        referencePrice: 10,
      },
    ],
    db,
  );
  db.exec(`INSERT INTO rebalance_plans (id,account_scope,account_id,source_kind,source_ref_id,
    as_of_date,execute_date,status,orders_json,risk_summary_json,expires_at,created_at,updated_at)
    VALUES ('plan','paper','shared','manual','source','2026-11-23','2026-11-24','draft','[]','{}',99,1,1)`);
  return intent!.id;
}

function installV25(db: Database.Database) {
  db.transaction(() => {
    for (const sql of migrations.slice(0, 25)) db.exec(sql);
    db.pragma("user_version=25");
    seedBusiness(db);
  })();
}

function schema(db: Database.Database) {
  return db
    .prepare<
      [],
      { name: string; tbl_name: string; type: string; sql: string | null }
    >("SELECT name,tbl_name,type,sql FROM sqlite_schema ORDER BY name")
    .all();
}

function rows(db: Database.Database, objects: ReturnType<typeof schema>) {
  return objects
    .filter(({ type }) => type === "table")
    .map(({ name }) =>
      db
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .safeIntegers()
        .all(),
    );
}

it("preserves every v25 schema object and row across upgrade and disk reopen", () => {
  expect(
    createHash("sha256")
      .update(JSON.stringify(migrations.slice(0, 25)))
      .digest("hex"),
  ).toBe("d93fc134be416d437c5427161699713e7d5df07546f7afa1d1e8727b11238919");
  const path = join(process.env.QUANT_DATA_DIR!, "upgrade-v26.sqlite");
  let db = new Database(path);
  try {
    installV25(db);
    expect(db.pragma("user_version", { simple: true })).toBe(25);
    const old = schema(db),
      data = rows(db, old);
    migrate(db);
    const upgraded = schema(db);
    expect(
      upgraded.filter((object) => !tables.includes(object.tbl_name)),
    ).toEqual(old);
    expect(rows(db, old)).toEqual(data);
    expect(
      upgraded
        .filter(
          ({ type, tbl_name, sql }) =>
            type === "index" && tables.includes(tbl_name) && sql !== null,
        )
        .map(({ name }) => name),
    ).toEqual(indexes);
    const strict = db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_list WHERE strict=1",
      )
      .all()
      .map((row) => row.name);
    expect(strict).toEqual(expect.arrayContaining(tables));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("user_version", { simple: true })).toBe(26);
    db.close();
    db = new Database(path, { fileMustExist: true });
    migrate(db);
    expect(schema(db)).toEqual(upgraded);
    expect(rows(db, old)).toEqual(data);
    expect(db.pragma("user_version", { simple: true })).toBe(26);
  } finally {
    if (db.open) db.close();
  }
});

it.each(["last index collision", "future v27"])(
  "leaves schema, business data and version intact on %s",
  (reason) => {
    const db = new Database(":memory:");
    try {
      installV25(db);
      const future = reason === "future v27";
      if (future) db.pragma("user_version=27");
      else
        db.exec(
          "CREATE INDEX intraday_watch_rules_enabled_symbol ON pipeline_runs(started_at)",
        );
      const before = schema(db),
        data = rows(db, before);
      expect(() => migrate(db)).toThrow(
        future
          ? /数据库版本高于/
          : /index intraday_watch_rules_enabled_symbol already exists/,
      );
      expect(schema(db)).toEqual(before);
      expect(rows(db, before)).toEqual(data);
      expect(db.pragma("user_version", { simple: true })).toBe(
        future ? 27 : 25,
      );
    } finally {
      db.close();
    }
  },
);

describe("v26 repositories", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => db.close());

  it("round-trips risk regimes without mixing identically named accounts across venues", () => {
    expect(getAccountRiskState(account, db)).toBeNull();
    const state = upsertAccountRiskState(
      {
        ...account,
        asOfDate: day,
        unitNav: 1,
        peakUnitNav: 1,
        drawdownPct: 0,
        regime: "normal",
      },
      db,
    );
    const paper = upsertAccountRiskState(
      { ...state, accountScope: "paper" },
      db,
    );
    const halted = upsertAccountRiskState(
      {
        ...state,
        asOfDate: nextDay,
        unitNav: 0.9,
        drawdownPct: 10,
        regime: "halted",
        recoveryStreak: 1,
      },
      db,
    );
    expect(getAccountRiskState(account, db)).toEqual(halted);
    expect(listAccountRiskStates(db)).toEqual([halted, paper]);
    expect(() =>
      upsertAccountRiskState({ ...state, unitNav: Infinity }, db),
    ).toThrow();
    for (const invalid of [
      "account_scope='other'",
      "regime='buy'",
      "unit_nav=0",
      "peak_unit_nav=-1",
      "drawdown_pct=-1",
      "recovery_streak=-1",
    ]) {
      expect(() =>
        db.exec("UPDATE account_risk_states SET " + invalid),
      ).toThrow(/CHECK constraint/);
    }
  });

  it("weights only new purchases, preserves the first fill date and keeps each owner's cash reservation", () => {
    const reservation = {
      ...key,
      quantity: 0,
      avgEntryPrice: null,
      entryDate: null,
      reservedCash: 17,
    };
    upsertSleeveHolding(reservation, db);
    const second = upsertSleeveHolding(
      { ...reservation, ownerId: "second", reservedCash: 3 },
      db,
    );
    const fill = {
      ...key,
      symbol: "SH510300",
      fillPrice: 10,
      quantityDelta: 100,
      tradeDate: day,
    };
    expect(syncSleeveHoldingDelta(fill, db)).toMatchObject({
      quantity: 100,
      avgEntryPrice: 10,
      entryDate: day,
      reservedCash: 17,
    });
    const increased = syncSleeveHoldingDelta(
      { ...fill, quantityDelta: 300, fillPrice: 14, tradeDate: nextDay },
      db,
    )!;
    expect(increased).toMatchObject({
      quantity: 400,
      avgEntryPrice: 13,
      entryDate: day,
    });
    expect(listAccountSleeveHoldings(account, db)).toEqual([increased, second]);
    expect(deleteZeroSleeveHolding(key, db)).toBe(false);
    const reduced = syncSleeveHoldingDelta(
      { ...fill, quantityDelta: -350, fillPrice: 20, tradeDate: nextDay },
      db,
    );
    expect(reduced).toMatchObject({
      quantity: 50,
      avgEntryPrice: 13,
      entryDate: day,
    });
    expect(() =>
      syncSleeveHoldingDelta({ ...fill, quantityDelta: -51 }, db),
    ).toThrow(/超过/);
    expect(listOwnerSleeveHoldings(owner, db)).toEqual([reduced]);
    const flat = syncSleeveHoldingDelta({ ...fill, quantityDelta: -50 }, db)!;
    expect(flat).toMatchObject({
      quantity: 0,
      avgEntryPrice: null,
      entryDate: null,
      reservedCash: 17,
    });
    expect(deleteZeroSleeveHolding(key, db)).toBe(false);
    upsertSleeveHolding({ ...flat, reservedCash: 0 }, db);
    expect(deleteZeroSleeveHolding(key, db)).toBe(true);
    expect(listAccountSleeveHoldings(account, db)).toEqual([second]);
    for (const invalid of [
      "owner_kind='broker'",
      "quantity=-1",
      "avg_entry_price=0",
      "reserved_cash=-1",
    ]) {
      expect(() =>
        db.exec("UPDATE account_sleeve_holdings SET " + invalid),
      ).toThrow(/CHECK constraint/);
    }
  });

  it("closes fractional fills without dust and rolls back the sleeve and its fill receipt together", () => {
    const delta = { ...key, fillPrice: 5, quantityDelta: 0.1, tradeDate: day };
    const link = { ...account, fillSource: "sim_fills", fillId: "f" } as const;
    expect(() =>
      db.transaction(() => {
        recordExecutionFillLink(link, db);
        syncSleeveHoldingDelta(delta, db);
        throw new Error("later write failed");
      })(),
    ).toThrow("later write failed");
    expect(listFillLinksByAccount(account, db)).toEqual([]);
    expect(listOwnerSleeveHoldings(owner, db)).toEqual([]);
    syncSleeveHoldingDelta(delta, db);
    syncSleeveHoldingDelta({ ...delta, quantityDelta: 0.2 }, db);
    expect(
      syncSleeveHoldingDelta({ ...delta, quantityDelta: -0.3 }, db),
    ).toBeNull();
    expect(listOwnerSleeveHoldings(owner, db)).toEqual([]);
  });

  it("retains the original arrival price on retries, looks up partial fills, and enforces both parent keys", () => {
    const intentId = seedBusiness(db);
    const link = {
      ...account,
      id: "a",
      intentId,
      rebalancePlanId: "plan",
      venueOrderId: "venue",
      fillSource: "sim_fills",
      fillId: "one",
      arrivalPrice: 9,
      createdAt: 1,
    } as const;
    expect(recordExecutionFillLink(link, db)).toBe(true);
    expect(
      recordExecutionFillLink({ ...link, id: "retry", arrivalPrice: 12 }, db),
    ).toBe(false);
    const partial = { ...link, id: "b", fillId: "two", createdAt: 2 };
    expect(recordExecutionFillLink(partial, db)).toBe(true);
    const other = {
      ...link,
      id: "c",
      accountScope: "paper",
      fillSource: "paper_fills",
      intentId: null,
      rebalancePlanId: null,
    } as const;
    expect(recordExecutionFillLink(other, db)).toBe(true);
    expect(
      listFillLinksByIntentIds([intentId, intentId, "unknown"], db),
    ).toEqual([partial, link]);
    expect(listFillLinksByIntentIds([], db)).toEqual([]);
    expect(listFillLinksByPlanId("plan", db)).toEqual([partial, link]);
    expect(listFillLinksByAccount(account, db)).toEqual([partial, link]);
    expect(listFillLinksByAccount(other, db)).toEqual([other]);
    for (const missing of [
      { intentId: "missing" },
      { rebalancePlanId: "missing" },
    ]) {
      expect(() =>
        recordExecutionFillLink(
          { ...link, ...missing, id: "invalid", fillId: "invalid" },
          db,
        ),
      ).toThrow(/FOREIGN KEY/);
    }
    expect(() =>
      recordExecutionFillLink({ ...link, fillId: "id-collision" }, db),
    ).toThrow(/UNIQUE/);
    for (const invalid of [
      "arrival_price=0",
      "fill_source='other'",
      "account_scope='other'",
    ]) {
      expect(() =>
        db.exec("UPDATE execution_fill_links SET " + invalid + " WHERE id='a'"),
      ).toThrow(/CHECK constraint/);
    }
  });

  it("returns read-only safe defaults and persists the inclusive 15–300 second bounds and all switches", () => {
    db.pragma("query_only=ON");
    const config = getIntradayAlertConfig(db);
    expect(config).toEqual({
      enabled: false,
      pollIntervalSec: 30,
      monitorHoldingsStops: true,
      monitorPlannedEntries: true,
      monitorWatchlistRules: true,
      intradayScanEnabled: false,
    });
    db.pragma("query_only=OFF");
    expect(db.prepare("SELECT * FROM intraday_alert_config").all()).toEqual([]);
    for (const pollIntervalSec of [15, 300]) {
      const enabled = {
        ...config,
        enabled: true,
        pollIntervalSec,
        monitorHoldingsStops: false,
        monitorPlannedEntries: false,
        monitorWatchlistRules: false,
        intradayScanEnabled: true,
      };
      saveIntradayAlertConfig(enabled, db);
      expect(getIntradayAlertConfig(db)).toEqual(enabled);
    }
    for (const invalid of [
      "id='other'",
      "poll_interval_sec=14",
      "poll_interval_sec=301",
      "enabled=2",
      "monitor_holdings_stops=2",
      "monitor_planned_entries=2",
      "monitor_watchlist_rules=2",
      "intraday_scan_enabled=2",
    ]) {
      expect(() =>
        db.exec("UPDATE intraday_alert_config SET " + invalid),
      ).toThrow(/CHECK constraint/);
    }
  });

  it("retains watch rule trigger history on edit and permits at most one trigger per trading date", () => {
    const rule = upsertIntradayWatchRule(
      { symbol: key.symbol, direction: "above", thresholdPrice: 5 },
      db,
    );
    expect(rule).toMatchObject({
      enabled: true,
      note: "",
      lastTriggeredDate: null,
    });
    expect(markIntradayWatchRuleTriggered(rule.id, day, db)).toBe(true);
    expect(markIntradayWatchRuleTriggered(rule.id, day, db)).toBe(false);
    expect(markIntradayWatchRuleTriggered(rule.id, "2026-11-20", db)).toBe(
      false,
    );
    const edited = upsertIntradayWatchRule(
      {
        ...rule,
        direction: "below",
        thresholdPrice: 4,
        note: "回落",
        enabled: false,
      },
      db,
    );
    expect(edited).toMatchObject({
      createdAt: rule.createdAt,
      lastTriggeredDate: day,
      enabled: false,
      note: "回落",
    });
    expect(listIntradayWatchRules(db)).toEqual([edited]);
    expect(markIntradayWatchRuleTriggered(rule.id, nextDay, db)).toBe(false);
    upsertIntradayWatchRule({ ...edited, enabled: true }, db);
    expect(markIntradayWatchRuleTriggered(rule.id, nextDay, db)).toBe(true);
    expect(listIntradayWatchRules(db)[0]?.lastTriggeredDate).toBe(nextDay);
    for (const invalid of [
      "direction='both'",
      "threshold_price=0",
      "enabled=-1",
    ]) {
      expect(() =>
        db.exec("UPDATE intraday_watch_rules SET " + invalid),
      ).toThrow(/CHECK constraint/);
    }
    expect(deleteIntradayWatchRule(rule.id, db)).toBe(true);
    expect(deleteIntradayWatchRule(rule.id, db)).toBe(false);
    expect(listIntradayWatchRules(db)).toEqual([]);
  });
});
