import Database from "better-sqlite3";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { put, sqlite } from "~/server/db";
import { createJob, readJob, saveJob, activeJobIds } from "~/server/db/jobs";
import { taskHistory } from "~/server/db/task-history";
import {
  readJobResultSnapshot,
  resultBatchBytes,
  resultBatchRows,
} from "~/server/db/job-results";
import { exportStoredFormulaScreen } from "~/server/screening/formula-screen-service";
import {
  readMaBaselineResultPage,
  readMaBaselineOrderPage,
  readMaBaselineArchive,
} from "~/server/db/backtest-results";
import {
  monitorWorkspacePage,
  signalWorkspacePage,
  deliveryWorkspacePage,
  monitorWorkspaceExport,
} from "~/server/db/monitor-workspace-query";
import { readSnapshot } from "~/server/db/snapshot";
import {
  enabledMonitorIds,
  sendingDeliveryIds,
  readMonitorRecord,
} from "~/server/db/monitor-records";
import type { Job } from "~/lib/domain";

const base: Job = {
  id: "fixture",
  type: "screen",
  status: "completed",
  progress: 100,
  createdAt: 1,
  updatedAt: 2,
  input: {},
};
const sequence = (count: number) => Array.from({ length: count }, (_, i) => i);
beforeEach(() => sqlite().prepare("DELETE FROM records").run());

it.each([0, 1, 200, 201, 603])(
  "reads exactly %i result rows and assembles the complete formula export",
  (count) => {
    const candidates = sequence(count).map((i) => ({
      symbol: `sh${600000 + i}`,
      name: `证券${i}`,
      snapshotId: `s${i}`,
      metrics: { close: i },
    }));
    const formula = { name: "fixture", source: "选股:C>0;", parameters: {} };
    const result = {
      formula,
      candidates,
      excluded: candidates.map((c) => ({ symbol: c.symbol, reason: "隔离" })),
      errors: candidates.map((c) => ({ symbol: c.symbol, error: "错误" })),
      total: count * 3,
      asOf: null,
      elapsedMs: 1,
      period: "day",
      researchMode: "latest-local",
      universeSource: "fixture",
      researchWarnings: [],
    };
    put("job", base.id, {
      ...base,
      input: { type: "formula-screen", formula, root: "fixture", now: 1 },
      result: { ...result, snapshots: ["UNREQUESTED_BULK".repeat(100000)] },
    });
    const parse = vi.spyOn(JSON, "parse");
    try {
      const exported = exportStoredFormulaScreen(base.id);
      expect(exported.candidates).toEqual(candidates);
      expect(exported.excluded).toEqual(result.excluded);
      expect(exported.errors).toEqual(result.errors);
      expect(exported.total).toBe(count * 3);
      expect(
        parse.mock.calls.some(([value]) => value.includes("UNREQUESTED_BULK")),
      ).toBe(false);
      expect(
        Math.max(
          ...parse.mock.calls.map(([value]) => Buffer.byteLength(value)),
        ),
      ).toBeLessThan(resultBatchBytes);
    } finally {
      parse.mockRestore();
    }
  },
);

it("bounds actual SQLite transfers by bytes and rows, including a multi-byte oversized row", () => {
  const items = sequence(405).map((i) => ({
    id: i,
    text: i === 201 ? "汉🙂".repeat(90000) : "中".repeat(3000),
  }));
  put("job", base.id, { ...base, result: { items } });
  const db = sqlite();
  const original = db.prepare.bind(db);
  const transfers: { rows: number; bytes: number }[] = [];
  const prepare = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    const statement = original(sql);
    const iterate = statement.iterate.bind(statement),
      get = statement.get.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation(function* (
      ...args: unknown[]
    ) {
      for (const row of iterate(...args) as Iterable<{ payload?: string }>) {
        transfers.push({
          rows: 1,
          bytes: row.payload ? Buffer.byteLength(row.payload) : 0,
        });
        yield row;
      }
    });
    vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
      const row = get(...args) as { chunk?: Buffer } | undefined;
      if (row?.chunk) transfers.push({ rows: 1, bytes: row.chunk.length });
      return row;
    });
    return statement;
  });
  try {
    expect(
      readJobResultSnapshot(base.id, ({ array }) => [
        ...array("$.result.items"),
      ]),
    ).toEqual(items);
    expect(transfers.length).toBeGreaterThan(400);
    expect(transfers.some((t) => t.bytes === resultBatchBytes)).toBe(true);
    expect(
      transfers.every(
        (t) => t.bytes <= resultBatchBytes && t.rows <= resultBatchRows,
      ),
    ).toBe(true);
  } finally {
    prepare.mockRestore();
  }
});

