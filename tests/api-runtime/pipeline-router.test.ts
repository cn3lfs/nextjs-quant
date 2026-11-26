import { extractVenueAccountKey } from "trading-strategies";
import { afterEach, beforeEach, beforeAll, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { createCaller } from "~/server/api/root";
import { sqlite } from "~/server/db";
import { upsertSleeveHolding } from "~/server/db/sleeve-holding-repository";
import {
  insertOrderIntents,
  updatePipelineRunStage,
  transitionIntentStatus,
  listExecutionAuditEvents,
} from "~/server/db/pipeline-repository";
import {
  registerLiveVenueAdapter,
  unregisterLiveVenueAdapter,
} from "~/server/execution/venue-router";
import * as gfCalendar from "~/server/data-sources/gf/gf-calendar";
import * as quotes from "~/server/execution/pipeline-quote-provider";
import {
  createSimAccount,
  getSimAccountDetail,
} from "~/server/portfolio/sim-accounts/service";
import { saveSettings } from "~/server/infra/settings";

const api = createCaller({ headers: new Headers() });

beforeEach(() => {
  vi.spyOn(gfCalendar, "gfCalendarReference").mockRejectedValue(
    new Error("offline"),
  );
});
afterEach(() => vi.restoreAllMocks());

beforeAll(() => {
  // A configured but empty TDX root keeps the offline run on the ENOENT path
  // instead of failing before the pool snapshot is produced.
  saveSettings(
    settingsSchema.parse({
      tdxRoot: process.env.QUANT_DATA_DIR,
      calendar: ["2024-04-15", "2024-04-16", "2024-09-30", "2024-10-08"],
    }),
  );
});

async function runUniverseStage(deploymentId: string) {
  const result = await api.pipelineRunStep({
    deploymentId,
    decisionDate: "2024-04-15",
    stage: "universe",
  });
  if (!("run" in result))
    throw new Error(`预期规划结果，实际返回 ${JSON.stringify(result)}`);
  return result;
}

function deploymentInput(name: string, symbols: string[]) {
  return {
    name,
    market: "cn-equity" as const,
    strategySpec: {
      kind: "study-rule" as const,
      strategyId: "breakout" as const,
    },
    universeSpec: { kind: "fixed-symbols" as const, symbols },
    regimeGate: { kind: "none" as const },
    riskPolicy: {},
    venueBinding: { kind: "ths_mock" as const, accountTag: "default" as const },
    schedule: { kind: "manual_only" as const },
    provenance: { sourceKind: "manual" as const },
  };
}

it("实盘自动执行需要确认短语，模拟开关与关闭操作不需要", async () => {
  await expect(
    api.pipelineSetGlobalAutoLive({ enabled: true }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "开启实盘自动执行必须输入确认短语 ENABLE_LIVE_TRADING",
  });
  await expect(
    api.pipelineSetGlobalAutoLive({
      enabled: true,
      confirmationPhrase: "enable_live_trading",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });

  expect(
    await api.pipelineSetGlobalAutoLive({
      enabled: true,
      confirmationPhrase: "ENABLE_LIVE_TRADING",
    }),
  ).toMatchObject({ autoLiveEnabled: true });
  expect((await api.pipelineGlobalConfig()).autoLiveEnabled).toBe(true);

  expect(await api.pipelineSetGlobalAutoLive({ enabled: false })).toMatchObject(
    { autoLiveEnabled: false },
  );
  expect((await api.pipelineGlobalConfig()).autoLiveEnabled).toBe(false);

  expect(await api.pipelineSetGlobalAutoSim({ enabled: true })).toMatchObject({
    autoSimEnabled: true,
  });
  expect((await api.pipelineGlobalConfig()).autoSimEnabled).toBe(true);
  expect(await api.pipelineSetGlobalAutoSim({ enabled: false })).toMatchObject({
    autoSimEnabled: false,
  });
});

it("部署创建、手动入池、移出、切换执行模式与归档形成完整闭环", async () => {
  const created = await api.deploymentCreate(
    deploymentInput("路由闭环测试", ["sh600001"]),
  );
  expect(created).toMatchObject({ status: "draft", executionMode: "shadow" });

  const listed = await api.deploymentList({ direction: "forward" });
  const listedItem = listed.items.find((item) => item.id === created.id);
  expect(listedItem).toMatchObject({ activePoolCount: 0, latestRun: null });

  const added = await api.deploymentPoolAdd({
    deploymentId: created.id,
    symbol: "sh600001",
    asOf: "2024-04-15",
    entryPrice: 10,
  });
  expect(added).toMatchObject({
    symbol: "sh600001",
    status: "watching",
    source: "manual",
    entryPrice: 10,
  });

  const watching = await api.deploymentPoolList({
    deploymentId: created.id,
    direction: "forward",
  });
  expect(watching.items.map((entry) => entry.symbol)).toEqual(["sh600001"]);

  const detail = await api.deploymentGet({ id: created.id });
  expect(detail.deployment.id).toBe(created.id);
  expect(detail.activePool.map((entry) => entry.symbol)).toEqual(["sh600001"]);
  expect(detail.runs).toEqual([]);

  const modeUpdated = await api.deploymentUpdateMode({
    id: created.id,
    status: "active",
    executionMode: "auto_sim",
  });
  expect(modeUpdated).toMatchObject({
    status: "active",
    executionMode: "auto_sim",
  });

  const configUpdated = await api.deploymentUpdateConfig({
    id: created.id,
    patch: { name: "路由闭环测试（改名）" },
  });
  expect(configUpdated.name).toBe("路由闭环测试（改名）");

  const evicted = await api.deploymentPoolEvict({
    deploymentId: created.id,
    symbol: "sh600001",
    asOf: "2024-04-16",
    reason: "测试手动移出",
  });
  expect(evicted).toMatchObject({
    symbol: "sh600001",
    status: "evicted",
    evictReason: "测试手动移出",
  });
  expect(
    (
      await api.deploymentPoolList({
        deploymentId: created.id,
        status: "watching",
      })
    ).items,
  ).toEqual([]);

  const archived = await api.deploymentArchive({ id: created.id });
  expect(archived.status).toBe("archived");
  expect(
    (await api.deploymentList({ status: "archived" })).items.map(
      (item) => item.id,
    ),
  ).toContain(created.id);
});

it("模式与通道不兼容时，部署状态、执行模式和审计记录保持原值", async () => {
  const created = await api.deploymentCreate(
    deploymentInput("原子更新测试", ["sh600001"]),
  );
  const audit = () =>
    listExecutionAuditEvents({ deploymentId: created.id }, sqlite()).items;
  const previousAudit = audit();

  await expect(
    api.deploymentUpdateMode({
      id: created.id,
      status: "active",
      executionMode: "auto_live",
    }),
  ).rejects.toThrow("部署执行模式与交易通道不匹配");

  expect((await api.deploymentGet({ id: created.id })).deployment).toEqual(
    created,
  );
  expect(audit()).toEqual(previousAudit);
});

it("单步演练创建运行，列表、详情与部署摘要返回一致", async () => {
  const deployment = await api.deploymentCreate(
    deploymentInput("路由演练测试", ["sh600002"]),
  );

  const planned = await runUniverseStage(deployment.id);
  expect(planned.run).toMatchObject({
    deploymentId: deployment.id,
    stage: "universe_done",
    universeSnapshot: { activeSymbols: ["sh600002"] },
  });
  expect(planned.intents).toEqual([]);

  const runs = await api.pipelineRunsList({
    deploymentId: deployment.id,
    direction: "backward",
  });
  expect(runs.items.map((run) => run.id)).toEqual([planned.run.id]);
  expect(runs.nextCursor).toBeNull();

  const runDetail = await api.pipelineRunDetail({ runId: planned.run.id });
  expect(runDetail.run.id).toBe(planned.run.id);
  expect(runDetail.intents).toEqual([]);
  expect(runDetail.auditEvents.length).toBeGreaterThan(0);

  const listed = await api.deploymentList({});
  expect(listed.items.find((item) => item.id === deployment.id)).toMatchObject({
    activePoolCount: 1,
    latestRun: { id: planned.run.id },
  });
});

it.each([
  { stage: "signals", resultStage: "signals_done" },
  { stage: "risk", resultStage: "completed" },
  { stage: "full", resultStage: "completed" },
] as const)(
  "手动运行 $stage 通过所绑定的外部通道读取账户",
  async ({ stage, resultStage }) => {
    const venueBinding = {
      kind: "cn_broker_live",
      broker: "http_bridge",
      accountId: "offline-account",
    } as const;
    const deployment = await api.deploymentCreate({
      ...deploymentInput(`外部通道演练测试 ${stage}`, ["sh600002"]),
      venueBinding,
    });
    const readAccountState = vi.fn(async () => ({
      cash: 100_000,
      equity: 100_000,
      drawdownPct: null,
      positions: [],
    }));
    const accountKey = extractVenueAccountKey(venueBinding);
    registerLiveVenueAdapter(accountKey, {
      kind: venueBinding.kind,
      isLive: true,
      readAccountState,
      submitOrder: vi.fn(),
      reconcileOrder: vi.fn(),
      cancelOrder: vi.fn(),
    });
    try {
      await api.pipelineSetGlobalAutoLive({
        enabled: true,
        confirmationPhrase: "ENABLE_LIVE_TRADING",
      });
      const executeDate = "2024-04-16";
      expect(
        await api.pipelineRunStep({
          deploymentId: deployment.id,
          decisionDate: "2024-04-15",
          executeDate,
          stage,
        }),
      ).toMatchObject({ run: { stage: resultStage }, intents: [] });
      expect(readAccountState).toHaveBeenCalledExactlyOnceWith(
        venueBinding,
        "2024-04-15",
        sqlite(),
      );
    } finally {
      unregisterLiveVenueAdapter(accountKey);
      await api.pipelineSetGlobalAutoLive({ enabled: false });
    }
  },
);

it("手动确认在影子模式下不提交，取消接口把 planned 意图置为 cancelled", async () => {
  const deployment = await api.deploymentCreate({
    ...deploymentInput("路由意图测试", ["sh600003"]),
    status: "active",
    executionMode: "shadow",
  });
  const planned = await runUniverseStage(deployment.id);

  const intents = insertOrderIntents(
    planned.run.id,
    [
      {
        runId: planned.run.id,
        deploymentId: deployment.id,
        venueKind: "ths_mock",
        symbol: "sh600003",
        side: "BUY",
        phase: 2,
        quantity: 100,
        referencePrice: 10,
      },
      {
        runId: planned.run.id,
        deploymentId: deployment.id,
        venueKind: "ths_mock",
        symbol: "sh600004",
        side: "BUY",
        phase: 2,
        quantity: 100,
        referencePrice: 10,
      },
    ],
    sqlite(),
  );
  const approveTarget = intents[0]!;
  const cancelTarget = intents[1]!;

  expect(
    await api.pipelineIntentApprove({ intentId: approveTarget.id }),
  ).toEqual({ skipped: true, reason: "shadow-mode" });

  const cancelled = await api.pipelineIntentCancel({
    intentId: cancelTarget.id,
  });
  expect(cancelled).toMatchObject({
    id: cancelTarget.id,
    status: "cancelled",
    errorSummary: "用户手动取消",
  });
  const detail = await api.pipelineRunDetail({ runId: planned.run.id });
  const statuses = Object.fromEntries(
    detail.intents.map((intent) => [intent.id, intent.status]),
  );
  expect(statuses).toEqual({
    [approveTarget.id]: "planned",
    [cancelTarget.id]: "cancelled",
  });
});

it("国庆前手动规划取节后首个已确认交易日", async () => {
  const dep = await api.deploymentCreate(
    deploymentInput("节日日历", ["sh600002"]),
  );
  const result = await api.pipelineRunStep({
    deploymentId: dep.id,
    decisionDate: "2024-09-30",
    stage: "universe",
  });
  expect(result).toMatchObject({
    run: { executeDate: "2024-10-08" },
    calendarWarning: null,
  });
});

it.each(["execute", "approve"] as const)(
  "API %s 入口缺执行日报价时拒绝，外部委托数为零",
  async (entry) => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2024-04-16T09:35:00+08:00"),
    );
    const dep = await api.deploymentCreate({
      ...deploymentInput("API 缺报价 " + entry, ["sh600002"]),
      status: "active",
      executionMode: entry === "execute" ? "auto_sim" : "manual_confirm",
      schedule: { kind: "post_close_auto" },
    });
    const { run } = await runUniverseStage(dep.id);
    const [intent] = insertOrderIntents(
      run.id,
      [
        {
          runId: run.id,
          deploymentId: dep.id,
          symbol: "sh600002",
          quantity: 100,
          referencePrice: 10,
          venueKind: "ths_mock",
          side: "BUY",
          phase: 2,
        },
      ],
      sqlite(),
    );
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    await api.pipelineSetGlobalAutoSim({ enabled: true });
    try {
      if (entry === "approve")
        await api.pipelineIntentApprove({ intentId: intent!.id });
      else
        await api.pipelineRunStep({
          deploymentId: dep.id,
          decisionDate: run.decisionDate,
          stage: "execute",
        });
      expect(
        (await api.pipelineRunDetail({ runId: run.id })).intents,
      ).toMatchObject([
        {
          status: "rejected",
          venueOrderId: null,
          filledQuantity: null,
          errorSummary: "missing-execution-quote",
        },
      ]);
      expect(network).toHaveBeenCalled();
      expect(
        network.mock.calls.every(
          ([url]) => !String(url).includes("pt_stk_weituo"),
        ),
      ).toBe(true);
    } finally {
      network.mockRestore();
      await api.pipelineSetGlobalAutoSim({ enabled: false });
    }
  },
);

