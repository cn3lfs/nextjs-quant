import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { sqlite } from "~/server/db";
import { migrate, migrations } from "~/server/db/migrations";
import {
  computeFactorCompositeConfigHash,
  deleteFactorComposite,
  getFactorComposite,
  listFactorComposites,
  updateFactorCompositeSummary,
  upsertFactorComposite,
  type UpsertFactorCompositeInput,
} from "~/server/db/factor-composite-repository";
import {
  cancelRebalancePlan,
  confirmRebalancePlan,
  createRebalancePlan,
  expireStaleRebalancePlans,
  getRebalancePlan,
  listRebalancePlans,
  recordRebalanceRecheck,
  type CreateRebalancePlanInput,
  type RebalanceOrder,
  type RebalanceRecheckResult,
} from "~/server/db/rebalance-plan-repository";

const directory = process.env.QUANT_DATA_DIR!;
const newTables = [
  "factor_composites",
  "rebalance_plans",
  "strategy_deployments",
  "pipeline_runs",
  "execution_order_intents",
  "execution_audit_events",
  "deployment_pool_entries",
  "account_risk_states",
  "account_sleeve_holdings",
  "execution_fill_links",
  "intraday_alert_config",
  "intraday_watch_rules",
];

it("keeps the released v1 through v23 migration SQL frozen", () => {
  const digest = createHash("sha256")
    .update(JSON.stringify(migrations.slice(0, 23)))
    .digest("hex");
  expect(digest).toBe(
    "0878ad2cca9aec8b6ddc15c9f97e1e2ffabdc0f7ccdc87ca58b7ddf9d948bb98",
  );
});

function createV23(path: string) {
  const db = new Database(path);
  try {
    db.transaction(() => {
      for (const sql of migrations.slice(0, 23)) db.exec(sql);
      db.pragma("user_version=23");
      db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
        "legacy",
        "snapshot",
        '{"label":"保留","quantity":0}',
        17,
      );
      db.exec(`
        UPDATE workspace_preferences SET density='compact',updated_at=18 WHERE id=1;
        INSERT INTO sim_accounts(id,name,market,currency,initial_capital_atoms,created_at,updated_at)
          VALUES ('sim','保留纸面账户','cn-equity','CNY',1000000,19,19);
        INSERT INTO delivery_batches(id,account,source,file_hash,file_name,imported_at,payload)
          VALUES ('batch','real','ths','hash','statement.xlsx',20,'{"source":"ths"}');
      `);
    })();
  } finally {
    db.close();
  }
}

function readSchema(db: Database.Database) {
  return db
    .prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name")
    .all() as {
    name: string;
    type: string;
    tbl_name: string;
    sql: string | null;
  }[];
}

function readTables(
  db: Database.Database,
  schema: ReturnType<typeof readSchema>,
) {
  return schema
    .filter(({ type }) => type === "table")
    .map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
}

it("upgrades a populated v23 database and preserves every existing schema object and row after reopening", () => {
  const path = join(directory, "v23.sqlite");
  createV23(path);
  const db = new Database(path, { fileMustExist: true });
  const oldSchema = readSchema(db);
  const oldRows = readTables(db, oldSchema);
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(23);
    expect(
      oldSchema.filter(({ tbl_name }) => newTables.includes(tbl_name)),
    ).toEqual([]);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(26);
    expect(
      readSchema(db).filter(({ tbl_name }) => !newTables.includes(tbl_name)),
    ).toEqual(oldSchema);
    expect(readTables(db, oldSchema)).toEqual(oldRows);
    const upgradedSchema = readSchema(db);
    expect(upgradedSchema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "factor_composites_updated",
          type: "index",
        }),
        expect.objectContaining({
          name: "rebalance_plans_status_date",
          type: "index",
        }),
      ]),
    );
    const tables = db.pragma("table_list") as {
      name: string;
      strict: number;
    }[];
    for (const name of newTables)
      expect(tables.find((table) => table.name === name)?.strict).toBe(1);
    db.close();

    const reopened = new Database(path, { fileMustExist: true });
    try {
      migrate(reopened);
      expect(reopened.pragma("user_version", { simple: true })).toBe(26);
      expect(readSchema(reopened)).toEqual(upgradedSchema);
      expect(readTables(reopened, oldSchema)).toEqual(oldRows);
    } finally {
      reopened.close();
    }
  } finally {
    if (db.open) db.close();
  }
});

