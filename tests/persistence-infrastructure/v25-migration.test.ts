import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildIntentIdempotencyKey,
  poolPolicySchema,
} from "trading-strategies";
import {
  createDeployment,
  getDeployment,
  getPipelineGlobalConfig,
  listDeployments,
  recordDeploymentFailure,
  setGlobalAutoLiveEnabled,
  setGlobalAutoSimEnabled,
  updateDeploymentConfig,
  updateDeploymentMode,
  updateDeploymentStatus,
  type CreateDeploymentInput,
} from "~/server/db/deployment-repository";
import { migrate, migrations } from "~/server/db/migrations";
import {
  appendExecutionAuditEvent,
  claimIntentForSubmission,
  findPipelineRun,
  getOrCreatePipelineRun,
  getPipelineRun,
  insertOrderIntents,
  listExecutionAuditEvents,
  listIntentsByDate,
  listIntentsByRun,
  listPipelineRuns,
  transitionIntentStatus,
  updatePipelineRunStage,
  type InsertOrderIntentInput,
  type PipelineRunRecord,
} from "~/server/db/pipeline-repository";
import {
  applyPoolSyncBatch,
  getActivePoolEntries,
  listPoolEntries,
  manualAddPoolEntry,
  manualEvictPoolEntry,
  recordPoolEntrySignal,
} from "~/server/db/pool-repository";

