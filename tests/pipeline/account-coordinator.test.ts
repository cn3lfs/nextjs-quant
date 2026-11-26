import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VenueBinding } from "trading-strategies";
import {
  createDeployment,
  updateDeploymentConfig,
  type CreateDeploymentInput,
} from "~/server/db/deployment-repository";
import { migrate } from "~/server/db/migrations";
import {
  appendExecutionAuditEvent,
  findPipelineRun,
  getOrCreatePipelineRun,
  insertOrderIntents,
  listIntentsByRun,
  transitionIntentStatus,
} from "~/server/db/pipeline-repository";
import {
  upsertSleeveHolding,
  type SleeveHolding,
} from "~/server/db/sleeve-holding-repository";
import {
  decisionIndustries,
  planningAccount,
  readPlanningFacts,
} from "~/server/pipeline/account-coordinator";
import { tickPipelineScheduler } from "~/server/pipeline/pipeline-scheduler";
import {
  runPipelinePlanning,
  type PipelineAccountState,
  type PipelinePlanningDeps,
} from "~/server/pipeline/signal-risk-runner";

const date = "2024-04-30",
  next = "2024-05-06",
  before = "2024-04-29";
const A = "sh600001",
  B = "sh600002",
  C = "sh600003",
  D = "sh600004",
  E = "sh600005";
const bond = "sh511010",
  domestic = "sh510300";
const external = { kind: "ths_mock", accountTag: "default" } as const;
const flat: PipelineAccountState = {
  equity: 100000,
  cash: 100000,
  drawdownPct: 0,
  positions: [],
};
let db: Database.Database;
const fetchMock = vi.fn(() => {
  throw new Error("test attempted network access");
});
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  if (db.open) db.close();
  vi.unstubAllGlobals();
  expect(fetchMock).not.toHaveBeenCalled();
});

function deploy(id: string, overrides: Partial<CreateDeploymentInput> = {}) {
  return createDeployment(
    {
      id,
      name: id,
      market: "cn-equity",
      status: "active",
      executionMode: "shadow",
      strategySpec: { kind: "macro-clock" },
      universeSpec: { kind: "fixed-symbols", symbols: [A] },
      regimeGate: { kind: "none", unlockAvoidanceDays: 0 },
      riskPolicy: {},
      venueBinding: external,
      schedule: { kind: "manual_only" },
      provenance: { sourceKind: "manual" },
      ...overrides,
    },
    db,
  );
}
function sleeve(
  dep: ReturnType<typeof deploy>,
  symbol: string,
  quantity: number,
  extra: Partial<SleeveHolding> = {},
) {
  return upsertSleeveHolding(
    {
      ...planningAccount(dep.venueBinding),
      ownerKind: "deployment",
      ownerId: dep.id,
      symbol,
      quantity,
      avgEntryPrice: 10,
      entryDate: before,
      updatedAt: Date.parse(before),
      ...extra,
    },
    db,
  );
}
const position = (symbol: string, quantity: number, sellable = quantity) => ({
  symbol,
  quantity,
  sellable,
  lastPrice: 10,
});
function inputs(
  state: PipelineAccountState,
  targets: Record<string, number> = { [A]: 1 },
): PipelinePlanningDeps {
  return {
    readAccountState: () => state,
    readReferencePrice: () => 10,
    readIndustries: (symbol) => [symbol],
    universe: { readBars: () => [] },
    strategy: {
      readTradingSessions: () => [before, date, next],
      resolveMacroClock: () => ({ regime: "recovery", targets }),
    },
  };
}
function run(
  dep: ReturnType<typeof deploy>,
  deps: PipelinePlanningDeps,
  runSlot = "daily",
  executeDate = next,
) {
  return runPipelinePlanning(
    {
      deploymentId: dep.id,
      decisionDate: date,
      executeDate,
      runSlot,
      triggerKind: "manual",
      deps,
    },
    db,
  );
}
function commitment(
  dep: ReturnType<typeof deploy>,
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  executeDate = next,
  connection = db,
) {
  const { run } = getOrCreatePipelineRun(
    {
      deploymentId: dep.id,
      decisionDate: before,
      runSlot: symbol + side,
      triggerKind: "manual",
      executeDate,
    },
    connection,
  );
  return insertOrderIntents(
    run.id,
    [
      {
        deploymentId: dep.id,
        runId: run.id,
        venueBinding: dep.venueBinding,
        venueKind: dep.venueBinding.kind,
        phase: side === "BUY" ? 2 : 1,
        symbol,
        side,
        quantity,
        referencePrice: 10,
      },
    ],
    connection,
  )[0]!;
}

