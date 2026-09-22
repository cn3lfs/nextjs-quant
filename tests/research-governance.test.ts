import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/migrations";
import { ResearchAttempts } from "../src/server/research/research-governance";
import {
  ResearchStore,
  type ResearchResult,
} from "../src/server/backtest/research-store";
import { researchSpecSchema } from "../src/lib/strategy-research";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";

const connections: Database.Database[] = [];
function setup() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  return {
    db,
    store: new ResearchStore(db),
    attempts: new ResearchAttempts(db),
  };
}
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  vi.restoreAllMocks();
});
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2024-01-01",
  end: "2024-12-31",
  validationStart: "2024-10-01",
});
const dataset: ResearchDataset = {
  version: "research-dataset-1",
  source: "tdx-local",
  root: "fixture",
  adjustment: "none",
  membership: {
    mode: "current-snapshot",
    symbols: ["sh600000"],
    source: null,
    warning: "fixture",
  },
  benchmark: { symbol: "sh000001", bars: [] },
  calendar: [],
  stocks: [],
  excluded: [],
  actionCoverage: "missing",
  actionSource: null,
  capturedAt: 1,
  hash: "fixture",
};
const result: ResearchResult = {
  version: "strategy-research-result-1",
  spec,
  datasetHash: "fixture",
  marketEvidenceHash: null,
  events: [],
  outcomes: [],
  partitions: [],
  exclusions: [],
  warnings: [],
  hash: "result",
};

it("fails closed when a task disappears but its result remains, preserving valid ordinary access", () => {
  const { db, store } = setup();
  const ordinary = store.create(spec, null);
  store.finish(ordinary.id, result);
  expect(store.isResultVisible(ordinary.id)).toBe(true);
  // A pre-governance task without mode remains an ordinary task.
  db.prepare(
    "UPDATE records SET payload=json_remove(payload,'$.mode') WHERE id=?",
  ).run(ordinary.id);
  expect(store.isResultVisible(ordinary.id)).toBe(true);
  db.prepare("DELETE FROM records WHERE id=? AND kind='research-task'").run(
    ordinary.id,
  );
  expect(store.result(ordinary.id)).toEqual(result);
  expect(store.isResultVisible(ordinary.id)).toBe(false);
  expect(store.isResultVisible("missing-task")).toBe(false);
});

it("research removal cannot delete audit records by accepting their identifiers", () => {
  const { db, store } = setup();
  const task = store.create(spec, null, "final-validation");
  store.saveDataset(task.id, dataset);
  const freeze = store.freeze(task.id);
  store.finish(task.id, result);
  store.reveal(task.id);
  const auditIds = [freeze.id, `${freeze.id}:reveal`, task.attemptId!];
  for (const id of auditIds) {
    const before = db.prepare("SELECT * FROM records WHERE id=?").get(id);
    expect(before).toBeDefined();
    store.remove(id);
    expect(db.prepare("SELECT * FROM records WHERE id=?").get(id)).toEqual(
      before,
    );
  }
  expect(store.isResultVisible(task.id)).toBe(true);
});