const newTables = [
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

function readSchema(db: Database.Database) {
  return db
    .prepare<
      [],
      { name: string; type: string; tbl_name: string; sql: string | null }
    >("SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name")
    .all();
}

function installV24(db: Database.Database) {
  db.transaction(() => {
    for (const sql of migrations.slice(0, 24)) db.exec(sql);
    db.pragma("user_version=24");
    db.exec(`
      INSERT INTO factor_composites (
        id,name,weighting_method,neutralization_mode,winsorize_method,config_json,created_at,updated_at
      ) VALUES ('factor','质量','equal','none','none','{"factors":[{"factorId":"quality","weight":1}]}',21,22);
      INSERT INTO rebalance_plans (
        id,account_scope,account_id,source_kind,source_ref_id,as_of_date,execute_date,
        status,orders_json,risk_summary_json,expires_at,created_at,updated_at
      ) VALUES ('plan','paper','paper-1','alpha','factor','2026-11-24','2026-11-25',
        'draft','[]','{"status":"normal","checks":[]}',100,21,22);
    `);
  })();
}

describe("SQLite v25 migration", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  it("keeps the released v1 through v24 migration SQL frozen", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(migrations.slice(0, 24)))
      .digest("hex");
    expect(digest).toBe(
      "b737452e69792dad3389b7222f861a63c4d79009de51aebd49331215b956ee0d",
    );
  });

  it("initializes a fresh database with the v25 and v26 STRICT tables and the v25 indexes", () => {
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(26);
    const tables = db.pragma("table_list") as {
      name: string;
      strict: number;
    }[];
    for (const name of newTables) {
      expect(tables.find((table) => table.name === name)?.strict).toBe(1);
    }
    const indexes = readSchema(db)
      .filter((entry) => entry.type === "index")
      .map((entry) => entry.name);
    for (const name of [
      "strategy_deployments_updated",
      "pipeline_runs_deployment_date",
      "pipeline_runs_started_id",
      "execution_order_intents_run_phase",
      "execution_order_intents_status_date",
      "execution_audit_events_dep_time",
      "deployment_pool_entries_dep_status",
    ]) {
      expect(indexes).toContain(name);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("upgrades a populated v24 database without changing existing schema or rows", () => {
    installV24(db);
    const schema = readSchema(db);
    const plans = db.prepare("SELECT * FROM rebalance_plans").all();
    const composites = db.prepare("SELECT * FROM factor_composites").all();
    expect(db.pragma("user_version", { simple: true })).toBe(24);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(26);
    expect(
      readSchema(db).filter((entry) => !newTables.includes(entry.tbl_name)),
    ).toEqual(schema);
    expect(db.prepare("SELECT * FROM rebalance_plans").all()).toEqual(plans);
    expect(db.prepare("SELECT * FROM factor_composites").all()).toEqual(
      composites,
    );
  });

  it("reapplies v26 safely and rejects a future v27 database", () => {
    migrate(db);
    const schema = readSchema(db);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(26);
    expect(readSchema(db)).toEqual(schema);
    db.pragma("user_version=27");
    expect(() => migrate(db)).toThrow("数据库版本高于此应用版本");
    expect(db.pragma("user_version", { simple: true })).toBe(27);
    expect(readSchema(db)).toEqual(schema);
  });

  it("rolls back v25 tables and version on a late DDL error", () => {
    installV24(db);
    db.exec("CREATE TABLE deployment_pool_entries(sentinel TEXT)");
    const schema = readSchema(db);
    expect(() => migrate(db)).toThrow(/deployment_pool_entries already exists/);
    expect(db.pragma("user_version", { simple: true })).toBe(24);
    expect(readSchema(db)).toEqual(schema);
  });
});

function deploymentInput(id: string): CreateDeploymentInput {
  return {
    id,
    name: `策略 ${id}`,
    market: "cn-equity",
    strategySpec: { kind: "double-breakout" },
    universeSpec: { kind: "fixed-symbols", symbols: ["SH600000"] },
    regimeGate: { kind: "none" },
    riskPolicy: { maxConsecutiveFailures: 2 },
    venueBinding: { kind: "local_sim", simAccountId: "account-1" },
    schedule: { kind: "manual_only" },
    provenance: { sourceKind: "manual" },
  };
}

const runInput = {
  deploymentId: "d1",
  decisionDate: "2026-11-24",
  executeDate: "2026-11-25",
  triggerKind: "scheduled",
} as const;

function orderInput(
  run: PipelineRunRecord,
  side: "SELL" | "BUY",
  overrides: Partial<InsertOrderIntentInput> = {},
): InsertOrderIntentInput {
  return {
    runId: run.id,
    deploymentId: run.deploymentId,
    venueKind: "local_sim",
    symbol: "SH600000",
    side,
    phase: side === "SELL" ? 1 : 2,
    quantity: 100,
    referencePrice: 10,
    ...overrides,
  };
}

describe("v25 deployment and pipeline repositories", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function createRun() {
    createDeployment(
      { ...deploymentInput("d1"), status: "active", executionMode: "auto_sim" },
      db,
    );
    setGlobalAutoSimEnabled(true, db);
    return getOrCreatePipelineRun(runInput, db).run;
  }

  function expectSubmissionBlocked(
    intentId: string,
    reason: string,
    message: RegExp,
  ) {
    expect(claimIntentForSubmission(intentId, Date.now(), db)).toEqual({
      claimed: false,
      reason,
    });
    expect(() =>
      transitionIntentStatus(intentId, "submitting", {}, db),
    ).toThrow(message);
  }

  it("defaults both global switches to off and updates them independently", () => {
    expect(getPipelineGlobalConfig(db)).toEqual({
      autoSimEnabled: false,
      autoLiveEnabled: false,
      updatedAt: null,
    });
    expect(
      db
        .prepare("SELECT * FROM records WHERE id=?")
        .get("pipeline-global-config"),
    ).toBeUndefined();
    vi.spyOn(Date, "now").mockReturnValue(100);
    expect(setGlobalAutoSimEnabled(true, db)).toEqual({
      autoSimEnabled: true,
      autoLiveEnabled: false,
      updatedAt: 100,
    });
    expect(setGlobalAutoLiveEnabled(true, db)).toMatchObject({
      autoSimEnabled: true,
      autoLiveEnabled: true,
    });
    expect(setGlobalAutoSimEnabled(false, db)).toMatchObject({
      autoSimEnabled: false,
      autoLiveEnabled: true,
    });
    setGlobalAutoSimEnabled(true, db);
    setGlobalAutoLiveEnabled(false, db);
    expect(getPipelineGlobalConfig(db)).toEqual({
      autoSimEnabled: true,
      autoLiveEnabled: false,
      updatedAt: 100,
    });
    expect(
      db
        .prepare("SELECT kind FROM records WHERE id=?")
        .get("pipeline-global-config"),
    ).toEqual({ kind: "pipeline-global-config" });
  });

  it("reads a legacy auto-sim setting with auto-live defaulting to off", () => {
    db.prepare("INSERT INTO records VALUES(?,?,?,?)").run(
      "pipeline-global-config",
      "pipeline-global-config",
      JSON.stringify({
        autoSimEnabled: true,
        updatedAt: 20,
        updatedBy: "local",
      }),
      20,
    );
    expect(getPipelineGlobalConfig(db)).toEqual({
      autoSimEnabled: true,
      autoLiveEnabled: false,
      updatedAt: 20,
    });
    expect(setGlobalAutoLiveEnabled(true, db).autoSimEnabled).toBe(true);
  });

  it("defaults to shadow and persists validated pool policy on create and update", () => {
    const deployment = createDeployment(deploymentInput("d1"), db);
    expect(deployment).toMatchObject({
      status: "draft",
      executionMode: "shadow",
      poolPolicy: poolPolicySchema.parse({}),
    });
    expect(getDeployment("d1", db)).toEqual(deployment);
    expect(updateDeploymentMode("d1", "manual_confirm", db).executionMode).toBe(
      "manual_confirm",
    );
    expect(
      listDeployments({ status: "draft", market: "cn-equity" }, db).items[0]
        ?.executionMode,
    ).toBe("manual_confirm");
    expect(
      listExecutionAuditEvents({ deploymentId: "d1" }, db).items.map(
        ({ eventType }) => eventType,
      ),
    ).toEqual(["deployment_execution_mode_changed", "deployment_created"]);
    const poolPolicy = {
      mode: "replace",
      eviction: { maxPoolSize: 25 },
    } as const;
    expect(updateDeploymentConfig("d1", { poolPolicy }, db).poolPolicy).toEqual(
      poolPolicySchema.parse(poolPolicy),
    );
    expect(getDeployment("d1", db)?.poolPolicy).toEqual(
      poolPolicySchema.parse(poolPolicy),
    );
    expect(
      createDeployment({ ...deploymentInput("d2"), poolPolicy }, db).poolPolicy,
    ).toEqual(poolPolicySchema.parse(poolPolicy));
    expect(() =>
      updateDeploymentConfig(
        "d1",
        { poolPolicy: { eviction: { maxPoolSize: 0 } } },
        db,
      ),
    ).toThrow(/maxPoolSize/);
  });

  it("validates deployment specs and market-venue compatibility on create and update", () => {
    const cryptoBinding = {
      kind: "crypto_sim",
      venue: "okx",
      accountId: "crypto-1",
    } as const;
    expect(() =>
      createDeployment(
        { ...deploymentInput("d1"), venueBinding: cryptoBinding },
        db,
      ),
    ).toThrow(/市场与交易通道不匹配/);
    expect(() =>
      createDeployment(
        {
          ...deploymentInput("d1"),
          universeSpec: { kind: "fixed-symbols", symbols: [] },
        },
        db,
      ),
    ).toThrow(/universeSpec/);
    const valid = createDeployment(deploymentInput("d1"), db);
    expect(() =>
      updateDeploymentConfig("d1", { venueBinding: cryptoBinding }, db),
    ).toThrow(/市场与交易通道不匹配/);
    expect(getDeployment("d1", db)).toEqual(valid);
    const updated = updateDeploymentConfig(
      "d1",
      { venueBinding: { kind: "ths_mock", accountTag: "default" } },
      db,
    );
    expect(updated.venueBinding.kind).toBe("ths_mock");
    expect(() =>
      createDeployment({ ...deploymentInput("d2"), name: valid.name }, db),
    ).toThrow(/UNIQUE constraint failed: strategy_deployments.name/);
  });

  it.each([
    ["cn-equity", { kind: "cn_broker_live", broker: "qmt", accountId: "cn-1" }],
    ["crypto", { kind: "crypto_live", venue: "okx", accountId: "crypto-1" }],
  ] as const)(
    "supports live mode and intent snapshots for %s",
    (market, venueBinding) => {
      const input = { ...deploymentInput("d1"), market, venueBinding };
      expect(() =>
        createDeployment({ ...input, executionMode: "auto_sim" }, db),
      ).toThrow(/执行模式/);
      expect(() =>
        createDeployment(
          { ...input, market: market === "crypto" ? "cn-equity" : "crypto" },
          db,
        ),
      ).toThrow(/部署市场/);

      const deployment = createDeployment(
        { ...input, executionMode: "auto_live" },
        db,
      );
      expect(deployment.executionMode).toBe("auto_live");
      expect(() => updateDeploymentMode("d1", "auto_sim", db)).toThrow(
        /执行模式/,
      );
      const simBinding =
        market === "crypto"
          ? ({ kind: "crypto_sim", venue: "okx", accountId: "sim-1" } as const)
          : ({ kind: "local_sim", simAccountId: "sim-1" } as const);
      expect(() =>
        updateDeploymentConfig("d1", { venueBinding: simBinding }, db),
      ).toThrow(/执行模式/);
      expect(getDeployment("d1", db)).toEqual(deployment);

      const run = getOrCreatePipelineRun(runInput, db).run;
      const [intent] = insertOrderIntents(
        run.id,
        [orderInput(run, "SELL", { venueKind: venueBinding.kind })],
        db,
      );
      expect(intent?.venueBinding).toEqual(venueBinding);
      expect(
        updateDeploymentMode("d1", "manual_confirm", db).executionMode,
      ).toBe("manual_confirm");
      expect(
        updateDeploymentConfig("d1", { venueBinding: simBinding }, db)
          .venueBinding,
      ).toEqual(simBinding);
      expect(() => updateDeploymentMode("d1", "auto_live", db)).toThrow(
        /执行模式/,
      );
      expect(updateDeploymentMode("d1", "auto_sim", db).executionMode).toBe(
        "auto_sim",
      );
    },
  );

  it("rejects auto-live creation for a simulated venue", () => {
    expect(() =>
      createDeployment(
        { ...deploymentInput("d1"), executionMode: "auto_live" },
        db,
      ),
    ).toThrow(/执行模式/);
    expect(getDeployment("d1", db)).toBeNull();
  });

  it("paginates deployments, runs, and audit events across tied sort values", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const run = createRun();
    createDeployment(deploymentInput("d2"), db);
    getOrCreatePipelineRun({ ...runInput, deploymentId: "d2" }, db);
    const deploymentPage = listDeployments({ limit: 1 }, db);
    expect(deploymentPage.items.map(({ id }) => id)).toEqual(["d2"]);
    expect(
      listDeployments(
        { limit: 1, after: deploymentPage.nextCursor! },
        db,
      ).items.map(({ id }) => id),
    ).toEqual(["d1"]);

    const allRuns = listPipelineRuns({}, db).items.map(({ id }) => id);
    const runPage = listPipelineRuns({ limit: 1 }, db);
    const nextRunPage = listPipelineRuns(
      { limit: 1, after: runPage.nextCursor! },
      db,
    );
    expect(
      [...runPage.items, ...nextRunPage.items].map(({ id }) => id),
    ).toEqual(allRuns);
    expect(nextRunPage.nextCursor).toBeNull();

    appendExecutionAuditEvent(
      {
        deploymentId: "d1",
        runId: run.id,
        eventType: "reviewed",
        details: { ok: true },
      },
      db,
    );
    const auditPage = listExecutionAuditEvents(
      { deploymentId: "d1", runId: run.id, limit: 1 },
      db,
    );
    expect(auditPage.items[0]).toMatchObject({
      eventType: "reviewed",
      details: { ok: true },
    });
    expect(
      listExecutionAuditEvents(
        {
          deploymentId: "d1",
          runId: run.id,
          limit: 1,
          after: auditPage.nextCursor!,
        },
        db,
      ).items[0]?.eventType,
    ).toBe("pipeline_run_created");
  });

  it("uses the global run index for all keyset sort columns without a temporary sort", () => {
    const plan = db
      .prepare<[string, number, string, number], { detail: string }>(
        `
      EXPLAIN QUERY PLAN SELECT * FROM pipeline_runs WHERE (decision_date,started_at,id) < (?,?,?)
      ORDER BY decision_date DESC,started_at DESC,id DESC LIMIT ?
    `,
      )
      .all(runInput.decisionDate, 100, "run", 50)
      .map(({ detail }) => detail)
      .join("\n");
    expect(plan).toContain("USING INDEX pipeline_runs_started_id");
    expect(plan).not.toContain("TEMP B-TREE");
    const indexColumns = db.pragma(
      "index_xinfo('pipeline_runs_started_id')",
    ) as { name: string; desc: number; key: number }[];
    expect(
      indexColumns
        .filter(({ key }) => key === 1)
        .map(({ name, desc }) => [name, desc]),
    ).toEqual([
      ["decision_date", 1],
      ["started_at", 1],
      ["id", 1],
    ]);
  });

  it("resets a failure streak on completion and auto-pauses at the threshold", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const oldRun = createRun();
    clock.mockReturnValue(101);
    expect(recordDeploymentFailure("d1", "first", db)).toMatchObject({
      status: "active",
      consecutiveFailures: 1,
    });
    clock.mockReturnValue(102);
    const run = getOrCreatePipelineRun(
      { ...runInput, runSlot: "open" },
      db,
    ).run;
    updatePipelineRunStage(oldRun.id, { stage: "completed" }, db);
    expect(getDeployment("d1", db)?.consecutiveFailures).toBe(1);
    updatePipelineRunStage(
      run.id,
      { stage: "completed", finishedAt: run.startedAt },
      db,
    );
    expect(getDeployment("d1", db)?.consecutiveFailures).toBe(0);
    expect(recordDeploymentFailure("d1", "later failure", db)).toMatchObject({
      status: "active",
      consecutiveFailures: 1,
    });
    updatePipelineRunStage(run.id, { stage: "completed" }, db);
    expect(getDeployment("d1", db)?.consecutiveFailures).toBe(1);
    expect(
      recordDeploymentFailure("d1", "connection unavailable", db),
    ).toMatchObject({
      status: "paused",
      consecutiveFailures: 2,
      pauseReason: "connection unavailable",
    });
    expect(
      listExecutionAuditEvents({ deploymentId: "d1" }, db).items[0],
    ).toMatchObject({
      eventType: "deployment_failure",
      details: { consecutiveFailures: 2, autoPaused: true },
    });
    expect(updateDeploymentStatus("d1", "active", undefined, db)).toMatchObject(
      {
        consecutiveFailures: 0,
        pauseReason: null,
      },
    );
  });

  it("scopes run reuse and order idempotency to the slot on the same decision date", () => {
    const daily = createRun();
    const intradayInput = { ...runInput, runSlot: " 10:00 " };
    const { run: intraday, created } = getOrCreatePipelineRun(
      intradayInput,
      db,
    );
    expect(created).toBe(true);
    expect(daily.runSlot).toBe("daily");
    expect(intraday.runSlot).toBe("10:00");
    expect(getOrCreatePipelineRun(intradayInput, db)).toEqual({
      run: intraday,
      created: false,
    });
    expect(findPipelineRun("d1", daily.decisionDate, db)).toEqual(daily);
    expect(findPipelineRun("d1", daily.decisionDate, "10:00", db)).toEqual(
      intraday,
    );
    expect(findPipelineRun("d1", daily.decisionDate, "11:00", db)).toBeNull();
    expect(() =>
      db
        .prepare(
          `INSERT INTO pipeline_runs (
        id,deployment_id,decision_date,execute_date,trigger_kind,stage,started_at
      ) VALUES ('duplicate','d1',?,?,'manual','pending',1)`,
        )
        .run(daily.decisionDate, daily.executeDate),
    ).toThrow(/UNIQUE constraint failed/);

    const [dailyIntent] = insertOrderIntents(
      daily.id,
      [orderInput(daily, "BUY")],
      db,
    );
    const [intradayIntent] = insertOrderIntents(
      intraday.id,
      [orderInput(intraday, "BUY")],
      db,
    );
    expect(dailyIntent!.idempotencyKey).not.toBe(
      intradayIntent!.idempotencyKey,
    );
    expect(JSON.parse(intradayIntent!.idempotencyKey).at(-1)).toBe("10:00");
  });

  it("reuses the run for a deployment and decision date, retaining its original inputs", () => {
    const run = createRun();
    expect(
      getOrCreatePipelineRun(
        { ...runInput, executeDate: "2026-11-26", triggerKind: "manual" },
        db,
      ),
    ).toEqual({ run, created: false });
    expect(findPipelineRun("d1", run.decisionDate, db)).toEqual(run);
    const snapshot = { symbols: ["SH600000"] };
    updatePipelineRunStage(
      run.id,
      { stage: "universe_done", universeSnapshot: snapshot },
      db,
    );
    updatePipelineRunStage(
      run.id,
      {
        stage: "risk_checked",
        signals: [{ score: 3 }],
        riskVerdict: { pass: true },
      },
      db,
    );
    expect(getPipelineRun(run.id, db)).toMatchObject({
      stage: "risk_checked",
      universeSnapshot: snapshot,
      signals: [{ score: 3 }],
      riskVerdict: { pass: true },
    });
    expect(
      listExecutionAuditEvents(
        { deploymentId: "d1", runId: run.id },
        db,
      ).items.map(({ details }) => details),
    ).toEqual([
      {
        from: "universe_done",
        to: "risk_checked",
        resetConsecutiveFailures: false,
      },
      { from: "pending", to: "universe_done", resetConsecutiveFailures: false },
      { triggerKind: "scheduled", stage: "pending" },
    ]);
  });

  it("keeps archived status after failures reach the auto-pause threshold", () => {
    createRun();
    recordDeploymentFailure("d1", "first failure", db);
    updateDeploymentStatus("d1", "archived", undefined, db);
    expect(recordDeploymentFailure("d1", "second failure", db)).toMatchObject({
      status: "archived",
      consecutiveFailures: 2,
      pauseReason: null,
    });
    expect(getDeployment("d1", db)?.status).toBe("archived");
    expect(
      listExecutionAuditEvents({ deploymentId: "d1" }, db).items[0],
    ).toMatchObject({
      eventType: "deployment_failure",
      details: { autoPaused: false, from: "archived", to: "archived" },
    });
  });

  it("rejects cross-run intents, reversed phases, and duplicate keys without partial inserts", () => {
    const run = createRun();
    const first = orderInput(run, "SELL");
    expect(() =>
      insertOrderIntents(
        run.id,
        [first, orderInput(run, "BUY", { runId: "other" })],
        db,
      ),
    ).toThrow(/流水线运行或部署不匹配/);
    expect(() =>
      insertOrderIntents(
        run.id,
        [first, orderInput(run, "BUY", { deploymentId: "other" })],
        db,
      ),
    ).toThrow(/流水线运行或部署不匹配/);
    expect(() =>
      insertOrderIntents(run.id, [orderInput(run, "SELL", { phase: 2 })], db),
    ).toThrow(/阶段/);
    expect(() =>
      insertOrderIntents(run.id, [orderInput(run, "BUY", { phase: 1 })], db),
    ).toThrow(/阶段/);
    expect(() =>
      insertOrderIntents(
        run.id,
        [first, orderInput(run, "SELL", { symbol: " sh600000 " })],
        db,
      ),
    ).toThrow(
      /UNIQUE constraint failed: execution_order_intents.idempotency_key/,
    );
    expect(listIntentsByRun(run.id, db)).toEqual([]);
    expect(
      listExecutionAuditEvents(
        { deploymentId: "d1", runId: run.id },
        db,
      ).items.map(({ eventType }) => eventType),
    ).toEqual(["pipeline_run_created"]);
    const [saved] = insertOrderIntents(run.id, [first], db);
    expect(saved?.idempotencyKey).toBe(
      buildIntentIdempotencyKey({
        ...first,
        decisionDate: run.decisionDate,
        executeDate: run.executeDate,
        phase: "1",
      }),
    );
    expect(listIntentsByDate(run.executeDate, ["queued"], db)).toEqual([]);
    expect(listIntentsByDate(run.executeDate, ["planned"], db)).toEqual([
      saved,
    ]);
    expect(() =>
      db
        .prepare("UPDATE execution_order_intents SET phase=2 WHERE id=?")
        .run(saved!.id),
    ).toThrow(/CHECK constraint/);
  });

  it("blocks BUY until every SELL is terminal and audits each legal transition once", () => {
    const run = createRun();
    const [sell, otherSell, buy] = insertOrderIntents(
      run.id,
      [
        orderInput(run, "SELL"),
        orderInput(run, "SELL", { symbol: "SH600001" }),
        orderInput(run, "BUY", { status: "queued" }),
      ],
      db,
    );
    const at = run.startedAt + 1;
    expect(claimIntentForSubmission(buy!.id, at, db)).toEqual({
      claimed: false,
      reason: "pending-sell-phase",
    });
    expect(() => transitionIntentStatus(buy!.id, "submitting", {}, db)).toThrow(
      /pending-sell-phase/,
    );
    expect(claimIntentForSubmission(sell!.id, at, db)).toMatchObject({
      claimed: true,
      intent: { status: "submitting", updatedAt: at },
    });
    expect(claimIntentForSubmission(sell!.id, at, db)).toEqual({
      claimed: false,
      reason: "invalid-status",
    });
    transitionIntentStatus(
      sell!.id,
      "unknown_reconcile",
      { errorSummary: "timeout" },
      db,
    );
    expect(() =>
      transitionIntentStatus(sell!.id, "submitting", {}, db),
    ).toThrow(/unknown_reconcile -> submitting/);
    expect(claimIntentForSubmission(sell!.id, at, db)).toEqual({
      claimed: false,
      reason: "invalid-status",
    });
    expect(claimIntentForSubmission(buy!.id, at, db)).toEqual({
      claimed: false,
      reason: "pending-sell-phase",
    });
    transitionIntentStatus(
      sell!.id,
      "filled",
      { filledQuantity: 100, averageFillPrice: 10, errorSummary: null },
      db,
    );
    expect(() => transitionIntentStatus(sell!.id, "cancelled", {}, db)).toThrow(
      /filled -> cancelled/,
    );
    expect(claimIntentForSubmission(buy!.id, at, db)).toEqual({
      claimed: false,
      reason: "pending-sell-phase",
    });
    transitionIntentStatus(otherSell!.id, "cancelled", {}, db);
    expect(claimIntentForSubmission(buy!.id, at, db)).toMatchObject({
      claimed: true,
      intent: { status: "submitting" },
    });
    expect(claimIntentForSubmission(buy!.id, at, db)).toEqual({
      claimed: false,
      reason: "invalid-status",
    });
    expect(() =>
      insertOrderIntents(
        run.id,
        [orderInput(run, "SELL", { symbol: "SH600002" })],
        db,
      ),
    ).toThrow(/无法再添加卖单/);

    const transitions = listExecutionAuditEvents(
      { deploymentId: "d1", runId: run.id },
      db,
    )
      .items.filter(
        ({ eventType }) =>
          eventType === "intent_status_changed" ||
          eventType === "intent_claimed",
      )
      .sort((first, second) => first.id - second.id)
      .map(({ intentId, eventType, details }) => ({
        intentId,
        eventType,
        details,
      }));
    expect(transitions).toEqual([
      {
        intentId: sell!.id,
        eventType: "intent_claimed",
        details: { from: "planned", to: "submitting" },
      },
      {
        intentId: sell!.id,
        eventType: "intent_status_changed",
        details: { from: "submitting", to: "unknown_reconcile" },
      },
      {
        intentId: sell!.id,
        eventType: "intent_status_changed",
        details: { from: "unknown_reconcile", to: "filled" },
      },
      {
        intentId: otherSell!.id,
        eventType: "intent_status_changed",
        details: { from: "planned", to: "cancelled" },
      },
      {
        intentId: buy!.id,
        eventType: "intent_claimed",
        details: { from: "queued", to: "submitting" },
      },
    ]);
  });

  it("rejects either submitting entry point inside an outer transaction", () => {
    const run = createRun();
    const [intent] = insertOrderIntents(run.id, [orderInput(run, "SELL")], db);
    const error = "订单提交认领不能在外部未提交事务内执行";
    expect(() =>
      db
        .transaction(() => {
          expect(db.inTransaction).toBe(true);
          expect(() =>
            claimIntentForSubmission(intent!.id, Date.now(), db),
          ).toThrow(error);
          expect(() =>
            transitionIntentStatus(intent!.id, "submitting", {}, db),
          ).toThrow(error);
          expect(listIntentsByRun(run.id, db)[0]?.status).toBe("planned");
          throw new Error("outer rollback");
        })
        .immediate(),
    ).toThrow("outer rollback");
    expect(claimIntentForSubmission(intent!.id, Date.now(), db).claimed).toBe(
      true,
    );
    expect(
      listExecutionAuditEvents(
        { deploymentId: "d1", runId: run.id },
        db,
      ).items.filter(({ eventType }) => eventType === "intent_claimed"),
    ).toHaveLength(1);
  });

  it("gates both submitting entry points on deployment status, mode, and explicit confirmation", () => {
    createDeployment(deploymentInput("d1"), db);
    const run = getOrCreatePipelineRun(runInput, db).run;
    const [claimIntent, transitionIntent] = insertOrderIntents(
      run.id,
      [
        orderInput(run, "SELL"),
        orderInput(run, "SELL", { symbol: "SH600001" }),
      ],
      db,
    );
    const id = claimIntent!.id;
    const transitionId = transitionIntent!.id;
    expectSubmissionBlocked(id, "deployment-inactive", /策略部署未启用/);
    updateDeploymentStatus("d1", "active", undefined, db);
    expectSubmissionBlocked(id, "execution-mode-blocked", /影子执行模式/);
    updateDeploymentStatus("d1", "paused", "暂停", db);
    expectSubmissionBlocked(id, "deployment-inactive", /策略部署未启用/);
    updateDeploymentStatus("d1", "active", undefined, db);
    updateDeploymentMode("d1", "manual_confirm", db);
    expectSubmissionBlocked(id, "manual-approval-required", /需要明确确认/);
    expect(claimIntentForSubmission(id, { manualApproved: false }, db)).toEqual(
      {
        claimed: false,
        reason: "manual-approval-required",
      },
    );
    const now = run.startedAt + 1;
    expect(
      claimIntentForSubmission(id, { now, manualApproved: true }, db),
    ).toMatchObject({
      claimed: true,
      intent: { updatedAt: now },
    });
    expect(
      transitionIntentStatus(
        transitionId,
        "submitting",
        { manualApproved: true },
        db,
      ).status,
    ).toBe("submitting");
  });

  it("requires the live switch and approval on both manual live submission entry points", () => {
    createDeployment(
      {
        ...deploymentInput("d1"),
        status: "active",
        executionMode: "manual_confirm",
        venueBinding: {
          kind: "cn_broker_live",
          broker: "qmt",
          accountId: "live-1",
        },
      },
      db,
    );
    const run = getOrCreatePipelineRun(runInput, db).run;
    const [forClaim, forTransition] = insertOrderIntents(
      run.id,
      [
        orderInput(run, "SELL", { venueKind: "cn_broker_live" }),
        orderInput(run, "SELL", {
          symbol: "SH600001",
          venueKind: "cn_broker_live",
        }),
      ],
      db,
    );
    const approved = { manualApproved: true };
    expect(claimIntentForSubmission(forClaim!.id, approved, db)).toEqual({
      claimed: false,
      reason: "live-kill-switch-off",
    });
    expect(() =>
      transitionIntentStatus(forTransition!.id, "submitting", approved, db),
    ).toThrow("live-kill-switch-off");
    expect(listIntentsByRun(run.id, db)).toEqual(
      [forClaim!, forTransition!].sort((a, b) => a.id.localeCompare(b.id)),
    );

    setGlobalAutoLiveEnabled(true, db);
    expectSubmissionBlocked(
      forClaim!.id,
      "manual-approval-required",
      /需要明确确认/,
    );
    expect(claimIntentForSubmission(forClaim!.id, approved, db).claimed).toBe(
      true,
    );
    expect(
      transitionIntentStatus(forTransition!.id, "submitting", approved, db)
        .status,
    ).toBe("submitting");
  });

  it.each([
    ["auto_sim", "kill-switch-off", /全局自动模拟开关/],
    ["auto_live", "live-kill-switch-off", /全局自动实盘开关/],
  ] as const)(
    "requires the global %s switch and a matching intent venue",
    (mode, reason, message) => {
      const sim = { kind: "local_sim", simAccountId: "account-1" } as const;
      const live = {
        kind: "cn_broker_live",
        broker: "qmt",
        accountId: "live-1",
      } as const;
      const binding = mode === "auto_sim" ? sim : live;
      const incompatibleBinding = mode === "auto_sim" ? live : sim;
      createDeployment(
        {
          ...deploymentInput("d1"),
          status: "active",
          venueBinding: incompatibleBinding,
        },
        db,
      );
      const previous = getOrCreatePipelineRun(runInput, db).run;
      const [stale] = insertOrderIntents(
        previous.id,
        [orderInput(previous, "SELL", { venueKind: incompatibleBinding.kind })],
        db,
      );

      updateDeploymentConfig("d1", { venueBinding: binding }, db);
      updateDeploymentMode("d1", mode, db);
      const run = getOrCreatePipelineRun(
        { ...runInput, runSlot: "next" },
        db,
      ).run;
      const [eligible] = insertOrderIntents(
        run.id,
        [orderInput(run, "SELL", { venueKind: binding.kind })],
        db,
      );
      const enable =
        mode === "auto_sim"
          ? setGlobalAutoSimEnabled
          : setGlobalAutoLiveEnabled;
      const enableOther =
        mode === "auto_sim"
          ? setGlobalAutoLiveEnabled
          : setGlobalAutoSimEnabled;
      enableOther(true, db);
      expectSubmissionBlocked(eligible!.id, reason, message);
      enable(true, db);
      expectSubmissionBlocked(stale!.id, reason, message);
      expect(
        claimIntentForSubmission(eligible!.id, Date.now(), db).claimed,
      ).toBe(true);
    },
  );

  it("binds an intent to a full account snapshot and rejects mismatched batch entries", () => {
    const run = createRun();
    const implicitBinding = orderInput(run, "SELL");
    const originalBinding = {
      kind: "local_sim",
      simAccountId: "account-1",
    } as const;
    for (const mismatch of [
      { venueKind: "ths_mock" },
      { venueBinding: { kind: "local_sim", simAccountId: "other-account" } },
      { venueBinding: { kind: "ths_mock", accountTag: "default" } },
    ] as const) {
      expect(() =>
        insertOrderIntents(
          run.id,
          [implicitBinding, orderInput(run, "BUY", mismatch)],
          db,
        ),
      ).toThrow(/账户绑定不匹配/);
      expect(listIntentsByRun(run.id, db)).toEqual([]);
    }
    const [sell, buy] = insertOrderIntents(
      run.id,
      [
        implicitBinding,
        orderInput(run, "BUY", { venueBinding: originalBinding }),
      ],
      db,
    );
    expect([sell?.venueBinding, buy?.venueBinding]).toEqual([
      originalBinding,
      originalBinding,
    ]);
    const newBinding = {
      kind: "local_sim",
      simAccountId: "account-2",
    } as const;
    updateDeploymentConfig(run.deploymentId, { venueBinding: newBinding }, db);
    expect(() =>
      insertOrderIntents(
        run.id,
        [orderInput(run, "BUY", { symbol: "SH600001" })],
        db,
      ),
    ).toThrow(/已锁定的交易通道或账户绑定不匹配/);
    expect(listIntentsByRun(run.id, db)).toEqual([sell, buy]);
    expect(listIntentsByDate(run.executeDate, undefined, db)).toEqual([
      sell,
      buy,
    ]);
    expect(claimIntentForSubmission(sell!.id, Date.now(), db)).toMatchObject({
      claimed: true,
      intent: { venueBinding: originalBinding },
    });
    const nextRun = getOrCreatePipelineRun(
      { ...runInput, runSlot: "next" },
      db,
    ).run;
    expect(
      insertOrderIntents(nextRun.id, [orderInput(nextRun, "BUY")], db)[0]
        ?.venueBinding,
    ).toEqual(newBinding);
  });

  it("requires a complete fill in both the repository and SQLite and preserves partial fills on cancellation", () => {
    const run = createRun();
    const [intent, fullFill] = insertOrderIntents(
      run.id,
      [
        orderInput(run, "SELL"),
        orderInput(run, "SELL", { symbol: "SH600001" }),
      ],
      db,
    );
    const id = intent!.id;
    claimIntentForSubmission(id, Date.now(), db);
    for (const patch of [
      {},
      { filledQuantity: null },
      { filledQuantity: 0 },
      { filledQuantity: 50 },
    ]) {
      expect(() => transitionIntentStatus(id, "filled", patch, db)).toThrow(
        "成交数量必须大于 0 且等于委托数量",
      );
    }
    const sql = db.prepare(
      "UPDATE execution_order_intents SET status='filled',filled_quantity=? WHERE id=?",
    );
    expect(() => sql.run(null, id)).toThrow(/CHECK constraint failed/);
    expect(() => sql.run(0, id)).toThrow(/CHECK constraint failed/);
    expect(() => sql.run(50, id)).toThrow(/CHECK constraint failed/);
    expect(
      listIntentsByRun(run.id, db).find((intent) => intent.id === id)?.status,
    ).toBe("submitting");
    transitionIntentStatus(id, "partial_filled", { filledQuantity: 50 }, db);
    expect(() =>
      transitionIntentStatus(id, "filled", { filledQuantity: null }, db),
    ).toThrow("已记录的成交数量不可清空或回退");
    expect(() =>
      transitionIntentStatus(id, "cancelled", { filledQuantity: null }, db),
    ).toThrow("已记录的成交数量不可清空或回退");
    expect(() => transitionIntentStatus(id, "filled", {}, db)).toThrow(
      "成交数量必须大于 0 且等于委托数量",
    );
    expect(transitionIntentStatus(id, "cancelled", {}, db)).toMatchObject({
      status: "cancelled",
      filledQuantity: 50,
    });
    claimIntentForSubmission(fullFill!.id, Date.now(), db);
    expect(
      transitionIntentStatus(
        fullFill!.id,
        "filled",
        { filledQuantity: 100 },
        db,
      ),
    ).toMatchObject({
      status: "filled",
      filledQuantity: 100,
    });
  });

  it("rolls back deployment creation and intent claims when auditing fails", () => {
    const run = createRun();
    const [intent] = insertOrderIntents(run.id, [orderInput(run, "SELL")], db);
    db.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON execution_audit_events
      BEGIN SELECT RAISE(ABORT, 'audit failed'); END;`);
    expect(() => createDeployment(deploymentInput("d2"), db)).toThrow(
      "audit failed",
    );
    expect(getDeployment("d2", db)).toBeNull();
    expect(() => claimIntentForSubmission(intent!.id, Date.now(), db)).toThrow(
      "audit failed",
    );
    expect(listIntentsByRun(run.id, db)[0]?.status).toBe("planned");
  });

  it("enforces foreign keys, enum values, JSON validity, and positive order values in SQLite", () => {
    const run = createRun();
    const [intent] = insertOrderIntents(run.id, [orderInput(run, "SELL")], db);
    expect(() =>
      db
        .prepare("UPDATE pipeline_runs SET deployment_id='missing' WHERE id=?")
        .run(run.id),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db
        .prepare("UPDATE pipeline_runs SET stage='unknown' WHERE id=?")
        .run(run.id),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          "UPDATE strategy_deployments SET risk_policy_json='broken' WHERE id=?",
        )
        .run(run.deploymentId),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare("UPDATE execution_order_intents SET quantity=0 WHERE id=?")
        .run(intent!.id),
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects raw cross-deployment and cross-run references while allowing run-only and deployment-only audits", () => {
    const run = createRun();
    const otherRun = getOrCreatePipelineRun(
      { ...runInput, runSlot: "next" },
      db,
    ).run;
    createDeployment(deploymentInput("d2"), db);
    const [intent] = insertOrderIntents(run.id, [orderInput(run, "SELL")], db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO execution_order_intents (
      id,run_id,deployment_id,decision_date,execute_date,idempotency_key,venue_kind,
      venue_binding_json,symbol,phase,side,quantity,reference_price,status,created_at,updated_at
    ) SELECT 'cross-deployment-intent',run_id,'d2',decision_date,execute_date,
      'cross-deployment-key',venue_kind,venue_binding_json,symbol,phase,side,quantity,
      reference_price,status,created_at,updated_at FROM execution_order_intents WHERE id=?`,
        )
        .run(intent!.id),
    ).toThrow(/FOREIGN KEY constraint failed/);

    const audit = db.prepare(`INSERT INTO execution_audit_events
      (deployment_id,run_id,intent_id,event_type,details_json,created_at)
      VALUES (?, ?, ?, 'raw_test', '{}', 1)`);
    expect(() => audit.run("d2", run.id, null)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(() => audit.run("d1", otherRun.id, intent!.id)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(() => audit.run("d1", null, intent!.id)).toThrow(
      /CHECK constraint failed/,
    );
    expect(audit.run("d2", null, null).changes).toBe(1);
    expect(audit.run("d1", run.id, null).changes).toBe(1);
    expect(audit.run("d1", run.id, intent!.id).changes).toBe(1);
    expect(
      appendExecutionAuditEvent(
        {
          deploymentId: "d1",
          intentId: intent!.id,
          eventType: "intent_reviewed",
        },
        db,
      ).runId,
    ).toBe(run.id);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects undeclared or missing JSON venue kinds and invalid pool policy JSON", () => {
    const run = createRun();
    const [intent] = insertOrderIntents(run.id, [orderInput(run, "SELL")], db);
    const setDeploymentBinding = db.prepare(
      "UPDATE strategy_deployments SET venue_binding_json=? WHERE id=?",
    );
    const setIntentBinding = db.prepare(
      "UPDATE execution_order_intents SET venue_binding_json=? WHERE id=?",
    );
    for (const invalid of [
      "broken",
      "{}",
      "null",
      '{"kind":null}',
      '{"kind":"invalid"}',
    ]) {
      expect(() => setDeploymentBinding.run(invalid, run.deploymentId)).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => setIntentBinding.run(invalid, intent!.id)).toThrow(
        /CHECK constraint failed/,
      );
    }
    expect(() =>
      setIntentBinding.run('{"kind":"ths_mock"}', intent!.id),
    ).toThrow(/CHECK constraint failed/);
    const setPolicy = db.prepare(
      "UPDATE strategy_deployments SET pool_policy_json=? WHERE id=?",
    );
    expect(() => setPolicy.run("broken", run.deploymentId)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => setPolicy.run(null, run.deploymentId)).toThrow(
      /NOT NULL constraint failed/,
    );
  });
});

