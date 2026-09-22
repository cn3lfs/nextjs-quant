import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/migrations";
import { ResearchStore } from "../src/server/backtest/research-store";
import { admissionResearchFixture } from "./strategy-admission-fixture";
import { defaultStrategy } from "../src/lib/domain";

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock("../src/server/db", async (original) => ({
  ...(await original<typeof import("../src/server/db")>()),
  sqlite: () => state.db!,
  // Mirror the global ID-only getter so cross-kind negative controls would
  // really leak without the endpoint guard; never open the default database.
  get: <T>(id: string): T | undefined => {
    const row = state
      .db!.prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  },
  put: <T>(kind: string, id: string, value: T): T => {
    state
      .db!.prepare(
        "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,updated_at=excluded.updated_at",
      )
      .run(id, kind, JSON.stringify(value), Date.now());
    return value;
  },
}));
import { createCaller } from "../src/server/api/root";
const caller = createCaller({ headers: new Headers() });
beforeEach(() => {
  state.db = new Database(":memory:");
  migrate(state.db);
});
afterEach(() => {
  state.db?.close();
  state.db = null;
});

it("blocks every result, derivative and export route until an explicit durable reveal", async () => {
  const { dataset, result } = await admissionResearchFixture();
  const store = new ResearchStore(state.db!);
  const task = store.create(result.spec, null, "final-validation");
  store.saveDataset(task.id, dataset);
  store.freeze(task.id);
  store.finish(task.id, result);
  for (const id of [
    task.id,
    `${task.id}:result`,
    `${task.id}:dataset`,
    `${task.id}:evidence`,
    store.task(task.id)!.freezeId!,
  ]) {
    expect(await caller.job({ id })).toBeNull();
    expect(await caller.jobSummary({ id })).toBeNull();
    await expect(caller.retryDelivery(id)).rejects.toThrow("投递不存在");
    await expect(caller.toggleMonitor({ id, enabled: false })).rejects.toThrow(
      "监控不存在",
    );
    if (state.db!.prepare("SELECT id FROM records WHERE id=?").get(id))
      await expect(
        caller.saveMonitor({
          id,
          name: "不能覆盖研究",
          symbols: ["sh600000"],
          strategy: defaultStrategy,
          period: "day",
          channels: [],
          ai: false,
          enabled: false,
        }),
      ).rejects.toThrow("不能覆盖其他类型记录");
  }
  expect(store.task(task.id)?.mode).toBe("final-validation");
  expect(
    state
      .db!.prepare(
        "SELECT count(*) AS count FROM records WHERE kind IN ('delivery','monitor')",
      )
      .get(),
  ).toEqual({ count: 0 });
  expect(await caller.strategyResearchResult(task.id)).toBeNull();
  for (const partition of ["development", "validation"] as const) {
    await expect(
      caller.strategyResearchAdmission({ id: task.id, partition }),
    ).rejects.toThrow("尚未揭示");
    await expect(
      caller.strategyResearchAdmissionExport({ id: task.id, partition }),
    ).rejects.toThrow("尚未揭示");
    await expect(
      caller.strategyResearchRollingPerformance({ id: task.id, partition }),
    ).rejects.toThrow("尚未揭示");
    await expect(
      caller.strategyResearchPeriodPerformance({ id: task.id, partition }),
    ).rejects.toThrow("尚未揭示");
  }
  await expect(caller.strategyResearchSegments(task.id)).rejects.toThrow(
    "尚未揭示",
  );
  await expect(caller.strategyResearchExport(task.id)).rejects.toThrow(
    "尚未揭示",
  );
  await expect(
    caller.universeAuditPage({
      source: { kind: "research", id: task.id },
      start: result.spec.start,
      end: result.spec.end,
    }),
  ).rejects.toThrow("尚未揭示");
  const metadata = (await caller.strategyResearchTasks()).find(
    (row) => row.id === task.id,
  )!;
  expect(metadata.phase).toContain("等待显式揭示");
  expect(metadata.total).toBe(0);
  state.db!.exec(
    "CREATE TRIGGER reject_reveal BEFORE INSERT ON records WHEN NEW.kind='research-reveal' BEGIN SELECT RAISE(FAIL,'read only audit'); END",
  );
  await expect(caller.strategyResearchReveal(task.id)).rejects.toThrow(
    "read only audit",
  );
  expect(await caller.strategyResearchResult(task.id)).toBeNull();
  state.db!.exec("DROP TRIGGER reject_reveal");
  const revealed = await caller.strategyResearchReveal(task.id);
  expect(revealed?.resultVisible).toBe(true);
  expect(await caller.strategyResearchReveal(task.id)).toEqual(revealed);
  expect((await caller.strategyResearchResult(task.id))?.hash).toBe(
    result.hash,
  );
  expect((await caller.strategyResearchExport(task.id)).dataset?.hash).toBe(
    dataset.hash,
  );
});