it("日历缺失时显式标注工作日回退，重复规划仍可查看首次回退的审计", async () => {
  const gf = vi
    .spyOn(gfCalendar, "gfCalendarReference")
    .mockRejectedValue(new Error("offline"));
  try {
    const dep = await api.deploymentCreate(
      deploymentInput("日历不可用", ["sh600002"]),
    );
    const input = {
      deploymentId: dep.id,
      decisionDate: "2025-01-24",
      stage: "universe",
    } as const;
    for (let i = 0; i < 2; i++)
      expect(await api.pipelineRunStep(input)).toMatchObject({
        run: { executeDate: "2025-01-27" },
        calendarWarning: expect.stringContaining("待确认"),
      });
    expect(gf).toHaveBeenCalledTimes(1);
    expect(
      listExecutionAuditEvents({ deploymentId: dep.id }, sqlite()).items.filter(
        (e) => e.eventType === "execution_calendar_fallback",
      ),
    ).toHaveLength(1);
  } finally {
    gf.mockRestore();
  }
});

it.each(["execute", "full", "approve", "reconcile"] as const)(
  "manual_only 的 %s 入口将暂定休市日顺延，确认日才允许手动成交",
  async (entry) => {
    const decisionDate = "2025-01-06",
      closed = "2025-01-07",
      next = "2025-01-08";
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(decisionDate + "T16:00:00+08:00"));
    const sim = createSimAccount(
      { name: "顺延 " + entry, market: "cn-equity", initialCapital: "100000" },
      sqlite(),
    );
    const dep = await api.deploymentCreate({
      ...deploymentInput("顺延 " + entry, ["sh600001"]),
      status: "active",
      executionMode: "manual_confirm",
      venueBinding: { kind: "local_sim", simAccountId: sim.id },
    });
    const input = { deploymentId: dep.id, decisionDate };
    const planned = await api.pipelineRunStep({ ...input, stage: "universe" });
    if (!("run" in planned)) throw new Error("缺少暂定运行");
    expect(planned.run.executeDate).toBe(closed);
    const runId = planned.run.id;
    const [intent] = insertOrderIntents(
      runId,
      [
        {
          runId,
          deploymentId: dep.id,
          symbol: "sh600001",
          side: "BUY",
          phase: 2,
          quantity: 100,
          referencePrice: 10,
          venueKind: "local_sim",
        },
      ],
      sqlite(),
    );
    updatePipelineRunStage(runId, { stage: "risk_checked" }, sqlite());
    const quote = vi.fn(async (symbol: string, tradeDate: string) => ({
      symbol,
      tradeDate,
      openPrice: 10,
      lastPrice: 10,
      prevClose: 10,
      upperLimit: 11,
      lowerLimit: 9,
      suspended: false,
      source: "fixture",
      observedAt: Date.now(),
      ttlMs: 60000,
    }));
    vi.spyOn(quotes, "createPipelineQuoteReader").mockImplementation(() =>
      Object.assign(quote, { readChecked: quote }),
    );
    now.mockReturnValue(Date.parse(closed + "T09:35:00+08:00"));
    const approve = () => api.pipelineIntentApprove({ intentId: intent!.id });
    const check = () =>
      entry === "approve"
        ? approve()
        : api.pipelineRunStep({ ...input, stage: entry, manualApproved: true });
    if (entry !== "reconcile") {
      const unknown = await check();
      expect(
        "execution" in unknown ? unknown.execution : unknown,
      ).toMatchObject({
        skipped: true,
        reason: "execution-calendar-unconfirmed",
      });
    }
    vi.mocked(gfCalendar.gfCalendarReference).mockResolvedValue({
      days: [next],
      closedDays: [closed],
      source: "fixture",
      hash: null,
    });
    for (let i = 0; i < 2; i++) {
      const response = await check();
      if (entry !== "reconcile")
        expect(
          "execution" in response ? response.execution : response,
        ).toMatchObject({ skipped: true, reason: "future-execute-date" });
    }
    const detail = await api.pipelineRunDetail({ runId });
    expect(detail.run.executeDate).toBe(next);
    expect(detail.intents).toMatchObject([
      { id: intent!.id, executeDate: next, status: "planned" },
    ]);
    expect(detail.intents[0]!.idempotencyKey).not.toBe(intent!.idempotencyKey);
    expect(
      detail.auditEvents.filter(
        (event) => event.eventType === "execution_calendar_rollover",
      ),
    ).toMatchObject([{ details: { from: closed, to: next, intents: 1 } }]);
    expect(quote).not.toHaveBeenCalled();
    now.mockReturnValue(Date.parse(next + "T09:35:00+08:00"));
    await approve();
    await approve();
    expect((await api.pipelineRunDetail({ runId })).intents).toMatchObject([
      { id: intent!.id, status: "filled" },
    ]);
    expect(
      getSimAccountDetail(
        { accountId: sim.id, currentTradeDate: next },
        sqlite(),
      ).trades,
    ).toHaveLength(1);
  },
);

