import Database from "better-sqlite3";
import type { Bar } from "trading-strategy-core/bars";
import { etfRotationCatalog } from "trading-strategies";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDeployment,
  updateDeploymentStatus,
  type CreateDeploymentInput,
} from "~/server/db/deployment-repository";
import { upsertSleeveHolding } from "~/server/db/sleeve-holding-repository";
import { migrate } from "~/server/db/migrations";
import {
  findPipelineRun,
  listIntentsByRun,
} from "~/server/db/pipeline-repository";
import {
  getActivePoolEntries,
  listPoolEntries,
} from "~/server/db/pool-repository";
import {
  evaluateRegimeGate,
  planOrderIntents,
  readLocalSimAccountState,
  runPipelinePlanning,
  type PipelineAccountState,
  type PipelinePlanningDeps,
} from "~/server/pipeline/signal-risk-runner";
import {
  confirmSimOrder,
  createSimAccount,
  executePipelineSimOrder,
  postSimCashFlow,
} from "~/server/portfolio/sim-accounts/service";

const A = "sh600001";
const B = "sh600002";
const C = "sh600003";
const D = "sh600004";
const E = "sh600005";
const day1 = "2024-04-15";
const day2 = "2024-04-16";
const day3 = "2024-04-17";
const day4 = "2024-04-18";
const dayMs = 86_400_000;
let db: Database.Database;
let fetchAttempt: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  fetchAttempt = vi.fn(() => {
    throw new Error("离线测试禁止联网");
  });
  vi.stubGlobal("fetch", fetchAttempt);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(fetchAttempt).not.toHaveBeenCalled();
});

function bar(date: string, close = 10, volume = 100): Bar {
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
    amount: close * volume,
  };
}

function history(end: string, length = 60, close = 10) {
  return Array.from({ length }, (_, index) =>
    bar(
      new Date(Date.parse(end) - (length - 1 - index) * dayMs)
        .toISOString()
        .slice(0, 10),
      close,
    ),
  );
}

function deployment(overrides: Partial<CreateDeploymentInput> = {}) {
  return createDeployment(
    {
      name: "唐奇安监控",
      market: "cn-equity",
      status: "active",
      strategySpec: { kind: "study-rule", strategyId: "breakout" },
      universeSpec: { kind: "fixed-symbols", symbols: [A] },
      poolPolicy: {
        eviction: { maxConsecutiveMissedDays: 2, hardEvictBelowMaDays: 20 },
      },
      regimeGate: { kind: "none", unlockAvoidanceDays: 0 },
      riskPolicy: {},
      venueBinding: { kind: "ths_mock", accountTag: "default" },
      schedule: { kind: "manual_only" },
      provenance: { sourceKind: "manual" },
      ...overrides,
    },
    db,
  );
}

const flatAccount: PipelineAccountState = {
  cash: 100_000,
  equity: 100_000,
  drawdownPct: 0,
  positions: [],
};

const monthEnd = "2024-04-30";
const monthEndEvidence = () => ["2024-04-29", monthEnd, "2024-05-06"];
function seedSleeve(
  ownerId: string,
  symbol: string,
  quantity: number,
  accountScope: "ths_mock" | "local_sim" = "ths_mock",
  accountId = "default",
  entryDate = day1,
) {
  upsertSleeveHolding(
    {
      ownerId,
      symbol,
      quantity,
      accountScope,
      accountId,
      ownerKind: "deployment",
      entryDate,
      avgEntryPrice: 10,
      updatedAt: Date.parse(entryDate + "T14:30:00+08:00"),
    },
    db,
  );
}

function quotes(series: Record<string, Bar[]>) {
  return (symbol: string) => series[symbol] ?? [];
}

function input(
  deploymentId: string,
  decisionDate: string,
  deps: PipelinePlanningDeps,
) {
  return {
    deploymentId,
    decisionDate,
    deps,
    triggerKind: "manual",
    executeDate: new Date(Date.parse(decisionDate) + dayMs)
      .toISOString()
      .slice(0, 10),
  } as const;
}

const hits = (...symbols: string[]) =>
  symbols.map((symbol) => ({
    symbol,
    reason: "选股命中",
    score: null,
    price: null,
  }));