it("holds one snapshot across pages while another connection inserts, updates and deletes", () => {
  const items = sequence(603).map((id) => ({ id, value: "original" }));
  put("job", base.id, { ...base, result: { items } });
  const writer = new Database(
    join(process.env.QUANT_DATA_DIR!, "quant.sqlite"),
  );
  try {
    const actual = readJobResultSnapshot(base.id, ({ array }) => {
      const seen: unknown[] = [];
      for (const item of array("$.result.items")) {
        seen.push(item);
        if (seen.length === 200) {
          writer.prepare("UPDATE records SET payload=? WHERE id=?").run(
            JSON.stringify({
              ...base,
              result: {
                items: [
                  { id: -1 },
                  ...items.map((i) => ({ ...i, value: "updated" })),
                ],
              },
            }),
            base.id,
          );
          writer
            .prepare("INSERT INTO records VALUES ('new-job','job',?,1)")
            .run(JSON.stringify({ ...base, id: "new-job" }));
        }
        if (seen.length === 400)
          writer.prepare("DELETE FROM records WHERE id=?").run(base.id);
      }
      return seen;
    });
    expect(actual).toEqual(items);
    expect(readJob(base.id)).toBeUndefined();
    expect(readJob("new-job")?.id).toBe("new-job");
  } finally {
    writer.close();
  }
});

it("rejects writes, async readers, escaped iterators and missing arrays, and restores connection writability", () => {
  put("job", base.id, { ...base, result: { items: [1, true, null, "汉"] } });
  expect(
    readJobResultSnapshot(base.id, ({ array }) => [...array("$.result.items")]),
  ).toEqual([1, true, null, "汉"]);
  expect(readJobResultSnapshot("missing", () => 1)).toBeNull();
  put("report", "foreign", base);
  expect(readJobResultSnapshot("foreign", () => 1)).toBeNull();
  expect(() =>
    readJobResultSnapshot(base.id, ({ array }) => [
      ...array("$.result.absent"),
    ]),
  ).toThrow("有效数组");
  const escaped = readJobResultSnapshot(base.id, ({ array }) =>
    array("$.result.items"),
  )!;
  expect(() => [...escaped]).toThrow("快照已关闭");
  const partial = readJobResultSnapshot(base.id, ({ array }) => {
    const iterator = array<number>("$.result.items")[Symbol.iterator]();
    expect(iterator.next().value).toBe(1);
    return iterator;
  })!;
  expect(() => partial.next()).toThrow("快照已关闭");
  expect(() => readSnapshot(() => put("job", "forbidden", base))).toThrow(
    /readonly/,
  );
  expect(readJob("forbidden")).toBeUndefined();
  expect(() => readSnapshot(() => Promise.resolve(1))).toThrow("同步");
  expect(() => put("job", "writable", base)).not.toThrow();
});