it.each([
  external,
  { kind: "local_sim", simAccountId: "shared" },
  { kind: "cn_broker_live", broker: "qmt", accountId: "shared" },
] satisfies VenueBinding[])(
  "only evaluated deployment inventory can be sold on $kind, including a shared symbol",
  async (binding) => {
    const dep = deploy("target", { venueBinding: binding }),
      other = deploy("other", { venueBinding: binding });
    sleeve(dep, B, 300);
    sleeve(other, B, 700);
    sleeve(dep, C, 200, { ownerKind: "manual", ownerId: "manual" });
    sleeve(dep, D, 400, { ownerKind: "legacy_unknown", ownerId: "unknown" });
    const result = await run(
      dep,
      inputs({
        ...flat,
        positions: [
          position(B, 1000),
          position(C, 200),
          position(D, 400),
          position(E, 100),
        ],
      }),
    );
    expect(result.run.signals).toMatchObject({ targets: { [A]: 1, [B]: 0 } });
    expect(
      Object.keys((result.run.signals as { targets: object }).targets).sort(),
    ).toEqual([A, B]);
    expect(result.intents.filter((i) => i.side === "SELL")).toMatchObject([
      { symbol: B, quantity: 300 },
    ]);
  },
);

it.each([
  {
    kind: "crypto_sim",
    venue: "binance",
    accountId: "wallet",
    scope: "crypto_sim",
  },
  { kind: "crypto_live", venue: "okx", accountId: "wallet", scope: "real" },
] as const)(
  "maps $kind sleeves to its executor account",
  ({ scope, ...binding }) => {
    expect(planningAccount(binding)).toEqual({
      accountScope: scope,
      accountId: `${binding.kind}:${binding.venue}:wallet`,
    });
  },
);

it("换绑同号券商后不继承旧券商的分仓、在途买单和账户限额", async () => {
  const oldBinding = {
    kind: "cn_broker_live",
    broker: "qmt",
    accountId: "same",
  } as const;
  const newBinding = { ...oldBinding, broker: "ptrade" } as const;
  const dep = deploy("rebound", { venueBinding: oldBinding });
  deploy("old-peer", {
    venueBinding: oldBinding,
    riskPolicy: { maxSymbolWeight: 0.01 },
  });
  sleeve(dep, B, 300);
  commitment(dep, A, "BUY", 100);
  const rebound = updateDeploymentConfig(
    dep.id,
    { venueBinding: newBinding },
    db,
  );
  const facts = readPlanningFacts(rebound, date, next, db);
  expect(facts.ownedSleeves).toEqual([]);
  expect(facts.commitments).toEqual([]);
  expect(facts.accountCaps?.symbol).toBe(rebound.riskPolicy.maxSymbolWeight);
  const result = await run(
    rebound,
    inputs({ ...flat, positions: [position(B, 300)] }),
  );
  expect(result.intents.filter((i) => i.side === "SELL")).toEqual([]);
});

it("same-day T+1 top-ups cannot borrow another sleeve's seasoned lots; bond ETF T+0 can sell", async () => {
  const dep = deploy("owner"),
    other = deploy("peer");
  sleeve(dep, B, 400);
  sleeve(other, B, 600);
  sleeve(dep, bond, 300, { entryDate: date });
  sleeve(dep, domestic, 300, { entryDate: date });
  const buy = commitment(dep, B, "BUY", 200, date);
  db.prepare(
    "UPDATE execution_order_intents SET status='filled',filled_quantity=200,updated_at=? WHERE id=?",
  ).run(Date.parse(date + "T14:00:00+08:00"), buy.id);
  commitment(dep, B, "SELL", 100, date);
  commitment(other, B, "SELL", 400, date);
  const state = {
    ...flat,
    positions: [
      position(B, 1000, 800),
      position(bond, 300),
      position(domestic, 500, 200),
    ],
  };
  const result = await run(dep, inputs(state), "same-day", date);
  expect(result.run.signals).toMatchObject({
    targets: { [B]: 0, [bond]: 0, [domestic]: 0 },
  });
  expect(
    result.intents
      .filter((i) => i.side === "SELL")
      .map((i) => [i.symbol, i.quantity])
      .sort(),
  ).toEqual(
    [
      [bond, 300],
      [B, 100],
    ].sort(),
  );
  expect(result.run.riskVerdict).toMatchObject({
    skipped: expect.arrayContaining([
      { symbol: domestic, side: "SELL", reason: "t_plus_1_locked" },
    ]),
  });
  const again = await run(dep, inputs(state), "same-day-again", date);
  expect(again.intents.filter((i) => i.side === "SELL")).toEqual([]);
});