it("三日留池、均线淘汰、放量突破与 BUY 信号回写使用真实流水线", async () => {
  const { id } = deployment({
    universeSpec: { kind: "rps-filter", period: 20, minRps: 85 },
  });
  const readBars = quotes({
    [A]: [...history(day1), bar(day2), bar(day3, 15, 800)],
    [B]: [...history(day1), bar(day2, 6), bar(day3, 6)],
  });
  const readRpsCandidates = vi.fn((_spec, date) =>
    date === day1 ? hits(A, B) : [],
  );
  const readAccountState = vi.fn(() => flatAccount);
  const deps: PipelinePlanningDeps = {
    universe: { readBars, readRpsCandidates },
    readAccountState,
  };

  const first = await runPipelinePlanning(input(id, day1, deps), db);
  expect(first.run).toMatchObject({
    stage: "completed",
    universeSnapshot: { activeSymbols: [A, B] },
    signals: {
      signals: [
        { symbol: A, action: "HOLD" },
        { symbol: B, action: "HOLD" },
      ],
    },
  });
  expect(first.intents).toEqual([]);
  expect(getActivePoolEntries(id, db)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ symbol: A, status: "watching" }),
      expect.objectContaining({ symbol: B, status: "watching" }),
    ]),
  );
  expect(await runPipelinePlanning(input(id, day1, deps), db)).toEqual(first);
  expect(readAccountState).toHaveBeenCalledTimes(1);
  expect(readAccountState).toHaveBeenCalledWith(
    { kind: "ths_mock", accountTag: "default" },
    day1,
    db,
  );

  const second = await runPipelinePlanning(input(id, day2, deps), db);
  expect(second.run).toMatchObject({
    stage: "completed",
    universeSnapshot: {
      activeSymbols: [A],
      missedGrace: [{ symbol: A, consecutiveMissedDays: 1 }],
      evicted: [
        { symbol: B, reason: expect.stringContaining("跌破 20 日均线") },
      ],
    },
  });
  expect(getActivePoolEntries(id, db)).toMatchObject([
    { symbol: A, consecutiveMissedDays: 1 },
  ]);
  expect(listPoolEntries(id, { status: "evicted" }, db).items).toMatchObject([
    {
      symbol: B,
      status: "evicted",
      evictedDate: day2,
      evictReason: expect.stringContaining("均线"),
    },
  ]);

  const third = await runPipelinePlanning(input(id, day3, deps), db);
  expect(third.run).toMatchObject({
    stage: "risk_checked",
    signals: {
      signals: [
        {
          symbol: A,
          action: "BUY",
          reason: expect.stringContaining("55 日通道"),
        },
      ],
    },
  });
  expect(third.intents).toMatchObject([
    { symbol: A, phase: 2, side: "BUY", quantity: 1300, referencePrice: 15 },
  ]);
  expect(listIntentsByRun(third.run.id, db)).toEqual(third.intents);
  expect(getActivePoolEntries(id, db)).toMatchObject([
    {
      symbol: A,
      consecutiveMissedDays: 2,
      lastSignalAction: "BUY",
      lastSignalDate: day3,
    },
  ]);
  expect(await runPipelinePlanning(input(id, day3, deps), db)).toEqual(third);
  expect(readRpsCandidates).toHaveBeenCalledTimes(3);
});

it.each([
  { eviction: { hardEvictBelowMaDays: 5 }, reason: "跌破 5 日均线" },
  { eviction: { hardEvictMaxDrawdownPct: 0.3 }, reason: "较入池价回撤" },
  { eviction: { maxWatchDays: 1 }, reason: "观察超过 1 天" },
])("硬淘汰优先于当日继续命中：$reason", async ({ eviction, reason }) => {
  const { id } = deployment({ poolPolicy: { eviction } });
  const deps: PipelinePlanningDeps = {
    universe: {
      readBars: quotes({
        [A]: [
          ...history(day1),
          ...(eviction.maxWatchDays ? [] : [bar(day2, 6)]),
        ],
      }),
    },
  };
  await runPipelinePlanning(
    { ...input(id, day1, deps), stopAfterStage: "universe" },
    db,
  );
  const { run } = await runPipelinePlanning(
    { ...input(id, day2, deps), stopAfterStage: "universe" },
    db,
  );
  expect(run.universeSnapshot).toMatchObject({
    matchedCount: 1,
    activeSymbols: [],
    retained: [],
    evicted: [{ symbol: A, reason: expect.stringContaining(reason) }],
  });
  expect(listPoolEntries(id, { status: "evicted" }, db).items).toMatchObject([
    { symbol: A, lastMatchedDate: day1, evictedDate: day2 },
  ]);
});

it("缺决策日收盘时，旧收盘和未来收盘都不能触发均线或回撤淘汰", async () => {
  const { id } = deployment({
    universeSpec: { kind: "rps-filter", period: 20, minRps: 85 },
    poolPolicy: {
      eviction: { hardEvictBelowMaDays: 5, hardEvictMaxDrawdownPct: 0.3 },
    },
  });
  const deps: PipelinePlanningDeps = {
    universe: {
      readRpsCandidates: (_spec, date) =>
        date === day2 ? [{ ...hits(A)[0]!, price: 10 }] : [],
      readBars: quotes({
        [A]: [...history(day1), bar(day2, 6), bar(day4, 5)],
      }),
    },
  };
  await runPipelinePlanning(
    { ...input(id, day2, deps), stopAfterStage: "universe" },
    db,
  );
  const { run } = await runPipelinePlanning(
    { ...input(id, day3, deps), stopAfterStage: "universe" },
    db,
  );
  expect(run.universeSnapshot).toMatchObject({
    skipReason: "missing-data",
    evicted: [],
    missedGrace: [],
  });
  expect(getActivePoolEntries(id, db)).toMatchObject([
    { symbol: A, lastCheckedDate: day2, consecutiveMissedDays: 0 },
  ]);
});