it("ordinary legacy-compatible research remains visible without freezing", async () => {
  const { dataset, result } = await admissionResearchFixture();
  const store = new ResearchStore(state.db!);
  const task = store.create(result.spec, null);
  store.saveDataset(task.id, dataset);
  store.finish(task.id, result);
  expect((await caller.strategyResearchResult(task.id))?.hash).toBe(
    result.hash,
  );
  expect((await caller.strategyResearchExport(task.id)).dataset?.hash).toBe(
    dataset.hash,
  );
  expect((await caller.researchAttempts({ page: 1, pageSize: 1 })).total).toBe(
    1,
  );
  await expect(caller.researchAttempts({ pageSize: 101 })).rejects.toThrow();
});

const reportReaders: {
  name: string;
  id: string;
  read: (id: string) => Promise<unknown>;
}[] = [
  {
    name: "fundamental",
    id: `fundamental-report-${"a".repeat(64)}`,
    read: (id) => caller.fundamentalReport(id),
  },
  {
    name: "financial quality",
    id: `financial-quality-${"a".repeat(64)}`,
    read: (id) => caller.financialQualityReport(id),
  },
  {
    name: "financial growth",
    id: `financial-quality-${"a".repeat(64)}`,
    read: (id) => caller.financialGrowthReport(id),
  },
  {
    name: "valuation",
    id: `valuation-scenario-${"a".repeat(64)}`,
    read: (id) => caller.valuationReport(id),
  },
  {
    name: "wyckoff",
    id: `wyckoff-report-${"a".repeat(64)}`,
    read: (id) => caller.wyckoffReport(id),
  },
  {
    name: "walk forward page",
    id: "walk-forward-00000000-0000-0000-0000-000000000000",
    read: (id) => caller.walkForwardResult(id),
  },
  {
    name: "walk forward export",
    id: "walk-forward-00000000-0000-0000-0000-000000000000",
    read: (id) => caller.walkForwardExport(id),
  },
  {
    name: "chan",
    id: `chan-report-${"a".repeat(64)}`,
    read: (id) => caller.chanReport(id),
  },
  {
    name: "canslim",
    id: `canslim-report-${"a".repeat(64)}`,
    read: (id) => caller.canslimReport(id),
  },
  {
    name: "news",
    id: `news-analysis-${"a".repeat(64)}`,
    read: (id) => caller.newsAnalysis(id),
  },
  {
    name: "identity",
    id: "identity-sh600000",
    read: () => caller.identityRecord("sh600000"),
  },
];
it.each(reportReaders)(
  "$name checks persisted kind even when the record ID passes the endpoint schema",
  async ({ id, read }) => {
    state
      .db!.prepare("INSERT INTO records VALUES (?,?,?,?)")
      .run(
        id,
        "research-result",
        JSON.stringify({ hiddenValidationReturn: 123.45 }),
        Date.now(),
      );
    expect(await read(id)).toBeNull();
  },
);