it.each([
  "submitted",
  "partial_filled",
  "unknown_reconcile",
  "queued",
] as const)("本地撤单按真实提交状态处理 %s", async (status) => {
  const dep = await api.deploymentCreate({
    ...deploymentInput("本地撤单 " + status, ["sh600001"]),
    status: "active",
    executionMode: "manual_confirm",
  });
  const { run } = await runUniverseStage(dep.id);
  const [i] = insertOrderIntents(
    run.id,
    [
      {
        runId: run.id,
        deploymentId: dep.id,
        symbol: "sh600001",
        quantity: 200,
        phase: 1,
        side: "SELL",
        referencePrice: 10,
        venueKind: "ths_mock",
      },
    ],
    sqlite(),
  );
  if (status === "queued") {
    transitionIntentStatus(i!.id, status, {}, sqlite());
    expect(await api.pipelineIntentCancel({ intentId: i!.id })).toMatchObject({
      status: "cancelled",
    });
    return;
  }
  transitionIntentStatus(
    i!.id,
    "submitting",
    { manualApproved: true },
    sqlite(),
  );
  transitionIntentStatus(
    i!.id,
    status,
    {
      venueOrderId: "venue",
      ...(status === "partial_filled" && {
        filledQuantity: 100,
        averageFillPrice: 10,
      }),
    },
    sqlite(),
  );
  await expect(
    api.pipelineIntentCancel({ intentId: i!.id }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (await api.pipelineRunDetail({ runId: run.id })).intents[0],
  ).toMatchObject({ status, venueOrderId: "venue" });
});

it.each([
  ["execute", "auto_sim"],
  ["full", "auto_sim"],
  ["execute", "auto_live"],
  ["full", "auto_live"],
] as const)(
  "API %s 在 %s 窗口截止后保留待执行意图，报价与提交次数为零",
  async (stage, executionMode) => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2024-04-16T09:41:00+08:00"),
    );
    const venueBinding =
      executionMode === "auto_live"
        ? ({
            kind: "cn_broker_live",
            broker: "http_bridge",
            accountId: "window-test",
          } as const)
        : ({ kind: "ths_mock", accountTag: "default" } as const);
    const dep = await api.deploymentCreate({
      ...deploymentInput(`窗口 ${executionMode} ${stage}`, ["sh600001"]),
      status: "active",
      executionMode,
      venueBinding,
      schedule: { kind: "post_close_auto", openCutoffTime: "09:40" },
    });
    const { run } = await runUniverseStage(dep.id);
    insertOrderIntents(
      run.id,
      [
        {
          runId: run.id,
          deploymentId: dep.id,
          symbol: "sh600001",
          quantity: 100,
          venueKind: venueBinding.kind,
          phase: 2,
          side: "BUY",
          referencePrice: 10,
        },
      ],
      sqlite(),
    );
    updatePipelineRunStage(run.id, { stage: "risk_checked" }, sqlite());
    await api.pipelineSetGlobalAutoSim({ enabled: true });
    await api.pipelineSetGlobalAutoLive({
      enabled: true,
      confirmationPhrase: "ENABLE_LIVE_TRADING",
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    try {
      const response = await api.pipelineRunStep({
        deploymentId: dep.id,
        decisionDate: run.decisionDate,
        stage,
      });
      expect("execution" in response ? response.execution : response).toEqual({
        skipped: true,
        reason: "execution-window-closed",
      });
      expect(
        (await api.pipelineRunDetail({ runId: run.id })).intents[0],
      ).toMatchObject({ status: "planned", venueOrderId: null });
      expect(network).not.toHaveBeenCalled();
    } finally {
      await api.pipelineSetGlobalAutoSim({ enabled: false });
      await api.pipelineSetGlobalAutoLive({ enabled: false });
    }
  },
);

it("节前收盘 full 用决策日账户完成风控，次日卖单保持 planned", async () => {
  const decisionDate = "2024-09-30";
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse(decisionDate + "T16:00:00+08:00"),
  );
  const venueBinding = {
    kind: "cn_broker_live",
    broker: "http_bridge",
    accountId: "future-test",
  } as const;
  const dep = await api.deploymentCreate({
    ...deploymentInput("次日计划", ["sh600001"]),
    status: "active",
    executionMode: "auto_live",
    schedule: { kind: "post_close_auto" },
    venueBinding,
  });
  const key = extractVenueAccountKey(venueBinding);
  upsertSleeveHolding(
    {
      accountScope: "real",
      accountId: key,
      ownerKind: "deployment",
      ownerId: dep.id,
      symbol: "sh600001",
      quantity: 100,
      avgEntryPrice: 10,
      entryDate: "2024-09-27",
      updatedAt: Date.parse("2024-09-27T15:00:00+08:00"),
    },
    sqlite(),
  );
  const submitOrder = vi.fn();
  const readAccountState = vi.fn(async (_, asOf: string) => {
    if (asOf !== decisionDate) throw new Error("只支持当日快照");
    return {
      cash: 1000,
      equity: 2000,
      drawdownPct: null,
      positions: [
        { symbol: "sh600001", quantity: 100, sellable: 100, lastPrice: 10 },
      ],
    };
  });
  registerLiveVenueAdapter(key, {
    kind: venueBinding.kind,
    isLive: true,
    readAccountState,
    submitOrder,
    reconcileOrder: vi.fn(),
    cancelOrder: vi.fn(),
  });
  try {
    await api.pipelineSetGlobalAutoLive({
      enabled: true,
      confirmationPhrase: "ENABLE_LIVE_TRADING",
    });
    const input = { deploymentId: dep.id, decisionDate };
    const universe = await api.pipelineRunStep({ ...input, stage: "universe" });
    if (!("run" in universe)) throw new Error("缺少规划运行");
    updatePipelineRunStage(
      universe.run.id,
      {
        stage: "signals_done",
        signals: {
          mode: "target-weights",
          allocation: "cash",
          asOf: decisionDate,
          targets: { sh600001: 0 },
          signals: [],
          regimeScale: null,
          disclosure: "卖出原持仓",
        },
      },
      sqlite(),
    );
    const result = await api.pipelineRunStep({ ...input, stage: "full" });
    expect(result).toMatchObject({
      run: { stage: "risk_checked", executeDate: "2024-10-08" },
      execution: { skipped: true, reason: "future-execute-date" },
    });
    expect(
      (await api.pipelineRunDetail({ runId: universe.run.id })).intents,
    ).toMatchObject([{ side: "SELL", status: "planned", quantity: 100 }]);
    expect(readAccountState).toHaveBeenCalledExactlyOnceWith(
      venueBinding,
      decisionDate,
      sqlite(),
    );
    expect(submitOrder).not.toHaveBeenCalled();
  } finally {
    unregisterLiveVenueAdapter(key);
    await api.pipelineSetGlobalAutoLive({ enabled: false });
  }
});