it("满池按命中优先裁剪，首个超过宽限期的未命中日立即淘汰", async () => {
  const { id } = deployment({
    universeSpec: { kind: "rps-filter", period: 20, minRps: 85 },
    poolPolicy: { eviction: { maxPoolSize: 2, maxConsecutiveMissedDays: 1 } },
  });
  const deps: PipelinePlanningDeps = {
    universe: {
      readBars: () => [],
      readRpsCandidates: (_spec, date) =>
        date === day1 ? hits(A, B) : hits(C),
    },
  };
  const sync = (date: string) =>
    runPipelinePlanning(
      { ...input(id, date, deps), stopAfterStage: "universe" },
      db,
    );
  expect((await sync(day1)).run.universeSnapshot).toMatchObject({
    activeSymbols: [A, B],
  });
  expect((await sync(day2)).run.universeSnapshot).toMatchObject({
    activeSymbols: [A, C],
    missedGrace: [{ symbol: A, consecutiveMissedDays: 1 }],
    evicted: [{ symbol: B, reason: expect.stringContaining("容量上限 2") }],
  });
  expect((await sync(day3)).run.universeSnapshot).toMatchObject({
    activeSymbols: [C],
    missedGrace: [],
    evicted: [{ symbol: A, reason: "连续 2 日未满足选股条件" }],
  });
  expect(getActivePoolEntries(id, db).map(({ symbol }) => symbol)).toEqual([C]);
});

it.each([500, 0])(
  "移出监控池后继续评估持仓，按可卖 %i 股处理",
  async (sellable) => {
    const { id } = deployment({
      universeSpec: { kind: "rps-filter", period: 20, minRps: 85 },
      poolPolicy: { mode: "replace" },
    });
    seedSleeve(id, C, 500);
    const deps: PipelinePlanningDeps = {
      universe: {
        readBars: quotes({ [C]: [...history(day1), bar(day2, 6)] }),
        readRpsCandidates: (_spec, date) => (date === day1 ? hits(C) : []),
      },
      readAccountState: () => ({
        ...flatAccount,
        positions: [{ symbol: C, quantity: 500, sellable, lastPrice: 6 }],
      }),
    };
    await runPipelinePlanning(
      { ...input(id, day1, deps), stopAfterStage: "universe" },
      db,
    );
    const { run, intents } = await runPipelinePlanning(
      input(id, day2, deps),
      db,
    );
    expect(run.universeSnapshot).toMatchObject({
      activeSymbols: [],
      evicted: [{ symbol: C }],
    });
    expect(run.signals).toMatchObject({
      signals: [{ symbol: C, action: "SELL" }],
    });
    if (sellable) {
      expect(intents).toMatchObject([
        { symbol: C, quantity: 500, phase: 1, side: "SELL" },
      ]);
    } else {
      expect(intents).toEqual([]);
      expect(run).toMatchObject({
        stage: "completed",
        riskVerdict: {
          skipped: [{ symbol: C, side: "SELL", reason: "t_plus_1_locked" }],
        },
      });
    }
  },
);

it.each([
  {
    phase: "unknown",
    exposureScale: null,
    allowNewEntries: true,
    expected: "unknown",
  },
  {
    phase: "ice",
    exposureScale: 0.3,
    allowNewEntries: false,
    expected: "block",
  },
  {
    phase: "ferment",
    exposureScale: 0,
    allowNewEntries: true,
    expected: "block",
  },
] as const)(
  "情绪 $phase / scale=$exposureScale 拦买放卖",
  async ({ expected, ...snapshot }) => {
    const { id } = deployment({
      regimeGate: { kind: "sentiment-regime", unlockAvoidanceDays: 0 },
    });
    seedSleeve(id, C, 550);
    const readBars = quotes({
      [A]: [...history(day1), bar(day2, 15, 800)],
      [C]: [...history(day1), bar(day2, 6)],
    });
    const deps: PipelinePlanningDeps = {
      strategy: { readBars },
      regime: { readSentiment: () => snapshot },
      readAccountState: () => ({
        ...flatAccount,
        positions: [{ symbol: C, quantity: 550, sellable: 550, lastPrice: 6 }],
      }),
    };
    const { run, intents } = await runPipelinePlanning(
      input(id, day2, deps),
      db,
    );
    expect(run.riskVerdict).toMatchObject({
      allowNewEntries: false,
      regime: { status: expected },
      skipped: [{ symbol: A, side: "BUY", reason: "regime_gate_blocked" }],
    });
    expect(intents).toMatchObject([
      { symbol: C, quantity: 550, phase: 1, side: "SELL" },
    ]);

    const blocked = await runPipelinePlanning(
      {
        ...input(id, day2, { ...deps, readAccountState: () => flatAccount }),
        runSlot: "entries-only",
      },
      db,
    );
    expect(blocked.run).toMatchObject({
      stage: "blocked",
      finishedAt: expect.any(Number),
    });
    expect(blocked.intents).toEqual([]);
    expect(
      await runPipelinePlanning(
        {
          ...input(id, day2, {
            ...deps,
            readAccountState: () => {
              throw new Error("不应重读");
            },
          }),
          runSlot: "entries-only",
        },
        db,
      ),
    ).toEqual(blocked);
  },
);