it("snapshot-shaped research evidence cannot enter snapshot queries or start a delegated research job", async () => {
  const id = "research-private:dataset";
  state.db!.prepare("INSERT INTO records VALUES (?,?,?,?)").run(
    id,
    "research-dataset",
    JSON.stringify({
      id,
      symbol: "sh600000",
      period: "day",
      source: "tdx-local",
      bars: [],
      hiddenValidationReturn: 123.45,
    }),
    Date.now(),
  );
  await expect(caller.savedSnapshot(id)).rejects.toThrow("快照不存在");
  await expect(caller.breakout({ snapshotId: id })).rejects.toThrow(
    "快照不存在",
  );
  await expect(caller.czsc({ snapshotId: id })).rejects.toThrow("快照不存在");
  await expect(
    caller.analyze({
      snapshotId: id,
      question: "test",
      strategy: defaultStrategy,
    }),
  ).rejects.toThrow("请先加载行情");
  await expect(
    caller.chanAnalyze({ snapshotId: id, question: "test" }),
  ).rejects.toThrow("请先加载研究行情");
  await expect(caller.canslimAnalyze({ snapshotId: id })).rejects.toThrow(
    "请先加载当前研究",
  );
  await expect(
    caller.wyckoffAnalyze({ snapshotId: id, question: "test" }),
  ).rejects.toThrow("请先加载行情快照");
  await expect(
    caller.backtest({
      snapshotId: id,
      strategy: defaultStrategy,
      initial: 10000,
    }),
  ).rejects.toThrow("请先加载行情快照");
  await expect(
    caller.walkForward({
      snapshotId: id,
      strategy: defaultStrategy,
      initial: 10000,
    }),
  ).rejects.toThrow("请先加载行情快照");
  expect(
    state
      .db!.prepare("SELECT count(*) AS count FROM records WHERE kind='job'")
      .get(),
  ).toEqual({ count: 0 });
});

it.each(["snapshot", "chart-snapshot"])(
  "retains legitimate %s reads",
  async (kind) => {
    const id = `${kind}-fixture`;
    const value = {
      id,
      symbol: "sh600000",
      period: "day",
      bars: [],
      hash: "fixture",
    };
    state
      .db!.prepare("INSERT INTO records VALUES (?,?,?,?)")
      .run(id, kind, JSON.stringify(value), Date.now());
    expect(await caller.savedSnapshot(id)).toEqual(value);
  },
);

it("properly typed report, delivery and monitor records remain usable in isolated storage", async () => {
  const reportId = `fundamental-report-${"b".repeat(64)}`;
  const insert = state.db!.prepare("INSERT INTO records VALUES (?,?,?,?)");
  insert.run(
    reportId,
    "fundamental-report",
    JSON.stringify({ id: reportId, title: "fixture" }),
    Date.now(),
  );
  expect(await caller.fundamentalReport(reportId)).toMatchObject({
    title: "fixture",
  });
  insert.run(
    "delivery-fixture",
    "delivery",
    JSON.stringify({
      id: "delivery-fixture",
      body: "fixture",
      status: "failed",
    }),
    Date.now(),
  );
  const retried = await caller.retryDelivery("delivery-fixture");
  expect(retried).toMatchObject({
    status: "pending",
    manualRetry: true,
    body: "【手动重发历史通知】\nfixture",
  });
  insert.run(
    "monitor-fixture",
    "monitor",
    JSON.stringify({ id: "monitor-fixture", enabled: true, name: "fixture" }),
    Date.now(),
  );
  expect(
    await caller.toggleMonitor({ id: "monitor-fixture", enabled: false }),
  ).toMatchObject({ id: "monitor-fixture", enabled: false });
});

it("monitor channels cannot point at a research record and failed validation does not write", async () => {
  state
    .db!.prepare("INSERT INTO records VALUES (?,?,?,?)")
    .run(
      "research-not-channel",
      "research-result",
      JSON.stringify({ id: "research-not-channel" }),
      Date.now(),
    );
  await expect(
    caller.saveMonitor({
      name: "fixture",
      symbols: ["sh600000"],
      strategy: defaultStrategy,
      period: "day",
      channels: ["research-not-channel"],
      ai: false,
      enabled: false,
    }),
  ).rejects.toThrow("通知渠道不存在");
  expect(
    state
      .db!.prepare("SELECT count(*) AS count FROM records WHERE kind='monitor'")
      .get(),
  ).toEqual({ count: 0 });
});
