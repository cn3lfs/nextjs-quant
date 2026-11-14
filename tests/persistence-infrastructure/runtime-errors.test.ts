import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  recordRuntimeError,
  recentRuntimeErrors,
} from "~/server/infra/runtime-errors";

const parent = process.env.QUANT_DATA_DIR!;
let root: string;
const file = () => join(root, "logs/runtime-errors.sqlite");
beforeEach(() => {
  root = mkdtempSync(join(parent, "errors-"));
  vi.stubEnv("QUANT_DATA_DIR", root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("reads an empty installation without creating a log or opening the business database", () => {
  expect(recentRuntimeErrors()).toEqual({
    entries: [],
    available: true,
    unrecordedInThisProcess: 0,
  });
  expect(existsSync(file())).toBe(false);
  expect(existsSync(join(root, "quant.sqlite"))).toBe(false);
});

it("persists only reviewed codes and summaries, with bounded validated correlation identifiers", () => {
  const secret = "token-super-secret-webhook-account";
  const error = Object.assign(
    new Error(`https://provider.invalid/?token=${secret}`),
    {
      code: secret,
      cause: { authorization: secret },
      response: secret,
    },
  );
  const jobId = `job-${randomUUID()}`;
  const requestId = randomUUID();
  expect(
    recordRuntimeError("job-run", error, { jobId, requestId, retryCount: 2 }),
  ).toBe(true);
  expect(
    recordRuntimeError("scheduler-tick", error, {
      jobId: secret,
      requestId: secret,
    }),
  ).toBe(true);
  const report = recentRuntimeErrors();
  expect(
    report.entries.find((entry) => entry.event === "job-run"),
  ).toMatchObject({
    jobId,
    requestId,
    code: "UNEXPECTED_ERROR",
    retryCount: 2,
    count: 1,
  });
  expect(
    report.entries.find((entry) => entry.event === "scheduler-tick"),
  ).toMatchObject({ jobId: null, requestId: null });
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(readFileSync(file()).includes(Buffer.from(secret))).toBe(false);
  expect(existsSync(join(root, "quant.sqlite"))).toBe(false);
});

it("merges repeated failures per minute while preserving counts, retry count and latest time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
  const first = Date.now();
  for (let n = 0; n < 20; n++) {
    vi.setSystemTime(first + n * 1000);
    expect(
      recordRuntimeError(
        "notification-send",
        { code: "ETIMEDOUT" },
        { retryCount: n },
      ),
    ).toBe(true);
  }
  expect(recentRuntimeErrors().entries).toEqual([
    expect.objectContaining({
      firstSeen: first,
      lastSeen: first + 19000,
      count: 20,
      retryCount: 19,
      code: "ETIMEDOUT",
    }),
  ]);
  vi.setSystemTime(first + 60000);
  recordRuntimeError("notification-send", { code: "ETIMEDOUT" });
  expect(recentRuntimeErrors().entries.map((row) => row.count)).toEqual([
    1, 20,
  ]);
});

it("rolls off old rows and keeps storage and API output bounded", () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 13);
  for (let n = 0; n < 300; n++) {
    vi.setSystemTime(start + n * 60000);
    expect(recordRuntimeError("scheduler-tick", { code: "SQLITE_BUSY" })).toBe(
      true,
    );
  }
  const db = new Database(file(), { readonly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM errors").get()).toEqual({
      n: 128,
    });
    expect(db.pragma("page_count", { simple: true })).toBeLessThanOrEqual(128);
  } finally {
    db.close();
  }
  expect(statSync(file()).size).toBeLessThanOrEqual(512 * 1024);
  const entries = recentRuntimeErrors().entries;
  expect(entries).toHaveLength(30);
  expect(entries[0]!.lastSeen).toBe(start + 299 * 60000);
});

it("keeps valid first/latest times when writers arrive out of timestamp order", () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 13);
  vi.setSystemTime(start + 2000);
  recordRuntimeError("scheduler-tick", null);
  vi.setSystemTime(start + 1000);
  recordRuntimeError("scheduler-tick", null);
  expect(recentRuntimeErrors()).toMatchObject({
    available: true,
    entries: [{ firstSeen: start + 1000, lastSeen: start + 2000, count: 2 }],
  });
});

it("does not count cancellation or normal shutdown as an error", () => {
  expect(
    recordRuntimeError(
      "worker-request",
      new DOMException("cancel", "AbortError"),
    ),
  ).toBe(false);
  expect(
    recordRuntimeError("job-run", new Error("terminated"), { cancelled: true }),
  ).toBe(false);
  expect(existsSync(file())).toBe(false);
});

it("survives unavailable storage and reports incomplete diagnostics without replacing the error", () => {
  writeFileSync(join(root, "logs"), "not a directory");
  const original = new Error("original failure");
  expect(() => {
    try {
      throw original;
    } catch (error) {
      recordRuntimeError("job-run", error);
      throw error;
    }
  }).toThrow(original);
  expect(recentRuntimeErrors()).toMatchObject({
    available: false,
    unrecordedInThisProcess: 1,
  });
});

it("leaves corrupt files untouched and reports unreadable instead of an empty success", () => {
  mkdirSync(join(root, "logs"));
  writeFileSync(file(), "invalid database");
  expect(recordRuntimeError("job-run", new Error())).toBe(false);
  expect(recentRuntimeErrors().available).toBe(false);
  expect(readFileSync(file(), "utf8")).toBe("invalid database");
});

it("fails softly on a busy writer, then records later failures after the lock is released", () => {
  recordRuntimeError("job-run", null);
  const db = new Database(file());
  try {
    db.exec("BEGIN EXCLUSIVE");
    expect(recordRuntimeError("scheduler-tick", null)).toBe(false);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
  expect(recordRuntimeError("scheduler-tick", null)).toBe(true);
  expect(recentRuntimeErrors()).toMatchObject({
    available: true,
    unrecordedInThisProcess: 1,
  });
});