it("达到回撤阈值只暂停买入，部分 T+1 锁定按完整可卖量退出", async () => {
  const { id } = deployment({ riskPolicy: { drawdownPausePct: 0.08 } });
  seedSleeve(id, C, 550);
  const { run, intents } = await runPipelinePlanning(
    input(id, day2, {
      strategy: {
        readBars: quotes({
          [A]: [...history(day1), bar(day2, 15, 800)],
          [C]: [...history(day1), bar(day2, 6)],
        }),
      },
      readAccountState: () => ({
        ...flatAccount,
        drawdownPct: 0.08,
        positions: [{ symbol: C, quantity: 550, sellable: 450, lastPrice: 6 }],
      }),
    }),
    db,
  );
  expect(run.riskVerdict).toMatchObject({
    allowNewEntries: false,
    reasons: ["drawdown_pause"],
    skipped: [{ symbol: A, side: "BUY", reason: "drawdown_pause" }],
  });
  expect(intents).toMatchObject([{ symbol: C, phase: 1, quantity: 450 }]);
});

it("市场基准读取抛错时阻止买入，并持久化已有持仓的卖单", async () => {
  const { id } = deployment({
    regimeGate: { kind: "oneil-market-direction", unlockAvoidanceDays: 0 },
  });
  seedSleeve(id, C, 550);
  const error = "沪深 300 日线读取失败";
  const { run, intents } = await runPipelinePlanning(
    input(id, day2, {
      strategy: {
        readBars: quotes({
          [A]: [...history(day1), bar(day2, 15, 800)],
          [C]: [...history(day1), bar(day2, 6)],
        }),
      },
      regime: {
        readBars: async () => {
          throw new Error(error);
        },
      },
      readAccountState: () => ({
        ...flatAccount,
        positions: [{ symbol: C, quantity: 550, sellable: 550, lastPrice: 6 }],
      }),
    }),
    db,
  );
  expect(run).toMatchObject({
    stage: "risk_checked",
    riskVerdict: {
      allowNewEntries: false,
      regime: {
        status: "unknown",
        scale: 0,
        allowNewEntries: false,
        reasons: [error],
        details: { error },
      },
      skipped: [{ symbol: A, side: "BUY", reason: "regime_gate_blocked" }],
    },
  });
  expect(intents).toMatchObject([{ symbol: C, side: "SELL", quantity: 550 }]);
  expect(listIntentsByRun(run.id, db)).toEqual(intents);
});

const valuePitSpec = {
  kind: "value-pit",
  strategyId: "value-magic-formula-pit",
} as const;

it.each([
  {
    strategySpec: valuePitSpec,
    strategy: {},
    reason: "缺档证券排除",
  },
  {
    strategySpec: valuePitSpec,
    strategy: { resolveValuePit: async () => ({}) },
    reason: "调仓日没有可用的正权重目标",
  },
  {
    strategySpec: {
      kind: "etf-rotation",
      config: etfRotationCatalog[0]!.defaults,
    },
    strategy: { resolveEtfRotation: () => ({}) },
    reason: "调仓日没有可用的正权重目标",
  },
  {
    strategySpec: { kind: "macro-clock" },
    strategy: {
      resolveMacroClock: () => ({
        regime: "unknown",
        targets: {},
        disclosure: "PMI 或通胀缺少两个可见报告期",
      }),
    },
    reason: "PMI 或通胀缺少两个可见报告期",
  },
  {
    strategySpec: { kind: "macro-clock" },
    strategy: {
      resolveMacroClock: () => ({ regime: "recovery", targets: {} }),
    },
    reason: "调仓日没有可用的正权重目标",
  },
] satisfies {
  strategySpec: CreateDeploymentInput["strategySpec"];
  strategy: PipelinePlanningDeps["strategy"];
  reason: string;
}[])(
  "$reason 时，持仓只生成 HOLD",
  async ({ strategySpec, strategy, reason }) => {
    const { id } = deployment({ strategySpec });
    for (const symbol of [A, C]) seedSleeve(id, symbol, 100);
    const { run, intents } = await runPipelinePlanning(
      input(id, monthEnd, {
        universe: { readBars: () => [] },
        strategy: { ...strategy, readTradingSessions: monthEndEvidence },
        readAccountState: () => ({
          ...flatAccount,
          positions: [A, C].map((symbol) => ({
            symbol,
            quantity: 100,
            sellable: 100,
            lastPrice: 10,
          })),
        }),
      }),
      db,
    );
    expect(run).toMatchObject({
      stage: "completed",
      signals: {
        mode: "delta-signals",
        targets: {},
        disclosure: expect.stringContaining(reason),
        signals: [A, C].map((symbol) => ({
          symbol,
          action: "HOLD",
          reason: expect.stringContaining("维持现有持仓"),
        })),
      },
    });
    expect(intents).toEqual([]);
  },
);

it("价值 PIT 的有效目标权重仍允许清仓落选持仓", async () => {
  const { id } = deployment({ strategySpec: valuePitSpec });
  seedSleeve(id, C, 100);
  const { run, intents } = await runPipelinePlanning(
    input(id, monthEnd, {
      universe: { readBars: () => [] },
      strategy: {
        readTradingSessions: monthEndEvidence,
        resolveValuePit: async () => ({ [A]: 0.5 }),
      },
      readAccountState: () => ({
        ...flatAccount,
        positions: [{ symbol: C, quantity: 100, sellable: 100, lastPrice: 10 }],
      }),
      readReferencePrice: () => 10,
    }),
    db,
  );
  expect(run.signals).toMatchObject({
    mode: "target-weights",
    targets: { [A]: 0.5, [C]: 0 },
  });
  expect(intents[0]).toMatchObject({ symbol: C, side: "SELL", quantity: 100 });
});