it("rolls the first v24 table and index back if the second table's DDL fails", () => {
  const path = join(directory, "rollback.sqlite");
  createV23(path);
  const db = new Database(path, { fileMustExist: true });
  try {
    db.exec(
      "CREATE TABLE rebalance_plans(sentinel TEXT); INSERT INTO rebalance_plans VALUES ('keep')",
    );
    const schema = readSchema(db);
    const rows = readTables(db, schema);
    expect(() => migrate(db)).toThrow(/rebalance_plans already exists/);
    expect(db.pragma("user_version", { simple: true })).toBe(23);
    expect(readSchema(db)).toEqual(schema);
    expect(readTables(db, schema)).toEqual(rows);
  } finally {
    db.close();
  }
});

it("refuses a future v27 database without advancing its schema or changing business rows", () => {
  const path = join(directory, "future.sqlite");
  createV23(path);
  const db = new Database(path, { fileMustExist: true });
  try {
    migrate(db);
    db.exec(
      "CREATE TABLE future_metadata(note TEXT); INSERT INTO future_metadata VALUES ('v27')",
    );
    db.pragma("user_version=27");
    const schema = readSchema(db);
    const rows = readTables(db, schema);
    expect(() => migrate(db)).toThrow("数据库版本高于此应用版本");
    expect(db.pragma("user_version", { simple: true })).toBe(27);
    expect(readSchema(db)).toEqual(schema);
    expect(readTables(db, schema)).toEqual(rows);
  } finally {
    db.close();
  }
});

const composite: UpsertFactorCompositeInput = {
  id: "composite",
  name: "质量与动量",
  weightingMethod: "custom",
  neutralizationMode: "industry_size",
  winsorizeMethod: "mad",
  config: {
    factors: [
      {
        factorId: "quality",
        direction: 1,
        formula: "C / MA(C, 20)",
        weight: 0.6,
        parameters: { periods: [20, 60], options: { normalized: true } },
      },
      { factorId: "volatility", direction: -1, weight: 0.4 },
    ],
    parameters: { madScale: 3 },
  },
};

const sell: RebalanceOrder = {
  side: "sell",
  symbol: "sh600000",
  quantity: 100,
  conditional: false,
  riskChecks: [],
};
const buy: RebalanceOrder = {
  side: "buy",
  symbol: "sh688001",
  quantity: 201,
  conditional: true,
  atrStopPrice: 8.5,
  maxBuyPrice: 10.2,
  riskChecks: [{ code: "cash-after-sells", status: "unknown" }],
};
const plan: CreateRebalancePlanInput = {
  id: "plan",
  accountScope: "paper",
  accountId: "book",
  sourceKind: "alpha",
  sourceRefId: "frozen-target",
  asOfDate: "2026-11-24",
  executeDate: "2026-11-25",
  orders: [sell, buy],
  riskSummary: {
    status: "reduced",
    checks: [],
    metrics: { drawdown: 0.06, stopExposure: null },
  },
  expiresAt: 1000,
};