it("separates attempts from successful usages and rejects late terminal changes", () => {
  const { db, attempts } = setup();
  for (const kind of [
    "backtest",
    "walk-forward",
    "formula-screen",
    "sample-research",
    "discipline-counterfactual",
  ] as const) {
    const first = attempts.begin({ taskId: kind, kind, config: { x: 1 } });
    expect(first.state).toBe("queued");
    attempts.update(first.id, { state: "running" });
    attempts.update(first.id, { state: "cancelled" });
    expect(attempts.update(first.id, { state: "succeeded" })?.state).toBe(
      "cancelled",
    );
    const retry = attempts.begin({
      taskId: `${kind}-retry`,
      kind,
      config: { x: 1 },
    });
    expect(retry.id).not.toBe(first.id);
  }
  expect(
    attempts.page({ page: 1, pageSize: 2, state: "cancelled" }).total,
  ).toBe(5);
  expect(
    attempts.page({ page: 2, pageSize: 2, state: "cancelled" }).items,
  ).toHaveLength(2);
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE kind='research-usage'")
      .get(),
  ).toEqual({ n: 0 });
});
it("only recovers attempts when their owning process is confirmed dead", () => {
  const { attempts } = setup();
  const task = attempts.begin({ taskId: "one", kind: "backtest", config: {} });
  attempts.recover(() => true);
  expect(attempts.read(task.id)?.state).toBe("queued");
  attempts.recover(() => false);
  expect(attempts.read(task.id)?.state).toBe("interrupted");
  expect(attempts.update(task.id, { state: "failed" })?.state).toBe(
    "interrupted",
  );
});
it("requires a freeze before results and reveals atomically and idempotently", () => {
  const { db, store, attempts } = setup();
  const task = store.create(spec, null, "final-validation");
  store.saveDataset(task.id, dataset);
  expect(() => store.finish(task.id, result)).toThrow("先冻结");
  const freeze = store.freeze(task.id);
  expect(freeze.spec).toEqual(spec);
  expect(freeze.engineVersion).toContain("sample-engine-governance-1");
  store.update(task.id, {
    status: "running",
    phase: "回放 sh600000 2024-12-25",
    completed: 5,
    total: 9,
  });
  attempts.update(task.attemptId!, {
    actualRange: { start: "2024-01-03", end: "2024-12-30" },
    symbols: ["sh600000"],
    error: "private excluded stock",
  });
  expect(attempts.page({ page: 1, pageSize: 20 }).items[0]?.symbols).toEqual(
    [],
  );
  expect(store.projectTask(store.task(task.id)!).phase).not.toContain(
    "sh600000",
  );
  expect(store.isResultVisible(task.id)).toBe(false);
  store.finish(task.id, result);
  db.exec(
    "CREATE TRIGGER reject_reveal BEFORE INSERT ON records WHEN NEW.kind='research-reveal' BEGIN SELECT RAISE(ABORT,'blocked reveal'); END",
  );
  expect(() => store.reveal(task.id)).toThrow("blocked reveal");
  expect(store.isResultVisible(task.id)).toBe(false);
  db.exec("DROP TRIGGER reject_reveal");
  const revealed = store.reveal(task.id);
  expect(revealed?.revealedAt).toBeTypeOf("number");
  expect(store.reveal(task.id)).toEqual(revealed);
  expect(store.isResultVisible(task.id)).toBe(true);
  expect(store.result(task.id)).toEqual(result);
});
it("freeze storage failure blocks final validation while ordinary audit failure remains visible", () => {
  const { db, store } = setup();
  db.exec(
    "CREATE TRIGGER reject_audit BEFORE INSERT ON records WHEN NEW.kind='research-attempt' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
  );
  const ordinary = store.create(spec, null);
  expect(ordinary.auditIncomplete).toBe(true);
  store.finish(ordinary.id, result);
  expect(store.result(ordinary.id)).toEqual(result);
  const task = store.create(spec, null, "final-validation");
  store.saveDataset(task.id, dataset);
  db.exec(
    "CREATE TRIGGER reject_freeze BEFORE INSERT ON records WHEN NEW.kind='research-freeze' BEGIN SELECT RAISE(ABORT,'freeze unavailable'); END",
  );
  expect(() => store.freeze(task.id)).toThrow("freeze unavailable");
  expect(store.task(task.id)?.freezeId).toBeUndefined();
  expect(() => store.finish(task.id, result)).toThrow("先冻结");
});
it("retries frozen input without refetch and refuses changed payload or engine evidence", () => {
  const { db, store } = setup();
  const task = store.create(spec, null, "final-validation");
  store.saveDataset(task.id, dataset);
  const freeze = store.freeze(task.id);
  store.update(task.id, { status: "failed" });
  const retry = store.retry(task.id);
  expect(retry.freezeId).toBe(freeze.id);
  expect(retry.attemptId).not.toBe(task.attemptId);
  expect(store.dataset(retry.id)).toEqual(dataset);
  db.prepare(
    "UPDATE records SET payload=json_set(payload,'$.engineVersion','changed-engine') WHERE id=?",
  ).run(freeze.id);
  expect(() => store.retry(task.id)).toThrow("引擎版本不一致");
  db.prepare("UPDATE records SET payload=? WHERE id=?").run(
    JSON.stringify(freeze),
    freeze.id,
  );
  db.prepare(
    "UPDATE records SET payload=json_set(payload,'$.capturedAt',123) WHERE id=?",
  ).run(`${task.id}:dataset`);
  expect(() => store.retry(task.id)).toThrow("冻结输入");
});
it("retains revealed and ordinary access facts after deletion and changing validation boundary", () => {
  const { db, store, attempts } = setup();
  const ordinary = store.create(spec, null);
  store.finish(ordinary.id, result);
  store.remove(ordinary.id);
  const task = store.create(spec, null, "final-validation");
  store.saveDataset(task.id, dataset);
  store.freeze(task.id);
  store.finish(task.id, result);
  expect(store.governance(task.id)?.possibleContamination).toBe(true);
  const before = attempts.all().length;
  store.reveal(task.id);
  store.remove(task.id);
  expect(attempts.all()).toHaveLength(before);
  const next = store.create(
    { ...spec, validationStart: "2024-11-01" },
    null,
    "final-validation",
  );
  expect(store.governance(next.id)?.overlappingAccessCount).toBe(2);
  const backtest = attempts.begin({
    taskId: "historical-backtest",
    kind: "backtest",
    config: {},
    requestedRange: { start: "2024-11-03", end: "2024-11-10" },
  });
  attempts.update(backtest.id, { state: "failed" });
  expect(store.governance(next.id)?.overlappingAccessCount).toBe(3);
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE kind='research-freeze'")
      .get(),
  ).toEqual({ n: 1 });
});