it("目标权重先减仓，解禁拦截高权重候选，余下买单受总敞口和订单数限制", async () => {
  const { id } = deployment({
    strategySpec: { kind: "macro-clock" },
    universeSpec: { kind: "fixed-symbols", symbols: [A, B, D] },
    regimeGate: { kind: "none", unlockAvoidanceDays: 10 },
    riskPolicy: {
      maxDailyOrders: 2,
      maxSymbolWeight: 0.21,
      maxTotalExposure: 0.62,
    },
  });
  seedSleeve(id, C, 550);
  const checkUnlockEvents = vi.fn(
    ({ symbols }: { symbols: readonly string[] }) =>
      symbols.includes(B)
        ? ([
            {
              code: "unlock",
              status: "warning",
              symbol: B,
              detail: "窗口内解禁",
            },
          ] as const)
        : [],
  );
  const { run, intents } = await runPipelinePlanning(
    {
      ...input(id, monthEnd, {
        universe: { readBars: () => [] },
        readIndustries: (symbol) => [symbol === C ? "银行" : "汽车"],
        strategy: {
          readTradingSessions: monthEndEvidence,
          resolveMacroClock: () => ({
            regime: "recovery",
            targets: { [A]: 0.55, [B]: 0.65, [C]: 0.385, [D]: 0.4 },
          }),
        },
        readAccountState: () => ({
          cash: 4500,
          equity: 10000,
          drawdownPct: 0,
          positions: [
            { symbol: C, quantity: 550, sellable: 550, lastPrice: 10 },
          ],
        }),
        readReferencePrice: () => 7,
        checkUnlockEvents,
      }),
      executeDate: "2024-05-06",
    },
    db,
  );
  // 5500 - 3850 permits a sale of 165 shares, rounded down to 100.
  // Then (6200 - 4500) / 7 permits 242 shares, rounded down to 200.
  expect(intents).toMatchObject([
    { symbol: C, phase: 1, side: "SELL", quantity: 100, referencePrice: 10 },
    { symbol: A, phase: 2, side: "BUY", quantity: 200, referencePrice: 7 },
  ]);
  expect(checkUnlockEvents.mock.calls).toEqual([
    [{ symbols: [B], executeDate: "2024-05-06", windowDays: 10 }],
    [{ symbols: [A], executeDate: "2024-05-06", windowDays: 10 }],
  ]);
  expect(run.riskVerdict).toMatchObject({
    skipped: [
      {
        symbol: B,
        side: "BUY",
        reason: "unlock_window_blocked",
        detail: "窗口内解禁",
      },
      { symbol: D, side: "BUY", reason: "max_daily_orders" },
    ],
  });
});

it.each([
  {
    cap: 0.21,
    exposure: 0.9,
    turnover: 1,
    cash: 10_000,
    price: 7,
    equity: 10_000,
    quantity: 300,
  },
  {
    cap: 0.21,
    exposure: 0.9,
    turnover: 0.4,
    cash: 10_000,
    price: 7,
    equity: 10_000,
    quantity: 200,
  },
  {
    cap: 0.5,
    exposure: 0.9,
    turnover: 2,
    cash: 0,
    price: 10,
    equity: 5_000,
    quantity: 100,
  },
  {
    cap: 1,
    exposure: 1,
    turnover: 2,
    cash: 0,
    price: 25,
    equity: 2_500,
    quantity: 0,
  },
])(
  "买单分别受单标 $cap、周转 $turnover 与卖后现金 $cash 限制，股数 $quantity",
  async ({ cap, exposure, turnover, cash, price, equity, quantity }) => {
    const config = deployment({
      riskPolicy: {
        maxSymbolWeight: cap,
        maxTotalExposure: exposure,
        maxDailyTurnover: turnover,
      },
    });
    const plan = await planOrderIntents({
      deployment: config,
      run: { id: "test", decisionDate: day3, executeDate: day4 },
      proposal: {
        mode: "target-weights",
        asOf: day3,
        targets: { [A]: 1, [C]: 0 },
        signals: [],
        regimeScale: null,
        disclosure: "",
      },
      ownerPositions: [{ symbol: C, quantity: 250, executionSellable: 250 }],
      accountState: {
        cash,
        equity,
        drawdownPct: 0,
        positions: [
          { symbol: C, quantity: 250, sellable: 1000, lastPrice: 10 },
        ],
      },
      regimeVerdict: await evaluateRegimeGate(config.regimeGate, day3),
      deps: { readReferencePrice: () => price },
    });
    expect(
      plan.intents.map((intent) => [intent.symbol, intent.quantity]),
    ).toEqual(
      quantity
        ? [
            [C, 250],
            [A, quantity],
          ]
        : [[C, 250]],
    );
    if (!quantity)
      expect(plan.riskVerdict.skipped).toEqual([
        { symbol: A, side: "BUY", reason: "below_min_lot" },
      ]);
  },
);