it("a delayed external buy locks its actual trade day instead of its scheduled day", async () => {
  const dep = deploy("delayed");
  sleeve(dep, B, 500);
  const buy = commitment(dep, B, "BUY", 200, before);
  db.prepare(
    "UPDATE execution_order_intents SET status='filled',filled_quantity=200 WHERE id=?",
  ).run(buy.id);
  appendExecutionAuditEvent(
    {
      deploymentId: dep.id,
      runId: buy.runId,
      intentId: buy.id,
      eventType: "sleeve_fill_delta",
      createdAt: Date.parse(date + "T14:00:00+08:00"),
      details: { tradeDate: date, quantityDelta: 200 },
    },
    db,
  );
  const result = await run(
    dep,
    inputs({ ...flat, positions: [position(B, 1000, 800)] }),
    "delayed",
    date,
  );
  expect(result.intents.filter((i) => i.side === "SELL")).toMatchObject([
    { symbol: B, quantity: 300 },
  ]);
});

it.each(["universe", "signals"] as const)(
  "resuming after %s keeps the original ownership and same-day T+1 quantities",
  async (stopAfterStage) => {
    const start = Date.parse(date + "T15:30:00+08:00");
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const dep = deploy("resume", {
        venueBinding: { kind: "local_sim", simAccountId: "frozen" },
      });
      sleeve(dep, B, 500, { updatedAt: start });
      const buy = commitment(dep, B, "BUY", 300, date);
      const receipt = (quantityDelta: number, createdAt: number) =>
        appendExecutionAuditEvent(
          {
            deploymentId: dep.id,
            runId: buy.runId,
            intentId: buy.id,
            eventType: "sleeve_fill_delta",
            createdAt,
            details: { tradeDate: date, quantityDelta },
          },
          db,
        );
      receipt(100, start);
      const state = {
        ...flat,
        positions: [position(B, 800), position(C, 300)],
      };
      const accountReader = vi.fn(() => state);
      const args = {
        deploymentId: dep.id,
        decisionDate: date,
        executeDate: date,
        runSlot: "staged",
        triggerKind: "manual",
        deps: { ...inputs(state), readAccountState: accountReader },
      } as const;
      const paused = await runPipelinePlanning({ ...args, stopAfterStage }, db);
      expect(paused.run.startedAt).toBe(start);

      // Both fills are on the same decision day, but were booked after this run began.
      clock.mockReturnValue(start + 1);
      sleeve(dep, B, 700, { updatedAt: start + 1 });
      sleeve(dep, C, 300, { updatedAt: start + 1 });
      receipt(200, start + 1);
      const resumed = await runPipelinePlanning(args, db);
      expect(accountReader).toHaveBeenCalledWith(
        dep.venueBinding,
        date,
        db,
        start,
      );
      expect((resumed.run.signals as { targets: object }).targets).toEqual({
        [A]: 1,
        [B]: 0,
      });
      expect(resumed.intents.filter((i) => i.side === "SELL")).toMatchObject([
        { symbol: B, quantity: 400 },
      ]);
      expect(resumed.run.riskVerdict).toMatchObject({
        unattributedPositions: [
          { symbol: B, quantity: 300 },
          { symbol: C, quantity: 300 },
        ],
      });
    } finally {
      clock.mockRestore();
    }
  },
);

