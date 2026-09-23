import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { background, cancelJob, updateJob } from "../../src/server/jobs/jobs";
import { sqlite, get } from "../../src/server/db/index";
import type { Job } from "../../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-job-tests-"));
beforeEach(() => sqlite().prepare("DELETE FROM records").run());

it("cancellation written by another process reaches the owner's signal and late results cannot replace it", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const job = background("research", {}, async (_, signal) => {
    started();
    return new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve({ lateResult: true });
        },
        { once: true },
      ),
    );
  });
  await ready;
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout = 5000');
    const id=process.argv[2];
    const row=db.prepare('SELECT payload FROM records WHERE id=?').get(id);
    const job=JSON.parse(row.payload);job.status='cancelled';job.updatedAt=Date.now();
    db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(job),id);
    db.close();
  `,
      join(process.env.QUANT_DATA_DIR!, "quant.sqlite"),
      job.id,
    ],
    { cwd: process.cwd(), windowsHide: true, encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 3000 });
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(get<Job>(job.id)?.result).toBeUndefined();
  updateJob(job.id, { status: "completed", result: "stale", progress: 100 });
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(get<Job>(job.id)?.result).toBeUndefined();
});

it("coalesces active submissions across object key order, then permits a fresh completed run", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(async () => {
    await gate;
    return { total: 1 };
  });
  const first = background("screen", {}, run, {
    period: "day",
    strategy: { fast: 5, slow: 20 },
  });
  const second = background("screen", {}, run, {
    strategy: { slow: 20, fast: 5 },
    period: "day",
  });
  expect(first.id).toBe(second.id);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  finish();
  await vi.waitFor(() => expect(get<Job>(first.id)?.status).toBe("completed"));
  const third = background("screen", {}, async () => 2, {
    period: "day",
    strategy: { fast: 5, slow: 20 },
  });
  expect(third.id).not.toBe(first.id);
  await vi.waitFor(() => expect(get<Job>(third.id)?.status).toBe("completed"));
});

it("different data scopes are independent and cancelled submissions can be retried", async () => {
  const run = vi.fn(async () => 1);
  const first = background("screen", {}, run, { root: "A", period: "day" });
  cancelJob(first.id);
  const retry = background("screen", {}, run, { root: "A", period: "day" });
  const other = background("screen", {}, run, { root: "B", period: "day" });
  expect(new Set([first.id, retry.id, other.id]).size).toBe(3);
  await vi.waitFor(() => expect(get<Job>(other.id)?.status).toBe("completed"));
  expect(run).toHaveBeenCalledTimes(2);
  expect(get<Job>(first.id)?.status).toBe("cancelled");
});