it("按信号分数选买单，缺价和不足一手均留下跳过原因", async () => {
  const config = deployment({ riskPolicy: { maxDailyOrders: 1 } });
  const plan = await planOrderIntents({
    deployment: config,
    run: { id: "test", decisionDate: day3, executeDate: day4 },
    proposal: {
      mode: "delta-signals",
      asOf: day3,
      targets: {},
      regimeScale: null,
      disclosure: "",
      signals: [
        [A, 2],
        [B, 3],
        [C, 4],
        [D, 5],
        [E, 6],
      ].map(([symbol, score]) => ({
        symbol: String(symbol),
        score: Number(score),
        action: "BUY",
        targetPrice: null,
        stopPrice: null,
        reason: "入场",
      })),
    },
    ownerPositions: [],
    accountState: flatAccount,
    regimeVerdict: await evaluateRegimeGate(config.regimeGate, day3),
    deps: {
      readReferencePrice: (symbol) =>
        ({ [E]: 0, [D]: null, [C]: 250, [B]: 10 })[symbol] ?? null,
    },
  });
  expect(plan.intents).toMatchObject([{ symbol: B, phase: 2, quantity: 2000 }]);
  expect(plan.riskVerdict.skipped).toEqual([
    { symbol: E, side: "BUY", reason: "missing_reference_price" },
    { symbol: D, side: "BUY", reason: "missing_reference_price" },
    { symbol: C, side: "BUY", reason: "below_min_lot" },
    { symbol: A, side: "BUY", reason: "max_daily_orders" },
  ]);
});

it("加密订单按账户精度向下截断并跳过 A 股解禁查询", async () => {
  const config = deployment({
    market: "crypto",
    strategySpec: { kind: "crypto-dual-ma", fast: 2, slow: 3, period: "day" },
    venueBinding: { kind: "crypto_sim", venue: "binance", accountId: "test" },
    regimeGate: { kind: "none", unlockAvoidanceDays: 10 },
  });
  const checkUnlockEvents = vi.fn(() => []);
  const plan = await planOrderIntents({
    deployment: config,
    run: { id: "test", decisionDate: day3, executeDate: day4 },
    proposal: {
      mode: "target-weights",
      asOf: day3,
      targets: { BTCUSDT: 0.2 },
      signals: [],
      regimeScale: null,
      disclosure: "",
    },
    ownerPositions: [],
    accountState: { ...flatAccount, cash: 100, equity: 100 },
    regimeVerdict: await evaluateRegimeGate(config.regimeGate, day3),
    deps: { readReferencePrice: () => 30_000, checkUnlockEvents },
  });
  expect(plan.intents).toMatchObject([
    { symbol: "BTCUSDT", phase: 2, quantity: 0.00066666 },
  ]);
  expect(checkUnlockEvents).not.toHaveBeenCalled();
});

it("未来暴涨 K 线无法改变选股入池价格、留池状态、信号和订单", async () => {
  const compare = async (futureBar: Bar[]) => {
    const { id } = deployment({
      name: futureBar.length ? "注入未来行情" : "原始行情",
      universeSpec: {
        kind: "formula-screen",
        formulaName: "测试候选",
        source: "C>0;",
      },
    });
    const deps: PipelinePlanningDeps = {
      universe: {
        readBars: quotes({
          [A]: [...history(day1), bar(day2), ...futureBar],
          [B]: [...history(day1), bar(day2, 6), ...futureBar],
        }),
        runFormulaScreen: (_spec, date) => (date === day1 ? hits(A, B) : []),
      },
      readAccountState: () => flatAccount,
    };
    const first = await runPipelinePlanning(input(id, day1, deps), db);
    const second = await runPipelinePlanning(input(id, day2, deps), db);
    return {
      added: first.run.universeSnapshot,
      secondPool: second.run.universeSnapshot,
      signals: second.run.signals,
      intents: second.intents,
      stage: second.run.stage,
    };
  };
  const baseline = await compare([]);
  expect(baseline).toMatchObject({
    added: {
      added: [
        { symbol: A, price: 10 },
        { symbol: B, price: 10 },
      ],
    },
    secondPool: { activeSymbols: [A], evicted: [{ symbol: B }] },
    signals: { signals: [{ symbol: A, action: "HOLD" }] },
    intents: [],
    stage: "completed",
  });
  expect(await compare([bar(day3, 500, 1_000_000)])).toEqual(baseline);
});

it("组合取最保守子门控，欧奈尔跟进日与道氏共振只读已完成基准", async () => {
  const sessions = history(day3, 40, 100);
  const oneilBars = sessions.map(({ date }, index) =>
    bar(
      date,
      index === 0 ? 100 : index < 4 ? 101 : 104,
      index === 4 ? 200 : 100,
    ),
  );
  const swingBars = sessions.map(({ date }, index) =>
    bar(date, 100 + index / 4 + 5 * Math.sin((index * Math.PI) / 4)),
  );
  const deps = {
    readBars: quotes({
      sh000300: [...oneilBars, bar(day4, 10, 1_000_000)],
      sh000001: swingBars,
      sz399001: swingBars,
    }),
    readMacroClock: () => ({ regime: "recession" as const }),
  };
  const oneil = { kind: "oneil-distribution" } as const;
  const dow = {
    kind: "dow-confirm",
    benchmark: "sh000001",
    secondaryBenchmark: "sz399001",
  } as const;
  expect(await evaluateRegimeGate(oneil, day3, deps)).toMatchObject({
    status: "allow",
    details: { followThroughDate: sessions[4]!.date, distributionDays: 0 },
  });
  expect(await evaluateRegimeGate(dow, day3, deps)).toMatchObject({
    status: "allow",
    scale: 1,
  });
  const combined = {
    kind: "composite",
    gates: [oneil, dow, { kind: "macro-clock" }],
  } as const;
  expect(await evaluateRegimeGate(combined, day3, deps)).toMatchObject({
    status: "reduced",
    scale: 0.5,
    allowNewEntries: true,
    details: {
      gates: [{ status: "allow" }, { status: "allow" }, { status: "reduced" }],
    },
  });
  expect(
    await evaluateRegimeGate(combined, day3, {
      ...deps,
      readBars: (symbol) =>
        symbol === "sz399001" ? [] : deps.readBars(symbol),
    }),
  ).toMatchObject({ status: "unknown", scale: 0, allowNewEntries: false });
  expect(
    await evaluateRegimeGate(oneil, day3, { readBars: () => [] }),
  ).toMatchObject({
    status: "unknown",
    scale: 0,
    allowNewEntries: false,
  });
});

