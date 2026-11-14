import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import { defaultStrategy } from "../../src/lib/domain";

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock("../../src/server/db/index", async (original) => ({
  ...(await original<typeof import("../../src/server/db/index")>()),
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
import { createCaller } from "../../src/server/api/root";
const caller = createCaller({ headers: new Headers() });
beforeEach(() => {
  state.db = new Database(":memory:");
  migrate(state.db);
});
afterEach(() => {
  state.db?.close();
  state.db = null;
});

it("generic jobs and monitors cannot read or overwrite unrelated record kinds", async () => {
  const kinds = [
    "research-task",
    "research-result",
    "research-dataset",
    "research-evidence",
    "research-freeze",
  ];
  for (const kind of kinds) {
    const id = `${kind}-private`;
    state
      .db!.prepare("INSERT INTO records VALUES (?,?,?,?)")
      .run(id, kind, JSON.stringify({ secret: "private" }), 1);
    expect(await caller.job({ id })).toBeNull();
    expect(await caller.jobSummary({ id })).toBeNull();
    await expect(caller.retryDelivery(id)).rejects.toThrow("投递不存在");
    await expect(caller.toggleMonitor({ id, enabled: false })).rejects.toThrow(
      "监控不存在",
    );
    await expect(
      caller.saveMonitor({
        id,
        name: "不能覆盖其他记录",
        symbols: ["sh600000"],
        strategy: defaultStrategy,
        period: "day",
        channels: [],
        ai: false,
        enabled: false,
      }),
    ).rejects.toThrow("不能覆盖其他类型记录");
  }
  expect(
    state
      .db!.prepare(
        "SELECT count(*) n FROM records WHERE kind IN ('monitor','delivery','job')",
      )
      .get(),
  ).toEqual({ n: 0 });
});

const reportReaders: {
  name: string;
  id: string;
  read: (id: string) => Promise<unknown>;
}[] = [
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
    (
      caller as unknown as { backtest: (input: unknown) => Promise<unknown> }
    ).backtest({
      snapshotId: id,
      strategy: defaultStrategy,
      initial: 10000,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
  const reportId = "report-fixture";
  const insert = state.db!.prepare("INSERT INTO records VALUES (?,?,?,?)");
  insert.run(
    reportId,
    "report",
    JSON.stringify({ id: reportId, title: "fixture" }),
    Date.now(),
  );
  expect(await caller.archivedReport(reportId)).toMatchObject({
    title: "fixture",
  });
  insert.run(
    "channel-fixture",
    "channel",
    JSON.stringify({
      id: "channel-fixture",
      name: "isolated",
      type: "feishu",
      target: "",
      thread: "",
      configured: true,
      enabled: true,
    }),
    Date.now(),
  );
  insert.run(
    "delivery-fixture",
    "delivery",
    JSON.stringify({
      id: "delivery-fixture",
      channelId: "channel-fixture",
      signalId: "signal-fixture",
      kind: "signal",
      title: "fixture",
      body: "fixture",
      status: "failed",
      createdAt: 1,
      nextAt: 1,
      expiresAt: 2,
      attempts: 1,
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
