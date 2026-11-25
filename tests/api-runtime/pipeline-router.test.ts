import { extractVenueAccountKey } from "trading-strategies";
import { beforeAll, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { createCaller } from "~/server/api/root";
import { sqlite } from "~/server/db";
import {
  insertOrderIntents,
  listExecutionAuditEvents,
} from "~/server/db/pipeline-repository";
import {
  registerLiveVenueAdapter,
  unregisterLiveVenueAdapter,
} from "~/server/execution/venue-router";
import { saveSettings } from "~/server/infra/settings";

const api = createCaller({ headers: new Headers() });

beforeAll(() => {
  // A configured but empty TDX root keeps the offline run on the ENOENT path
  // instead of failing before the pool snapshot is produced.
  saveSettings(settingsSchema.parse({ tdxRoot: process.env.QUANT_DATA_DIR }));
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

  const listed = await api.deploymentList({});
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

  const runs = await api.pipelineRunsList({ deploymentId: deployment.id });
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
        executeDate,
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