it.each([0, 1, 200, 201, 603])(
  "pages all %i tasks and workspace kinds with stable tie breakers",
  (count) => {
    const db = sqlite();
    db.transaction(() => {
      for (const i of sequence(count)) {
        const id = String(i).padStart(5, "0");
        put("job", `job-${id}`, {
          ...base,
          id: `job-${id}`,
          result: { bulk: "ignored" },
        });
        put("monitor", `monitor-${id}`, {
          id: `monitor-${id}`,
          createdAt: 1,
          name: id,
          enabled: true,
          symbols: ["sh600000"],
          channels: [],
          strategy: { type: "ma-cross", name: "fixture" },
        });
        put("signal", `signal-${id}`, {
          id: `signal-${id}`,
          createdAt: 1,
          symbol: "sh600000",
          strategy: { name: "fixture" },
          metrics: {},
        });
        put("delivery", `delivery-${id}`, {
          id: `delivery-${id}`,
          createdAt: 1,
          signalId: `signal-${id}`,
          channelId: "channel",
          kind: "signal",
          title: id,
          status: "sending",
          body: "EVIDENCE",
        });
      }
    })();
    let taskCursor: { createdAt: number; id: string } | undefined;
    const tasks: string[] = [];
    do {
      const page = taskHistory({ cursor: taskCursor });
      expect(page.hasMore).toBe(page.nextCursor !== null);
      tasks.push(...page.items.map((row) => row.id));
      taskCursor = page.nextCursor ?? undefined;
    } while (taskCursor);
    expect(tasks).toEqual(
      sequence(count)
        .reverse()
        .map((i) => `job-${String(i).padStart(5, "0")}`),
    );
    for (const [kind, read] of [
      ["monitor", monitorWorkspacePage],
      ["signal", signalWorkspacePage],
      ["delivery", deliveryWorkspacePage],
    ] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = read(db, { cursor });
        expect(page.hasMore).toBe(page.nextCursor !== null);
        ids.push(...page.items.map((row) => row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(
        sequence(count)
          .reverse()
          .map((i) => `${kind}-${String(i).padStart(5, "0")}`),
      );
    }
    const sending = sendingDeliveryIds();
    put("delivery", "later", { id: "later", status: "sending" });
    for (const id of sending)
      put("delivery", id, {
        ...readMonitorRecord("delivery", id),
        status: "failed",
      });
    expect(sending).toHaveLength(count);
    expect(sendingDeliveryIds()).toEqual(["later"]);
    expect(enabledMonitorIds()).toHaveLength(count);
  },
);

it("keeps job validation/kind collisions and frozen recovery identities explicit", () => {
  expect(() => createJob({ ...base, progress: Infinity })).toThrow();
  put("report", base.id, { title: "retained" });
  expect(readJob(base.id)).toBeUndefined();
  expect(() => createJob(base)).toThrow("其他类型");
  expect(() => readJob("")).toThrow();
  put("job", "active", { ...base, id: "active", status: "running" });
  const ids = activeJobIds();
  saveJob({ ...base, id: "active", status: "failed" });
  createJob({ ...base, id: "later", status: "queued" });
  expect(ids).toEqual(["active"]);
  expect(activeJobIds()).toEqual(["later"]);
});

it("reads paged backtest results without the archived bars; full assembly preserves every field", () => {
  const fills = sequence(603).map((orderId) => ({ orderId, text: "fill" }));
  const orders = sequence(603).map((id) => ({
    id,
    status: id % 2 ? "filled" : "rejected",
    reason: `reason-${id}`,
  }));
  const archive = {
    result: {
      fills,
      orders,
      equity: [{ date: "2026-11-13", equity: 100 }],
      input: { symbol: "sh600000" },
      quality: { grade: "rule-check-only" },
    },
    manifest: { version: "fixture" },
    inputSnapshot: {
      bars: sequence(603).map((id) => ({
        id,
        extra: "ARCHIVED_BARS_ONLY".repeat(20),
      })),
      calendar: ["2026-11-13"],
      actions: {},
    },
  };
  put("job", base.id, {
    ...base,
    type: "backtest",
    input: { type: "ma-baseline" },
    result: archive,
  });
  const parse = vi.spyOn(JSON, "parse");
  try {
    const page = readMaBaselineResultPage(base.id, 12)!;
    expect(page.fills).toEqual(fills.slice(600));
    expect(page.fillCount).toBe(603);
    expect(page.orderCount).toBe(603);
    expect(page.rejectedCount).toBe(302);
    expect(readMaBaselineOrderPage(base.id, 6, "rejected")).toEqual({
      orders: orders.filter((o) => o.status === "rejected").slice(300),
      rowCount: 302,
    });
    expect(
      parse.mock.calls.some(([value]) => value.includes("ARCHIVED_BARS_ONLY")),
    ).toBe(false);
  } finally {
    parse.mockRestore();
  }
  expect(readMaBaselineArchive(base.id)).toEqual(archive);
  expect(() => readMaBaselineOrderPage(base.id, -1, "all")).toThrow();
  expect(() => readMaBaselineResultPage("missing", 0)).toThrow("不存在");
});

it("streams every associated delivery into a complete signal export beyond 200 rows", () => {
  put("signal", "signal", { id: "signal", symbol: "sh600000" });
  for (const i of sequence(603))
    put("delivery", `delivery-${String(i).padStart(4, "0")}`, {
      id: `delivery-${String(i).padStart(4, "0")}`,
      signalId: "signal",
      status: "failed",
      body: `evidence-${i}`,
      createdAt: i,
    });
  const exported = monitorWorkspaceExport(sqlite(), "signal", "signal");
  expect(
    exported.kind === "signal" && exported.deliveries.map((row) => row.body),
  ).toEqual(sequence(603).map((i) => `evidence-${i}`));
});