it("本地账户以真实账本现金和执行日可卖量构建快照", async () => {
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(day1 + "T09:00:00+08:00"));
  const account = createSimAccount(
    { market: "cn-equity", name: "离线账户", initialCapital: "1005.50" },
    db,
  );
  confirmSimOrder(
    {
      accountId: account.id,
      symbol: A,
      side: "buy",
      quantity: "100",
      price: "10.00",
      tradeDate: day1,
      clientRequestId: "seed",
    },
    db,
    Date.parse(day1 + "T17:00:00+08:00"),
  );
  clock.mockRestore();
  const readPrice = vi.fn(() => 11);
  expect(
    await readLocalSimAccountState(account.id, day1, db, readPrice),
  ).toEqual({
    cash: 0,
    equity: 1100,
    riskRegime: "normal",
    drawdownPct: 0,
    positions: [{ symbol: A, quantity: 100, sellable: 0, lastPrice: 11 }],
  });
  expect(
    await readLocalSimAccountState(account.id, day2, db, readPrice),
  ).toMatchObject({
    cash: 0,
    positions: [{ symbol: A, sellable: 100 }],
  });
  expect(
    await readLocalSimAccountState(account.id, day1, db, readPrice, day2),
  ).toMatchObject({
    cash: 0,
    equity: 1100,
    positions: [{ symbol: A, quantity: 100, sellable: 100, lastPrice: 11 }],
  });
  expect(readPrice.mock.calls).toEqual([
    [A, day1],
    [A, day2],
    [A, day1],
  ]);
});

it("资金在建仓前到账时按净投入本金计算回撤，T 日买入触发退出可在 T+1 卖出", async () => {
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(day1 + "T09:00:00+08:00"));
  const account = createSimAccount(
    { market: "cn-equity", name: "本地回撤测试", initialCapital: "2000" },
    db,
  );
  postSimCashFlow(
    {
      accountId: account.id,
      kind: "deposit",
      amount: "700",
      requestId: "deposit",
    },
    db,
  );
  postSimCashFlow(
    {
      accountId: account.id,
      kind: "withdrawal",
      amount: "200",
      requestId: "withdrawal",
    },
    db,
  );
  const { id } = deployment({
    venueBinding: { kind: "local_sim", simAccountId: account.id },
    riskPolicy: {
      drawdownPausePct: 0.15,
      maxDailyTurnover: 1,
      maxSymbolWeight: 1,
      maxTotalExposure: 1,
    },
  });
  executePipelineSimOrder(
    {
      accountId: account.id,
      symbol: C,
      side: "buy",
      quantity: 100,
      price: 10,
      tradeDate: day2,
      clientRequestId: "same-day-buy",
    },
    db,
    Date.parse(day2 + "T14:30:00+08:00"),
  );
  seedSleeve(id, C, 100, "local_sim", account.id, day2);
  clock.mockRestore();
  const { run, intents } = await runPipelinePlanning(
    input(id, day2, {
      strategy: {
        readBars: quotes({
          [A]: [...history(day1), bar(day2, 12, 800)],
          [C]: [...history(day1), bar(day2, 6), bar(day3, 30)],
        }),
      },
    }),
    db,
  );
  // Net capital 2500, cash 1494.50, plus 100 shares at the decision close of 6.
  expect(run.riskVerdict).toMatchObject({
    drawdownPct: 0.1622,
    allowNewEntries: false,
    reasons: ["drawdown_pause"],
    skipped: [{ symbol: A, side: "BUY", reason: "drawdown_pause" }],
  });
  expect(intents).toMatchObject([
    {
      symbol: C,
      side: "SELL",
      executeDate: day3,
      quantity: 100,
      referencePrice: 6,
    },
  ]);
});