it.each(["staged", "next-morning"] as const)(
  "rebuilds %s sleeve balances only through the earlier of decision close and run start",
  async (scenario) => {
    const start = Date.parse(date + "T15:30:00+08:00");
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const dep = deploy("older-run");
      if (scenario === "staged")
        getOrCreatePipelineRun(
          {
            deploymentId: dep.id,
            decisionDate: date,
            executeDate: next,
            runSlot: "older",
            triggerKind: "manual",
          },
          db,
        );
      const buy = commitment(dep, B, "BUY", 700, before);
      const later =
        scenario === "staged"
          ? start + 1
          : Date.parse(next + "T08:00:00+08:00");
      for (const [quantityDelta, createdAt] of [
        [500, start],
        [200, later],
      ] as const) {
        appendExecutionAuditEvent(
          {
            deploymentId: dep.id,
            runId: buy.runId,
            intentId: buy.id,
            eventType: "sleeve_fill_delta",
            createdAt,
            details: { quantityDelta, tradeDate: before },
          },
          db,
        );
      }
      clock.mockReturnValue(later);
      sleeve(dep, B, 700, { updatedAt: later });
      sleeve(dep, C, 200, { updatedAt: later });
      const result = await run(
        dep,
        inputs({
          ...flat,
          positions: [position(B, 700), position(C, 200)],
        }),
        "older",
      );
      expect(result.intents.filter((i) => i.side === "SELL")).toMatchObject([
        { symbol: B, quantity: 500 },
      ]);
    } finally {
      clock.mockRestore();
    }
  },
);

it("a manual reduction that leaves fewer shares than the attributed sleeves cannot consume another owner's inventory", async () => {
  const dep = deploy("strategy");
  sleeve(dep, B, 400);
  sleeve(dep, B, 600, { ownerKind: "manual", ownerId: "manual" });
  const result = await run(
    dep,
    inputs({ ...flat, positions: [position(B, 700)] }),
  );
  expect(result.intents.filter((i) => i.side === "SELL")).toMatchObject([
    { symbol: B, quantity: 100 },
  ]);
});

it("a pending partial exit only releases the unreserved part of a target reduction", async () => {
  const dep = deploy("partial-sell");
  sleeve(dep, B, 850);
  const sale = commitment(dep, B, "SELL", 250);
  db.prepare(
    "UPDATE execution_order_intents SET status='partial_filled',filled_quantity=150 WHERE id=?",
  ).run(sale.id);
  // 850 currently held, 550 desired, 100 still pending -> sell 200.
  const result = await run(
    dep,
    inputs(
      { ...flat, positions: [position(B, 850)] },
      { [A]: 0.1, [B]: 0.055 },
    ),
  );
  expect(result.intents.filter((i) => i.side === "SELL")).toMatchObject([
    { symbol: B, quantity: 200 },
  ]);
});

it.each([
  ["null drawdown", { drawdownPct: null }],
  ["missing drawdown", { drawdownPct: undefined }],
  ["nonfinite drawdown", { drawdownPct: NaN }],
  ["missing equity", { equity: undefined }],
  ["nonfinite cash", { cash: Infinity }],
  [
    "missing account mark",
    { positions: [{ ...position(B, 200), lastPrice: null }] },
  ],
])("%s blocks buys while retaining a priced owned exit", async (_, patch) => {
  const dep = deploy("bad-evidence");
  sleeve(dep, B, 200);
  const state = {
    ...flat,
    positions: [position(B, 200)],
    ...(patch as object),
  } as PipelineAccountState;
  const result = await run(dep, inputs(state));
  expect(result.intents).toMatchObject([
    { symbol: B, side: "SELL", quantity: 200 },
  ]);
  expect(result.run.riskVerdict).toMatchObject({
    scope: "account",
    allowNewEntries: false,
    reasons: ["risk-evidence-missing"],
    skipped: [{ symbol: A, side: "BUY", reason: "risk-evidence-missing" }],
  });
  expect(await run(dep, inputs(flat))).toEqual(result);
});

it("an unavailable external account produces a persisted buy gate", async () => {
  const dep = deploy("unavailable");
  const result = await run(dep, {
    ...inputs(flat),
    readAccountState: () => null,
  });
  expect(result.run).toMatchObject({
    stage: "blocked",
    riskVerdict: { reasons: ["risk-evidence-missing"] },
  });
  expect(result.intents).toEqual([]);
});

it.each([
  ["reduced", 1000],
  ["halted", 0],
  ["normal", 2000],
] as const)(
  "local account %s is respected even after drawdown has fallen below pause",
  async (riskRegime, quantity) => {
    const dep = deploy("local", {
      venueBinding: { kind: "local_sim", simAccountId: "risk" },
    });
    sleeve(dep, B, 100);
    const result = await run(
      dep,
      inputs({ ...flat, riskRegime, positions: [position(B, 100)] }),
    );
    expect(result.intents.filter((i) => i.side === "SELL")).toMatchObject([
      { symbol: B, quantity: 100 },
    ]);
    expect(result.intents.find((i) => i.side === "BUY")?.quantity ?? 0).toBe(
      quantity,
    );
    expect(result.run.riskVerdict).toMatchObject({
      riskRegime,
      allowNewEntries: riskRegime !== "halted",
    });
    if (riskRegime === "reduced")
      expect(result.run.riskVerdict).toMatchObject({
        entryScale: 0.5,
        clipped: [
          { symbol: A, reasons: expect.arrayContaining(["drawdown_reduced"]) },
        ],
      });
  },
);

