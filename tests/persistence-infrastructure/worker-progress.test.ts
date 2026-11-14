import { readJob } from "../../src/server/db/jobs";
import { beforeEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { sqlite } from "~/server/db";
import { newJob, runWorker } from "~/server/jobs/jobs";

const control = vi.hoisted(() => ({
  messages: [] as Record<string, unknown>[],
  handle: (_worker: EventEmitter, _message: Record<string, unknown>) => {},
  terminated: 0,
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      threadId = 1;
      ref() {}
      unref() {}
      async terminate() {
        this.threadId = -1;
        control.terminated++;
        return 0;
      }
      postMessage(message: Record<string, unknown>) {
        control.messages.push(message);
        queueMicrotask(() => control.handle(this, message));
      }
    },
  };
});

beforeEach(() => {
  control.messages.length = 0;
  control.terminated = 0;
  sqlite().prepare("DELETE FROM records").run();
});

it("acknowledges a saved batch only after its progress is committed", async () => {
  const work = { type: "scan" as const, root: "fixture" };
  const job = newJob("scan", work);
  control.handle = (worker, message) => {
    if (message.progressAck === 7) {
      worker.emit("message", { result: readJob(job.id)?.phase });
    } else {
      worker.emit("message", {
        progress: 95,
        phase: "saved batch",
        progressId: 7,
      });
    }
  };
  await expect(runWorker(work, job.id)).resolves.toBe("saved batch");
  expect(control.messages[0]).toMatchObject({ jobId: job.id });
  expect(control.messages[1]).toEqual({ progressAck: 7 });
});

it("fails and terminates the worker when progress cannot be committed, without acknowledging it", async () => {
  const work = { type: "scan" as const, root: "fixture" };
  const job = newJob("scan", work);
  sqlite()
    .exec(`CREATE TEMP TRIGGER reject_worker_progress BEFORE UPDATE ON records
    WHEN json_extract(NEW.payload, '$.phase') = 'reject progress'
    BEGIN SELECT RAISE(ABORT, 'fixture rejected progress'); END`);
  control.handle = (worker) => {
    worker.emit("message", {
      progress: 95,
      phase: "reject progress",
      progressId: 8,
    });
  };
  try {
    await expect(runWorker(work, job.id)).rejects.toThrow(
      "fixture rejected progress",
    );
    expect(control.terminated).toBe(1);
    expect(control.messages.some((message) => "progressAck" in message)).toBe(
      false,
    );
  } finally {
    sqlite().exec("DROP TRIGGER reject_worker_progress");
  }
});