describe("v25 deployment pool repository", () => {
  let db: Database.Database;
  const symbol = "SH600000";
  const emptyBatch = { added: [], retained: [], missedGrace: [], evicted: [] };

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    createDeployment(deploymentInput("d1"), db);
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("adds, retains, tracks missed days, evicts, and reactivates a screener entry", () => {
    expect(getActivePoolEntries("d1", db)).toEqual([]);
    applyPoolSyncBatch(
      "d1",
      {
        ...emptyBatch,
        asOf: "2026-11-17",
        added: [{ symbol, reason: "breakout", price: 10, score: 4 }],
      },
      db,
    );
    const [initial] = getActivePoolEntries("d1", db);
    expect(initial).toMatchObject({
      status: "watching",
      source: "screener",
      enteredDate: "2026-11-17",
      lastMatchedDate: "2026-11-17",
      consecutiveMissedDays: 0,
      entryPrice: 10,
      entryReason: "breakout",
      lastMetrics: { score: 4 },
    });

    applyPoolSyncBatch(
      "d1",
      {
        ...emptyBatch,
        asOf: "2026-11-18",
        retained: [{ symbol, metrics: { score: 5 } }],
      },
      db,
    );
    expect(getActivePoolEntries("d1", db)[0]).toMatchObject({
      enteredDate: "2026-11-17",
      entryPrice: 10,
      lastMatchedDate: "2026-11-18",
      consecutiveMissedDays: 0,
      lastMetrics: { score: 5 },
    });

    for (const [asOf, consecutiveMissedDays] of [
      ["2026-11-19", 1],
      ["2026-11-20", 2],
    ] as const) {
      applyPoolSyncBatch(
        "d1",
        {
          ...emptyBatch,
          asOf,
          missedGrace: [
            {
              symbol,
              consecutiveMissedDays,
              metrics: { score: 2 - consecutiveMissedDays },
            },
          ],
        },
        db,
      );
      expect(getActivePoolEntries("d1", db)[0]).toMatchObject({
        status: "watching",
        lastMatchedDate: "2026-11-18",
        consecutiveMissedDays,
        lastMetrics: { score: 2 - consecutiveMissedDays },
      });
    }

    applyPoolSyncBatch(
      "d1",
      {
        ...emptyBatch,
        asOf: "2026-11-23",
        evicted: [{ symbol, reason: "missed threshold" }],
      },
      db,
    );
    expect(getActivePoolEntries("d1", db)).toEqual([]);
    expect(
      listPoolEntries("d1", { status: "evicted" }, db).items,
    ).toMatchObject([
      {
        id: initial!.id,
        evictedDate: "2026-11-23",
        evictReason: "missed threshold",
      },
    ]);

    const reentry = {
      ...emptyBatch,
      asOf: "2026-11-24",
      added: [
        { symbol, reason: "new breakout", price: 12, metrics: { score: 6 } },
      ],
    };
    expect(applyPoolSyncBatch("d1", reentry, db).added).toBe(1);
    const active = getActivePoolEntries("d1", db);
    expect(active).toMatchObject([
      {
        id: initial!.id,
        status: "watching",
        source: "screener",
        enteredDate: "2026-11-24",
        lastMatchedDate: "2026-11-24",
        consecutiveMissedDays: 0,
        entryPrice: 12,
        entryReason: "new breakout",
        lastMetrics: { score: 6 },
        evictedDate: null,
        evictReason: null,
        createdAt: initial!.createdAt,
      },
    ]);
    expect(listPoolEntries("d1", { status: "evicted" }, db).items).toEqual([]);
    expect(applyPoolSyncBatch("d1", reentry, db).added).toBe(0);
    expect(getActivePoolEntries("d1", db)).toEqual(active);
    const audits = listExecutionAuditEvents(
      { deploymentId: "d1" },
      db,
    ).items.filter(({ eventType }) => eventType === "pool_synced");
    expect(audits).toHaveLength(7);
    expect(audits[0]).toMatchObject({
      runId: null,
      intentId: null,
      details: {
        asOf: "2026-11-24",
        added: 0,
        retained: 0,
        missedGrace: 0,
        evicted: 0,
      },
    });
  });

  it("adds and evicts a manual entry with audits and records its latest signal", () => {
    const manual = manualAddPoolEntry("d1", { symbol, asOf: "2026-11-24" }, db);
    expect(manual).toMatchObject({
      source: "manual",
      status: "watching",
      entryPrice: null,
      entryReason: "手动入池",
      lastMetrics: {},
    });
    expect(
      recordPoolEntrySignal(
        "d1",
        symbol,
        { signalDate: "2026-11-25", action: "BUY" },
        db,
      ),
    ).toMatchObject({
      id: manual.id,
      lastSignalDate: "2026-11-25",
      lastSignalAction: "BUY",
    });
    expect(
      manualEvictPoolEntry(
        "d1",
        symbol,
        { asOf: "2026-11-26", reason: "reviewed" },
        db,
      ),
    ).toMatchObject({
      id: manual.id,
      status: "evicted",
      evictedDate: "2026-11-26",
      evictReason: "reviewed",
      lastSignalDate: "2026-11-25",
      lastSignalAction: "BUY",
    });
    expect(getActivePoolEntries("d1", db)).toEqual([]);
    expect(
      listExecutionAuditEvents({ deploymentId: "d1" }, db).items.map(
        ({ eventType }) => eventType,
      ),
    ).toEqual([
      "pool_manual_evicted",
      "pool_manual_added",
      "deployment_created",
    ]);
  });

  it("rolls back stale sync batches against both recent matches and later evictions", () => {
    const nextSymbol = "SH600001";
    const matched = manualAddPoolEntry(
      "d1",
      { symbol, asOf: "2026-11-23" },
      db,
    );
    const added = [
      { symbol: nextSymbol, reason: "breakout", price: 10, score: 4 },
    ];
    const audits = listExecutionAuditEvents({ deploymentId: "d1" }, db).items;
    expect(() =>
      applyPoolSyncBatch(
        "d1",
        { ...emptyBatch, asOf: "2026-11-22", added, retained: [symbol] },
        db,
      ),
    ).toThrow(/早于标的 sh600000 的最近记录日期/);
    expect(getActivePoolEntries("d1", db)).toEqual([matched]);
    expect(listExecutionAuditEvents({ deploymentId: "d1" }, db).items).toEqual(
      audits,
    );

    const evicted = manualEvictPoolEntry(
      "d1",
      symbol,
      { asOf: "2026-11-25" },
      db,
    );
    expect(() =>
      applyPoolSyncBatch(
        "d1",
        {
          ...emptyBatch,
          asOf: "2026-11-24",
          added: [{ ...added[0]!, symbol }],
        },
        db,
      ),
    ).toThrow(/早于标的 sh600000 的最近记录日期/);
    expect(listPoolEntries("d1", {}, db).items).toEqual([evicted]);
  });

  it("enforces pool capacity for both writes and counts evictions in the same batch", () => {
    updateDeploymentConfig(
      "d1",
      { poolPolicy: { eviction: { maxPoolSize: 1 } } },
      db,
    );
    const asOf = "2026-11-24";
    const nextSymbol = "SH600001";
    const entry = manualAddPoolEntry("d1", { symbol, asOf }, db);
    const batch = {
      ...emptyBatch,
      asOf,
      added: [{ symbol: nextSymbol, reason: "breakout", price: 10, score: 4 }],
    };
    const audits = listExecutionAuditEvents({ deploymentId: "d1" }, db).items;
    expect(() =>
      manualAddPoolEntry("d1", { symbol: nextSymbol, asOf }, db),
    ).toThrow(/监控池.*超过上限 1/);
    expect(() => applyPoolSyncBatch("d1", batch, db)).toThrow(
      /监控池.*超过上限 1/,
    );
    expect(listPoolEntries("d1", {}, db).items).toEqual([entry]);
    expect(listExecutionAuditEvents({ deploymentId: "d1" }, db).items).toEqual(
      audits,
    );

    expect(
      applyPoolSyncBatch(
        "d1",
        { ...batch, evicted: [{ symbol, reason: "replacement" }] },
        db,
      ),
    ).toMatchObject({ added: 1, evicted: 1 });
    expect(getActivePoolEntries("d1", db).map(({ symbol }) => symbol)).toEqual([
      "sh600001",
    ]);
  });

  it("scopes entries to their deployment and paginates tied update timestamps", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    for (const [entrySymbol, asOf] of [
      ["SH600003", "2026-11-24"],
      ["SH600002", "2026-11-24"],
      [symbol, "2026-11-25"],
    ] as const) {
      manualAddPoolEntry("d1", { symbol: entrySymbol, asOf }, db);
    }
    createDeployment(deploymentInput("d2"), db);
    manualAddPoolEntry("d2", { symbol, asOf: "2026-11-24" }, db);
    expect(getActivePoolEntries("d1", db).map((entry) => entry.symbol)).toEqual(
      ["sh600002", "sh600003", "sh600000"],
    );
    const all = listPoolEntries("d1", {}, db).items;
    expect(all).toHaveLength(3);
    const first = listPoolEntries("d1", { status: "watching", limit: 2 }, db);
    const second = listPoolEntries(
      "d1",
      { status: "watching", limit: 2, cursor: first.nextCursor! },
      db,
    );
    expect([...first.items, ...second.items]).toEqual(all);
    expect(second.nextCursor).toBeNull();
  });

  it("rejects invalid pool inputs and rolls back writes when the batch audit fails", () => {
    const asOf = "2026-11-24";
    const original = manualAddPoolEntry("d1", { symbol, asOf }, db);
    expect(() =>
      manualAddPoolEntry(
        "d1",
        { symbol, asOf, metrics: { score: Infinity } },
        db,
      ),
    ).toThrow(/metrics/);
    expect(() =>
      manualEvictPoolEntry("d1", symbol, { asOf: "2026-02-30" }, db),
    ).toThrow(/asOf/);
    expect(() => listPoolEntries("d1", { cursor: "{}" }, db)).toThrow();
    expect(() =>
      applyPoolSyncBatch(
        "d1",
        {
          ...emptyBatch,
          asOf,
          retained: [symbol],
          evicted: [{ symbol, reason: "conflict" }],
        },
        db,
      ),
    ).toThrow("证券代码不能重复");
    db.exec(`CREATE TRIGGER reject_pool_audit BEFORE INSERT ON execution_audit_events
      WHEN NEW.event_type='pool_synced' BEGIN SELECT RAISE(ABORT, 'pool audit failed'); END;`);
    expect(() =>
      applyPoolSyncBatch(
        "d1",
        {
          ...emptyBatch,
          asOf: "2026-11-25",
          added: [{ symbol: "SH600001", reason: "new" }],
          evicted: [{ symbol, reason: "retired" }],
        },
        db,
      ),
    ).toThrow("pool audit failed");
    expect(listPoolEntries("d1", {}, db).items).toEqual([original]);
  });
});

