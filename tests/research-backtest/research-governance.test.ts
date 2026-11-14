import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import { ResearchAttempts } from "../../src/server/db/research-governance";
const connections: Database.Database[] = [];
function setup() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  return {
    db,
    attempts: new ResearchAttempts(db),
  };
}
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  vi.restoreAllMocks();
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