it("未收盘拒绝固化默认 daily，同一决策日收盘后可重新运行", async () => {
  const { id } = deployment();
  const now = vi.fn(() => Date.parse(day2 + "T15:04:59+08:00"));
  const readAccountState = vi.fn(() => flatAccount);
  const params = input(id, day2, {
    now,
    universe: { readBars: quotes({ [A]: history(day2) }) },
    readAccountState,
  });
  await expect(runPipelinePlanning(params, db)).rejects.toThrow(
    "A 股交易日尚未收盘，无法固化当日日频流水线",
  );
  expect(findPipelineRun(id, day2, db)).toBeNull();
  expect(getActivePoolEntries(id, db)).toEqual([]);
  expect(readAccountState).not.toHaveBeenCalled();

  now.mockReturnValue(Date.parse(day2 + "T15:05:00+08:00"));
  const { run, intents } = await runPipelinePlanning(params, db);
  expect(run.stage).toBe("completed");
  expect(intents).toEqual([]);
  expect(findPipelineRun(id, day2, db)).toEqual(run);
});

it("分阶段续跑复用选股与信号，失败可恢复，归档拒绝执行", async () => {
  const { id } = deployment();
  const readBars = vi.fn(
    quotes({ [A]: [...history(day1), bar(day2, 15, 800)] }),
  );
  const readAccountState = vi.fn(() => flatAccount);
  const params = input(id, day2, { universe: { readBars }, readAccountState });
  const universe = await runPipelinePlanning(
    { ...params, stopAfterStage: "universe" },
    db,
  );
  expect(universe.run).toMatchObject({
    stage: "universe_done",
    signals: null,
    riskVerdict: null,
  });
  expect(readAccountState).not.toHaveBeenCalled();
  const signals = await runPipelinePlanning(
    { ...params, stopAfterStage: "signals" },
    db,
  );
  const priorBarReads = readBars.mock.calls.length;
  expect(signals.run).toMatchObject({
    id: universe.run.id,
    stage: "signals_done",
    riskVerdict: null,
  });
  expect(signals.intents).toEqual([]);

  await expect(
    runPipelinePlanning(
      {
        ...params,
        deps: {
          ...params.deps,
          readReferencePrice: () => {
            throw new Error("价格源故障");
          },
        },
      },
      db,
    ),
  ).rejects.toThrow("价格源故障");
  expect(findPipelineRun(id, day2, db)).toMatchObject({
    stage: "failed",
    errorSummary: "价格源故障",
    signals: signals.run.signals,
  });
  const recovered = await runPipelinePlanning(
    {
      ...params,
      stopAfterStage: "risk",
      deps: { ...params.deps, readReferencePrice: () => 15 },
    },
    db,
  );
  expect(recovered.run).toMatchObject({
    id: universe.run.id,
    stage: "risk_checked",
    errorSummary: null,
  });
  expect(recovered.intents).toMatchObject([{ symbol: A, side: "BUY" }]);
  expect(readBars).toHaveBeenCalledTimes(priorBarReads);
  updateDeploymentStatus(id, "archived", undefined, db);
  await expect(
    runPipelinePlanning(input(id, day3, params.deps), db),
  ).rejects.toThrow("已归档");
  expect(findPipelineRun(id, day3, db)).toBeNull();
});

it("同一时段并发规划只执行一次选股和账户读取，只写一份意图", async () => {
  const { id } = deployment({
    universeSpec: { kind: "rps-filter", period: 20, minRps: 85 },
  });
  const readRpsCandidates = vi.fn(async () => hits(A));
  const readAccountState = vi.fn(async () => flatAccount);
  const params = input(id, day2, {
    universe: {
      readBars: quotes({ [A]: [...history(day1), bar(day2, 15, 800)] }),
      readRpsCandidates,
    },
    readAccountState,
  });
  const [first, retry] = await Promise.all([
    runPipelinePlanning(params, db),
    runPipelinePlanning(params, db),
  ]);
  expect(first.run.stage).toBe("risk_checked");
  expect(first.intents).toMatchObject([{ symbol: A, side: "BUY" }]);
  expect(retry).toEqual(first);
  expect(listIntentsByRun(first.run.id, db)).toEqual(first.intents);
  expect(readRpsCandidates).toHaveBeenCalledTimes(1);
  expect(readAccountState).toHaveBeenCalledTimes(1);
});

it("风控阶段写入失败时回滚已写意图并保留可重试的失败记录", async () => {
  const { id } = deployment();
  const params = input(id, day2, {
    universe: {
      readBars: quotes({ [A]: [...history(day1), bar(day2, 15, 800)] }),
    },
    readAccountState: () => flatAccount,
  });
  db.exec(`
    CREATE TEMP TRIGGER reject_risk_checkpoint BEFORE UPDATE ON pipeline_runs
    WHEN NEW.stage = 'risk_checked'
    BEGIN SELECT RAISE(ABORT, '模拟风控写入失败'); END;
  `);
  await expect(runPipelinePlanning(params, db)).rejects.toThrow(
    "模拟风控写入失败",
  );
  const failed = findPipelineRun(id, day2, db)!;
  expect(failed).toMatchObject({
    stage: "failed",
    errorSummary: "模拟风控写入失败",
    signals: { signals: [{ symbol: A, action: "BUY" }] },
  });
  expect(listIntentsByRun(failed.id, db)).toEqual([]);

  db.exec("DROP TRIGGER reject_risk_checkpoint");
  const retried = await runPipelinePlanning(params, db);
  expect(retried.run).toMatchObject({
    id: failed.id,
    stage: "risk_checked",
    errorSummary: null,
  });
  expect(retried.intents).toMatchObject([{ symbol: A, side: "BUY" }]);
});