describe("v24 repositories", () => {
  // The shared repository connection is local to this test file's worker.
  afterAll(() => sqlite().close());

  it("round-trips composite configuration and summary, preserves creation time and deletes by id", () => {
    expect(getFactorComposite(composite.id)).toBeNull();
    const created = upsertFactorComposite(composite, 10);
    const configHash = computeFactorCompositeConfigHash(composite);
    expect(getFactorComposite(composite.id)).toEqual({
      ...composite,
      description: "",
      configHash,
      latestEvalSummary: null,
      createdAt: 10,
      updatedAt: 10,
    });
    const summary = { rankIC: 0.13, icir: null, details: { horizon: 5 } };
    expect(
      updateFactorCompositeSummary(created.id, summary, configHash, 20),
    ).toEqual({ ...created, latestEvalSummary: summary, updatedAt: 20 });
    expect(
      upsertFactorComposite({ ...composite, description: "备注" }, 30),
    ).toEqual({
      ...created,
      description: "备注",
      latestEvalSummary: summary,
      updatedAt: 30,
    });
    const changed = { ...composite, winsorizeMethod: "quantile" } as const;
    expect(upsertFactorComposite(changed, 40)).toEqual({
      ...created,
      winsorizeMethod: "quantile",
      configHash: computeFactorCompositeConfigHash(changed),
      latestEvalSummary: null,
      updatedAt: 40,
    });
    expect(deleteFactorComposite(created.id)).toBe(true);
    expect(deleteFactorComposite(created.id)).toBe(false);
    expect(getFactorComposite(created.id)).toBeNull();
    expect(
      updateFactorCompositeSummary(created.id, summary, configHash, 50),
    ).toBeNull();
  });

  it("rejects a late summary after the evaluated configuration changes", () => {
    const input = { ...composite, id: "composite-stale-summary" };
    const evaluated = upsertFactorComposite(input, 10);
    const current = upsertFactorComposite(
      { ...input, config: { ...input.config, parameters: { madScale: 4 } } },
      20,
    );
    const summary = { rankIC: 0.13, icir: null };

    try {
      expect(current.configHash).not.toBe(evaluated.configHash);
      expect(current.latestEvalSummary).toBeNull();
      expect(
        updateFactorCompositeSummary(
          input.id,
          summary,
          evaluated.configHash,
          30,
        ),
      ).toBeNull();
      expect(getFactorComposite(input.id)).toEqual(current);
    } finally {
      deleteFactorComposite(input.id);
    }
  });

  it("hashes nested configuration objects in key order and keeps array order meaningful", () => {
    const first = {
      ...composite,
      config: { ...composite.config, parameters: { nested: { a: 1, b: 2 } } },
    };
    const reordered = {
      ...composite,
      config: {
        parameters: { nested: { b: 2, a: 1 } },
        factors: first.config.factors,
      },
    };
    const configHash = computeFactorCompositeConfigHash(first);
    expect(configHash).toBe(computeFactorCompositeConfigHash(reordered));
    expect(configHash).not.toBe(
      computeFactorCompositeConfigHash({
        ...first,
        config: {
          ...first.config,
          factors: [...first.config.factors].reverse(),
        },
      }),
    );
  });

  it("pages composites by updated time then id, including equal timestamps", () => {
    upsertFactorComposite({ ...composite, id: "a" }, 12);
    upsertFactorComposite({ ...composite, id: "b" }, 12);
    upsertFactorComposite({ ...composite, id: "z" }, 10);
    try {
      const first = listFactorComposites(1);
      expect(first.items.map(({ id }) => id)).toEqual(["b"]);
      expect(first.nextCursor).toEqual({ updatedAt: 12, id: "b" });
      const last = listFactorComposites(2, first.nextCursor!);
      expect(last.items.map(({ id }) => id)).toEqual(["a", "z"]);
      expect(last.nextCursor).toBeNull();
    } finally {
      for (const id of ["a", "b", "z"]) deleteFactorComposite(id);
    }
  });

  it("validates factor weights, direction, JSON parameters, summary, and page size at the repository boundary", () => {
    expect(() =>
      upsertFactorComposite({
        ...composite,
        config: {
          factors: [{ factorId: "f", direction: 1 }],
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      upsertFactorComposite({
        ...composite,
        config: {
          factors: [{ factorId: "f", direction: 0 as never, weight: 1 }],
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      upsertFactorComposite({
        ...composite,
        config: {
          ...composite.config,
          parameters: { invalid: Infinity },
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      updateFactorCompositeSummary(
        composite.id,
        { rankIC: 1.1, icir: 1 },
        computeFactorCompositeConfigHash(composite),
      ),
    ).toThrow(ZodError);
    expect(() => listFactorComposites(0)).toThrow(ZodError);
    expect(getFactorComposite(composite.id)).toBeNull();
  });

  it("round-trips plan snapshots and records only legal confirmation, recheck, and cancellation transitions", () => {
    const draft = createRebalancePlan(plan, 100);
    expect(getRebalancePlan(plan.id)).toEqual({
      ...plan,
      status: "draft",
      confirmedAt: null,
      recheckedAt: null,
      recheckResult: null,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(() => createRebalancePlan({ ...plan, orders: [] }, 200)).toThrow(
      /UNIQUE/,
    );
    expect(getRebalancePlan(plan.id)).toEqual(draft);
    const result: RebalanceRecheckResult = {
      outcome: "blocked",
      checks: [
        {
          code: "gap-above-cap",
          status: "blocked",
          symbol: buy.symbol,
          detail: "高开超过上限",
        },
      ],
    };
    expect(() => recordRebalanceRecheck(plan.id, result, 110)).toThrow(
      "无法复检",
    );
    expect(() => confirmRebalancePlan(plan.id, 99)).toThrow("无法确认");
    const confirmed = confirmRebalancePlan(plan.id, 110);
    expect(confirmed).toEqual({
      ...draft,
      status: "confirmed",
      updatedAt: 110,
      confirmedAt: 110,
    });
    expect(() => confirmRebalancePlan(plan.id, 111)).toThrow("无法确认");
    expect(() => recordRebalanceRecheck(plan.id, result, 109)).toThrow(
      "无法复检",
    );
    expect(() =>
      recordRebalanceRecheck(
        plan.id,
        { ...result, outcome: "sent" as never },
        120,
      ),
    ).toThrow(ZodError);
    const rechecked = recordRebalanceRecheck(plan.id, result, 120);
    expect(rechecked).toEqual({
      ...confirmed,
      status: "rechecked",
      updatedAt: 120,
      recheckedAt: 120,
      recheckResult: result,
    });
    expect(() => recordRebalanceRecheck(plan.id, result, 121)).toThrow(
      "无法复检",
    );
    expect(cancelRebalancePlan(plan.id, 130)).toEqual({
      ...rechecked,
      status: "cancelled",
      updatedAt: 130,
    });
    expect(() => confirmRebalancePlan(plan.id, 140)).toThrow("无法确认");
    expect(() => cancelRebalancePlan(plan.id, 140)).toThrow("无法取消");
  });

  it.each([
    ["passed", "blocked"],
    ["warning", "blocked"],
    ["conditional", "blocked"],
    ["blocked", "warning"],
    ["passed", "warning"],
  ] as const)(
    "rejects outcome %s with a %s check without updating the plan",
    (outcome, status) => {
      const id = `recheck-${outcome}-${status}`;
      createRebalancePlan({ ...plan, id }, 100);
      const confirmed = confirmRebalancePlan(id, 110);

      expect(() =>
        recordRebalanceRecheck(
          id,
          { outcome, checks: [{ code: "gap", status }] },
          120,
        ),
      ).toThrow(ZodError);
      expect(getRebalancePlan(id)).toEqual(confirmed);
    },
  );

  it("persists a warning recheck when no checks block execution", () => {
    const id = "recheck-warning";
    createRebalancePlan({ ...plan, id }, 100);
    confirmRebalancePlan(id, 110);
    const result: RebalanceRecheckResult = {
      outcome: "warning",
      checks: [{ code: "gap", status: "warning" }],
    };

    recordRebalanceRecheck(id, result, 120);
    expect(getRebalancePlan(id)?.recheckResult).toEqual(result);
  });

  it("expires all live states at the deadline, preserves receipts, and rejects stale transitions even before the sweep", () => {
    const expiresAt = 200;
    for (const id of [
      "stale-draft",
      "stale-confirmed",
      "stale-rechecked",
      "stale-cancelled",
    ])
      createRebalancePlan({ ...plan, id, expiresAt }, 100);
    const confirmed = confirmRebalancePlan("stale-confirmed", 110);
    confirmRebalancePlan("stale-rechecked", 110);
    const result: RebalanceRecheckResult = {
      outcome: "conditional",
      checks: [],
    };
    const rechecked = recordRebalanceRecheck("stale-rechecked", result, 120);
    cancelRebalancePlan("stale-cancelled", 110);

    expect(expireStaleRebalancePlans(199)).toBe(0);
    expect(() => confirmRebalancePlan("stale-draft", 200)).toThrow("已过期");
    expect(() =>
      recordRebalanceRecheck("stale-confirmed", result, 200),
    ).toThrow("已过期");
    expect(() => cancelRebalancePlan("stale-rechecked", 200)).toThrow("已过期");
    expect(expireStaleRebalancePlans(200)).toBe(3);
    expect(expireStaleRebalancePlans(201)).toBe(0);
    expect(getRebalancePlan("stale-draft")).toMatchObject({
      status: "expired",
      updatedAt: 200,
    });
    expect(getRebalancePlan(confirmed.id)).toEqual({
      ...confirmed,
      status: "expired",
      updatedAt: 200,
    });
    expect(getRebalancePlan(rechecked.id)).toEqual({
      ...rechecked,
      status: "expired",
      updatedAt: 200,
    });
    expect(getRebalancePlan("stale-cancelled")).toMatchObject({
      status: "cancelled",
      updatedAt: 110,
    });
    expect(() => confirmRebalancePlan("stale-draft", 201)).toThrow("无法确认");
  });

  it("pages plans by execution date, creation time and id within one account and scope", () => {
    const account = { accountScope: "paper", accountId: "page-book" } as const;
    const base = { ...plan, ...account };
    createRebalancePlan({ ...base, id: "a" }, 110);
    createRebalancePlan({ ...base, id: "b" }, 110);
    createRebalancePlan({ ...base, id: "z" }, 100);
    createRebalancePlan(
      { ...base, id: "later", executeDate: "2026-11-26" },
      90,
    );
    createRebalancePlan(
      { ...base, id: "other-account", accountId: "other" },
      120,
    );
    createRebalancePlan(
      { ...base, id: "other-scope", accountScope: "real" },
      120,
    );
    const first = listRebalancePlans(account, 2);
    expect(first.items.map(({ id }) => id)).toEqual(["later", "b"]);
    expect(first.nextCursor).toEqual({
      ...account,
      executeDate: base.executeDate,
      createdAt: 110,
      id: "b",
    });
    cancelRebalancePlan("b", 130);
    const last = listRebalancePlans(account, 2, first.nextCursor!);
    expect(last.items.map(({ id }) => id)).toEqual(["a", "z"]);
    expect(last.nextCursor).toBeNull();
    expect(() =>
      listRebalancePlans(
        { ...account, accountScope: "real" },
        2,
        first.nextCursor!,
      ),
    ).toThrow("游标与账户不匹配");
  });

  it("rejects invalid dates, shares, order sequence, protection, and caller-supplied status before any write", () => {
    const base = { ...plan, id: "invalid" };
    expect(() =>
      createRebalancePlan({ ...base, executeDate: "2026-11-31" }, 100),
    ).toThrow(ZodError);
    expect(() =>
      createRebalancePlan({ ...base, executeDate: base.asOfDate }, 100),
    ).toThrow(ZodError);
    expect(() =>
      createRebalancePlan({ ...base, orders: [buy, sell] }, 100),
    ).toThrow(ZodError);
    expect(() =>
      createRebalancePlan(
        { ...base, orders: [{ ...buy, quantity: 100.5 }] },
        100,
      ),
    ).toThrow(ZodError);
    expect(() =>
      createRebalancePlan(
        { ...base, orders: [{ ...buy, maxBuyPrice: 0 }] },
        100,
      ),
    ).toThrow(ZodError);
    const withStatus = { ...base, status: "confirmed" };
    expect(() => createRebalancePlan(withStatus, 100)).toThrow(ZodError);
    expect(() => createRebalancePlan(base, base.expiresAt)).toThrow(ZodError);
    expect(getRebalancePlan(base.id)).toBeNull();
  });
});