it.each([
  {
    reason: "instrument_cap",
    symbol: A,
    held: 1200,
    pending: 500,
    quantity: 300,
  },
  {
    reason: "industry_cap",
    symbol: B,
    held: 1500,
    pending: 500,
    quantity: 500,
  },
  {
    reason: "total_exposure_cap",
    symbol: C,
    held: 1500,
    pending: 500,
    quantity: 500,
  },
  { reason: "cash_cap", symbol: C, held: 0, pending: 1000, quantity: 400 },
])(
  "account $reason includes other ownership and pending buys, recording a nonzero clip",
  async ({ reason, symbol, held, pending, quantity }) => {
    const dep = deploy("target", {
        riskPolicy: {
          maxTotalExposure: reason === "total_exposure_cap" ? 0.25 : 1,
        },
      }),
      peer = deploy("peer");
    if (held) sleeve(peer, symbol, held);
    commitment(peer, symbol, "BUY", pending);
    const deps = inputs({
      ...flat,
      cash: reason === "cash_cap" ? 15000 : 70000,
      positions: held ? [position(symbol, held)] : [],
    });
    deps.readIndustries = (s) => [s === B ? A : s];
    const result = await run(dep, deps);
    expect(result.intents).toMatchObject([
      { symbol: A, side: "BUY", quantity },
    ]);
    expect(result.run.riskVerdict).toMatchObject({
      clipped: [
        { symbol: A, quantity, reasons: expect.arrayContaining([reason]) },
      ],
    });
  },
);

it("concurrent manual requests share one commitment; unknown and partial receipts reserve just the live remainder", async () => {
  const first = deploy("one"),
    second = deploy("two"),
    third = deploy("three");
  const results = await Promise.all([
    run(first, inputs(flat)),
    run(second, inputs(flat)),
  ]);
  expect(results.flatMap((r) => r.intents).map((i) => i.quantity)).toEqual([
    2000,
  ]);
  const intent = results[0]!.intents[0]!;
  db.prepare(
    "UPDATE execution_order_intents SET status='unknown_reconcile',filled_quantity=500 WHERE id=?",
  ).run(intent.id);
  const account = { ...flat, positions: [position(A, 500)] };
  expect((await run(third, inputs(account))).intents).toEqual([]);
  transitionIntentStatus(intent.id, "cancelled", {}, db);
  expect((await run(third, inputs(account), "released")).intents).toMatchObject(
    [{ symbol: A, quantity: 1500 }],
  );
});

it("未验证的成交回报不释放共享现金，只有已入账的部分成交才释放对应预留", async () => {
  const peer = deploy("pending-buy");
  const nextDeployment = deploy("next-buy", {
    universeSpec: { kind: "fixed-symbols", symbols: [B] },
  });
  const intent = commitment(peer, A, "BUY", 2000);
  db.prepare(
    "UPDATE execution_order_intents SET status='unknown_reconcile',filled_quantity=500 WHERE id=?",
  ).run(intent.id);
  const deps = inputs({ ...flat, cash: 20000 }, { [B]: 1 });
  const unverified = await run(nextDeployment, deps);
  expect(unverified.intents).toEqual([]);
  expect(unverified.run.riskVerdict).toMatchObject({
    skipped: [{ symbol: B, side: "BUY", reason: "cash_cap" }],
  });

  appendExecutionAuditEvent(
    {
      deploymentId: peer.id,
      runId: intent.runId,
      intentId: intent.id,
      eventType: "sleeve_fill_delta",
      details: {
        filledQuantity: 500,
        averageFillPrice: 10,
        quantityDelta: 500,
      },
    },
    db,
  );
  const verified = await run(
    nextDeployment,
    inputs({ ...flat, cash: 20000, positions: [position(A, 500)] }, { [B]: 1 }),
    "verified-receipt",
  );
  expect(verified.intents).toMatchObject([{ symbol: B, side: "BUY" }]);
  expect(verified.intents[0]!.quantity).toBeGreaterThan(0);
  expect(verified.run.riskVerdict).toMatchObject({
    clipped: [{ symbol: B, reasons: expect.arrayContaining(["cash_cap"]) }],
  });
});

