import { beforeEach, expect, it, vi } from "vitest";
import { sqlite } from "~/server/db";
import { readJob, recoverJobs } from "~/server/jobs/jobs";
import { ResearchAttempts } from "~/server/research/research-governance";

const { spawnWorker } = vi.hoisted(() => ({ spawnWorker: vi.fn() }));
vi.mock("node:worker_threads", () => ({ Worker: spawnWorker }));

beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  spawnWorker.mockClear();
});

it("recovers every abandoned task beyond 10,000 newer results without replaying work", () => {
  const db = sqlite();
  const insert = db.prepare("INSERT INTO records VALUES (?, 'job', ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 10001; i++) {
      const id = `finished-${i}`;
      insert.run(id, JSON.stringify({ id, status: "completed", result: i }), 2);
    }
    // Multiple pages of active rows: changing their status must not skip rows.
    for (let i = 0; i < 1201; i++) {
      const id = `abandoned-${String(i).padStart(4, "0")}`;
      insert.run(
        id,
        JSON.stringify({
          id,
          type: "screen",
          input: { type: i % 2 ? "screen" : "formula-screen" },
          status: i % 2 ? "queued" : "running",
          ownerPid: 2147483647,
        }),
        1,
      );
    }
    insert.run(
      "live",
      JSON.stringify({ id: "live", status: "running", ownerPid: process.pid }),
      1,
    );
    insert.run(
      "ownerless",
      JSON.stringify({ id: "ownerless", status: "queued" }),
      1,
    );
    for (const status of ["cancelled", "failed"]) {
      insert.run(
        status,
        JSON.stringify({ id: status, status, error: "original" }),
        1,
      );
    }
  })();
  const terminal = db
    .prepare(
      "SELECT * FROM records WHERE id='finished-0' OR id IN ('cancelled','failed','live') ORDER BY id",
    )
    .all();
  recoverJobs();
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM records WHERE id LIKE 'abandoned-%' AND json_extract(payload,'$.status')='failed'",
      )
      .get(),
  ).toEqual({ n: 1201 });
  expect(readJob("ownerless")).toMatchObject({
    status: "failed",
    error: "应用重启中断了任务，可重新运行",
  });
  expect(
    db
      .prepare(
        "SELECT * FROM records WHERE id='finished-0' OR id IN ('cancelled','failed','live') ORDER BY id",
      )
      .all(),
  ).toEqual(terminal);
  const recovered = db.prepare("SELECT * FROM records ORDER BY id").all();
  recoverJobs();
  expect(db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    recovered,
  );
  expect(spawnWorker).not.toHaveBeenCalled();
});

it("recovers active audits in pages without parsing unrelated terminal audit formats", () => {
  const db = sqlite();
  const attempts = new ResearchAttempts(db);
  const template = attempts.begin({
    taskId: "fixture",
    kind: "formula-screen",
    config: {},
  });
  const insert = db.prepare(
    "INSERT INTO records VALUES (?, 'research-attempt', ?, 1)",
  );
  db.transaction(() => {
    // A completed historical audit is outside recovery, even if its old shape
    // no longer conforms to the current schema.
    insert.run(
      "old-audit",
      JSON.stringify({ state: "succeeded", oldFormat: true }),
    );
    for (let i = 0; i < 1201; i++) {
      const id = `audit-${String(i).padStart(4, "0")}`;
      insert.run(
        id,
        JSON.stringify({
          ...template,
          id,
          state: i % 2 ? "queued" : "running",
          ownerPid: 2147483647,
        }),
      );
    }
  })();
  const alive = vi.fn((pid: number) => pid === process.pid);
  attempts.recover(alive);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM records WHERE json_extract(payload,'$.state')='interrupted'",
      )
      .get(),
  ).toEqual({ n: 1201 });
  expect(attempts.read(template.id)).toEqual(template);
  const recovered = db.prepare("SELECT * FROM records ORDER BY id").all();
  attempts.recover(alive);
  expect(db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    recovered,
  );
  expect(spawnWorker).not.toHaveBeenCalled();
});