it("does not repeat run creation or an intent claim across two SQLite connections", () => {
  const path = join(process.env.QUANT_DATA_DIR!, "v25-shared.sqlite");
  const writer = new Database(path);
  const retry = new Database(path, { timeout: 0 });
  try {
    migrate(writer);
    createDeployment(
      { ...deploymentInput("d1"), status: "active", executionMode: "auto_sim" },
      writer,
    );
    setGlobalAutoSimEnabled(true, writer);
    const initial = getOrCreatePipelineRun(runInput, writer);
    expect(initial.created).toBe(true);
    expect(getOrCreatePipelineRun(runInput, retry)).toEqual({
      run: initial.run,
      created: false,
    });
    const [intent] = insertOrderIntents(
      initial.run.id,
      [orderInput(initial.run, "BUY")],
      writer,
    );
    const at = Date.now();
    expect(claimIntentForSubmission(intent!.id, at, writer).claimed).toBe(true);
    writer
      .transaction(() => {
        expect(() => claimIntentForSubmission(intent!.id, at, retry)).toThrow(
          /database is locked/,
        );
      })
      .immediate();
    expect(claimIntentForSubmission(intent!.id, at, retry)).toEqual({
      claimed: false,
      reason: "invalid-status",
    });
    expect(
      listExecutionAuditEvents(
        { deploymentId: "d1", runId: initial.run.id },
        retry,
      ).items.filter(({ eventType }) => eventType === "intent_claimed"),
    ).toHaveLength(1);
  } finally {
    retry.close();
    writer.close();
  }
});