it("an independent writer reserving during pricing is observed before publication", async () => {
  const directory = mkdtempSync(
    join(process.env.QUANT_DATA_DIR ?? tmpdir(), "atomic-publish-"),
  );
  const filename = join(directory, "isolated.sqlite");
  db.close();
  db = new Database(filename);
  migrate(db);
  const writer = new Database(filename);
  try {
    const dep = deploy("request"),
      peer = deploy("independent");
    let injected = false;
    const state = vi.fn(() => flat);
    const result = await run(dep, {
      ...inputs(flat),
      readAccountState: state,
      readReferencePrice: () => {
        if (!injected) {
          injected = true;
          commitment(peer, A, "BUY", 1500, next, writer);
        }
        return 10;
      },
    });
    expect(state).toHaveBeenCalledTimes(2);
    expect(result.intents).toMatchObject([{ symbol: A, quantity: 500 }]);
    expect(listIntentsByRun(result.run.id, db)).toEqual(result.intents);
  } finally {
    writer.close();
    db.close();
    rmSync(directory, { recursive: true });
  }
});

it("scheduler competition awards shared cash in deployment ID order, independent of insertion order", async () => {
  for (const id of ["z", "a"])
    deploy(id, { schedule: { kind: "post_close_auto", executeAtOpen: false } });
  const result = await tickPipelineScheduler(
    {
      now: Date.parse(date + "T16:00:00+08:00"),
      deps: {
        ...inputs({ ...flat, cash: 10500 }),
        isTradingDay: () => true,
        nextTradingDay: () => next,
        isPostCloseDataReady: () => true,
      },
    },
    db,
  );
  expect(result).toMatchObject({
    plannedRuns: 2,
    executedRuns: 0,
    failures: [],
  });
  expect(
    listIntentsByRun(findPipelineRun("a", date, db)!.id, db),
  ).toMatchObject([{ symbol: A, quantity: 1000 }]);
  expect(listIntentsByRun(findPipelineRun("z", date, db)!.id, db)).toEqual([]);
});

it.each(["non-rebalance-day", "missing-data"] as const)(
  "persists %s on signals and risk and replays without liquidating",
  async (reason) => {
    const dep = deploy("skip");
    sleeve(dep, B, 500);
    const deps = inputs({ ...flat, positions: [position(B, 500)] });
    deps.strategy = {
      ...deps.strategy,
      readTradingSessions: () =>
        reason === "missing-data" ? [] : [before, date],
    };
    const decisionDate = reason === "missing-data" ? date : before;
    const args = {
      deploymentId: dep.id,
      decisionDate,
      executeDate: next,
      triggerKind: "manual",
      deps,
    } as const;
    const result = await runPipelinePlanning(args, db);
    expect(result).toMatchObject({
      skipReason: reason,
      intents: [],
      run: {
        stage: "completed",
        signals: {
          skipReason: reason,
          signals: [{ symbol: B, action: "HOLD" }],
        },
        riskVerdict: { scope: "account", skipReason: reason },
      },
    });
    expect(
      await runPipelinePlanning(
        {
          ...args,
          deps: {
            readAccountState: () => {
              throw Error("unexpected replay read");
            },
          },
        },
        db,
      ),
    ).toEqual(result);
  },
);

it("future sleeve mutations and industry backfills do not become decision-day evidence", async () => {
  const dep = deploy("pit");
  sleeve(dep, B, 500, { updatedAt: Date.parse(next) });
  sleeve(dep, C, 200, { entryDate: next });
  const result = await run(
    dep,
    inputs({ ...flat, positions: [position(B, 500), position(C, 200)] }),
  );
  expect((result.run.signals as { targets: object }).targets).toEqual({
    [A]: 1,
  });
  expect(result.intents.map((i) => i.side)).toEqual(["BUY"]);
  db.prepare("INSERT INTO industry_rps_days(date,payload) VALUES(?,?)").run(
    date,
    JSON.stringify({
      date,
      createdAt: Date.parse(next),
      industry: {
        snapshot: {
          files: [{ name: "future", members: [A], mtimeMs: Date.parse(next) }],
        },
      },
    }),
  );
  expect(decisionIndustries(date, db).size).toBe(0);
});
